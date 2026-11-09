"""Unit and integration tests for Story 1.4: Curated Preset Parlay Feed with Conviction Micro-Copy."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from parlaypal_worker.models import Event, PlayerProp
from parlaypal_worker.presets import (
    CuratedPresetFeed,
    PresetCard,
    PresetError,
    PresetLeg,
    calculate_combined_parlay,
    calculate_hybrid_value_score,
    decimal_to_american,
    generate_conviction_rationale,
    generate_curated_presets,
    sync_preset_feed_to_redis,
)


def test_decimal_to_american_odds_conversion() -> None:
    """Validate decimal to American odds mathematical boundary conditions."""
    # Even money (2.0000 -> +100)
    assert decimal_to_american(Decimal("2.0000")) == 100
    # Underdog (+485 for 5.8500)
    assert decimal_to_american(Decimal("5.8500")) == 485
    # Longshot (+1250 for 13.5000)
    assert decimal_to_american(Decimal("13.5000")) == 1250
    # Heavy favorite (-200 for 1.5000)
    assert decimal_to_american(Decimal("1.5000")) == -200
    # Moderate favorite (-133 for 1.7500)
    assert decimal_to_american(Decimal("1.7500")) == -133
    # Boundary condition (1.0100 -> -10000)
    assert decimal_to_american(Decimal("1.0100")) == -10000

    # Invalid decimal odds < 1.01
    with pytest.raises(PresetError, match="Decimal odds must be >= 1.01"):
        decimal_to_american(Decimal("1.0000"))


def test_hybrid_value_score_calculation() -> None:
    """Validate composite Hybrid Value Score calculation blending hit rate and guarded EV."""
    # High consistency (80% L10) and solid +4.5% EV
    score_high = calculate_hybrid_value_score(
        avg_hit_rate_l10=Decimal("0.8000"),
        combined_ev=Decimal("0.0450"),
    )
    assert 80 <= score_high <= 99

    # Moderate consistency (60% L10) and +2.0% EV
    score_mod = calculate_hybrid_value_score(
        avg_hit_rate_l10=Decimal("0.6000"),
        combined_ev=Decimal("0.0200"),
    )
    assert 60 <= score_mod <= 79

    # Lower consistency (40% L10) and zero EV
    score_low = calculate_hybrid_value_score(
        avg_hit_rate_l10=Decimal("0.4000"),
        combined_ev=Decimal("0.0000"),
    )
    assert 30 <= score_low <= 55

    # Clamp boundaries: always strictly within 0 to 100
    score_max = calculate_hybrid_value_score(
        avg_hit_rate_l10=Decimal("1.0000"),
        combined_ev=Decimal("0.0990"),
    )
    assert score_max <= 100

    score_min = calculate_hybrid_value_score(
        avg_hit_rate_l10=Decimal("0.0000"),
        combined_ev=Decimal("-0.2000"),
    )
    assert score_min >= 0


def test_conviction_micro_copy_generation() -> None:
    """Ensure plain-English conviction rationales synthesize consistency, matchup, and weather."""
    # NFL Anytime Touchdown rationale
    copy_td = generate_conviction_rationale(
        player_name="Derrick Henry",
        market_key="player_anytime_td",
        matchup="BAL @ PIT",
        hit_rate_formatted="7/10 (70.0%)",
        weather_badge_summary=None,
    )
    assert "Derrick Henry" in copy_td
    assert "7/10" in copy_td or "70.0%" in copy_td
    assert "touchdown" in copy_td.lower() or "td" in copy_td.lower()

    # NFL Passing Yards with wind warning
    copy_wind = generate_conviction_rationale(
        player_name="Josh Allen",
        market_key="player_pass_yds",
        matchup="BUF @ NYJ",
        hit_rate_formatted="8/10 (80.0%)",
        weather_badge_summary="⚠️ 19mph Wind",
    )
    assert "Josh Allen" in copy_wind
    assert "19mph" in copy_wind or "wind" in copy_wind.lower()

    # NBA Points rationale
    copy_nba = generate_conviction_rationale(
        player_name="Jayson Tatum",
        market_key="player_points",
        matchup="BOS @ NYK",
        hit_rate_formatted="8/10 (80.0%)",
        weather_badge_summary=None,
    )
    assert "Jayson Tatum" in copy_nba
    assert "8/10" in copy_nba or "80.0%" in copy_nba


def test_calculate_combined_parlay() -> None:
    """Validate independent multi-leg parlay pricing: combined odds, fair prob, and EV."""
    leg1 = PresetLeg(
        prop_id=uuid.uuid4(),
        event_id=uuid.uuid4(),
        player_name="Derrick Henry",
        team_abbreviation="BAL",
        matchup="BAL @ PIT",
        market_key="player_anytime_td",
        market_display="Anytime Touchdown",
        selection="OVER",
        line_value=Decimal("0.5"),
        offered_decimal_odds=Decimal("1.8000"),
        offered_american_odds=-125,
        sharp_decimal_odds=Decimal("1.7500"),
        sharp_american_odds=-133,
        fair_probability=Decimal("0.5800"),
        guarded_ev=Decimal("0.0440"),
        hit_rate_l5=Decimal("0.8000"),
        hit_rate_l10=Decimal("0.7000"),
        hit_rate_season=Decimal("0.7500"),
        hit_rate_display="7/10 (70.0%) L10",
        sofascore_form=[True, True, False, True, True],
        sofascore_dots="🟢🟢🔴🟢🟢",
        weather_badge={"badge_type": "CLEAR", "summary": "Clear Skies", "is_threat": False},
        conviction_rationale="Henry has scored in 7 of last 10 games.",
    )

    leg2 = PresetLeg(
        prop_id=uuid.uuid4(),
        event_id=uuid.uuid4(),
        player_name="CeeDee Lamb",
        team_abbreviation="DAL",
        matchup="DAL @ PHI",
        market_key="player_anytime_td",
        market_display="Anytime Touchdown",
        selection="OVER",
        line_value=Decimal("0.5"),
        offered_decimal_odds=Decimal("2.1000"),
        offered_american_odds=110,
        sharp_decimal_odds=Decimal("2.0000"),
        sharp_american_odds=100,
        fair_probability=Decimal("0.5100"),
        guarded_ev=Decimal("0.0710"),
        hit_rate_l5=Decimal("0.6000"),
        hit_rate_l10=Decimal("0.7000"),
        hit_rate_season=Decimal("0.6500"),
        hit_rate_display="7/10 (70.0%) L10",
        sofascore_form=[True, False, True, True, True],
        sofascore_dots="🟢🔴🟢🟢🟢",
        weather_badge=None,
        conviction_rationale="Lamb has scored in 7 of last 10 games.",
    )

    result = calculate_combined_parlay([leg1, leg2])

    # Combined decimal odds = 1.8000 * 2.1000 = 3.7800
    assert result.combined_decimal_odds == Decimal("3.7800")
    # American odds for 3.7800 = +278
    assert result.combined_american_odds == 278
    # Fair probability = 0.5800 * 0.5100 = 0.2958
    assert result.combined_fair_probability == Decimal("0.29580")
    # Expected Value = (0.2958 * 3.7800) - 1 = 1.118124 - 1 = +0.1181
    assert Decimal("0.1180") <= result.combined_ev <= Decimal("0.1182")


def test_preset_card_enforces_leg_bounds() -> None:
    """Card must have between 2 and 4 legs (inclusive)."""
    leg_sample = PresetLeg(
        prop_id=uuid.uuid4(),
        event_id=uuid.uuid4(),
        player_name="Luka Doncic",
        team_abbreviation="DAL",
        matchup="DAL @ LAL",
        market_key="player_points",
        market_display="Over 28.5 Points",
        selection="OVER",
        line_value=Decimal("28.5"),
        offered_decimal_odds=Decimal("1.9091"),
        offered_american_odds=-110,
        sharp_decimal_odds=Decimal("1.8500"),
        sharp_american_odds=-118,
        fair_probability=Decimal("0.5400"),
        guarded_ev=Decimal("0.0309"),
        hit_rate_l5=Decimal("0.8000"),
        hit_rate_l10=Decimal("0.8000"),
        hit_rate_season=Decimal("0.7500"),
        hit_rate_display="8/10 (80.0%) L10",
        sofascore_form=[True, True, True, True, False],
        sofascore_dots="🟢🟢🟢🟢🔴",
        weather_badge=None,
        conviction_rationale="Doncic has cleared 28.5 pts in 8 of last 10.",
    )

    # 1 leg -> Rejects
    with pytest.raises(PresetError, match="must have between 2 and 4 legs"):
        PresetCard.create(
            preset_id=uuid.uuid4(),
            title="Solo Bet",
            sport_key="nba",
            theme_badge="NBA · 1-Leg",
            legs=[leg_sample],
        )

    # 5 legs -> Rejects
    with pytest.raises(PresetError, match="must have between 2 and 4 legs"):
        PresetCard.create(
            preset_id=uuid.uuid4(),
            title="Overstuffed Parlay",
            sport_key="nba",
            theme_badge="NBA · 5-Leg",
            legs=[leg_sample] * 5,
        )

    # 3 legs -> Succeeds
    card_valid = PresetCard.create(
        preset_id=uuid.uuid4(),
        title="The Floor Generals",
        sport_key="nba",
        theme_badge="NBA · 3-Leg Playmakers",
        legs=[leg_sample, leg_sample, leg_sample],
    )
    assert len(card_valid.legs) == 3
    assert card_valid.status == "ACTIVE"


def test_outlier_guard_and_commenced_filters_in_generator() -> None:
    """Outlier circuit breaker (EV > 10%) and commenced games must be filtered out."""
    now_utc = datetime.now(UTC)

    # 1. Stale suspect line (EV = 14%)
    stale_prop = PlayerProp(
        prop_id=uuid.uuid4(),
        external_provider_id="papi_nfl_stale",
        event_id=uuid.uuid4(),
        player_name="Stale Player",
        market_key="player_anytime_td",
        selection="OVER",
        line_value=Decimal("0.5"),
        offered_decimal_odds=Decimal("2.5000"),
        sharp_decimal_odds=Decimal("2.0000"),
        fair_probability=Decimal("0.5700"),
        guarded_ev=Decimal("0.1400"),  # > 10%
        status="SUSPECT_STALE_LINE",
        hit_rate_l10=Decimal("0.8000"),
    )

    # 2. Commenced event
    commenced_event_id = uuid.uuid4()
    commenced_event = Event(
        event_id=commenced_event_id,
        external_provider_id="papi_event_past",
        sport_key="nfl",
        commence_time=now_utc - timedelta(minutes=15),
        status="LIVE",
        home_team_id=uuid.uuid4(),
        away_team_id=uuid.uuid4(),
    )
    commenced_prop = PlayerProp(
        prop_id=uuid.uuid4(),
        external_provider_id="papi_prop_commenced",
        event_id=commenced_event_id,
        player_name="Active Playing Player",
        market_key="player_anytime_td",
        selection="OVER",
        line_value=Decimal("0.5"),
        offered_decimal_odds=Decimal("1.9000"),
        fair_probability=Decimal("0.5500"),
        guarded_ev=Decimal("0.0450"),
        status="ACTIVE",
        hit_rate_l10=Decimal("0.7000"),
    )

    # 3. Clean active future props
    future_event1_id = uuid.uuid4()
    future_event1 = Event(
        event_id=future_event1_id,
        external_provider_id="papi_event_future1",
        sport_key="nfl",
        commence_time=now_utc + timedelta(hours=3),
        status="SCHEDULED",
        home_team_id=uuid.uuid4(),
        away_team_id=uuid.uuid4(),
    )
    clean_prop1 = PlayerProp(
        prop_id=uuid.uuid4(),
        external_provider_id="papi_clean_1",
        event_id=future_event1_id,
        player_name="Derrick Henry",
        market_key="player_anytime_td",
        selection="OVER",
        line_value=Decimal("0.5"),
        offered_decimal_odds=Decimal("1.8000"),
        sharp_decimal_odds=Decimal("1.7500"),
        fair_probability=Decimal("0.5800"),
        guarded_ev=Decimal("0.0440"),
        status="ACTIVE",
        hit_rate_l5=Decimal("0.8000"),
        hit_rate_l10=Decimal("0.7000"),
        hit_rate_season=Decimal("0.7000"),
    )

    future_event2_id = uuid.uuid4()
    future_event2 = Event(
        event_id=future_event2_id,
        external_provider_id="papi_event_future2",
        sport_key="nfl",
        commence_time=now_utc + timedelta(hours=4),
        status="SCHEDULED",
        home_team_id=uuid.uuid4(),
        away_team_id=uuid.uuid4(),
    )
    clean_prop2 = PlayerProp(
        prop_id=uuid.uuid4(),
        external_provider_id="papi_clean_2",
        event_id=future_event2_id,
        player_name="CeeDee Lamb",
        market_key="player_anytime_td",
        selection="OVER",
        line_value=Decimal("0.5"),
        offered_decimal_odds=Decimal("2.1000"),
        sharp_decimal_odds=Decimal("2.0000"),
        fair_probability=Decimal("0.5100"),
        guarded_ev=Decimal("0.0710"),
        status="ACTIVE",
        hit_rate_l5=Decimal("0.6000"),
        hit_rate_l10=Decimal("0.7000"),
        hit_rate_season=Decimal("0.6500"),
    )

    events_map = {
        commenced_event_id: commenced_event,
        future_event1_id: future_event1,
        future_event2_id: future_event2,
    }

    props = [stale_prop, commenced_prop, clean_prop1, clean_prop2]

    feed = generate_curated_presets(
        props=props,
        events_map=events_map,
        teams_map={},
        target_count=3,
        now_utc=now_utc,
    )

    # Stale prop and commenced prop must be excluded
    all_selected_prop_ids = {leg.prop_id for card in feed.cards for leg in card.legs}
    assert stale_prop.prop_id not in all_selected_prop_ids
    assert commenced_prop.prop_id not in all_selected_prop_ids
    assert clean_prop1.prop_id in all_selected_prop_ids
    assert clean_prop2.prop_id in all_selected_prop_ids


def test_generate_curated_presets_feed_structure() -> None:
    """Verify that generate_curated_presets returns 3 to 5 themed preset cards."""
    now_utc = datetime.now(UTC)
    events: list[Event] = []
    props: list[PlayerProp] = []

    # Create 8 clean props across 4 events (2 NFL, 2 NBA)
    for i in range(8):
        sport = "nfl" if i < 4 else "nba"
        event_id = uuid.uuid4()
        event = Event(
            event_id=event_id,
            external_provider_id=f"papi_event_{i}",
            sport_key=sport,
            commence_time=now_utc + timedelta(hours=i + 2),
            status="SCHEDULED",
            home_team_id=uuid.uuid4(),
            away_team_id=uuid.uuid4(),
        )
        events.append(event)

        prop = PlayerProp(
            prop_id=uuid.uuid4(),
            external_provider_id=f"papi_prop_{i}",
            event_id=event_id,
            player_name=f"Player {i}",
            market_key="player_anytime_td" if sport == "nfl" else "player_points",
            selection="OVER",
            line_value=Decimal("0.5") if sport == "nfl" else Decimal("22.5"),
            offered_decimal_odds=Decimal("1.8500"),
            sharp_decimal_odds=Decimal("1.8000"),
            fair_probability=Decimal("0.5700"),
            guarded_ev=Decimal("0.0545"),
            status="ACTIVE",
            hit_rate_l5=Decimal("0.8000"),
            hit_rate_l10=Decimal("0.8000"),
            hit_rate_season=Decimal("0.7500"),
        )
        props.append(prop)

    events_map = {e.event_id: e for e in events}

    feed = generate_curated_presets(
        props=props,
        events_map=events_map,
        teams_map={},
        target_count=3,
        now_utc=now_utc,
    )

    assert 3 <= len(feed.cards) <= 5
    for card in feed.cards:
        assert 2 <= len(card.legs) <= 4
        assert card.combined_decimal_odds >= Decimal("1.01")
        assert card.hybrid_value_score >= 0
        assert card.title != ""
        assert card.theme_badge != ""
        for leg in card.legs:
            assert leg.conviction_rationale != ""
            assert len(leg.sofascore_form) == 5
            assert leg.sofascore_dots != ""


def test_sync_preset_feed_to_redis() -> None:
    """Ensure sync_preset_feed_to_redis serializes and writes with TTL."""
    now_utc = datetime.now(UTC)
    leg = PresetLeg(
        prop_id=uuid.uuid4(),
        event_id=uuid.uuid4(),
        player_name="Derrick Henry",
        team_abbreviation="BAL",
        matchup="BAL @ PIT",
        market_key="player_anytime_td",
        market_display="Anytime Touchdown",
        selection="OVER",
        line_value=Decimal("0.5"),
        offered_decimal_odds=Decimal("1.8000"),
        offered_american_odds=-125,
        sharp_decimal_odds=Decimal("1.7500"),
        sharp_american_odds=-133,
        fair_probability=Decimal("0.5800"),
        guarded_ev=Decimal("0.0440"),
        hit_rate_l5=Decimal("0.8000"),
        hit_rate_l10=Decimal("0.7000"),
        hit_rate_season=Decimal("0.7000"),
        hit_rate_display="7/10 (70.0%) L10",
        sofascore_form=[True, True, False, True, True],
        sofascore_dots="🟢🟢🔴🟢🟢",
        weather_badge=None,
        conviction_rationale="Henry has scored in 7 of last 10 games.",
    )
    card = PresetCard.create(
        preset_id=uuid.uuid4(),
        title="The Red Zone Express",
        sport_key="nfl",
        theme_badge="NFL · 2-Leg Anytime TD",
        legs=[leg, leg],
    )
    feed = CuratedPresetFeed(
        generated_at=now_utc,
        cards=[card],
    )

    class MockRedis:
        def __init__(self) -> None:
            self.store: dict[str, str] = {}
            self.ttls: dict[str, int] = {}

        def set(self, key: str, value: str, ex: int | None = None) -> bool:
            self.store[key] = value
            if ex is not None:
                self.ttls[key] = ex
            return True

    mock_redis = MockRedis()
    sync_preset_feed_to_redis(feed=feed, redis_client=mock_redis, ttl_seconds=45)

    assert "presets:feed:all" in mock_redis.store
    assert mock_redis.ttls.get("presets:feed:all") == 45
    assert "The Red Zone Express" in mock_redis.store["presets:feed:all"]
