"""Unit and integration tests for Story 4.2: Asynchronous Closing Line Value (CLV) Worker."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

import parlaypal_worker.celery_app as celery_app_module
import parlaypal_worker.clv as clv_module
from parlaypal_worker.bets import (
    BetNotFoundError,
    InvalidBetError,
    create_user_bet,
    get_user_bet,
    stamp_bet_clv,
)
from parlaypal_worker.celery_app import celery_app, stamp_closing_line_value
from parlaypal_worker.clv import (
    ClosingOddsClientError,
    ClosingOddsProviderError,
    calculate_clv,
    compute_bet_closing,
    fetch_closing_odds,
    parse_closing_leg_prices,
    stamp_due_bets,
)
from parlaypal_worker.db import create_session_factory, init_db
from parlaypal_worker.devig import DeviggingError
from parlaypal_worker.models import Event, PlayerProp, Team, UserBet


@pytest.fixture
def db_session():
    """Create in-memory SQLite database with seeded teams and session factory."""
    engine = create_engine("sqlite:///:memory:")
    init_db(engine=engine)
    session_factory = create_session_factory(engine)
    session = session_factory()
    try:
        home_team = Team(
            external_provider_id="papi_nfl_kc",
            sport_key="americanfootball_nfl",
            name="Kansas City Chiefs",
            abbreviation="KC",
        )
        away_team = Team(
            external_provider_id="papi_nfl_bal",
            sport_key="americanfootball_nfl",
            name="Baltimore Ravens",
            abbreviation="BAL",
        )
        alt_home = Team(
            external_provider_id="papi_nba_lal",
            sport_key="basketball_nba",
            name="Los Angeles Lakers",
            abbreviation="LAL",
        )
        alt_away = Team(
            external_provider_id="papi_nba_bos",
            sport_key="basketball_nba",
            name="Boston Celtics",
            abbreviation="BOS",
        )
        session.add_all([home_team, away_team, alt_home, alt_away])
        session.commit()
        yield (
            session,
            {
                "nfl_home": home_team,
                "nfl_away": away_team,
                "nba_home": alt_home,
                "nba_away": alt_away,
                "session_factory": session_factory,
            },
        )
    finally:
        session.close()
        engine.dispose()


def _create_event(
    session: Session,
    teams: dict[str, Any],
    *,
    external_provider_id: str = "papi_nfl_evt_1",
    sport_key: str = "americanfootball_nfl",
    commence_time: datetime | None = None,
    status: str = "COMMENCED",
) -> Event:
    is_nba = "nba" in sport_key
    home = teams["nba_home"] if is_nba else teams["nfl_home"]
    away = teams["nba_away"] if is_nba else teams["nfl_away"]
    event = Event(
        external_provider_id=external_provider_id,
        sport_key=sport_key,
        home_team_id=home.team_id,
        away_team_id=away.team_id,
        commence_time=commence_time or datetime(2026, 11, 10, 18, 0, tzinfo=UTC),
        status=status,
    )
    session.add(event)
    session.commit()
    return event


def _sample_leg(
    *,
    player_name: str = "Patrick Mahomes",
    market_key: str | None = "player_pass_yds",
    selection: str = "OVER",
    line: Decimal | float | None = 274.5,
    offered_decimal_odds: str = "2.10",
) -> dict[str, Any]:
    leg: dict[str, Any] = {
        "propId": str(uuid.uuid4()),
        "playerName": player_name,
        "marketDisplay": "Pass Yds",
        "selection": selection,
        "offeredDecimalOdds": offered_decimal_odds,
    }
    if market_key is not None:
        leg["marketKey"] = market_key
    if line is not None:
        leg["line"] = line
    return leg


def _closing_payload(
    *,
    event_id: str | None = "papi_nfl_evt_1",
    bookmakers: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    if event_id is not None:
        payload["event_id"] = event_id
    payload["bookmakers"] = (
        bookmakers
        if bookmakers is not None
        else [
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Patrick Mahomes",
                                "price": 1.95,
                                "point": 274.5,
                            },
                            {
                                "name": "Under",
                                "description": "Patrick Mahomes",
                                "price": 1.95,
                                "point": 274.5,
                            },
                        ],
                    }
                ],
            }
        ]
    )
    return payload


# ---------------------------------------------------------------------------
# 1. Pure CLV math & suspect threshold boundaries
# ---------------------------------------------------------------------------


def test_calculate_clv_worked_example_and_percent_units() -> None:
    """Worked example: D_exec=2.10, P_fair_close=0.5 -> +5.000% (percent points, 3 dp)."""
    clv = calculate_clv(Decimal("0.50000"), Decimal("2.1000"))
    assert clv == Decimal("5.000")
    assert isinstance(clv, Decimal)


def test_calculate_clv_negative_and_large_negative_values() -> None:
    """Negative CLV including values below -10% are computed accurately in percent points."""
    assert calculate_clv(Decimal("0.50000"), Decimal("1.9000")) == Decimal("-5.000")
    assert calculate_clv(Decimal("0.40000"), Decimal("1.5000")) == Decimal("-40.000")


def test_calculate_clv_rejects_invalid_inputs() -> None:
    """Invalid probabilities or execution odds raise DeviggingError."""
    for bad_prob in (Decimal("0"), Decimal("1"), Decimal("-0.1"), Decimal("1.1"), "NaN", True):
        with pytest.raises(DeviggingError):
            calculate_clv(bad_prob, Decimal("2.00"))  # type: ignore[arg-type]

    for bad_odds in (Decimal("1.00"), Decimal("10000.0000"), "NaN", False):
        with pytest.raises(DeviggingError):
            calculate_clv(Decimal("0.50"), bad_odds)  # type: ignore[arg-type]


def test_compute_bet_closing_boundary_ten_percent_and_suspect_guard() -> None:
    """Exact +10.000% is valid; > +10.000% triggers suspect guard; large negative is allowed."""
    # Exact +10.000%: P_fair=0.50000 (1.95/1.95), D_exec=2.2000
    at_boundary = compute_bet_closing(
        Decimal("2.2000"),
        [(Decimal("1.95"), Decimal("1.95"))],
    )
    assert at_boundary.closing_fair_prob == Decimal("0.50000")
    assert at_boundary.closing_decimal_odds == Decimal("1.9500")
    assert at_boundary.clv_percentage == Decimal("10.000")
    assert at_boundary.is_suspect_stale_line is False

    # Slightly above +10%: D_exec=2.2010 -> (0.5 * 2.201 - 1) * 100 = 10.050%
    above_boundary = compute_bet_closing(
        Decimal("2.2010"),
        [(Decimal("1.95"), Decimal("1.95"))],
    )
    assert above_boundary.clv_percentage == Decimal("10.050")
    assert above_boundary.is_suspect_stale_line is True

    # Large negative CLV (-25.000%) is NOT suspect
    large_negative = compute_bet_closing(
        Decimal("1.5000"),
        [(Decimal("1.95"), Decimal("1.95"))],
    )
    assert large_negative.clv_percentage == Decimal("-25.000")
    assert large_negative.is_suspect_stale_line is False


def test_compute_bet_closing_multi_leg_parlay_product() -> None:
    """Multi-leg tickets multiply per-leg devig_power probs and compare against combined D_exec."""
    # Leg 1: 1.95/1.95 -> P=0.50000; Leg 2: 1.95/1.95 -> P=0.50000 => P_joint=0.25000
    # D_exec = 4.2000 => CLV% = (0.25 * 4.20 - 1) * 100 = +5.000%
    result = compute_bet_closing(
        Decimal("4.2000"),
        [
            (Decimal("1.95"), Decimal("1.95")),
            (Decimal("1.95"), Decimal("1.95")),
        ],
    )
    assert result.closing_fair_prob == Decimal("0.25000")
    assert result.closing_decimal_odds == Decimal("3.8025")
    assert result.clv_percentage == Decimal("5.000")
    assert result.is_suspect_stale_line is False


# ---------------------------------------------------------------------------
# 2. Persistence helper: stamp_bet_clv
# ---------------------------------------------------------------------------


def test_stamp_bet_clv_persists_without_changing_status_and_is_idempotent(db_session) -> None:
    session, teams = db_session
    event = _create_event(session, teams)
    bet = create_user_bet(
        session,
        sportsbook="DraftKings",
        decimal_odds=Decimal("2.1000"),
        event_id=event.event_id,
        stake_amount=Decimal("25.00"),
        status="pending",
    )

    stamped = stamp_bet_clv(
        session,
        bet.bet_id,
        closing_decimal_odds=Decimal("1.9500"),
        closing_fair_prob=Decimal("0.50000"),
        clv_percentage=Decimal("5.000"),
    )
    assert stamped.status == "pending"
    assert stamped.settled_at is None
    assert stamped.closing_decimal_odds == Decimal("1.9500")
    assert stamped.closing_fair_prob == Decimal("0.50000")
    assert stamped.clv_percentage == Decimal("5.000")

    # Second call with different values must remain idempotent (no overwrite)
    second = stamp_bet_clv(
        session,
        bet.bet_id,
        closing_decimal_odds=Decimal("1.8000"),
        closing_fair_prob=Decimal("0.55000"),
        clv_percentage=Decimal("1.000"),
    )
    assert second.closing_decimal_odds == Decimal("1.9500")
    assert second.closing_fair_prob == Decimal("0.50000")
    assert second.clv_percentage == Decimal("5.000")


def test_stamp_bet_clv_validation_branches_and_rollback(db_session, monkeypatch) -> None:
    session, teams = db_session
    event = _create_event(session, teams)

    with pytest.raises(BetNotFoundError):
        stamp_bet_clv(
            session,
            uuid.uuid4(),
            closing_decimal_odds=Decimal("1.95"),
            closing_fair_prob=Decimal("0.50"),
            clv_percentage=Decimal("5.000"),
        )

    staged = create_user_bet(
        session,
        sportsbook="FanDuel",
        decimal_odds=Decimal("2.00"),
        event_id=event.event_id,
        status="STAGED",
    )
    with pytest.raises(InvalidBetError, match="non-pending"):
        stamp_bet_clv(
            session,
            staged.bet_id,
            closing_decimal_odds=Decimal("1.95"),
            closing_fair_prob=Decimal("0.50"),
            clv_percentage=Decimal("0.000"),
        )

    pending = create_user_bet(
        session,
        sportsbook="FanDuel",
        decimal_odds=Decimal("2.00"),
        event_id=event.event_id,
        stake_amount=Decimal("20.00"),
        status="PENDING",
    )

    # Bounds and quantize-after-bounds checks
    invalid_cases = [
        (Decimal("1.00"), Decimal("0.50"), Decimal("0.0")),
        (Decimal("10000.00"), Decimal("0.50"), Decimal("0.0")),
        (Decimal("1.95"), Decimal("0"), Decimal("0.0")),
        (Decimal("1.95"), Decimal("1"), Decimal("0.0")),
        (Decimal("1.95"), Decimal("0.999996"), Decimal("0.0")),  # rounds to 1.00000
        (Decimal("1.95"), Decimal("0.000001"), Decimal("0.0")),  # rounds to 0.00000
        (Decimal("1.95"), Decimal("0.50"), Decimal("10.001")),
        (Decimal("1.95"), Decimal("0.50"), Decimal("10.0004")),  # raw > 10.000
        (Decimal("1.95"), Decimal("0.50"), Decimal("-1000.000")),
        (Decimal("1.95"), Decimal("0.50"), Decimal("-999.9996")),  # rounds to -1000.000
    ]
    for close_odds, fair_prob, clv_pct in invalid_cases:
        with pytest.raises(InvalidBetError):
            stamp_bet_clv(
                session,
                pending.bet_id,
                closing_decimal_odds=close_odds,
                closing_fair_prob=fair_prob,
                clv_percentage=clv_pct,
            )

    # Commit failure rolls back cleanly
    rollback_spy = MagicMock(wraps=session.rollback)
    monkeypatch.setattr(session, "rollback", rollback_spy)
    monkeypatch.setattr(session, "commit", MagicMock(side_effect=RuntimeError("db write failure")))
    with pytest.raises(RuntimeError, match="db write failure"):
        stamp_bet_clv(
            session,
            pending.bet_id,
            closing_decimal_odds=Decimal("1.95"),
            closing_fair_prob=Decimal("0.50"),
            clv_percentage=Decimal("0.000"),
        )
    assert rollback_spy.called


# ---------------------------------------------------------------------------
# 3. Payload parsing: Pinnacle-first, line/marketKey matching, malformed odds
# ---------------------------------------------------------------------------


def test_parse_closing_leg_prices_pinnacle_first_and_multi_player_disambiguation() -> None:
    payload = _closing_payload(
        bookmakers=[
            {
                "key": "draftkings",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Patrick Mahomes",
                                "price": 1.85,
                                "point": 274.5,
                            },
                            {
                                "name": "Under",
                                "description": "Patrick Mahomes",
                                "price": 2.05,
                                "point": 274.5,
                            },
                        ],
                    }
                ],
            },
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Josh Allen",
                                "price": 1.90,
                                "point": 274.5,
                            },
                            {
                                "name": "Under",
                                "description": "Josh Allen",
                                "price": 2.00,
                                "point": 274.5,
                            },
                            {
                                "name": "Over",
                                "description": "Patrick Mahomes",
                                "price": 1.91,
                                "point": 274.5,
                            },
                            {
                                "name": "Under",
                                "description": "Patrick Mahomes",
                                "price": 1.99,
                                "point": 274.5,
                            },
                            {
                                "name": "Over",
                                "description": "Patrick Mahomes",
                                "price": 2.30,
                                "point": 284.5,
                            },
                            {
                                "name": "Under",
                                "description": "Patrick Mahomes",
                                "price": 1.65,
                                "point": 284.5,
                            },
                        ],
                    }
                ],
            },
        ]
    )

    pairs = parse_closing_leg_prices(payload, [_sample_leg(selection="UNDER", line=274.5)])
    assert pairs == [(Decimal("1.99"), Decimal("1.91"))]


def test_parse_closing_leg_prices_minimal_schema_without_market_key_or_line() -> None:
    """Supports minimal {bookmakers:[{key, markets:[{outcomes:[{name, price}]}]}]} when leg also omits line/marketKey."""
    payload = _closing_payload(
        bookmakers=[
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "outcomes": [
                            {"name": "Over", "price": 1.95},
                            {"name": "Under", "price": 1.95},
                        ]
                    }
                ],
            }
        ]
    )
    leg = _sample_leg(market_key=None, line=None)
    assert parse_closing_leg_prices(payload, [leg]) == [(Decimal("1.95"), Decimal("1.95"))]


def test_parse_closing_leg_prices_rejects_line_and_market_key_mismatches() -> None:
    # 1. Leg has line, outcome missing point
    payload_missing_point = _closing_payload(
        bookmakers=[
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {"name": "Over", "description": "Patrick Mahomes", "price": 1.95},
                            {"name": "Under", "description": "Patrick Mahomes", "price": 1.95},
                        ],
                    }
                ],
            }
        ]
    )
    with pytest.raises(DeviggingError):
        parse_closing_leg_prices(payload_missing_point, [_sample_leg(line=274.5)])

    # 2. Leg lacks line, outcome has point
    payload_with_point = _closing_payload()
    with pytest.raises(DeviggingError):
        parse_closing_leg_prices(payload_with_point, [_sample_leg(line=None)])

    # 3. Leg has line != outcome point
    with pytest.raises(DeviggingError):
        parse_closing_leg_prices(payload_with_point, [_sample_leg(line=269.5)])

    # 4. Leg has marketKey, market key differs
    with pytest.raises(DeviggingError):
        parse_closing_leg_prices(payload_with_point, [_sample_leg(market_key="player_rush_yds")])

    # 5. Leg has marketKey, payload market omits key
    payload_missing_market_key = _closing_payload(
        bookmakers=[
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Patrick Mahomes",
                                "price": 1.95,
                                "point": 274.5,
                            },
                            {
                                "name": "Under",
                                "description": "Patrick Mahomes",
                                "price": 1.95,
                                "point": 274.5,
                            },
                        ]
                    }
                ],
            }
        ]
    )
    with pytest.raises(DeviggingError):
        parse_closing_leg_prices(
            payload_missing_market_key, [_sample_leg(market_key="player_pass_yds")]
        )


def test_parse_closing_leg_prices_rejects_malformed_odds_and_missing_side() -> None:
    # Missing opposite side
    missing_side = _closing_payload(
        bookmakers=[
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Patrick Mahomes",
                                "price": 1.95,
                                "point": 274.5,
                            }
                        ],
                    }
                ],
            }
        ]
    )
    with pytest.raises(DeviggingError):
        parse_closing_leg_prices(missing_side, [_sample_leg()])

    # Odds < 1.01 or NaN
    for bad_price in (1.00, 0.95, "NaN", None):
        bad_payload = _closing_payload(
            bookmakers=[
                {
                    "key": "pinnacle",
                    "markets": [
                        {
                            "key": "player_pass_yds",
                            "outcomes": [
                                {
                                    "name": "Over",
                                    "description": "Patrick Mahomes",
                                    "price": bad_price,
                                    "point": 274.5,
                                },
                                {
                                    "name": "Under",
                                    "description": "Patrick Mahomes",
                                    "price": 1.95,
                                    "point": 274.5,
                                },
                            ],
                        }
                    ],
                }
            ]
        )
        with pytest.raises(DeviggingError):
            parse_closing_leg_prices(bad_payload, [_sample_leg()])


# ---------------------------------------------------------------------------
# 4. Provider HTTP client: fetch_closing_odds
# ---------------------------------------------------------------------------


def test_fetch_closing_odds_success_keeps_papi_prefix_and_verifies_event_id() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("Authorization")
        return httpx.Response(200, json=_closing_payload(event_id="papi_nfl_evt_1"))

    client = httpx.Client(transport=httpx.MockTransport(handler))
    data = fetch_closing_odds(
        "americanfootball_nfl",
        "papi_nfl_evt_1",
        api_key="test-key",
        base_url="https://api.parlay-api.com/v1",
        http_client=client,
    )
    assert captured["url"] == (
        "https://api.parlay-api.com/v1/historical/sports/americanfootball_nfl/closing-odds?event_id=papi_nfl_evt_1"
    )
    assert captured["auth"] == "Bearer test-key"
    assert data["event_id"] == "papi_nfl_evt_1"


def test_fetch_closing_odds_rejects_mismatched_payload_event_id() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_closing_payload(event_id="papi_other_event"))

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(DeviggingError, match="event_id"):
        fetch_closing_odds(
            "americanfootball_nfl",
            "papi_nfl_evt_1",
            api_key="test-key",
            http_client=client,
        )


def test_fetch_closing_odds_retryable_vs_non_retryable_failures() -> None:
    # Missing API key fails fast with ClosingOddsClientError (NOT ClosingOddsProviderError)
    with pytest.raises(ClosingOddsClientError):
        fetch_closing_odds("americanfootball_nfl", "papi_nfl_evt_1", api_key="")

    # Auth / unexpected non-retryable 4xx fail fast with ClosingOddsClientError
    for status in (401, 403):
        client = httpx.Client(
            transport=httpx.MockTransport(lambda _req, s=status: httpx.Response(s))
        )
        with pytest.raises(ClosingOddsClientError):
            fetch_closing_odds(
                "americanfootball_nfl",
                "papi_nfl_evt_1",
                api_key="test-key",
                http_client=client,
            )

    # Event-level client errors (400, 404, 422) raise DeviggingError so individual events skip
    for status in (400, 404, 422):
        client = httpx.Client(
            transport=httpx.MockTransport(lambda _req, s=status: httpx.Response(s))
        )
        with pytest.raises(DeviggingError) as exc_info:
            fetch_closing_odds(
                "americanfootball_nfl",
                "papi_nfl_evt_1",
                api_key="test-key",
                http_client=client,
            )
        assert exc_info.value.code == "INVALID_MARKET_ODDS"

    # 429 and 5xx raise ClosingOddsProviderError
    for status in (429, 500, 502, 503):
        client = httpx.Client(
            transport=httpx.MockTransport(lambda _req, s=status: httpx.Response(s))
        )
        with pytest.raises(ClosingOddsProviderError):
            fetch_closing_odds(
                "americanfootball_nfl",
                "papi_nfl_evt_1",
                api_key="test-key",
                http_client=client,
            )

    # Timeout raises ClosingOddsProviderError
    def raise_timeout(_req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out")

    timeout_client = httpx.Client(transport=httpx.MockTransport(raise_timeout))
    with pytest.raises(ClosingOddsProviderError):
        fetch_closing_odds(
            "americanfootball_nfl",
            "papi_nfl_evt_1",
            api_key="test-key",
            http_client=timeout_client,
        )


# ---------------------------------------------------------------------------
# 5. Sweep orchestration: stamp_due_bets (full I/O & Edge-Case Matrix)
# ---------------------------------------------------------------------------


def test_stamp_due_bets_happy_path_and_idempotency(db_session) -> None:
    session, teams = db_session
    commence = datetime(2026, 11, 10, 18, 0, tzinfo=UTC)
    event = _create_event(
        session, teams, external_provider_id="papi_nfl_evt_1", commence_time=commence
    )
    bet = create_user_bet(
        session,
        sportsbook="DraftKings",
        decimal_odds=Decimal("2.1000"),
        event_id=event.event_id,
        stake_amount=Decimal("50.00"),
        status="PENDING",
        legs_json=[_sample_leg(offered_decimal_odds="2.10")],
    )

    calls = 0

    def handler(_req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=_closing_payload(event_id="papi_nfl_evt_1"))

    client = httpx.Client(transport=httpx.MockTransport(handler))
    now = commence + timedelta(minutes=15)

    summary_1 = stamp_due_bets(session, now, api_key="test-key", http_client=client)
    assert summary_1.stamped_bets == 1
    assert calls == 1

    refreshed = get_user_bet(session, bet.bet_id)
    assert refreshed is not None
    assert refreshed.status == "PENDING"
    assert refreshed.closing_decimal_odds == Decimal("1.9500")
    assert refreshed.closing_fair_prob == Decimal("0.50000")
    assert refreshed.clv_percentage == Decimal("5.000")

    # Second run makes zero provider calls for already-stamped bet
    summary_2 = stamp_due_bets(
        session, now + timedelta(minutes=1), api_key="test-key", http_client=client
    )
    assert summary_2.stamped_bets == 0
    assert calls == 1


def test_stamp_due_bets_timing_boundaries_ten_minutes_and_seven_days(db_session) -> None:
    session, teams = db_session
    now = datetime(2026, 11, 10, 18, 10, 0, tzinfo=UTC)

    # 9m59s past commence -> too early (skipped)
    evt_early = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_early",
        commence_time=now - timedelta(minutes=9, seconds=59),
    )
    bet_early = create_user_bet(
        session,
        sportsbook="FanDuel",
        decimal_odds=Decimal("2.10"),
        event_id=evt_early.event_id,
        stake_amount=Decimal("10.00"),
        status="PENDING",
        legs_json=[_sample_leg()],
    )

    # Exact 10m00s past commence -> due!
    evt_exact = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_exact",
        commence_time=now - timedelta(minutes=10),
    )
    bet_exact = create_user_bet(
        session,
        sportsbook="FanDuel",
        decimal_odds=Decimal("2.10"),
        event_id=evt_exact.event_id,
        stake_amount=Decimal("10.00"),
        status="PENDING",
        legs_json=[_sample_leg()],
    )

    # > 7 days past commence -> capped/skipped
    evt_old = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_old",
        commence_time=now - timedelta(days=7, seconds=1),
    )
    bet_old = create_user_bet(
        session,
        sportsbook="FanDuel",
        decimal_odds=Decimal("2.10"),
        event_id=evt_old.event_id,
        stake_amount=Decimal("10.00"),
        status="PENDING",
        legs_json=[_sample_leg()],
    )

    requested_ids: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        eid = req.url.params["event_id"]
        requested_ids.append(eid)
        return httpx.Response(200, json=_closing_payload(event_id=eid))

    client = httpx.Client(transport=httpx.MockTransport(handler))
    summary = stamp_due_bets(session, now, api_key="test-key", http_client=client)

    assert summary.stamped_bets == 1
    assert requested_ids == ["papi_nfl_exact"]
    early_row = get_user_bet(session, bet_early.bet_id)
    exact_row = get_user_bet(session, bet_exact.bet_id)
    old_row = get_user_bet(session, bet_old.bet_id)
    assert early_row is not None and early_row.clv_percentage is None
    assert exact_row is not None and exact_row.clv_percentage == Decimal("5.000")
    assert old_row is not None and old_row.clv_percentage is None


def test_stamp_due_bets_handles_naive_and_null_commence_and_non_pending(db_session) -> None:
    session, teams = db_session
    now = datetime(2026, 11, 10, 18, 30, tzinfo=UTC)

    # Naive commence_time (as loaded from SQLite)
    evt = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_naive",
        commence_time=datetime(2026, 11, 10, 18, 0),
    )
    pending_bet = create_user_bet(
        session,
        sportsbook="BetMGM",
        decimal_odds=Decimal("2.10"),
        event_id=evt.event_id,
        stake_amount=Decimal("15.00"),
        status="pending",
        legs_json=[_sample_leg()],
    )
    staged_bet = create_user_bet(
        session,
        sportsbook="BetMGM",
        decimal_odds=Decimal("2.10"),
        event_id=evt.event_id,
        stake_amount=Decimal("0.00"),
        status="STAGED",
        legs_json=[_sample_leg()],
    )
    won_bet = create_user_bet(
        session,
        sportsbook="BetMGM",
        decimal_odds=Decimal("2.10"),
        event_id=evt.event_id,
        stake_amount=Decimal("15.00"),
        status="WON",
        legs_json=[_sample_leg()],
    )

    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda _req: httpx.Response(200, json=_closing_payload(event_id="papi_nfl_naive"))
        )
    )
    summary = stamp_due_bets(session, now, api_key="test-key", http_client=client)
    assert summary.stamped_bets == 1
    pending_row = get_user_bet(session, pending_bet.bet_id)
    staged_row = get_user_bet(session, staged_bet.bet_id)
    won_row = get_user_bet(session, won_bet.bet_id)
    assert pending_row is not None and pending_row.clv_percentage == Decimal("5.000")
    assert staged_row is not None and staged_row.clv_percentage is None
    assert won_row is not None and won_row.clv_percentage is None

    # VG-3: Unresolvable event metadata and null commence_time / external_provider_id
    # must skip cleanly via real ORM objects (no MagicMock) with skipped_invalid and 0 HTTP calls.
    http_calls: list[str] = []

    def _counting_handler(req: httpx.Request) -> httpx.Response:
        http_calls.append(str(req.url))
        return httpx.Response(200, json=_closing_payload(event_id="papi_nfl_unexpected"))

    counting_client = httpx.Client(transport=httpx.MockTransport(_counting_handler))

    # 1. Real DB rows where event_id=None and leg cannot resolve to any Event row
    create_user_bet(
        session,
        sportsbook="BetMGM",
        decimal_odds=Decimal("2.10"),
        event_id=None,
        stake_amount=Decimal("10.00"),
        status="PENDING",
        placed_at=now - timedelta(minutes=30),
        legs_json=[_sample_leg()],
    )
    unknown_leg_evt = _sample_leg()
    unknown_leg_evt["eventId"] = "papi_nfl_missing_evt"
    create_user_bet(
        session,
        sportsbook="BetMGM",
        decimal_odds=Decimal("2.10"),
        event_id=None,
        stake_amount=Decimal("10.00"),
        status="PENDING",
        placed_at=now - timedelta(minutes=30),
        legs_json=[unknown_leg_evt],
    )
    missing_summary = stamp_due_bets(session, now, api_key="test-key", http_client=counting_client)
    assert missing_summary.stamped_bets == 0
    assert missing_summary.skipped_invalid == 2
    assert missing_summary.events_fetched == 0
    assert http_calls == []

    # 2. Real Event/UserBet ORM instances with null commence_time / external_provider_id
    class _ScalarResult:
        def __init__(self, rows: list[UserBet]) -> None:
            self._rows = rows

        def all(self) -> list[UserBet]:
            return self._rows

    class _OrmStubSession:
        def __init__(self, bets: list[UserBet], events_by_id: dict[uuid.UUID, Event]) -> None:
            self._bets = bets
            self._events_by_id = events_by_id
            self.rollbacks = 0

        def scalars(self, _stmt: Any) -> _ScalarResult:
            return _ScalarResult(self._bets)

        def get(self, model: Any, key: uuid.UUID) -> Any:
            if model is Event:
                return self._events_by_id.get(key)
            return None

        def rollback(self) -> None:
            self.rollbacks += 1

    null_commence_event_id = uuid.uuid4()
    null_provider_event_id = uuid.uuid4()
    orm_events = {
        null_commence_event_id: Event(
            event_id=null_commence_event_id,
            sport_key="americanfootball_nfl",
            home_team_id=teams["nfl_home"].team_id,
            away_team_id=teams["nfl_away"].team_id,
            external_provider_id="papi_nfl_null_commence",
            commence_time=None,  # type: ignore[arg-type]
            status="SCHEDULED",
        ),
        null_provider_event_id: Event(
            event_id=null_provider_event_id,
            sport_key="americanfootball_nfl",
            home_team_id=teams["nfl_home"].team_id,
            away_team_id=teams["nfl_away"].team_id,
            external_provider_id=None,  # type: ignore[arg-type]
            commence_time=now - timedelta(minutes=25),
            status="SCHEDULED",
        ),
    }
    orm_bets = [
        UserBet(
            bet_id=uuid.uuid4(),
            event_id=null_commence_event_id,
            prop_id=None,
            sportsbook="BetMGM",
            status="PENDING",
            clv_percentage=None,
            decimal_odds=Decimal("2.00"),
            stake_amount=Decimal("10.00"),
            placed_at=now - timedelta(minutes=30),
            legs_json=[_sample_leg()],
        ),
        UserBet(
            bet_id=uuid.uuid4(),
            event_id=null_provider_event_id,
            prop_id=None,
            sportsbook="BetMGM",
            status="PENDING",
            clv_percentage=None,
            decimal_odds=Decimal("2.00"),
            stake_amount=Decimal("10.00"),
            placed_at=now - timedelta(minutes=30),
            legs_json=[_sample_leg()],
        ),
    ]
    orm_stub = _OrmStubSession(orm_bets, orm_events)
    null_summary = stamp_due_bets(
        orm_stub,  # type: ignore[arg-type]
        now,
        api_key="test-key",
        http_client=counting_client,
    )
    assert null_summary.stamped_bets == 0
    assert null_summary.skipped_invalid == 2
    assert null_summary.events_fetched == 0
    assert http_calls == []


def test_stamp_due_bets_negative_clv_suspect_guard_and_malformed_isolation(
    db_session, caplog: pytest.LogCaptureFixture
) -> None:
    session, teams = db_session
    now = datetime(2026, 11, 10, 19, 0, tzinfo=UTC)
    evt = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_mixed",
        commence_time=now - timedelta(minutes=20),
    )

    # 1. Large negative CLV (-25.000%) MUST be stamped
    neg_bet = create_user_bet(
        session,
        sportsbook="DraftKings",
        decimal_odds=Decimal("1.5000"),
        event_id=evt.event_id,
        stake_amount=Decimal("20.00"),
        status="PENDING",
        legs_json=[_sample_leg(player_name="Patrick Mahomes", line=274.5)],
    )
    # 2. Exact +10.000% boundary MUST be stamped
    boundary_bet = create_user_bet(
        session,
        sportsbook="DraftKings",
        decimal_odds=Decimal("2.2000"),
        event_id=evt.event_id,
        stake_amount=Decimal("20.00"),
        status="PENDING",
        legs_json=[_sample_leg(player_name="Patrick Mahomes", line=274.5)],
    )
    # 3. Suspect positive CLV (+15.000%) MUST NOT be stamped + log SUSPECT_STALE_LINE
    suspect_bet = create_user_bet(
        session,
        sportsbook="DraftKings",
        decimal_odds=Decimal("2.3000"),
        event_id=evt.event_id,
        stake_amount=Decimal("20.00"),
        status="PENDING",
        legs_json=[_sample_leg(player_name="Patrick Mahomes", line=274.5)],
    )
    # 4. Malformed market odds (missing side for Travis Kelce) MUST NOT crash batch
    bad_bet = create_user_bet(
        session,
        sportsbook="DraftKings",
        decimal_odds=Decimal("2.0000"),
        event_id=evt.event_id,
        stake_amount=Decimal("20.00"),
        status="PENDING",
        legs_json=[_sample_leg(player_name="Travis Kelce", line=65.5)],
    )

    payload = _closing_payload(
        event_id="papi_nfl_mixed",
        bookmakers=[
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Patrick Mahomes",
                                "price": 1.95,
                                "point": 274.5,
                            },
                            {
                                "name": "Under",
                                "description": "Patrick Mahomes",
                                "price": 1.95,
                                "point": 274.5,
                            },
                            {
                                "name": "Over",
                                "description": "Travis Kelce",
                                "price": 1.95,
                                "point": 65.5,
                            },
                        ],
                    }
                ],
            }
        ],
    )
    calls = 0

    def handler(_req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=payload)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with caplog.at_level(logging.WARNING):
        summary = stamp_due_bets(session, now, api_key="test-key", http_client=client)

    assert calls == 1  # Single fetch shared across all bets on the same event
    assert summary.stamped_bets == 2
    assert summary.skipped_suspect == 1
    assert summary.skipped_invalid == 1

    neg_row = get_user_bet(session, neg_bet.bet_id)
    boundary_row = get_user_bet(session, boundary_bet.bet_id)
    suspect_row = get_user_bet(session, suspect_bet.bet_id)
    bad_row = get_user_bet(session, bad_bet.bet_id)
    assert neg_row is not None and neg_row.clv_percentage == Decimal("-25.000")
    assert boundary_row is not None and boundary_row.clv_percentage == Decimal("10.000")
    assert suspect_row is not None and suspect_row.clv_percentage is None
    assert bad_row is not None and bad_row.clv_percentage is None
    assert "SUSPECT_STALE_LINE" in caplog.text
    assert "INVALID_MARKET_ODDS" in caplog.text


def test_stamp_due_bets_multi_event_partial_failure_commits_good_and_raises_provider_error(
    db_session,
) -> None:
    session, teams = db_session
    now = datetime(2026, 11, 10, 19, 0, tzinfo=UTC)

    evt_fail = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_fail",
        commence_time=now - timedelta(minutes=25),
    )
    evt_ok = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_ok",
        commence_time=now - timedelta(minutes=20),
    )

    bet_fail = create_user_bet(
        session,
        sportsbook="DraftKings",
        decimal_odds=Decimal("2.10"),
        event_id=evt_fail.event_id,
        stake_amount=Decimal("20.00"),
        status="PENDING",
        placed_at=now - timedelta(hours=2),
        legs_json=[_sample_leg()],
    )
    bet_ok = create_user_bet(
        session,
        sportsbook="DraftKings",
        decimal_odds=Decimal("2.10"),
        event_id=evt_ok.event_id,
        stake_amount=Decimal("20.00"),
        status="PENDING",
        placed_at=now - timedelta(hours=1),
        legs_json=[_sample_leg()],
    )

    def handler(req: httpx.Request) -> httpx.Response:
        eid = req.url.params["event_id"]
        if eid == "papi_nfl_fail":
            return httpx.Response(503, json={"error": "upstream unavailable"})
        return httpx.Response(200, json=_closing_payload(event_id=eid))

    client = httpx.Client(transport=httpx.MockTransport(handler))

    with pytest.raises(ClosingOddsProviderError):
        stamp_due_bets(session, now, api_key="test-key", http_client=client)

    # Good event's bet MUST be committed; failed event's bet remains unstamped
    ok_row = get_user_bet(session, bet_ok.bet_id)
    fail_row = get_user_bet(session, bet_fail.bet_id)
    assert ok_row is not None and ok_row.clv_percentage == Decimal("5.000")
    assert fail_row is not None and fail_row.clv_percentage is None


def test_stamp_due_bets_fails_fast_on_missing_api_key_and_non_429_4xx(db_session) -> None:
    session, teams = db_session
    now = datetime(2026, 11, 10, 19, 0, tzinfo=UTC)
    evt = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_auth",
        commence_time=now - timedelta(minutes=20),
    )
    create_user_bet(
        session,
        sportsbook="FanDuel",
        decimal_odds=Decimal("2.10"),
        event_id=evt.event_id,
        stake_amount=Decimal("20.00"),
        status="PENDING",
        legs_json=[_sample_leg()],
    )

    with pytest.raises(ClosingOddsClientError):
        stamp_due_bets(session, now, api_key="")

    client_401 = httpx.Client(transport=httpx.MockTransport(lambda _r: httpx.Response(401)))
    with pytest.raises(ClosingOddsClientError):
        stamp_due_bets(session, now, api_key="bad-key", http_client=client_401)


# ---------------------------------------------------------------------------
# 6. Celery task registration, autoretry config, and Beat schedule
# ---------------------------------------------------------------------------


def test_celery_task_registration_retry_config_and_beat_schedule() -> None:
    assert "parlaypal_worker.stamp_closing_line_value" in celery_app.tasks
    assert stamp_closing_line_value.autoretry_for == (ClosingOddsProviderError,)
    assert stamp_closing_line_value.retry_backoff is True
    assert stamp_closing_line_value.max_retries == 3

    beat_schedule = celery_app.conf.beat_schedule
    assert beat_schedule
    matching_entries = [
        entry
        for entry in beat_schedule.values()
        if entry.get("task") == "parlaypal_worker.stamp_closing_line_value"
    ]
    assert len(matching_entries) == 1
    assert matching_entries[0]["schedule"] == 60.0


def test_celery_stamp_closing_line_value_task_body(
    db_session, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, teams = db_session
    now = datetime(2026, 11, 10, 19, 0, tzinfo=UTC)
    evt = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_task",
        commence_time=now - timedelta(minutes=20),
    )
    bet = create_user_bet(
        session,
        sportsbook="DraftKings",
        decimal_odds=Decimal("2.10"),
        event_id=evt.event_id,
        stake_amount=Decimal("25.00"),
        status="PENDING",
        legs_json=[_sample_leg()],
    )

    monkeypatch.setattr(celery_app_module, "create_session_factory", lambda: lambda: session)
    monkeypatch.setattr(
        "parlaypal_worker.clv.get_settings",
        lambda: MagicMock(
            parlay_api_key="test-key", parlay_api_base_url="https://api.parlay-api.com/v1"
        ),
    )

    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda _r: httpx.Response(200, json=_closing_payload(event_id="papi_nfl_task"))
        )
    )
    result = stamp_closing_line_value(http_client=client, now=now)
    assert result["status"] == "ok"
    assert result["stamped_bets"] == 1
    task_bet_row = get_user_bet(session, bet.bet_id)
    assert task_bet_row is not None and task_bet_row.clv_percentage == Decimal("5.000")


def test_parse_closing_leg_prices_fallback_sharp_book_when_pinnacle_absent(
    caplog: pytest.LogCaptureFixture,
) -> None:
    payload = _closing_payload(
        bookmakers=[
            {
                "key": "fanduel",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Patrick Mahomes",
                                "price": 1.85,
                                "point": 274.5,
                            },
                            {
                                "name": "Under",
                                "description": "Patrick Mahomes",
                                "price": 2.05,
                                "point": 274.5,
                            },
                        ],
                    }
                ],
            },
            {
                "key": "circa",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Patrick Mahomes",
                                "price": 1.93,
                                "point": 274.5,
                            },
                            {
                                "name": "Under",
                                "description": "Patrick Mahomes",
                                "price": 1.97,
                                "point": 274.5,
                            },
                        ],
                    }
                ],
            },
        ]
    )
    with caplog.at_level(logging.INFO):
        pairs = parse_closing_leg_prices(payload, [_sample_leg(selection="OVER", line=274.5)])
    assert pairs == [(Decimal("1.93"), Decimal("1.97"))]
    assert "circa" in caplog.text


def test_stamp_due_bets_multi_leg_partial_leg_failure_leaves_bet_unstamped(db_session) -> None:
    session, teams = db_session
    now = datetime(2026, 11, 10, 19, 0, tzinfo=UTC)
    evt = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_sgp",
        commence_time=now - timedelta(minutes=20),
    )

    # 2-leg SGP where both resolve -> stamped with product of fair probs
    valid_parlay = create_user_bet(
        session,
        sportsbook="DraftKings",
        decimal_odds=Decimal("4.2000"),
        event_id=evt.event_id,
        stake_amount=Decimal("25.00"),
        status="PENDING",
        legs_json=[
            _sample_leg(player_name="Patrick Mahomes", market_key="player_pass_yds", line=274.5),
            _sample_leg(player_name="Lamar Jackson", market_key="player_rush_yds", line=54.5),
        ],
    )
    # 2-leg SGP where leg 2 cannot resolve -> MUST NOT be stamped
    partial_parlay = create_user_bet(
        session,
        sportsbook="DraftKings",
        decimal_odds=Decimal("4.2000"),
        event_id=evt.event_id,
        stake_amount=Decimal("25.00"),
        status="PENDING",
        legs_json=[
            _sample_leg(player_name="Patrick Mahomes", market_key="player_pass_yds", line=274.5),
            _sample_leg(player_name="Unknown Player", market_key="player_rush_yds", line=44.5),
        ],
    )

    payload = _closing_payload(
        event_id="papi_nfl_sgp",
        bookmakers=[
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Patrick Mahomes",
                                "price": 1.95,
                                "point": 274.5,
                            },
                            {
                                "name": "Under",
                                "description": "Patrick Mahomes",
                                "price": 1.95,
                                "point": 274.5,
                            },
                        ],
                    },
                    {
                        "key": "player_rush_yds",
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Lamar Jackson",
                                "price": 1.95,
                                "point": 54.5,
                            },
                            {
                                "name": "Under",
                                "description": "Lamar Jackson",
                                "price": 1.95,
                                "point": 54.5,
                            },
                        ],
                    },
                ],
            }
        ],
    )
    client = httpx.Client(
        transport=httpx.MockTransport(lambda _r: httpx.Response(200, json=payload))
    )
    summary = stamp_due_bets(session, now, api_key="test-key", http_client=client)

    assert summary.stamped_bets == 1
    assert summary.skipped_invalid == 1

    stamped = get_user_bet(session, valid_parlay.bet_id)
    assert stamped is not None
    assert stamped.closing_fair_prob == Decimal("0.25000")
    assert stamped.closing_decimal_odds == Decimal("3.8025")
    assert stamped.clv_percentage == Decimal("5.000")

    unstamped = get_user_bet(session, partial_parlay.bet_id)
    assert unstamped is not None
    assert unstamped.clv_percentage is None
    assert unstamped.closing_fair_prob is None
    assert unstamped.closing_decimal_odds is None


def test_stamp_due_bets_missing_legs_json_skipped_and_retry_only_fetches_failed_event(
    db_session,
) -> None:
    session, teams = db_session
    now = datetime(2026, 11, 10, 19, 0, tzinfo=UTC)
    evt_1 = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_evt_good",
        commence_time=now - timedelta(minutes=30),
    )
    evt_2 = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_evt_flaky",
        commence_time=now - timedelta(minutes=25),
    )

    bet_no_legs = create_user_bet(
        session,
        sportsbook="FanDuel",
        decimal_odds=Decimal("2.10"),
        event_id=evt_1.event_id,
        stake_amount=Decimal("10.00"),
        status="PENDING",
        placed_at=now - timedelta(hours=3),
        legs_json=None,
    )
    bet_good = create_user_bet(
        session,
        sportsbook="FanDuel",
        decimal_odds=Decimal("2.10"),
        event_id=evt_1.event_id,
        stake_amount=Decimal("20.00"),
        status="PENDING",
        placed_at=now - timedelta(hours=2),
        legs_json=[_sample_leg()],
    )
    bet_flaky = create_user_bet(
        session,
        sportsbook="FanDuel",
        decimal_odds=Decimal("2.10"),
        event_id=evt_2.event_id,
        stake_amount=Decimal("20.00"),
        status="PENDING",
        placed_at=now - timedelta(hours=1),
        legs_json=[_sample_leg()],
    )

    attempt_1_events: list[str] = []

    def flaky_handler(req: httpx.Request) -> httpx.Response:
        eid = req.url.params["event_id"]
        attempt_1_events.append(eid)
        if eid == "papi_nfl_evt_flaky":
            return httpx.Response(429)
        return httpx.Response(200, json=_closing_payload(event_id=eid))

    with pytest.raises(ClosingOddsProviderError):
        stamp_due_bets(
            session,
            now,
            api_key="test-key",
            http_client=httpx.Client(transport=httpx.MockTransport(flaky_handler)),
        )

    assert attempt_1_events == ["papi_nfl_evt_good", "papi_nfl_evt_flaky"]
    no_legs_row = get_user_bet(session, bet_no_legs.bet_id)
    good_row = get_user_bet(session, bet_good.bet_id)
    flaky_row = get_user_bet(session, bet_flaky.bet_id)
    assert no_legs_row is not None and no_legs_row.clv_percentage is None
    assert good_row is not None and good_row.clv_percentage == Decimal("5.000")
    assert flaky_row is not None and flaky_row.clv_percentage is None

    # On retry, only evt_flaky should be fetched (bet_good is already stamped)
    attempt_2_events: list[str] = []

    def recovery_handler(req: httpx.Request) -> httpx.Response:
        eid = req.url.params["event_id"]
        attempt_2_events.append(eid)
        return httpx.Response(200, json=_closing_payload(event_id=eid))

    summary_retry = stamp_due_bets(
        session,
        now + timedelta(seconds=30),
        api_key="test-key",
        http_client=httpx.Client(transport=httpx.MockTransport(recovery_handler)),
    )
    assert attempt_2_events == ["papi_nfl_evt_flaky"]
    assert summary_retry.stamped_bets == 1
    assert summary_retry.skipped_invalid == 1  # bet_no_legs still skipped cleanly
    flaky_retry_row = get_user_bet(session, bet_flaky.bet_id)
    assert flaky_retry_row is not None and flaky_retry_row.clv_percentage == Decimal("5.000")


def test_celery_task_retries_provider_error_and_fails_fast_on_client_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_session = MagicMock()
    monkeypatch.setattr(celery_app_module, "create_session_factory", lambda: lambda: fake_session)

    # 1. Transient ClosingOddsProviderError triggers Celery retry mechanism and closes owned session
    monkeypatch.setattr(
        celery_app_module,
        "stamp_due_bets",
        MagicMock(side_effect=ClosingOddsProviderError("503 upstream")),
    )
    retry_spy = MagicMock(side_effect=ClosingOddsProviderError("retried"))
    monkeypatch.setattr(stamp_closing_line_value, "retry", retry_spy)
    try:
        with pytest.raises(ClosingOddsProviderError):
            stamp_closing_line_value.apply().get()
        assert retry_spy.called
        assert fake_session.close.called
    finally:
        monkeypatch.undo()

    # 2. Non-retryable ClosingOddsClientError does NOT trigger retry and still closes owned session
    fake_session_2 = MagicMock()
    monkeypatch.setattr(celery_app_module, "create_session_factory", lambda: lambda: fake_session_2)
    monkeypatch.setattr(
        celery_app_module,
        "stamp_due_bets",
        MagicMock(side_effect=ClosingOddsClientError("missing api key")),
    )
    retry_spy_2 = MagicMock()
    monkeypatch.setattr(stamp_closing_line_value, "retry", retry_spy_2)
    with pytest.raises(ClosingOddsClientError, match="missing api key"):
        stamp_closing_line_value.apply().get()
    assert not retry_spy_2.called
    assert fake_session_2.close.called


# ---------------------------------------------------------------------------
# 6. Iteration 2 Review Patches: Regression & Verification-Gap Coverage
# ---------------------------------------------------------------------------


def test_stamp_bet_clv_early_idempotency_and_extreme_bounds(db_session) -> None:
    session, teams = db_session
    event = _create_event(session, teams, external_provider_id="papi_nfl_patch6")
    bet = create_user_bet(
        session,
        sportsbook="DraftKings",
        decimal_odds=Decimal("2.00"),
        event_id=event.event_id,
        stake_amount=Decimal("25.00"),
        status="PENDING",
    )

    stamped = stamp_bet_clv(
        session,
        bet.bet_id,
        closing_decimal_odds=Decimal("1.9500"),
        closing_fair_prob=Decimal("0.50000"),
        clv_percentage=Decimal("0.000"),
    )
    assert stamped.clv_percentage == Decimal("0.000")

    # Idempotency check runs BEFORE decimal/bounds validation of incoming arguments.
    re_stamped = stamp_bet_clv(
        session,
        bet.bet_id,
        closing_decimal_odds=Decimal("0.50"),
        closing_fair_prob=Decimal("2.00"),
        clv_percentage=Decimal("999.000"),
    )
    assert re_stamped.closing_decimal_odds == Decimal("1.9500")
    assert re_stamped.closing_fair_prob == Decimal("0.50000")
    assert re_stamped.clv_percentage == Decimal("0.000")

    # Extreme negative CLV raises InvalidBetError cleanly before Decimal.quantize overflows.
    unstamped = create_user_bet(
        session,
        sportsbook="FanDuel",
        decimal_odds=Decimal("2.00"),
        event_id=event.event_id,
        stake_amount=Decimal("25.00"),
        status="PENDING",
    )
    with pytest.raises(InvalidBetError):
        stamp_bet_clv(
            session,
            unstamped.bet_id,
            closing_decimal_odds=Decimal("1.9500"),
            closing_fair_prob=Decimal("0.50000"),
            clv_percentage=Decimal("-1e30"),
        )


def test_parse_closing_leg_prices_excludes_retail_and_honors_novig_priority_5() -> None:
    leg = _sample_leg()

    # 1. Retail-only bookmakers are excluded even if they carry matching lines.
    retail_only = _closing_payload(
        bookmakers=[
            {
                "key": "draftkings",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Patrick Mahomes",
                                "price": 1.88,
                                "point": 274.5,
                            },
                            {
                                "name": "Under",
                                "description": "Patrick Mahomes",
                                "price": 2.02,
                                "point": 274.5,
                            },
                        ],
                    }
                ],
            },
            {
                "key": "fanduel",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Patrick Mahomes",
                                "price": 1.90,
                                "point": 274.5,
                            },
                            {
                                "name": "Under",
                                "description": "Patrick Mahomes",
                                "price": 2.00,
                                "point": 274.5,
                            },
                        ],
                    }
                ],
            },
        ]
    )
    with pytest.raises(DeviggingError) as retail_err:
        parse_closing_leg_prices(retail_only, [leg])
    assert retail_err.value.code == "MISSING_CLOSING_MARKET"

    # 2. Pinnacle lacking the target market must NOT fall back to DraftKings.
    pinnacle_no_market_plus_dk = _closing_payload(
        bookmakers=[
            {"key": "pinnacle", "markets": []},
            retail_only["bookmakers"][0],
        ]
    )
    with pytest.raises(DeviggingError) as missing_sharp_err:
        parse_closing_leg_prices(pinnacle_no_market_plus_dk, [leg])
    assert missing_sharp_err.value.code == "MISSING_CLOSING_MARKET"

    # 3. 'novig' is accepted at sharp priority 5 when higher-priority sharps are absent.
    novig_payload = _closing_payload(
        bookmakers=[
            retail_only["bookmakers"][0],
            {
                "key": "novig",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Patrick Mahomes",
                                "price": 1.96,
                                "point": 274.5,
                            },
                            {
                                "name": "Under",
                                "description": "Patrick Mahomes",
                                "price": 1.96,
                                "point": 274.5,
                            },
                        ],
                    }
                ],
            },
        ]
    )
    assert parse_closing_leg_prices(novig_payload, [leg]) == [(Decimal("1.96"), Decimal("1.96"))]

    # 4. Priority 4 ('lowvig') outranks priority 5 ('novig') regardless of ordering.
    lowvig_vs_novig = _closing_payload(
        bookmakers=[
            novig_payload["bookmakers"][1],
            {
                "key": "lowvig",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Patrick Mahomes",
                                "price": 1.93,
                                "point": 274.5,
                            },
                            {
                                "name": "Under",
                                "description": "Patrick Mahomes",
                                "price": 1.97,
                                "point": 274.5,
                            },
                        ],
                    }
                ],
            },
        ]
    )
    assert parse_closing_leg_prices(lowvig_vs_novig, [leg]) == [(Decimal("1.93"), Decimal("1.97"))]


def test_parse_closing_leg_prices_falls_back_on_incomplete_or_malformed_sharp_market(
    caplog: pytest.LogCaptureFixture,
) -> None:
    leg = _sample_leg()

    # 1. Pinnacle one-sided market falls back to Circa cleanly.
    pinnacle_one_sided_plus_circa = _closing_payload(
        bookmakers=[
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Patrick Mahomes",
                                "price": 1.90,
                                "point": 274.5,
                            }
                        ],
                    }
                ],
            },
            {
                "key": "circa",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Patrick Mahomes",
                                "price": 1.92,
                                "point": 274.5,
                            },
                            {
                                "name": "Under",
                                "description": "Patrick Mahomes",
                                "price": 1.98,
                                "point": 274.5,
                            },
                        ],
                    }
                ],
            },
        ]
    )
    with caplog.at_level(logging.INFO, logger="parlaypal_worker.clv"):
        pairs = parse_closing_leg_prices(pinnacle_one_sided_plus_circa, [leg])
    assert pairs == [(Decimal("1.92"), Decimal("1.98"))]
    assert "using fallback book 'circa'" in caplog.text

    # 2. Pinnacle malformed price falls back to Novig cleanly.
    pinnacle_malformed_plus_novig = _closing_payload(
        bookmakers=[
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Patrick Mahomes",
                                "price": "not-a-number",
                                "point": 274.5,
                            },
                            {
                                "name": "Under",
                                "description": "Patrick Mahomes",
                                "price": 1.95,
                                "point": 274.5,
                            },
                        ],
                    }
                ],
            },
            {
                "key": "novig",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Patrick Mahomes",
                                "price": 1.97,
                                "point": 274.5,
                            },
                            {
                                "name": "Under",
                                "description": "Patrick Mahomes",
                                "price": 1.97,
                                "point": 274.5,
                            },
                        ],
                    }
                ],
            },
        ]
    )
    assert parse_closing_leg_prices(pinnacle_malformed_plus_novig, [leg]) == [
        (Decimal("1.97"), Decimal("1.97"))
    ]

    # 3. If sharp markets exist for the leg but all fail validation, preserve validation reason.
    all_malformed = _closing_payload(bookmakers=[pinnacle_one_sided_plus_circa["bookmakers"][0]])
    with pytest.raises(DeviggingError) as invalid_err:
        parse_closing_leg_prices(all_malformed, [leg])
    assert invalid_err.value.code == "INVALID_MARKET_ODDS"


def test_parse_closing_leg_prices_two_way_anytime_td_spreads_and_mixed_names() -> None:
    # 1. player_anytime_td OVER/UNDER <-> Yes/No (with description AND player-prefixed names)
    td_desc_payload = _closing_payload(
        bookmakers=[
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "player_anytime_td",
                        "outcomes": [
                            {"name": "Yes", "description": "Derrick Henry", "price": 1.80},
                            {"name": "No", "description": "Derrick Henry", "price": 2.15},
                        ],
                    }
                ],
            }
        ]
    )
    assert parse_closing_leg_prices(
        td_desc_payload,
        [
            _sample_leg(
                player_name="Derrick Henry",
                market_key="player_anytime_td",
                selection="OVER",
                line=0.5,
            )
        ],
    ) == [(Decimal("1.80"), Decimal("2.15"))]
    assert parse_closing_leg_prices(
        td_desc_payload,
        [
            _sample_leg(
                player_name="Derrick Henry",
                market_key="player_anytime_td",
                selection="UNDER",
                line=None,
            )
        ],
    ) == [(Decimal("2.15"), Decimal("1.80"))]

    td_prefixed_payload = _closing_payload(
        bookmakers=[
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "player_anytime_td",
                        "outcomes": [
                            {"name": "Derrick Henry Yes", "price": 1.85, "point": 0.5},
                            {"name": "Derrick Henry No", "price": 2.05, "point": 0.5},
                        ],
                    }
                ],
            }
        ]
    )
    assert parse_closing_leg_prices(
        td_prefixed_payload,
        [
            _sample_leg(
                player_name="Derrick Henry",
                market_key="player_anytime_td",
                selection="OVER",
                line=0.5,
            )
        ],
    ) == [(Decimal("1.85"), Decimal("2.05"))]

    # Normal Over/Under market must NOT fall back to matching Yes/No.
    normal_totals_with_yes_no = _closing_payload(
        bookmakers=[
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "totals",
                        "outcomes": [
                            {"name": "Yes", "price": 1.90, "point": 48.5},
                            {"name": "No", "price": 1.90, "point": 48.5},
                        ],
                    }
                ],
            }
        ]
    )
    with pytest.raises(DeviggingError):
        parse_closing_leg_prices(
            normal_totals_with_yes_no,
            [
                {
                    "marketKey": "totals",
                    "selection": "OVER",
                    "line": 48.5,
                }
            ],
        )

    # 2. Spreads opposite outcome carries -leg_line (including pick'em 0 / -0).
    spread_payload = _closing_payload(
        bookmakers=[
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "spreads",
                        "outcomes": [
                            {"name": "Kansas City Chiefs", "price": 1.91, "point": -3.5},
                            {"name": "Buffalo Bills", "price": 1.99, "point": 3.5},
                            {"name": "Kansas City Chiefs", "price": 2.25, "point": -6.5},
                            {"name": "Buffalo Bills", "price": 1.69, "point": 6.5},
                        ],
                    }
                ],
            }
        ]
    )
    assert parse_closing_leg_prices(
        spread_payload,
        [{"marketKey": "spreads", "selection": "Kansas City Chiefs", "line": -3.5}],
    ) == [(Decimal("1.91"), Decimal("1.99"))]

    pickem_payload = _closing_payload(
        bookmakers=[
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "spreads",
                        "outcomes": [
                            {"name": "Kansas City Chiefs", "price": 1.95, "point": 0},
                            {"name": "Buffalo Bills", "price": 1.95, "point": -0.0},
                        ],
                    }
                ],
            }
        ]
    )
    assert parse_closing_leg_prices(
        pickem_payload,
        [{"marketKey": "spreads", "selection": "Kansas City Chiefs", "line": 0}],
    ) == [(Decimal("1.95"), Decimal("1.95"))]

    # 3. Mixed generic / player-prefixed outcomes guard.
    # 3a) Generic Over must NOT pair with a player-prefixed Under.
    generic_vs_prefixed = _closing_payload(
        bookmakers=[
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "totals",
                        "outcomes": [
                            {"name": "Over", "price": 1.91, "point": 48.5},
                            {"name": "Josh Allen Under", "price": 1.99, "point": 48.5},
                        ],
                    }
                ],
            }
        ]
    )
    with pytest.raises(DeviggingError):
        parse_closing_leg_prices(
            generic_vs_prefixed,
            [{"marketKey": "totals", "selection": "OVER", "line": 48.5}],
        )

    # 3b) Conflicting description vs prefixed name is rejected.
    conflicting_desc_name = _closing_payload(
        bookmakers=[
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {
                                "name": "James Cook Over",
                                "description": "Josh Allen",
                                "price": 1.91,
                                "point": 274.5,
                            },
                            {
                                "name": "Josh Allen Under",
                                "description": "Josh Allen",
                                "price": 1.99,
                                "point": 274.5,
                            },
                        ],
                    }
                ],
            }
        ]
    )
    with pytest.raises(DeviggingError):
        parse_closing_leg_prices(
            conflicting_desc_name,
            [_sample_leg(player_name="Josh Allen", line=274.5)],
        )

    # 3c) Same player across description + prefixed opposite matches cleanly without cross-matching another player.
    mixed_same_player = _closing_payload(
        bookmakers=[
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "player_pass_yds",
                        "outcomes": [
                            {
                                "name": "Over",
                                "description": "Josh Allen",
                                "price": 1.92,
                                "point": 274.5,
                            },
                            {"name": "Josh Allen Under", "price": 1.98, "point": 274.5},
                            {"name": "James Cook Under", "price": 2.10, "point": 274.5},
                        ],
                    }
                ],
            }
        ]
    )
    assert parse_closing_leg_prices(
        mixed_same_player,
        [_sample_leg(player_name="Josh Allen", line=274.5)],
    ) == [(Decimal("1.92"), Decimal("1.98"))]


def test_stamp_due_bets_http_400_404_422_isolated_while_401_403_fail_fast(
    db_session,
) -> None:
    session, teams = db_session
    now = datetime(2026, 11, 10, 19, 0, tzinfo=UTC)

    evt_404 = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_evt_404",
        commence_time=now - timedelta(minutes=30),
    )
    evt_400 = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_evt_400",
        commence_time=now - timedelta(minutes=30),
    )
    evt_422 = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_evt_422",
        commence_time=now - timedelta(minutes=30),
    )
    evt_ok = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_evt_ok",
        commence_time=now - timedelta(minutes=30),
    )

    bet_404 = create_user_bet(
        session,
        sportsbook="BetMGM",
        decimal_odds=Decimal("2.10"),
        event_id=evt_404.event_id,
        stake_amount=Decimal("10.00"),
        status="PENDING",
        placed_at=now - timedelta(hours=3),
        legs_json=[_sample_leg()],
    )
    bet_400 = create_user_bet(
        session,
        sportsbook="BetMGM",
        decimal_odds=Decimal("2.10"),
        event_id=evt_400.event_id,
        stake_amount=Decimal("10.00"),
        status="PENDING",
        placed_at=now - timedelta(hours=2),
        legs_json=[_sample_leg()],
    )
    bet_422 = create_user_bet(
        session,
        sportsbook="BetMGM",
        decimal_odds=Decimal("2.10"),
        event_id=evt_422.event_id,
        stake_amount=Decimal("10.00"),
        status="PENDING",
        placed_at=now - timedelta(hours=1),
        legs_json=[_sample_leg()],
    )
    bet_ok = create_user_bet(
        session,
        sportsbook="BetMGM",
        decimal_odds=Decimal("2.10"),
        event_id=evt_ok.event_id,
        stake_amount=Decimal("10.00"),
        status="PENDING",
        placed_at=now - timedelta(minutes=30),
        legs_json=[_sample_leg()],
    )

    def mixed_http_handler(req: httpx.Request) -> httpx.Response:
        eid = req.url.params["event_id"]
        if eid == "papi_nfl_evt_404":
            return httpx.Response(404)
        if eid == "papi_nfl_evt_400":
            return httpx.Response(400)
        if eid == "papi_nfl_evt_422":
            return httpx.Response(422)
        return httpx.Response(200, json=_closing_payload(event_id=eid))

    summary = stamp_due_bets(
        session,
        now,
        api_key="test-key",
        http_client=httpx.Client(transport=httpx.MockTransport(mixed_http_handler)),
    )
    assert summary.skipped_invalid == 3
    assert summary.stamped_bets == 1
    assert summary.events_fetched == 1
    assert get_user_bet(session, bet_ok.bet_id).clv_percentage == Decimal("5.000")  # type: ignore[union-attr]
    for skipped_id in (bet_404.bet_id, bet_400.bet_id, bet_422.bet_id):
        skipped_row = get_user_bet(session, skipped_id)
        assert skipped_row is not None and skipped_row.clv_percentage is None

    # 401 / 403 / missing API key fail fast with ClosingOddsClientError
    for status in (401, 403):
        with pytest.raises(ClosingOddsClientError):
            stamp_due_bets(
                session,
                now,
                api_key="test-key",
                http_client=httpx.Client(
                    transport=httpx.MockTransport(lambda _req, s=status: httpx.Response(s))
                ),
            )
    with pytest.raises(ClosingOddsClientError):
        stamp_due_bets(session, now, api_key="")


def test_stamp_due_bets_cross_game_papi_ids_staggered_and_status_exclusions(
    db_session, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, teams = db_session
    now = datetime(2026, 11, 10, 19, 0, tzinfo=UTC)

    evt_due = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_cg_due",
        commence_time=now - timedelta(minutes=20),
        status="COMMENCED",
    )
    evt_later = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_cg_later",
        commence_time=now + timedelta(minutes=25),
        status="SCHEDULED",
    )
    evt_postponed = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_postponed",
        commence_time=now - timedelta(hours=2),
        status="POSTPONED",
    )
    evt_cancelled = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_cancelled",
        commence_time=now - timedelta(hours=2),
        status="CANCELLED",
    )

    # 1. Single-leg bet with event_id=None referencing papi_ eventId
    single_papi_bet = create_user_bet(
        session,
        sportsbook="BetMGM",
        decimal_odds=Decimal("2.10"),
        event_id=None,
        stake_amount=Decimal("20.00"),
        status="PENDING",
        placed_at=now - timedelta(hours=1),
        legs_json=[{**_sample_leg(), "eventId": "papi_nfl_cg_due"}],
    )

    # 2. 2-leg cross-game parlay with staggered commence_times (event_id=None)
    staggered_parlay = create_user_bet(
        session,
        sportsbook="DraftKings",
        decimal_odds=Decimal("4.20"),
        event_id=None,
        stake_amount=Decimal("10.00"),
        status="PENDING",
        placed_at=now - timedelta(hours=1),
        legs_json=[
            {**_sample_leg(player_name="Patrick Mahomes"), "eventId": "papi_nfl_cg_due"},
            {**_sample_leg(player_name="Josh Allen"), "eventId": "papi_nfl_cg_later"},
        ],
    )

    # 3. Single-game POSTPONED / CANCELLED event bets + cross-game leg pointing to POSTPONED
    postponed_bet = create_user_bet(
        session,
        sportsbook="FanDuel",
        decimal_odds=Decimal("2.00"),
        event_id=evt_postponed.event_id,
        stake_amount=Decimal("10.00"),
        status="PENDING",
        placed_at=now - timedelta(hours=3),
        legs_json=[_sample_leg()],
    )
    cancelled_bet = create_user_bet(
        session,
        sportsbook="FanDuel",
        decimal_odds=Decimal("2.00"),
        event_id=evt_cancelled.event_id,
        stake_amount=Decimal("10.00"),
        status="PENDING",
        placed_at=now - timedelta(hours=3),
        legs_json=[_sample_leg()],
    )
    cg_postponed_leg_bet = create_user_bet(
        session,
        sportsbook="BetMGM",
        decimal_odds=Decimal("4.00"),
        event_id=None,
        stake_amount=Decimal("10.00"),
        status="PENDING",
        placed_at=now - timedelta(hours=1),
        legs_json=[
            {**_sample_leg(player_name="Patrick Mahomes"), "eventId": "papi_nfl_cg_due"},
            {**_sample_leg(player_name="Josh Allen"), "eventId": "papi_nfl_postponed"},
        ],
    )

    # 4. Orphan event_id=None bet older than 7-day lookback window must be excluded
    aged_orphan_bet = create_user_bet(
        session,
        sportsbook="Caesars",
        decimal_odds=Decimal("2.10"),
        event_id=None,
        stake_amount=Decimal("10.00"),
        status="PENDING",
        placed_at=now - timedelta(days=8),
        legs_json=[{**_sample_leg(), "eventId": evt_due.external_provider_id}],
    )

    fetched_events: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        eid = req.url.params["event_id"]
        fetched_events.append(eid)
        if eid == "papi_nfl_cg_later":
            return httpx.Response(
                200,
                json=_closing_payload(
                    event_id=eid,
                    bookmakers=[
                        {
                            "key": "pinnacle",
                            "markets": [
                                {
                                    "key": "player_pass_yds",
                                    "outcomes": [
                                        {
                                            "name": "Over",
                                            "description": "Josh Allen",
                                            "price": 1.95,
                                            "point": 274.5,
                                        },
                                        {
                                            "name": "Under",
                                            "description": "Josh Allen",
                                            "price": 1.95,
                                            "point": 274.5,
                                        },
                                    ],
                                }
                            ],
                        }
                    ],
                ),
            )
        return httpx.Response(200, json=_closing_payload(event_id=eid))

    monkeypatch.setenv("PARLAY_API_KEY", "test-key")
    client = httpx.Client(transport=httpx.MockTransport(handler))
    summary_t1 = stamp_due_bets(session, now, api_key="test-key", http_client=client)

    assert summary_t1.stamped_bets == 1
    assert summary_t1.skipped_not_due == 2  # staggered_parlay + cg_postponed_leg_bet
    assert fetched_events == ["papi_nfl_cg_due"]

    single_row = get_user_bet(session, single_papi_bet.bet_id)
    parlay_row = get_user_bet(session, staggered_parlay.bet_id)
    postponed_row = get_user_bet(session, postponed_bet.bet_id)
    cancelled_row = get_user_bet(session, cancelled_bet.bet_id)
    cg_postponed_row = get_user_bet(session, cg_postponed_leg_bet.bet_id)
    aged_row = get_user_bet(session, aged_orphan_bet.bet_id)
    assert single_row is not None and single_row.clv_percentage == Decimal("5.000")
    assert parlay_row is not None and parlay_row.clv_percentage is None
    assert postponed_row is not None and postponed_row.clv_percentage is None
    assert cancelled_row is not None and cancelled_row.clv_percentage is None
    assert cg_postponed_row is not None and cg_postponed_row.clv_percentage is None
    assert aged_row is not None and aged_row.clv_percentage is None

    # Advance now past evt_later + 10m -> staggered_parlay now stamps cleanly
    assert evt_later.commence_time is not None
    later_now = now + timedelta(minutes=40)
    fetched_events.clear()
    summary_t2 = stamp_due_bets(session, later_now, api_key="test-key", http_client=client)
    assert summary_t2.stamped_bets == 1
    assert sorted(fetched_events) == ["papi_nfl_cg_due", "papi_nfl_cg_later"]
    parlay_row_after = get_user_bet(session, staggered_parlay.bet_id)
    assert parlay_row_after is not None and parlay_row_after.clv_percentage == Decimal("5.000")


def test_stamp_due_bets_prop_id_fallback_when_legs_json_is_none(db_session) -> None:
    session, teams = db_session
    now = datetime(2026, 11, 10, 19, 0, tzinfo=UTC)
    evt = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_prop_fallback",
        commence_time=now - timedelta(minutes=25),
    )
    prop = PlayerProp(
        external_provider_id="papi_nfl_prop_mahomes",
        event_id=evt.event_id,
        team_id=teams["nfl_home"].team_id,
        player_name="Patrick Mahomes",
        market_key="player_pass_yds",
        selection="OVER",
        line_value=Decimal("274.50"),
        offered_decimal_odds=Decimal("2.1000"),
        status="ACTIVE",
    )
    session.add(prop)
    session.commit()

    # Both event_id set and event_id=None with legs_json=None resolve via prop_id fallback
    bet_with_evt = create_user_bet(
        session,
        sportsbook="DraftKings",
        decimal_odds=Decimal("2.10"),
        event_id=evt.event_id,
        prop_id=prop.prop_id,
        stake_amount=Decimal("25.00"),
        status="PENDING",
        placed_at=now - timedelta(minutes=45),
        legs_json=None,
    )
    bet_without_evt = create_user_bet(
        session,
        sportsbook="FanDuel",
        decimal_odds=Decimal("2.10"),
        event_id=None,
        prop_id=prop.prop_id,
        stake_amount=Decimal("25.00"),
        status="PENDING",
        placed_at=now - timedelta(minutes=40),
        legs_json=None,
    )

    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda req: httpx.Response(
                200, json=_closing_payload(event_id=req.url.params["event_id"])
            )
        )
    )
    summary = stamp_due_bets(session, now, api_key="test-key", http_client=client)
    assert summary.stamped_bets == 2
    assert summary.events_fetched == 1
    row_a = get_user_bet(session, bet_with_evt.bet_id)
    row_b = get_user_bet(session, bet_without_evt.bet_id)
    assert row_a is not None and row_a.clv_percentage == Decimal("5.000")
    assert row_b is not None and row_b.clv_percentage == Decimal("5.000")


def test_stamp_due_bets_shares_single_httpx_client_and_evaluates_3dp_suspect_boundary(
    db_session, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, teams = db_session
    now = datetime(2026, 11, 10, 19, 0, tzinfo=UTC)

    # 1. Verify is_suspect uses quantized 3-dp clv_percentage, not unquantized raw CLV.
    # Symmetric 1.95 / 1.95 closing pair has fair prob = 0.50000 -> exec odds 2.200004
    # gives raw CLV 10.0002%, quantized to 10.000% (<= 10.000% -> NOT suspect).
    boundary_eval = compute_bet_closing(
        Decimal("2.200004"),
        [(Decimal("1.95"), Decimal("1.95"))],
    )
    assert boundary_eval.clv_percentage == Decimal("10.000")
    assert boundary_eval.is_suspect_stale_line is False

    # Exec odds 2.200010 gives raw CLV 10.0005%, quantized HALF_UP to 10.001% (> 10.000%).
    suspect_eval = compute_bet_closing(
        Decimal("2.200010"),
        [(Decimal("1.95"), Decimal("1.95"))],
    )
    assert suspect_eval.clv_percentage == Decimal("10.001")
    assert suspect_eval.is_suspect_stale_line is True

    # 2. Verify stamp_due_bets opens and closes ONE shared httpx.Client across multi-event fetches.
    evt_1 = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_shared_1",
        commence_time=now - timedelta(minutes=20),
    )
    evt_2 = _create_event(
        session,
        teams,
        external_provider_id="papi_nfl_shared_2",
        commence_time=now - timedelta(minutes=20),
    )
    create_user_bet(
        session,
        sportsbook="BetMGM",
        decimal_odds=Decimal("2.10"),
        event_id=evt_1.event_id,
        stake_amount=Decimal("10.00"),
        status="PENDING",
        placed_at=now - timedelta(minutes=30),
        legs_json=[_sample_leg()],
    )
    create_user_bet(
        session,
        sportsbook="BetMGM",
        decimal_odds=Decimal("2.10"),
        event_id=evt_2.event_id,
        stake_amount=Decimal("10.00"),
        status="PENDING",
        placed_at=now - timedelta(minutes=30),
        legs_json=[_sample_leg()],
    )

    orig_client_cls = httpx.Client
    created_clients: list[httpx.Client] = []
    fetched_ids: list[str] = []

    def _sweep_handler(req: httpx.Request) -> httpx.Response:
        eid = req.url.params["event_id"]
        fetched_ids.append(eid)
        return httpx.Response(200, json=_closing_payload(event_id=eid))

    def _spy_client_factory(**kwargs: Any) -> httpx.Client:
        client_inst = orig_client_cls(transport=httpx.MockTransport(_sweep_handler), **kwargs)
        created_clients.append(client_inst)
        return client_inst

    monkeypatch.setattr(clv_module.httpx, "Client", _spy_client_factory)
    summary = stamp_due_bets(session, now, api_key="test-key", http_client=None)
    assert summary.stamped_bets == 2
    assert summary.events_fetched == 2
    assert fetched_ids == ["papi_nfl_shared_1", "papi_nfl_shared_2"]
    assert len(created_clients) == 1
    assert created_clients[0].is_closed is True
