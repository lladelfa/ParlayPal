"""Unit and integration tests for Story 1.3: Rolling Consistency Hit-Rate Engine."""

from __future__ import annotations

from decimal import Decimal

import pytest
from sqlalchemy import create_engine, select

from parlaypal_worker.db import create_session_factory, init_db
from parlaypal_worker.hit_rate import (
    HitRateError,
    PlayerGameStat,
    compute_rolling_hit_rate,
    update_props_hit_rates,
)
from parlaypal_worker.models import Event, PlayerProp, Team


def test_standard_l10_and_l5_over_hit_rate() -> None:
    """Scenario 1: Derrick Henry Rush Yards (Line: 75.5, OVER); 10 games."""
    # Games ordered from most recent to oldest
    game_stats = [91, 85, 54, 102, 70, 88, 110, 60, 95, 82]
    # Hits: 91 (>75.5), 85 (>75.5), 102 (>75.5), 88 (>75.5), 110 (>75.5), 95 (>75.5), 82 (>75.5) -> 7 hits out of 10
    # First 5 (most recent): 91 (H), 85 (H), 54 (M), 102 (H), 70 (M) -> 3 hits out of 5
    result = compute_rolling_hit_rate(
        game_stats=game_stats,
        line_value=Decimal("75.5"),
        selection="OVER",
    )

    assert result.total_games == 10
    assert result.l5_hits == 3
    assert result.l5_total == 5
    assert result.l5_rate == Decimal("0.6000")
    assert result.l10_hits == 7
    assert result.l10_total == 10
    assert result.l10_rate == Decimal("0.7000")
    assert result.season_hits == 7
    assert result.season_total == 10
    assert result.season_rate == Decimal("0.7000")
    assert result.l10_formatted == "7/10 (70.0%)"
    assert result.l5_formatted == "3/5 (60.0%)"
    # Form dots for last 5 games ordered chronologically (oldest to newest): 70 (M), 102 (H), 54 (M), 85 (H), 91 (H) -> 🔴🟢🔴🟢🟢
    assert result.form_dots == "🔴🟢🔴🟢🟢"


def test_anytime_touchdown_hit_rate() -> None:
    """Scenario 2: CeeDee Lamb Anytime TD (Line: 0.5, OVER); 8 games played."""
    # Most recent to oldest: [0, 1, 1, 0, 1, 2, 0, 1]
    # L5 (most recent 5): [0, 1, 1, 0, 1] -> 3 hits out of 5
    # Total 8: 5 hits out of 8 -> 5 / 8 = 0.6250
    game_stats = [0, 1, 1, 0, 1, 2, 0, 1]
    result = compute_rolling_hit_rate(
        game_stats=game_stats,
        line_value=Decimal("0.5"),
        selection="OVER",
    )

    assert result.total_games == 8
    assert result.l5_hits == 3
    assert result.l5_rate == Decimal("0.6000")
    assert result.l10_hits == 5
    assert result.l10_total == 8
    assert result.l10_rate == Decimal("0.6250")
    assert result.season_hits == 5
    assert result.season_total == 8
    assert result.season_rate == Decimal("0.6250")
    assert result.l10_formatted == "5/8 (62.5%)"


def test_under_prop_with_push_handling() -> None:
    """Scenario 3: Under 25.0 Points with push; games: [24, 20, 25, 28, 22]."""
    # Most recent to oldest: [24, 20, 25, 28, 22]
    # Selection: UNDER
    # 24 < 25 (Hit)
    # 20 < 25 (Hit)
    # 25 == 25 (Push - not a hit)
    # 28 > 25 (Miss)
    # 22 < 25 (Hit)
    # Hits: 3 / 5 = 0.6000
    game_stats = [24, 20, 25, 28, 22]
    result = compute_rolling_hit_rate(
        game_stats=game_stats,
        line_value=Decimal("25.0"),
        selection="UNDER",
    )

    assert result.total_games == 5
    assert result.l5_hits == 3
    assert result.l5_total == 5
    assert result.l5_rate == Decimal("0.6000")
    assert result.l5_formatted == "3/5 (60.0%)"


def test_sample_smaller_than_rolling_windows() -> None:
    """Scenario 4: Rookie with 3 games [18, 22, 15] on line 16.5 OVER."""
    # Most recent to oldest: 18 (H), 22 (H), 15 (M) -> 2 hits out of 3
    game_stats = [18, 22, 15]
    result = compute_rolling_hit_rate(
        game_stats=game_stats,
        line_value=Decimal("16.5"),
        selection="OVER",
    )

    assert result.total_games == 3
    assert result.l5_hits == 2
    assert result.l5_total == 3
    assert result.l5_rate == Decimal("0.6667")
    assert result.l10_hits == 2
    assert result.l10_total == 3
    assert result.l10_rate == Decimal("0.6667")
    assert result.season_hits == 2
    assert result.season_total == 3
    assert result.season_rate == Decimal("0.6667")
    assert result.l10_formatted == "2/3 (66.7%)"


def test_empty_or_invalid_game_log_handling() -> None:
    """Scenario 8: Empty game log returns safe empty result, invalid stats raise HitRateError."""
    empty_res = compute_rolling_hit_rate(
        game_stats=[],
        line_value=Decimal("20.5"),
        selection="OVER",
    )
    assert empty_res.total_games == 0
    assert empty_res.l5_rate is None
    assert empty_res.l10_rate is None
    assert empty_res.season_rate is None
    assert empty_res.form_dots == ""

    with pytest.raises(HitRateError):
        compute_rolling_hit_rate(
            game_stats=[10, "invalid", 15],  # type: ignore[list-item]
            line_value=Decimal("12.5"),
            selection="OVER",
        )

    with pytest.raises(HitRateError):
        compute_rolling_hit_rate(
            game_stats=[10, 15],
            line_value=Decimal("12.5"),
            selection="INVALID_SELECTION",  # type: ignore[arg-type]
        )


def test_update_props_hit_rates_persists_to_postgresql() -> None:
    """Verify update_props_hit_rates batch helper updates PlayerProp rows in PostgreSQL."""
    engine = create_engine("sqlite:///:memory:")
    init_db(engine=engine)
    session_factory = create_session_factory(engine)
    sport_key = "americanfootball_nfl"

    with session_factory() as session:
        team = Team(
            external_provider_id="papi_nfl_dal",
            sport_key=sport_key,
            name="Dallas Cowboys",
            abbreviation="DAL",
        )
        session.add(team)
        session.flush()

        from datetime import UTC, datetime

        event = Event(
            external_provider_id="papi_nfl_20261120_dal",
            sport_key=sport_key,
            home_team_id=team.team_id,
            away_team_id=team.team_id,
            commence_time=datetime(2026, 11, 20, 20, 0, tzinfo=UTC),
            status="SCHEDULED",
        )
        # Bypassing distinct team check for test fixture by creating second team
        team_away = Team(
            external_provider_id="papi_nfl_phi",
            sport_key=sport_key,
            name="Philadelphia Eagles",
            abbreviation="PHI",
        )
        session.add(team_away)
        session.flush()
        event.away_team_id = team_away.team_id
        session.add(event)
        session.flush()

        prop = PlayerProp(
            external_provider_id="papi_prop_ceedee_rec_yds",
            event_id=event.event_id,
            player_name="CeeDee Lamb",
            market_key="player_reception_yds",
            selection="OVER",
            line_value=Decimal("78.50"),
            offered_decimal_odds=Decimal("1.9091"),
            sharp_decimal_odds=Decimal("1.9091"),
        )
        session.add(prop)
        session.commit()
        prop_id = prop.prop_id

    # Game logs for CeeDee Lamb: 8 games with [85, 92, 60, 110, 79, 70, 105, 54]
    player_logs = {
        "CeeDee Lamb": [85, 92, 60, 110, 79, 70, 105, 54],
    }

    with session_factory() as session:
        updated_count = update_props_hit_rates(session=session, player_game_logs=player_logs)
        assert updated_count == 1

        updated_prop = session.scalar(select(PlayerProp).where(PlayerProp.prop_id == prop_id))
        assert updated_prop is not None
        assert updated_prop.hit_rate_l5 == Decimal("0.8000")
        assert updated_prop.hit_rate_l10 == Decimal("0.6250")
        assert updated_prop.hit_rate_season == Decimal("0.6250")


def test_negative_stat_values_allowed_and_player_game_stat_support() -> None:
    """Verify negative stats (e.g. net rushing yards with tackles for loss) and PlayerGameStat objects."""
    # Games: [-5, 12, 0, -2, 25] on line 5.5 OVER
    # Hits: 12, 25 (2 hits)
    # Misses: -5, 0, -2 (3 misses)
    # L5 hits: 2 / 5 = 0.4000
    stats: list[PlayerGameStat | Decimal | float | int | str] = [
        PlayerGameStat(stat_value=Decimal("-5")),
        Decimal("12"),
        0,
        -2,
        "25",
    ]
    result = compute_rolling_hit_rate(
        game_stats=stats,
        line_value=Decimal("5.5"),
        selection="OVER",
    )
    assert result.total_games == 5
    assert result.l5_hits == 2
    assert result.l5_rate == Decimal("0.4000")


def test_update_props_hit_rates_market_disambiguation_and_celery_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify (player_name, market_key) compound key mapping and sync_player_hit_rates task."""
    engine = create_engine("sqlite:///:memory:")
    init_db(engine=engine)
    session_factory = create_session_factory(engine)
    sport_key = "americanfootball_nfl"

    with session_factory() as session:
        t1 = Team(
            external_provider_id="papi_nfl_kc_hr",
            sport_key=sport_key,
            name="Chiefs",
            abbreviation="KC",
        )
        t2 = Team(
            external_provider_id="papi_nfl_lv_hr",
            sport_key=sport_key,
            name="Raiders",
            abbreviation="LV",
        )
        session.add_all([t1, t2])
        session.flush()

        from datetime import UTC, datetime

        event = Event(
            external_provider_id="papi_nfl_20261125_kc_lv",
            sport_key=sport_key,
            home_team_id=t1.team_id,
            away_team_id=t2.team_id,
            commence_time=datetime(2026, 11, 25, 20, 0, tzinfo=UTC),
            status="SCHEDULED",
        )
        session.add(event)
        session.flush()

        # Same player, two different markets
        prop_pass = PlayerProp(
            external_provider_id="papi_prop_mahomes_pass",
            event_id=event.event_id,
            player_name="Patrick Mahomes",
            market_key="player_pass_yds",
            selection="OVER",
            line_value=Decimal("260.50"),
            offered_decimal_odds=Decimal("1.9091"),
            sharp_decimal_odds=Decimal("1.9091"),
        )
        prop_td = PlayerProp(
            external_provider_id="papi_prop_mahomes_td",
            event_id=event.event_id,
            player_name="Patrick Mahomes",
            market_key="player_pass_tds",
            selection="OVER",
            line_value=Decimal("1.50"),
            offered_decimal_odds=Decimal("1.9091"),
            sharp_decimal_odds=Decimal("1.9091"),
        )
        session.add_all([prop_pass, prop_td])
        session.commit()
        pass_id = prop_pass.prop_id
        td_id = prop_td.prop_id

    # Disambiguated logs mapping
    logs = {
        ("Patrick Mahomes", "player_pass_yds"): [280, 290, 240, 310, 275],  # 4/5 over 260.5
        ("Patrick Mahomes", "player_pass_tds"): [2, 1, 3, 2, 1],  # 3/5 over 1.5
    }

    from parlaypal_worker import celery_app as celery_app_module
    from parlaypal_worker.celery_app import sync_player_hit_rates

    monkeypatch.setattr(celery_app_module, "create_session_factory", lambda: session_factory)

    task_res = sync_player_hit_rates(logs)
    assert task_res["status"] == "ok"
    assert task_res["updated_props"] == 2

    with session_factory() as session:
        pass_prop = session.scalar(select(PlayerProp).where(PlayerProp.prop_id == pass_id))
        td_prop = session.scalar(select(PlayerProp).where(PlayerProp.prop_id == td_id))
        assert pass_prop is not None and pass_prop.hit_rate_l5 == Decimal("0.8000")
        assert td_prop is not None and td_prop.hit_rate_l5 == Decimal("0.6000")
