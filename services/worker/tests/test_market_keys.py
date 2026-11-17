"""Tests for Story 7.3: canonical prop market keys."""

from __future__ import annotations

import logging

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from parlaypal_worker import market_keys
from parlaypal_worker.ingestion import _extract_direct_props, _extract_props_from_bookmakers
from parlaypal_worker.market_keys import (
    MARKET_KEY_ALIASES,
    canonicalize_market_key,
    rewrite_stored_market_keys,
)
from parlaypal_worker.models import PlayerProp
from tests.test_ingestion import db_session

__all__ = ["db_session"]


@pytest.fixture(autouse=True)
def _reset_logged() -> None:
    market_keys._LOGGED_UNKNOWN.clear()


@pytest.mark.parametrize(
    ("raw", "canonical"),
    [
        ("player_threes_made", "player_threes"),
        ("player_threes", "player_threes"),
        ("player_rushing_yards", "player_rush_yds"),
        ("player_rush_yards", "player_rush_yds"),
        ("player_rushing_yds", "player_rush_yds"),
        ("player_rush_yds", "player_rush_yds"),
        ("player_passing_yards", "player_pass_yds"),
        ("player_passing_yds", "player_pass_yds"),
        ("player_pass_yards", "player_pass_yds"),
        ("player_pass_yds", "player_pass_yds"),
        ("player_anytime_td", "player_anytime_td"),
        ("  Player_Threes_Made ", "player_threes"),
    ],
)
def test_aliases_map_to_one_canonical_key(raw: str, canonical: str) -> None:
    assert canonicalize_market_key(raw) == canonical


def test_alias_table_targets_are_never_aliases_themselves() -> None:
    assert not set(MARKET_KEY_ALIASES.values()) & set(MARKET_KEY_ALIASES)


def test_unknown_key_is_kept_as_received_and_logged_once(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING, logger="parlaypal_worker.market_keys"):
        assert canonicalize_market_key("player_weird_stat") == "player_weird_stat"
        assert canonicalize_market_key("player_weird_stat") == "player_weird_stat"
    assert sum("player_weird_stat" in r.getMessage() for r in caplog.records) == 1


def test_known_key_is_not_logged(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="parlaypal_worker.market_keys"):
        canonicalize_market_key("player_points")
        canonicalize_market_key("player_threes_made")
    assert not caplog.records


def test_direct_props_path_canonicalizes_and_keeps_unknown() -> None:
    def prop(pid: str, key: str) -> dict[str, object]:
        return {
            "id": pid,
            "player_name": "Some Player",
            "market_key": key,
            "selection": "OVER",
            "line": 2.5,
            "offered_decimal_odds": 2.0,
            "sharp_decimal_odds": 1.9,
            "opposite_sharp_decimal_odds": 1.9,
        }

    props, malformed = _extract_direct_props(
        {"props": [prop("a", "player_threes_made"), prop("b", "player_odd_market")]},
        event_external_id="papi_nba_evt_x",
        sport_key="basketball_nba",
    )
    assert malformed == 0
    assert [p.market_key for p in props] == ["player_threes", "player_odd_market"]


def test_bookmakers_path_canonicalizes_before_sport_filter() -> None:
    def outcome(side: str) -> dict[str, object]:
        return {
            "name": side,
            "description": "Josh Allen",
            "price": 1.9,
            "point": 250.5,
        }

    raw_event = {
        "bookmakers": [
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "player_passing_yards",
                        "outcomes": [outcome("Over"), outcome("Under")],
                    }
                ],
            }
        ]
    }
    props, _ = _extract_props_from_bookmakers(
        raw_event, event_external_id="papi_nfl_evt_x", sport_key="americanfootball_nfl"
    )
    assert props
    assert {p.market_key for p in props} == {"player_pass_yds"}


def test_rewrite_stored_market_keys_rewrites_variants_only(
    db_session: tuple[Session, object, object],
) -> None:
    session = db_session[0]
    from datetime import UTC, datetime  # noqa: PLC0415

    from parlaypal_worker.ingestion import upsert_slate_to_db  # noqa: PLC0415
    from tests.test_ingestion import _outcomes_slate  # noqa: PLC0415

    now = datetime(2026, 11, 12, 15, 0, tzinfo=UTC)
    upsert_slate_to_db(
        session, _outcomes_slate(now, [1, 2, 3, 4, 5, 6]), now_utc=now, redis_client=None
    )
    session.commit()
    props = list(session.scalars(select(PlayerProp)).all())
    assert props
    props[0].market_key = "player_threes_made"
    session.commit()

    counts = rewrite_stored_market_keys(session)
    session.commit()

    assert counts == {"player_threes_made": 1}
    assert "player_threes_made" not in {p.market_key for p in session.scalars(select(PlayerProp))}
