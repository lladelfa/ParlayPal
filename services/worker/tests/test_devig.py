"""Unit and integration tests for Story 1.2: Quantitative Devigging & Outlier Guard Engine."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
import json
import logging
import uuid

from pydantic import ValidationError
import pytest
from sqlalchemy import create_engine, select

from parlaypal_worker import celery_app as celery_app_module
from parlaypal_worker.celery_app import evaluate_prop_markets
from parlaypal_worker.db import create_session_factory, init_db
from parlaypal_worker.devig import (
    DeviggingError,
    TwoWayPropMarketInput,
    american_to_decimal,
    combine_independent_fair_probabilities,
    decimal_to_american,
    devig_multiplicative,
    devig_power,
    evaluate_two_way_prop,
    process_and_publish_ev_props,
)
from parlaypal_worker.models import Event, PlayerProp, Team
from parlaypal_worker.redis_client import (
    HOT_CACHE_TTL_SECONDS,
    EvaluatedPropFeedItem,
    cache_ev_feed,
    ev_feed_key,
    get_redis_pool,
)
from tests.test_substrate import FakeRedisClient


def test_american_and_decimal_odds_conversions() -> None:
    """Verify American <-> Decimal conversion accuracy at ingestion and display boundaries."""
    assert american_to_decimal(-110) == Decimal("1.9091")
    assert american_to_decimal("-110") == Decimal("1.9091")
    assert american_to_decimal(-200) == Decimal("1.5000")
    assert american_to_decimal(-100) == Decimal("2.0000")
    assert american_to_decimal(100) == Decimal("2.0000")
    assert american_to_decimal("+110") == Decimal("2.1000")
    assert american_to_decimal(150) == Decimal("2.5000")
    assert american_to_decimal(300) == Decimal("4.0000")

    assert decimal_to_american(Decimal("1.9091")) == -110
    assert decimal_to_american(Decimal("1.5000")) == -200
    assert decimal_to_american(Decimal("2.0000")) == 100
    assert decimal_to_american(Decimal("2.1000")) == 110
    assert decimal_to_american(Decimal("2.5000")) == 150
    assert decimal_to_american(Decimal("4.0000")) == 300
    assert decimal_to_american(Decimal("5.8500")) == 485


def test_invalid_odds_and_sub_one_overround_raise_devigging_error() -> None:
    """Verify invalid decimal/American odds and zero/negative overround raise DeviggingError."""
    # American odds between -99 and +99 are invalid
    for invalid_am in (-99, -50, -1, 0, 1, 50, 99, "invalid", float("nan"), float("inf"), True):
        with pytest.raises(DeviggingError) as exc_info:
            american_to_decimal(invalid_am)  # type: ignore[arg-type]
        assert exc_info.value.code == "INVALID_MARKET_ODDS"

    # Extreme negative or positive American odds (including >= 1e26) are rejected with DeviggingError
    for extreme_am in (-100000, 10**27, "1e30", "-1e30"):
        with pytest.raises(DeviggingError) as extreme_exc:
            american_to_decimal(extreme_am)
        assert extreme_exc.value.code == "INVALID_MARKET_ODDS"

    # Boolean values on numeric fields of TwoWayPropMarketInput are rejected
    with pytest.raises(ValidationError):
        TwoWayPropMarketInput(
            external_provider_id="papi_prop_bool_test",
            player_name="Patrick Mahomes",
            market_key="player_pass_yds",
            offered_decimal_odds=True,  # type: ignore[arg-type]
            sharp_decimal_odds=Decimal("1.9091"),
            opposite_sharp_decimal_odds=Decimal("1.9091"),
        )

    # Decimal odds < 1.01, > 9999.9999, NaN, Infinity, or boolean are rejected
    for invalid_dec in (
        Decimal("1.0099"),
        Decimal("0.9500"),
        Decimal("10000.0000"),
        Decimal("NaN"),
        Decimal("Infinity"),
        False,
    ):
        with pytest.raises(DeviggingError) as exc_info:
            decimal_to_american(invalid_dec)
        assert exc_info.value.code == "INVALID_MARKET_ODDS"

    # Zero or negative bookmaker overround (1/D_1 + 1/D_2 <= 1.0) raises structured DeviggingError
    for sharp_pair in (
        (Decimal("2.0000"), Decimal("2.0000")),  # 0.5 + 0.5 == 1.0 (zero overround)
        (Decimal("2.1000"), Decimal("2.1000")),  # 0.47619 + 0.47619 = 0.95238 < 1.0 (negative overround)
    ):
        with pytest.raises(DeviggingError) as mult_exc:
            devig_multiplicative(*sharp_pair)
        assert mult_exc.value.code == "INVALID_MARKET_ODDS"
        assert mult_exc.value.to_problem_details() == {
            "error": {
                "code": "INVALID_MARKET_ODDS",
                "message": mult_exc.value.message,
                "retry_after": 0,
            }
        }

        with pytest.raises(DeviggingError) as power_exc:
            devig_power(*sharp_pair)
        assert power_exc.value.code == "INVALID_MARKET_ODDS"


def test_standard_symmetric_two_way_market_positive_ev() -> None:
    """Scenario 1: Sharp (-110/-110 -> 1.9091/1.9091) with offered 2.1000 (+110) yields +5.0% EV."""
    p_mult_1, p_mult_2 = devig_multiplicative(Decimal("1.9091"), Decimal("1.9091"))
    p_pow_1, p_pow_2 = devig_power(Decimal("1.9091"), Decimal("1.9091"))

    assert p_mult_1 == Decimal("0.50000")
    assert p_mult_2 == Decimal("0.50000")
    assert p_pow_1 == Decimal("0.50000")
    assert p_pow_2 == Decimal("0.50000")

    result = evaluate_two_way_prop(
        sharp_primary_odds=Decimal("1.9091"),
        sharp_secondary_odds=Decimal("1.9091"),
        offered_odds=Decimal("2.1000"),
    )

    assert result.fair_probability_mult == Decimal("0.50000")
    assert result.fair_probability_power == Decimal("0.50000")
    assert result.fair_probability == Decimal("0.50000")
    assert result.ev_mult == Decimal("0.05000")
    assert result.ev_power == Decimal("0.05000")
    assert result.guarded_ev == Decimal("0.05000")
    assert result.status == "ACTIVE"
    assert result.is_positive_ev is True
    assert result.is_high_value is False
    assert result.is_outlier is False
    assert result.value_tier == "POSITIVE_VALUE"
    assert result.offered_american_odds == 110
    assert result.sharp_american_odds == -110


def test_asymmetric_two_way_market_power_vs_multiplicative_divergence() -> None:
    """Scenario 2: Asymmetric sharp (1.2500, 3.6000) with offered underdog 4.0000.

    Power method penalizes longshot bias more heavily than Multiplicative, so
    EV_guarded = min(EV_mult, EV_power) = EV_power.
    """
    p_mult_fav, p_mult_dog = devig_multiplicative(Decimal("1.2500"), Decimal("3.6000"))
    p_pow_fav, p_pow_dog = devig_power(Decimal("1.2500"), Decimal("3.6000"))

    assert p_mult_fav + p_mult_dog == Decimal("1.00000")
    assert p_pow_fav + p_pow_dog == Decimal("1.00000")
    # Power method assigns lower fair win probability to the underdog than Multiplicative
    assert p_pow_dog < p_mult_dog
    assert p_pow_fav > p_mult_fav

    # Evaluate underdog side (3.6000 sharp underdog vs 1.2500 sharp favorite, offered at 4.0000)
    underdog_eval = evaluate_two_way_prop(
        sharp_primary_odds=Decimal("3.6000"),
        sharp_secondary_odds=Decimal("1.2500"),
        offered_odds=Decimal("4.0000"),
    )

    assert underdog_eval.fair_probability_mult == Decimal("0.25773")
    assert underdog_eval.fair_probability_power == Decimal("0.22740")
    assert underdog_eval.fair_probability == underdog_eval.fair_probability_power
    assert underdog_eval.ev_mult == Decimal("0.03093")  # Multiplicative falsely sees +3.09% EV
    assert underdog_eval.ev_power == Decimal("-0.09038")  # Power reveals -9.04% EV
    assert underdog_eval.guarded_ev == min(underdog_eval.ev_mult, underdog_eval.ev_power)
    assert underdog_eval.guarded_ev == underdog_eval.ev_power
    assert underdog_eval.is_positive_ev is False
    assert underdog_eval.status == "ACTIVE"
    assert underdog_eval.value_tier == "NEUTRAL"

    # Also verify target_side=1 when passing (1.2500, 3.6000) produces the exact same result
    underdog_side1 = evaluate_two_way_prop(
        sharp_primary_odds=Decimal("1.2500"),
        sharp_secondary_odds=Decimal("3.6000"),
        offered_odds=Decimal("4.0000"),
        target_side=1,
    )
    assert underdog_side1 == underdog_eval


def test_outlier_circuit_breaker_stamps_suspect_stale_line() -> None:
    """Scenario 3: Sharp (1.8000, 2.0500) with stale offered odds 2.4500 triggers SUSPECT_STALE_LINE."""
    result = evaluate_two_way_prop(
        sharp_primary_odds=Decimal("1.8000"),
        sharp_secondary_odds=Decimal("2.0500"),
        offered_odds=Decimal("2.4500"),
        hit_rate_l10=Decimal("0.9000"),
    )

    assert result.guarded_ev > Decimal("0.10000")
    assert result.status == "SUSPECT_STALE_LINE"
    assert result.value_tier == "SUSPECT_STALE_LINE"
    assert result.is_positive_ev is False
    assert result.is_high_value is False
    assert result.is_outlier is True
    assert result.is_suspect_stale_line is True

    # Exact 10.0% boundary check: 0.50000 * 2.2000 - 1 = 0.10000 is ACTIVE; 2.2002 -> 0.10010 is SUSPECT_STALE_LINE
    at_ten_pct = evaluate_two_way_prop(
        sharp_primary_odds=Decimal("1.9091"),
        sharp_secondary_odds=Decimal("1.9091"),
        offered_odds=Decimal("2.2000"),
    )
    assert at_ten_pct.guarded_ev == Decimal("0.10000")
    assert at_ten_pct.status == "ACTIVE"
    assert at_ten_pct.is_positive_ev is True

    above_ten_pct = evaluate_two_way_prop(
        sharp_primary_odds=Decimal("1.9091"),
        sharp_secondary_odds=Decimal("1.9091"),
        offered_odds=Decimal("2.2002"),
    )
    assert above_ten_pct.guarded_ev == Decimal("0.10010")
    assert above_ten_pct.status == "SUSPECT_STALE_LINE"
    assert above_ten_pct.is_positive_ev is False

    # Extreme stale offered_odds clamps guarded_ev to Numeric(7, 5) max (99.99999) and extreme skew clamps fair_probability to [0.00001, 0.99999]
    extreme_outlier = evaluate_two_way_prop(
        sharp_primary_odds=Decimal("1.0100"),
        sharp_secondary_odds=Decimal("95.0000"),
        offered_odds=Decimal("9999.9999"),
    )
    assert Decimal("0.00001") <= extreme_outlier.fair_probability <= Decimal("0.99999")
    assert extreme_outlier.guarded_ev == Decimal("99.99999")
    assert extreme_outlier.status == "SUSPECT_STALE_LINE"

    clamped_joint = combine_independent_fair_probabilities([Decimal("0.01")] * 4)
    assert clamped_joint == Decimal("0.00001")


def test_sub_threshold_and_high_value_tier_classifications() -> None:
    """Scenarios 4 & 5: Sub-threshold (<1.5%) vs Positive (>=1.5%) vs High Value (>=3.5% + >=70% L10)."""
    # Scenario 4: Sub-threshold value (+1.0% < 1.5%)
    sub_threshold = evaluate_two_way_prop(
        sharp_primary_odds=Decimal("1.9091"),
        sharp_secondary_odds=Decimal("1.9091"),
        offered_odds=Decimal("2.0200"),
    )
    assert sub_threshold.guarded_ev == Decimal("0.01000")
    assert sub_threshold.status == "ACTIVE"
    assert sub_threshold.is_positive_ev is False
    assert sub_threshold.is_high_value is False
    assert sub_threshold.value_tier == "NEUTRAL"

    # Exact 1.5% threshold: 0.50000 * 2.0300 - 1 = +0.01500
    at_positive_threshold = evaluate_two_way_prop(
        sharp_primary_odds=Decimal("1.9091"),
        sharp_secondary_odds=Decimal("1.9091"),
        offered_odds=Decimal("2.0300"),
    )
    assert at_positive_threshold.guarded_ev == Decimal("0.01500")
    assert at_positive_threshold.is_positive_ev is True
    assert at_positive_threshold.value_tier == "POSITIVE_VALUE"

    # Scenario 5: High-value tier (+4.2% EV and hit_rate_l10 = 0.8000 >= 0.7000)
    high_val = evaluate_two_way_prop(
        sharp_primary_odds=Decimal("1.9091"),
        sharp_secondary_odds=Decimal("1.9091"),
        offered_odds=Decimal("2.0840"),
        hit_rate_l10=Decimal("0.8000"),
    )
    assert high_val.guarded_ev == Decimal("0.04200")
    assert high_val.status == "ACTIVE"
    assert high_val.is_positive_ev is True
    assert high_val.is_high_value is True
    assert high_val.value_tier == "HIGH_VALUE"

    # Falls back to POSITIVE_VALUE when hit_rate_l10 is None or < 0.7000
    fallback_none = evaluate_two_way_prop(
        sharp_primary_odds=Decimal("1.9091"),
        sharp_secondary_odds=Decimal("1.9091"),
        offered_odds=Decimal("2.0840"),
        hit_rate_l10=None,
    )
    assert fallback_none.is_positive_ev is True
    assert fallback_none.is_high_value is False
    assert fallback_none.value_tier == "POSITIVE_VALUE"

    fallback_low_hr = evaluate_two_way_prop(
        sharp_primary_odds=Decimal("1.9091"),
        sharp_secondary_odds=Decimal("1.9091"),
        offered_odds=Decimal("2.0840"),
        hit_rate_l10=Decimal("0.6999"),
    )
    assert fallback_low_hr.is_positive_ev is True
    assert fallback_low_hr.is_high_value is False
    assert fallback_low_hr.value_tier == "POSITIVE_VALUE"


def test_combine_independent_fair_probabilities() -> None:
    """Verify independent cross-game parlay joint fair probability calculation and validation."""
    joint = combine_independent_fair_probabilities(
        [Decimal("0.50000"), Decimal("0.55000"), Decimal("0.60000")]
    )
    assert joint == Decimal("0.16500")

    with pytest.raises(DeviggingError):
        combine_independent_fair_probabilities([])

    for invalid_prob in (Decimal("0"), Decimal("1.0"), Decimal("-0.2"), Decimal("1.2")):
        with pytest.raises(DeviggingError):
            combine_independent_fair_probabilities([Decimal("0.5"), invalid_prob])


def test_process_and_publish_ev_props_persists_db_and_excludes_outliers_from_redis(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Verify batch evaluation updates PostgreSQL PlayerProp rows and filters SUSPECT_STALE_LINE from Redis."""
    engine = create_engine("sqlite:///:memory:")
    init_db(engine=engine)
    session_factory = create_session_factory(engine)
    fake_redis = FakeRedisClient()
    sport_key = "americanfootball_nfl"

    with session_factory() as session:
        home_team = Team(
            external_provider_id="papi_nfl_kc",
            sport_key=sport_key,
            name="Kansas City Chiefs",
            abbreviation="KC",
        )
        away_team = Team(
            external_provider_id="papi_nfl_buf",
            sport_key=sport_key,
            name="Buffalo Bills",
            abbreviation="BUF",
        )
        session.add_all([home_team, away_team])
        session.flush()

        event = Event(
            external_provider_id="papi_nfl_20261115_kc_buf",
            sport_key=sport_key,
            home_team_id=home_team.team_id,
            away_team_id=away_team.team_id,
            commence_time=datetime(2026, 11, 15, 21, 25, tzinfo=timezone.utc),
            status="SCHEDULED",
        )
        session.add(event)
        session.commit()
        event_id = event.event_id

    batch_markets = [
        # 1. Standard positive EV (+5.0% EV, no hit rate -> POSITIVE_VALUE)
        {
            "external_provider_id": "papi_prop_mahomes_pass_yds",
            "event_id": event_id,
            "player_name": "Patrick Mahomes",
            "market_key": "player_pass_yds",
            "selection": "OVER",
            "line_value": Decimal("274.50"),
            "sharp_decimal_odds": Decimal("1.9091"),
            "opposite_sharp_decimal_odds": Decimal("1.9091"),
            "offered_decimal_odds": Decimal("2.1000"),
        },
        # 2. High-value qualification (+4.2% EV, 80% L10 hit rate -> HIGH_VALUE)
        {
            "external_provider_id": "papi_prop_allen_rush_yds",
            "event_id": event_id,
            "player_name": "Josh Allen",
            "market_key": "player_rush_yds",
            "selection": "OVER",
            "line_value": Decimal("42.50"),
            "sharp_decimal_odds": Decimal("1.9091"),
            "opposite_sharp_decimal_odds": Decimal("1.9091"),
            "offered_decimal_odds": Decimal("2.0840"),
            "hit_rate_l10": Decimal("0.8000"),
        },
        # 3. Sub-threshold neutral (+1.0% EV < 1.5% -> NEUTRAL, excluded from ev:feed)
        {
            "external_provider_id": "papi_prop_kelce_rec_yds",
            "event_id": event_id,
            "player_name": "Travis Kelce",
            "market_key": "player_reception_yds",
            "selection": "OVER",
            "line_value": Decimal("61.50"),
            "sharp_decimal_odds": Decimal("1.9091"),
            "opposite_sharp_decimal_odds": Decimal("1.9091"),
            "offered_decimal_odds": Decimal("2.0200"),
        },
        # 4. Outlier stale line (>10.0% EV -> SUSPECT_STALE_LINE, persisted to DB, excluded from ev:feed)
        {
            "external_provider_id": "papi_prop_cook_stale_line",
            "event_id": event_id,
            "player_name": "James Cook",
            "market_key": "player_rush_yds",
            "selection": "OVER",
            "line_value": Decimal("58.50"),
            "sharp_decimal_odds": Decimal("1.8000"),
            "opposite_sharp_decimal_odds": Decimal("2.0500"),
            "offered_decimal_odds": Decimal("2.4500"),
        },
    ]

    with session_factory() as session:
        with caplog.at_level(logging.WARNING):
            batch_result = process_and_publish_ev_props(
                sport_key=sport_key,
                prop_markets=batch_markets,
                redis_client=fake_redis,
                session=session,
            )

        assert batch_result.outlier_count == 1
        assert batch_result.positive_ev_count == 2
        assert batch_result.high_value_count == 1
        assert len(batch_result.evaluated) == 4
        assert len(batch_result.published_items) == 2
        assert "Outlier Circuit Breaker triggered for prop papi_prop_cook_stale_line" in caplog.text

        # Verify all 4 props were persisted to PostgreSQL with quantized fair_probability & guarded_ev
        persisted_props = {
            row.external_provider_id: row
            for row in session.scalars(select(PlayerProp)).all()
        }
        assert set(persisted_props.keys()) == {
            "papi_prop_mahomes_pass_yds",
            "papi_prop_allen_rush_yds",
            "papi_prop_kelce_rec_yds",
            "papi_prop_cook_stale_line",
        }

        stale_row = persisted_props["papi_prop_cook_stale_line"]
        assert stale_row.status == "SUSPECT_STALE_LINE"
        assert stale_row.guarded_ev is not None and stale_row.guarded_ev > Decimal("0.10000")
        assert stale_row.fair_probability == Decimal("0.53247")

        allen_row = persisted_props["papi_prop_allen_rush_yds"]
        assert allen_row.status == "ACTIVE"
        assert allen_row.fair_probability == Decimal("0.50000")
        assert allen_row.guarded_ev == Decimal("0.04200")
        assert allen_row.hit_rate_l10 == Decimal("0.8000")

        # Re-evaluate an existing PlayerProp row without supplying hit_rate_l10:
        # verifies existing_prop update path, hit_rate_l10 fallback from DB, and in-batch duplicate handling
        update_result = process_and_publish_ev_props(
            sport_key=sport_key,
            prop_markets=[
                {
                    "external_provider_id": "papi_prop_allen_rush_yds",
                    "event_id": event_id,
                    "player_name": "Josh Allen",
                    "market_key": "player_rush_yds",
                    "selection": "UNDER",
                    "line_value": Decimal("44.50"),
                    "sharp_decimal_odds": Decimal("1.9091"),
                    "opposite_sharp_decimal_odds": Decimal("1.9091"),
                    "offered_decimal_odds": Decimal("2.0840"),
                },
                {
                    "external_provider_id": "papi_prop_new_dup_in_batch",
                    "event_id": event_id,
                    "player_name": "Stefon Diggs",
                    "market_key": "player_reception_yds",
                    "selection": "OVER",
                    "line_value": Decimal("55.50"),
                    "sharp_decimal_odds": Decimal("1.9091"),
                    "opposite_sharp_decimal_odds": Decimal("1.9091"),
                    "offered_decimal_odds": Decimal("2.0600"),
                },
                {
                    "external_provider_id": "papi_prop_new_dup_in_batch",
                    "event_id": event_id,
                    "player_name": "Stefon Diggs",
                    "market_key": "player_reception_yds",
                    "selection": "OVER",
                    "line_value": Decimal("56.50"),
                    "sharp_decimal_odds": Decimal("1.9091"),
                    "opposite_sharp_decimal_odds": Decimal("1.9091"),
                    "offered_decimal_odds": Decimal("2.1000"),
                },
            ],
            redis_client=fake_redis,
            session=session,
        )
        assert update_result.high_value_count == 1
        session.refresh(allen_row)
        assert allen_row.selection == "UNDER"
        assert allen_row.line_value == Decimal("44.50")
        assert allen_row.hit_rate_l10 == Decimal("0.8000")

    # Restore expected 4-market feed snapshot for downstream assertions
    with session_factory() as session:
        process_and_publish_ev_props(
            sport_key=sport_key,
            prop_markets=batch_markets,
            redis_client=fake_redis,
            session=session,
        )

    # Verify Redis ev:feed:{sport_key} has 45s TTL and strictly excludes SUSPECT_STALE_LINE and NEUTRAL props
    raw_feed = fake_redis.get(ev_feed_key(sport_key))
    assert raw_feed is not None
    assert fake_redis.ttl(ev_feed_key(sport_key)) == HOT_CACHE_TTL_SECONDS == 45

    parsed_feed = json.loads(raw_feed)
    assert parsed_feed["sport_key"] == sport_key
    feed_provider_ids = [item["external_provider_id"] for item in parsed_feed["items"]]
    assert feed_provider_ids == [
        "papi_prop_mahomes_pass_yds",
        "papi_prop_allen_rush_yds",
    ]
    assert "papi_prop_cook_stale_line" not in feed_provider_ids
    assert "papi_prop_kelce_rec_yds" not in feed_provider_ids

    tiers_by_id = {
        item["external_provider_id"]: item["value_tier"] for item in parsed_feed["items"]
    }
    assert tiers_by_id["papi_prop_mahomes_pass_yds"] == "POSITIVE_VALUE"
    assert tiers_by_id["papi_prop_allen_rush_yds"] == "HIGH_VALUE"


def test_cache_ev_feed_and_celery_task_enforce_circuit_breaker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify EvaluatedPropFeedItem, cache_ev_feed, get_redis_pool, and evaluate_prop_markets task."""
    fake_redis = FakeRedisClient()

    # Direct attempt to construct or cache a SUSPECT_STALE_LINE, EV > 10%, EV < 1.5%, or inconsistent HIGH_VALUE item must fail
    for bad_ev in (Decimal("0.33118"), Decimal("0.01000")):
        with pytest.raises(ValidationError):
            EvaluatedPropFeedItem(
                external_provider_id="papi_prop_bad_ev",
                sport_key="basketball_nba",
                player_name="Luka Doncic",
                market_key="player_points",
                offered_decimal_odds=Decimal("2.5000"),
                sharp_decimal_odds=Decimal("1.8000"),
                fair_probability=Decimal("0.53247"),
                guarded_ev=bad_ev,
            )

    with pytest.raises(ValidationError):
        EvaluatedPropFeedItem(
            external_provider_id="papi_prop_bad_tier",
            sport_key="basketball_nba",
            player_name="Luka Doncic",
            market_key="player_points",
            offered_decimal_odds=Decimal("2.0840"),
            sharp_decimal_odds=Decimal("1.9091"),
            fair_probability=Decimal("0.50000"),
            guarded_ev=Decimal("0.04200"),
            hit_rate_l10=Decimal("0.6000"),
            value_tier="HIGH_VALUE",
            is_high_value=True,
        )

    for bad_dict in (
        {"external_provider_id": "papi_prop_bad", "status": "SUSPECT_STALE_LINE"},
        {"external_provider_id": "papi_prop_sub", "guarded_ev": "0.01000"},
        {"external_provider_id": "papi_prop_nan", "guarded_ev": "not-a-decimal"},
        {"external_provider_id": "papi_prop_wrong_sport", "sport_key": "americanfootball_nfl", "ev": "0.0400"},
    ):
        with pytest.raises(ValueError):
            cache_ev_feed(fake_redis, "basketball_nba", [bad_dict])

    assert len(fake_redis.store) == 0

    # Verify shared Redis connection pool caching per URL
    pool_a = get_redis_pool("redis://localhost:6379/0")
    pool_b = get_redis_pool("redis://localhost:6379/0")
    assert pool_a is pool_b

    # Missing markets/props/items key in dict payload raises ValueError
    with pytest.raises(ValueError):
        evaluate_prop_markets({"sport_key": "basketball_nba"})

    # Verify Celery task parlaypal_worker.evaluate_prop_markets opens a DB session via create_session_factory when session=None
    engine = create_engine("sqlite:///:memory:")
    init_db(engine=engine)
    session_factory = create_session_factory(engine)
    monkeypatch.setattr(celery_app_module, "get_redis_client", lambda: fake_redis)
    monkeypatch.setattr(celery_app_module, "create_session_factory", lambda: session_factory)

    task_output = evaluate_prop_markets(
        {
            "sport_key": "basketball_nba",
            "markets": [
                {
                    "external_provider_id": "papi_nba_tatum_pts",
                    "player_name": "Jayson Tatum",
                    "market_key": "player_points",
                    "selection": "OVER",
                    "line_value": "28.5",
                    "sharp_american_odds": -110,
                    "opposite_sharp_american_odds": -110,
                    "offered_american_odds": 110,
                    "hit_rate_l10": "0.7500",
                },
                {
                    "external_provider_id": "papi_nba_brown_stale",
                    "player_name": "Jaylen Brown",
                    "market_key": "player_points",
                    "selection": "OVER",
                    "line_value": "24.5",
                    "sharp_american_odds": -125,
                    "opposite_sharp_american_odds": 105,
                    "offered_american_odds": 145,
                },
            ],
        }
    )

    assert task_output["sport_key"] == "basketball_nba"
    assert task_output["outlier_count"] == 1
    assert task_output["positive_ev_count"] == 1
    assert task_output["high_value_count"] == 1
    assert fake_redis.closed is True

    with session_factory() as verify_session:
        db_rows = {
            row.external_provider_id: row
            for row in verify_session.scalars(select(PlayerProp)).all()
        }
        assert set(db_rows.keys()) == {"papi_nba_tatum_pts", "papi_nba_brown_stale"}
        assert db_rows["papi_nba_tatum_pts"].status == "ACTIVE"
        assert db_rows["papi_nba_brown_stale"].status == "SUSPECT_STALE_LINE"

    nba_feed = json.loads(fake_redis.get(ev_feed_key("basketball_nba")) or "{}")
    assert len(nba_feed["items"]) == 1
    assert nba_feed["items"][0]["external_provider_id"] == "papi_nba_tatum_pts"
    assert nba_feed["items"][0]["value_tier"] == "HIGH_VALUE"
    assert nba_feed["items"][0]["guarded_ev"] == "0.05000"
