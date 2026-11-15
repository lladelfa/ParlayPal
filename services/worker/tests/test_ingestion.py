"""TDD unit and integration tests for Story 5.1: Automated Upstream Schedule, Prop Ingestion & Beat Orchestration."""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx
import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.orm import Session

import parlaypal_worker.celery_app as celery_app_module
import parlaypal_worker.devig as devig_module
import parlaypal_worker.ingestion as ingestion_module
from parlaypal_worker.celery_app import celery_app, sync_live_slate
from parlaypal_worker.db import create_session_factory, init_db
from parlaypal_worker.ingestion import (
    IngestedEvent,
    IngestedGameLog,
    IngestedProp,
    IngestedSlate,
    IngestedTeam,
    UpstreamIngestionError,
    _ensure_provider_prefix,
    _extract_direct_props,
    _extract_props_from_bookmakers,
    _parse_odds_to_decimal,
    _parse_optional_decimal,
    _resolve_team_metadata,
    _split_outcome_player_and_side,
    build_local_seed_slate,
    fetch_upstream_slate,
    run_live_slate_sync,
    upsert_slate_to_db,
)
from parlaypal_worker.models import Event, PlayerProp, Team
from parlaypal_worker.redis_client import (
    HOT_CACHE_TTL_SECONDS,
    ev_feed_key,
    odds_feed_channel,
    odds_latest_key,
)


class FakeRedisClient:
    """In-memory Redis double tracking TTLs and Pub/Sub broadcasts."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.ttls: dict[str, int | None] = {}
        self.published: list[tuple[str, str]] = []
        self.closed: bool = False

    def set(self, name: str, value: str, ex: int | None = None) -> bool:
        self.store[name] = value
        self.ttls[name] = ex
        return True

    def get(self, name: str) -> str | None:
        return self.store.get(name)

    def ttl(self, name: str) -> int | None:
        return self.ttls.get(name)

    def publish(self, channel: str, message: str) -> int:
        self.published.append((channel, message))
        return 1

    def close(self) -> None:
        self.closed = True


@pytest.fixture()
def db_session():
    """Create an in-memory SQLite database initialized with ParlayPal schema."""
    engine = create_engine("sqlite:///:memory:")
    init_db(engine=engine)
    session_factory = create_session_factory(engine)
    session = session_factory()
    try:
        yield session, session_factory, engine
    finally:
        session.close()
        engine.dispose()


def _build_upstream_mock_transport(
    now_utc: datetime,
    *,
    include_malformed_prop: bool = False,
    include_outlier_prop: bool = False,
) -> httpx.MockTransport:
    """Build deterministic Odds API v4 / ParlayAPI mock transport for NFL and NBA."""
    today_time = (now_utc + timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
    tomorrow_time = (
        (now_utc + timedelta(days=1))
        .replace(hour=19, minute=0, second=0)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    )
    weekend_time = (now_utc + timedelta(hours=54)).strftime("%Y-%m-%dT%H:%M:%SZ")

    nfl_outcomes_pass: list[dict[str, Any]] = [
        {"name": "Over", "description": "Patrick Mahomes", "price": 1.91, "point": 274.5},
        {"name": "Under", "description": "Patrick Mahomes", "price": 1.93, "point": 274.5},
    ]
    nfl_outcomes_pass_soft: list[dict[str, Any]] = [
        {"name": "Over", "description": "Patrick Mahomes", "price": 2.05, "point": 274.5},
        {"name": "Under", "description": "Patrick Mahomes", "price": 1.80, "point": 274.5},
    ]

    nfl_outcomes_td_sharp: list[dict[str, Any]] = [
        {"name": "Yes", "description": "Derrick Henry", "price": 1.80},
        {"name": "No", "description": "Derrick Henry", "price": 2.10},
    ]
    nfl_outcomes_td_soft: list[dict[str, Any]] = [
        {"name": "Yes", "description": "Derrick Henry", "price": 1.95},
        {"name": "No", "description": "Derrick Henry", "price": 1.88},
    ]

    nfl_outcomes_rush_sharp: list[dict[str, Any]] = [
        {"name": "Over", "description": "James Cook", "price": 1.87, "point": 64.5},
        {"name": "Under", "description": "James Cook", "price": 1.95, "point": 64.5},
    ]
    nfl_outcomes_rush_soft: list[dict[str, Any]] = [
        {"name": "Over", "description": "James Cook", "price": 1.98, "point": 64.5},
        {"name": "Under", "description": "James Cook", "price": 1.83, "point": 64.5},
    ]

    if include_malformed_prop:
        # Malformed prop: missing opposite side AND invalid decimal odds 0.85
        nfl_outcomes_pass_soft.append(
            {"name": "Over", "description": "Broken Player", "price": 0.85, "point": 199.5}
        )
        nfl_outcomes_pass.append(
            {"name": "Over", "description": "Broken Player", "price": 1.90, "point": 199.5}
        )

    if include_outlier_prop:
        # Fair prob ~ 0.50, offered 2.50 -> EV ~ +25.0% (> 10.0% outlier threshold)
        nfl_outcomes_rush_sharp.extend(
            [
                {"name": "Over", "description": "Stale Outlier RB", "price": 1.91, "point": 55.5},
                {"name": "Under", "description": "Stale Outlier RB", "price": 1.91, "point": 55.5},
            ]
        )
        nfl_outcomes_rush_soft.extend(
            [
                {"name": "Over", "description": "Stale Outlier RB", "price": 2.50, "point": 55.5},
                {"name": "Under", "description": "Stale Outlier RB", "price": 1.60, "point": 55.5},
            ]
        )

    nfl_events = [
        {
            "id": "papi_nfl_kc_buf_001",
            "sport_key": "americanfootball_nfl",
            "commence_time": today_time,
            "home_team": "Buffalo Bills",
            "away_team": "Kansas City Chiefs",
            "weather": {"wind_speed_mph": 17.5, "temp_f": 38.0, "precip_prob": 20.0},
            "bookmakers": [
                {
                    "key": "pinnacle",
                    "title": "Pinnacle",
                    "markets": [
                        {"key": "player_pass_yds", "outcomes": nfl_outcomes_pass},
                    ],
                },
                {
                    "key": "fanduel",
                    "title": "FanDuel",
                    "markets": [
                        {"key": "player_pass_yds", "outcomes": nfl_outcomes_pass_soft},
                    ],
                },
            ],
        },
        {
            "id": "papi_nfl_bal_pit_002",
            "sport_key": "americanfootball_nfl",
            "commence_time": weekend_time,
            "home_team": "Pittsburgh Steelers",
            "away_team": "Baltimore Ravens",
            "bookmakers": [
                {
                    "key": "pinnacle",
                    "title": "Pinnacle",
                    "markets": [
                        {"key": "player_anytime_td", "outcomes": nfl_outcomes_td_sharp},
                        {"key": "player_rush_yds", "outcomes": nfl_outcomes_rush_sharp},
                    ],
                },
                {
                    "key": "draftkings",
                    "title": "DraftKings",
                    "markets": [
                        {"key": "player_anytime_td", "outcomes": nfl_outcomes_td_soft},
                        {"key": "player_rush_yds", "outcomes": nfl_outcomes_rush_soft},
                    ],
                },
            ],
        },
    ]

    nba_events = [
        {
            "id": "nba_bos_nyk_001",
            "sport_key": "basketball_nba",
            "commence_time": today_time,
            "home_team": "New York Knicks",
            "away_team": "Boston Celtics",
            "bookmakers": [
                {
                    "key": "pinnacle",
                    "title": "Pinnacle",
                    "markets": [
                        {
                            "key": "player_points",
                            "outcomes": [
                                {
                                    "name": "Over",
                                    "description": "Jayson Tatum",
                                    "price": -115,
                                    "point": 26.5,
                                },
                                {
                                    "name": "Under",
                                    "description": "Jayson Tatum",
                                    "price": -105,
                                    "point": 26.5,
                                },
                            ],
                        },
                        {
                            "key": "player_rebounds",
                            "outcomes": [
                                {
                                    "name": "Over",
                                    "description": "Jayson Tatum",
                                    "price": 1.92,
                                    "point": 8.5,
                                },
                                {
                                    "name": "Under",
                                    "description": "Jayson Tatum",
                                    "price": 1.92,
                                    "point": 8.5,
                                },
                            ],
                        },
                    ],
                },
                {
                    "key": "fanduel",
                    "title": "FanDuel",
                    "markets": [
                        {
                            "key": "player_points",
                            "outcomes": [
                                {
                                    "name": "Over",
                                    "description": "Jayson Tatum",
                                    "price": 100,
                                    "point": 26.5,
                                },
                                {
                                    "name": "Under",
                                    "description": "Jayson Tatum",
                                    "price": -125,
                                    "point": 26.5,
                                },
                            ],
                        },
                        {
                            "key": "player_rebounds",
                            "outcomes": [
                                {
                                    "name": "Over",
                                    "description": "Jayson Tatum",
                                    "price": 2.02,
                                    "point": 8.5,
                                },
                                {
                                    "name": "Under",
                                    "description": "Jayson Tatum",
                                    "price": 1.82,
                                    "point": 8.5,
                                },
                            ],
                        },
                    ],
                },
            ],
        },
        {
            "id": "nba_gsw_lal_002",
            "sport_key": "basketball_nba",
            "commence_time": tomorrow_time,
            "home_team": "Los Angeles Lakers",
            "away_team": "Golden State Warriors",
            "bookmakers": [
                {
                    "key": "pinnacle",
                    "title": "Pinnacle",
                    "markets": [
                        {
                            "key": "player_threes",
                            "outcomes": [
                                {
                                    "name": "Over",
                                    "description": "Stephen Curry",
                                    "price": 1.95,
                                    "point": 4.5,
                                },
                                {
                                    "name": "Under",
                                    "description": "Stephen Curry",
                                    "price": 1.88,
                                    "point": 4.5,
                                },
                            ],
                        }
                    ],
                },
                {
                    "key": "draftkings",
                    "title": "DraftKings",
                    "markets": [
                        {
                            "key": "player_threes",
                            "outcomes": [
                                {
                                    "name": "Over",
                                    "description": "Stephen Curry",
                                    "price": 2.08,
                                    "point": 4.5,
                                },
                                {
                                    "name": "Under",
                                    "description": "Stephen Curry",
                                    "price": 1.78,
                                    "point": 4.5,
                                },
                            ],
                        }
                    ],
                },
            ],
        },
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("Authorization") == "Bearer test_live_key"
        path = request.url.path
        if "/sports/americanfootball_nfl/odds" in path:
            return httpx.Response(200, json=nfl_events)
        if "/sports/basketball_nba/odds" in path:
            return httpx.Response(200, json=nba_events)
        return httpx.Response(404, json={"error": "not found"})

    return httpx.MockTransport(handler)


# ---------------------------------------------------------------------------
# Matrix Row 1: Upstream happy path & malformed individual prop isolation
# ---------------------------------------------------------------------------


def test_upstream_happy_path_persists_db_caches_redis_and_skips_malformed_props(
    db_session: tuple[Session, Any, Any],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Upstream NFL + NBA events & two-way props persist to DB, warm 45s Redis caches, publish deltas, and isolate malformed props."""
    session, _, _ = db_session
    fake_redis = FakeRedisClient()
    fixed_now = datetime(2026, 11, 12, 15, 0, tzinfo=UTC)

    transport = _build_upstream_mock_transport(fixed_now, include_malformed_prop=True)
    with httpx.Client(transport=transport) as http_client:
        with caplog.at_level(logging.WARNING):
            result = run_live_slate_sync(
                session=session,
                redis_client=fake_redis,
                http_client=http_client,
                api_key="test_live_key",
                base_url="https://api.parlay-api.com/v1",
                now_utc=fixed_now,
            )

    assert result.status == "ok"
    assert result.source == "upstream"
    assert result.teams_upserted == 8
    assert result.events_upserted == 4
    assert result.props_evaluated == 6
    assert result.props_outlier_blocked == 0
    assert result.props_skipped_malformed == 2
    assert result.market_browser_games == 4
    assert result.market_browser_props == 6
    assert result.odds_deltas_published == 4
    assert "Broken Player" in caplog.text

    teams = list(session.scalars(select(Team)).all())
    events = list(session.scalars(select(Event)).all())
    props = list(session.scalars(select(PlayerProp)).all())

    assert len(teams) == 8
    assert len(events) == 4
    assert len(props) == 6
    assert all(t.external_provider_id.startswith("papi_") for t in teams)
    assert all(e.external_provider_id.startswith("papi_") for e in events)
    assert all(p.external_provider_id.startswith("papi_") for p in props)
    assert all(e.status == "SCHEDULED" for e in events)
    assert all(p.fair_probability is not None and p.guarded_ev is not None for p in props)

    # Check weather persistence on Bills home game
    bills_game = next(e for e in events if e.external_provider_id == "papi_nfl_kc_buf_001")
    assert bills_game.weather_wind_mph == Decimal("17.50")

    # Verify Redis 45s TTL keys
    expected_keys = (
        "presets:feed:all",
        "presets:feed:nfl",
        "presets:feed:nba",
        "markets:browser:all",
        "markets:browser:nfl",
        "markets:browser:nba",
        ev_feed_key("americanfootball_nfl"),
        ev_feed_key("basketball_nba"),
    )
    for key in expected_keys:
        assert key in fake_redis.store, f"Missing Redis key: {key}"
        assert fake_redis.ttl(key) == HOT_CACHE_TTL_SECONDS == 45

    browser_all = json.loads(fake_redis.store["markets:browser:all"])
    assert len(browser_all["games"]) == 4
    assert len(browser_all["props"]) == 6
    assert "Broken Player" not in fake_redis.store["markets:browser:all"]

    # Verify odds:latest:{sport_key}:{event_id} and Pub/Sub odds:feed:{sport_key}
    for event in events:
        latest_k = odds_latest_key(event.sport_key, event.event_id)
        assert latest_k in fake_redis.store
        assert fake_redis.ttl(latest_k) == 45

    published_channels = {ch for ch, _ in fake_redis.published}
    assert odds_feed_channel("americanfootball_nfl") in published_channels
    assert odds_feed_channel("basketball_nba") in published_channels
    for _, msg in fake_redis.published:
        frame = json.loads(msg)
        assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", frame["updated_at"])
        assert len(frame["quotes"]) >= 1


# ---------------------------------------------------------------------------
# Matrix Row 2: Missing/placeholder API key fallback & deterministic seed slate
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("api_key", ["", "   ", "replace_with_parlay_api_key"])
def test_missing_or_placeholder_api_key_falls_back_to_seed_without_http(
    db_session: tuple[Session, Any, Any],
    caplog: pytest.LogCaptureFixture,
    api_key: str,
) -> None:
    """Blank or placeholder PARLAY_API_KEY activates deterministic local seed slate without HTTP calls."""
    session, _, _ = db_session
    fake_redis = FakeRedisClient()
    fixed_now = datetime(2026, 11, 15, 18, 30, tzinfo=UTC)  # Sunday

    def fail_if_called(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected HTTP request: {request.url}")

    with httpx.Client(transport=httpx.MockTransport(fail_if_called)) as http_client:
        with caplog.at_level(logging.INFO):
            result = run_live_slate_sync(
                session=session,
                redis_client=fake_redis,
                http_client=http_client,
                api_key=api_key,
                base_url="https://api.parlay-api.com/v1",
                now_utc=fixed_now,
            )

    assert result.source == "seed"
    assert result.status == "ok"
    assert "seed" in caplog.text.lower()
    assert result.teams_upserted == 12
    assert result.events_upserted == 6
    assert result.props_evaluated == 12
    assert result.props_outlier_blocked == 0
    assert result.market_browser_games == 6
    assert result.market_browser_props == 12
    assert result.presets_generated == 5
    assert result.odds_deltas_published == 6

    db_props = list(session.scalars(select(PlayerProp)).all())
    assert len(db_props) == 12
    assert all(
        p.hit_rate_l5 is not None and p.hit_rate_l10 is not None and p.hit_rate_season is not None
        for p in db_props
    )

    browser_all = json.loads(fake_redis.store["markets:browser:all"])
    assert all(row["hitRateL10"] is not None for row in browser_all["props"])
    windows = {g["dateWindow"] for g in browser_all["games"]}
    sports = {g["sportKey"] for g in browser_all["games"]}
    assert windows == {"today", "tomorrow", "weekend"}
    assert sports == {"nfl", "nba"}

    ev_nfl = json.loads(fake_redis.store[ev_feed_key("americanfootball_nfl")])
    assert any(item["value_tier"] == "HIGH_VALUE" for item in ev_nfl["items"])

    for key in (
        "presets:feed:all",
        "presets:feed:nfl",
        "presets:feed:nba",
        "markets:browser:all",
        "markets:browser:nfl",
        "markets:browser:nba",
        ev_feed_key("americanfootball_nfl"),
        ev_feed_key("basketball_nba"),
    ):
        assert key in fake_redis.store
        assert fake_redis.ttl(key) == 45

    presets_nfl = json.loads(fake_redis.store["presets:feed:nfl"])
    presets_nba = json.loads(fake_redis.store["presets:feed:nba"])
    assert len(presets_nfl["cards"]) >= 1
    assert len(presets_nba["cards"]) >= 1


@pytest.mark.parametrize(
    "anchor_time",
    [
        datetime(2026, 11, 11, 15, 0, tzinfo=UTC),  # Wednesday afternoon
        datetime(2026, 11, 15, 18, 30, tzinfo=UTC),  # Sunday afternoon
        datetime(2026, 11, 14, 23, 30, tzinfo=UTC),  # Saturday late night UTC
        datetime(2026, 11, 14, 23, 59, 59, 900000, tzinfo=UTC),  # Final second of UTC day
    ],
)
def test_build_local_seed_slate_covers_all_windows_deterministically(
    anchor_time: datetime,
) -> None:
    """build_local_seed_slate produces deterministic seed_ IDs and spans today, tomorrow, weekend on any day/hour."""
    slate_a = build_local_seed_slate(now_utc=anchor_time)
    slate_b = build_local_seed_slate(now_utc=anchor_time)
    assert slate_a.model_dump() == slate_b.model_dump()

    assert slate_a.source == "seed"
    assert all(t.external_provider_id.startswith("seed_") for t in slate_a.teams)
    assert all(e.external_provider_id.startswith("seed_") for e in slate_a.events)
    assert all(p.external_provider_id.startswith("seed_") for p in slate_a.props)
    assert all(e.commence_time > anchor_time for e in slate_a.events)

    from parlaypal_worker.market_browser import classify_date_window

    windows = {classify_date_window(e.commence_time, anchor_time) for e in slate_a.events}
    assert windows == {"today", "tomorrow", "weekend"}


# ---------------------------------------------------------------------------
# Matrix Row 3: Upstream HTTP errors, timeouts, transport errors, and empty slate
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "failure_mode",
    [
        "http_500",
        "http_401",
        "http_429",
        "timeout",
        "transport",
        "empty_list",
        "past_events_only",
        "bad_json",
    ],
)
def test_upstream_failures_and_empty_responses_fall_back_to_seed_slate(
    db_session: tuple[Session, Any, Any],
    caplog: pytest.LogCaptureFixture,
    failure_mode: str,
) -> None:
    """Upstream 4xx/5xx, timeout, transport error, invalid JSON, or 0 upcoming events fall back cleanly without crashing."""
    session, _, _ = db_session
    fake_redis = FakeRedisClient()
    fixed_now = datetime(2026, 11, 12, 16, 0, tzinfo=UTC)

    def handler(request: httpx.Request) -> httpx.Response:
        if failure_mode == "http_500":
            return httpx.Response(500, json={"error": "server error"})
        if failure_mode == "http_401":
            return httpx.Response(401, json={"error": "unauthorized"})
        if failure_mode == "http_429":
            return httpx.Response(429, json={"error": "rate limited"})
        if failure_mode == "timeout":
            raise httpx.ReadTimeout("upstream timed out", request=request)
        if failure_mode == "transport":
            raise httpx.ConnectError("connection refused", request=request)
        if failure_mode == "empty_list":
            return httpx.Response(200, json=[])
        if failure_mode == "past_events_only":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": "papi_past_1",
                        "sport_key": request.url.path.split("/")[3],
                        "commence_time": (fixed_now - timedelta(hours=2)).strftime(
                            "%Y-%m-%dT%H:%M:%SZ"
                        ),
                        "home_team": "Buffalo Bills",
                        "away_team": "Kansas City Chiefs",
                        "bookmakers": [],
                    }
                ],
            )
        return httpx.Response(200, text="{not valid json")

    with httpx.Client(transport=httpx.MockTransport(handler)) as http_client:
        with caplog.at_level(logging.WARNING):
            result = run_live_slate_sync(
                session=session,
                redis_client=fake_redis,
                http_client=http_client,
                api_key="test_live_key",
                base_url="https://api.parlay-api.com/v1",
                now_utc=fixed_now,
            )

    assert result.status == "ok"
    assert result.source == "seed"
    assert result.market_browser_props >= 6
    assert "markets:browser:all" in fake_redis.store
    assert "presets:feed:all" in fake_redis.store
    assert fake_redis.ttl("markets:browser:all") == 45


def test_fetch_upstream_slate_raises_structured_error_on_http_failure() -> None:
    """fetch_upstream_slate raises UpstreamIngestionError when upstream endpoints fail."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "service unavailable"})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(UpstreamIngestionError):
            fetch_upstream_slate(
                api_key="test_live_key",
                base_url="https://api.parlay-api.com/v1",
                http_client=client,
            )


# ---------------------------------------------------------------------------
# Matrix Row 4: Commenced game transition
# ---------------------------------------------------------------------------


def test_commenced_event_transition_and_feed_exclusion(
    db_session: tuple[Session, Any, Any],
) -> None:
    """SCHEDULED events with commence_time <= now_utc transition to COMMENCED and drop out of Redis feeds."""
    session, _, _ = db_session
    fake_redis = FakeRedisClient()
    fixed_now = datetime(2026, 11, 15, 18, 30, tzinfo=UTC)

    home = Team(
        external_provider_id="papi_nfl_team_kc",
        sport_key="americanfootball_nfl",
        name="Kansas City Chiefs",
        abbreviation="KC",
    )
    away = Team(
        external_provider_id="papi_nfl_team_den",
        sport_key="americanfootball_nfl",
        name="Denver Broncos",
        abbreviation="DEN",
    )
    session.add_all([home, away])
    session.flush()

    past_event = Event(
        external_provider_id="papi_nfl_past_commence",
        sport_key="americanfootball_nfl",
        home_team_id=home.team_id,
        away_team_id=away.team_id,
        commence_time=fixed_now - timedelta(minutes=5),
        status="SCHEDULED",
    )
    session.add(past_event)
    session.flush()

    past_prop = PlayerProp(
        external_provider_id="papi_prop_past_commence",
        event_id=past_event.event_id,
        team_id=home.team_id,
        player_name="Already Started QB",
        market_key="player_pass_yds",
        selection="OVER",
        line_value=Decimal("250.50"),
        offered_decimal_odds=Decimal("2.0500"),
        sharp_decimal_odds=Decimal("1.9000"),
        fair_probability=Decimal("0.51000"),
        guarded_ev=Decimal("0.04550"),
        hit_rate_l10=Decimal("0.8000"),
        status="ACTIVE",
    )
    session.add(past_prop)
    session.commit()

    result = run_live_slate_sync(
        session=session,
        redis_client=fake_redis,
        api_key="",
        now_utc=fixed_now,
    )

    assert result.commenced_transitioned == 1
    session.refresh(past_event)
    assert past_event.status == "COMMENCED"

    # Excluded from presets, market browser, and odds:latest / odds:feed
    assert "Already Started QB" not in fake_redis.store["markets:browser:all"]
    assert "Already Started QB" not in fake_redis.store["presets:feed:all"]
    assert odds_latest_key("americanfootball_nfl", past_event.event_id) not in fake_redis.store
    for _, msg in fake_redis.published:
        assert str(past_event.event_id) not in msg


# ---------------------------------------------------------------------------
# Matrix Row 5: Outlier prop circuit breaker (> 10.0% EV)
# ---------------------------------------------------------------------------


def test_outlier_prop_stamped_suspect_stale_line_and_excluded_from_all_feeds(
    db_session: tuple[Session, Any, Any],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Props with guarded_ev > 10.0% are stamped SUSPECT_STALE_LINE in DB and excluded from all Redis feeds."""
    session, _, _ = db_session
    fake_redis = FakeRedisClient()
    fixed_now = datetime(2026, 11, 12, 15, 0, tzinfo=UTC)

    transport = _build_upstream_mock_transport(fixed_now, include_outlier_prop=True)
    with httpx.Client(transport=transport) as http_client:
        with caplog.at_level(logging.WARNING):
            result = run_live_slate_sync(
                session=session,
                redis_client=fake_redis,
                http_client=http_client,
                api_key="test_live_key",
                base_url="https://api.parlay-api.com/v1",
                now_utc=fixed_now,
            )

    assert result.props_evaluated == 7
    assert result.props_outlier_blocked == 1
    assert "Outlier Circuit Breaker" in caplog.text

    outlier_prop = session.scalar(
        select(PlayerProp).where(PlayerProp.player_name == "Stale Outlier RB")
    )
    assert outlier_prop is not None
    assert outlier_prop.status == "SUSPECT_STALE_LINE"
    assert outlier_prop.guarded_ev is not None
    assert outlier_prop.guarded_ev > Decimal("0.10000")

    for redis_key in (
        ev_feed_key("americanfootball_nfl"),
        "presets:feed:all",
        "presets:feed:nfl",
        "markets:browser:all",
        "markets:browser:nfl",
    ):
        assert "Stale Outlier RB" not in fake_redis.store[redis_key]

    for _, pub_msg in fake_redis.published:
        assert "Stale Outlier RB" not in pub_msg


# ---------------------------------------------------------------------------
# Matrix Row 6: Idempotent re-run / upsert preserving UUID primary keys
# ---------------------------------------------------------------------------


def test_idempotent_rerun_updates_in_place_without_duplicates(
    db_session: tuple[Session, Any, Any],
) -> None:
    """Running sync twice consecutively with identical external_provider_ids preserves UUIDs and row counts."""
    session, _, _ = db_session
    fake_redis = FakeRedisClient()
    fixed_now = datetime(2026, 11, 15, 18, 30, tzinfo=UTC)

    run_live_slate_sync(
        session=session,
        redis_client=fake_redis,
        api_key="",
        now_utc=fixed_now,
    )

    teams_1 = {t.external_provider_id: t.team_id for t in session.scalars(select(Team)).all()}
    events_1 = {e.external_provider_id: e.event_id for e in session.scalars(select(Event)).all()}
    props_1 = {p.external_provider_id: p.prop_id for p in session.scalars(select(PlayerProp)).all()}

    # Second run 30 seconds later
    run_live_slate_sync(
        session=session,
        redis_client=fake_redis,
        api_key="",
        now_utc=fixed_now + timedelta(seconds=30),
    )

    teams_2 = {t.external_provider_id: t.team_id for t in session.scalars(select(Team)).all()}
    events_2 = {e.external_provider_id: e.event_id for e in session.scalars(select(Event)).all()}
    props_2 = {p.external_provider_id: p.prop_id for p in session.scalars(select(PlayerProp)).all()}

    assert teams_1 == teams_2
    assert events_1 == events_2
    assert props_1 == props_2


def test_upsert_slate_to_db_updates_existing_prop_odds_in_place(
    db_session: tuple[Session, Any, Any],
) -> None:
    """upsert_slate_to_db updates existing PlayerProp odds in place while preserving UUIDs."""
    session, _, _ = db_session
    fake_redis = FakeRedisClient()
    fixed_now = datetime(2026, 11, 12, 15, 0, tzinfo=UTC)

    def make_slate(offered: Decimal) -> IngestedSlate:
        return IngestedSlate(
            source="upstream",
            generated_at=fixed_now,
            teams=[
                IngestedTeam(
                    external_provider_id="papi_nba_team_bos",
                    sport_key="basketball_nba",
                    name="Boston Celtics",
                    abbreviation="BOS",
                    is_dome=True,
                ),
                IngestedTeam(
                    external_provider_id="papi_nba_team_nyk",
                    sport_key="basketball_nba",
                    name="New York Knicks",
                    abbreviation="NYK",
                    is_dome=True,
                ),
            ],
            events=[
                IngestedEvent(
                    external_provider_id="papi_nba_evt_1",
                    sport_key="basketball_nba",
                    home_team_external_id="papi_nba_team_nyk",
                    away_team_external_id="papi_nba_team_bos",
                    commence_time=fixed_now + timedelta(hours=4),
                    is_dome=True,
                )
            ],
            props=[
                IngestedProp(
                    external_provider_id="papi_prop_tatum_pts",
                    event_external_id="papi_nba_evt_1",
                    sport_key="basketball_nba",
                    team_external_id="papi_nba_team_bos",
                    player_name="Jayson Tatum",
                    market_key="player_points",
                    selection="OVER",
                    line_value=Decimal("26.5"),
                    offered_decimal_odds=offered,
                    sharp_decimal_odds=Decimal("1.9000"),
                    opposite_sharp_decimal_odds=Decimal("1.9200"),
                )
            ],
        )

    upsert_slate_to_db(
        session, make_slate(Decimal("2.0000")), now_utc=fixed_now, redis_client=fake_redis
    )
    prop_first = session.scalar(
        select(PlayerProp).where(PlayerProp.external_provider_id == "papi_prop_tatum_pts")
    )
    assert prop_first is not None
    original_prop_id = prop_first.prop_id

    upsert_slate_to_db(
        session,
        make_slate(Decimal("2.0600")),
        now_utc=fixed_now + timedelta(seconds=30),
        redis_client=fake_redis,
    )
    all_props = list(session.scalars(select(PlayerProp)).all())
    assert len(all_props) == 1
    assert all_props[0].prop_id == original_prop_id
    assert all_props[0].offered_decimal_odds == Decimal("2.0600")


# ---------------------------------------------------------------------------
# Matrix Row 7: 30s Celery Beat schedule, task registration & cold-start schema
# ---------------------------------------------------------------------------


def test_celery_sync_live_slate_task_registration_and_beat_schedule() -> None:
    """Verify parlaypal_worker.sync_live_slate is registered on a 30.0s Beat interval with expiry."""
    assert "parlaypal_worker.sync_live_slate" in celery_app.tasks

    beat_schedule = celery_app.conf.beat_schedule
    assert "sync-live-slate-every-30s" in beat_schedule
    entry = beat_schedule["sync-live-slate-every-30s"]
    assert entry["task"] == "parlaypal_worker.sync_live_slate"
    assert entry["schedule"] == 30.0
    assert entry["options"]["expires"] == 25.0

    # Existing CLV schedule remains intact
    assert "stamp-closing-line-value-every-minute" in beat_schedule
    assert beat_schedule["stamp-closing-line-value-every-minute"]["schedule"] == 60.0


def test_celery_sync_live_slate_task_execution_and_resource_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify sync_live_slate closes owned Session/Redis on both normal exit and Redis error."""
    engine = create_engine("sqlite:///:memory:")
    session_factory = create_session_factory(engine)
    fake_redis = FakeRedisClient()

    session_closed_flags: list[bool] = []

    def tracked_session_factory() -> Session:
        s = session_factory()
        idx = len(session_closed_flags)
        session_closed_flags.append(False)
        orig_close = s.close

        def wrapped_close() -> None:
            session_closed_flags[idx] = True
            orig_close()

        monkeypatch.setattr(s, "close", wrapped_close)
        return s

    monkeypatch.setattr(
        celery_app_module, "create_session_factory", lambda: tracked_session_factory
    )
    monkeypatch.setattr(celery_app_module, "get_redis_client", lambda: fake_redis)
    monkeypatch.setenv("PARLAY_API_KEY", "replace_with_parlay_api_key")

    from parlaypal_worker.config import get_settings

    get_settings.cache_clear()
    try:
        result = sync_live_slate()
    finally:
        get_settings.cache_clear()

    assert result["status"] == "ok"
    assert result["source"] == "seed"
    assert result["market_browser_props"] == 12
    assert result["market_browser_games"] == 6
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", result["synced_at"])
    assert fake_redis.closed is True
    assert session_closed_flags == [True]
    assert fake_redis.ttl("markets:browser:all") == 45
    assert fake_redis.ttl("presets:feed:all") == 45

    with session_factory() as verify_session:
        inspector = inspect(engine)
        assert inspector.has_table("player_props")
        assert len(list(verify_session.scalars(select(Event)).all())) == 6
        assert len(list(verify_session.scalars(select(PlayerProp)).all())) == 12

    # Exception path when get_redis_client raises must also close the owned Session
    def fail_redis() -> Any:
        raise RuntimeError("redis unreachable")

    monkeypatch.setattr(celery_app_module, "get_redis_client", fail_redis)
    get_settings.cache_clear()
    try:
        with pytest.raises(RuntimeError, match="redis unreachable"):
            sync_live_slate()
    finally:
        get_settings.cache_clear()

    assert session_closed_flags == [True, True]
    engine.dispose()


# ---------------------------------------------------------------------------
# Matrix Row 8: Partial upstream failure, seed retirement & prop lifecycle
# ---------------------------------------------------------------------------


def test_partial_sport_http_failure_preserves_sibling_sport_and_ev_feed(
    db_session: tuple[Session, Any, Any],
) -> None:
    """Single-sport HTTP failure keeps existing sibling sport DB rows and ev:feed untouched."""
    session, _, _ = db_session
    fake_redis = FakeRedisClient()
    fixed_now = datetime(2026, 11, 12, 15, 0, tzinfo=UTC)

    # Run 1: both NFL and NBA succeed
    with httpx.Client(transport=_build_upstream_mock_transport(fixed_now)) as client:
        run_live_slate_sync(
            session=session,
            redis_client=fake_redis,
            http_client=client,
            api_key="test_live_key",
            base_url="https://api.parlay-api.com/v1",
            now_utc=fixed_now,
        )

    prior_nfl_ev_feed = fake_redis.store[ev_feed_key("americanfootball_nfl")]
    assert len(json.loads(prior_nfl_ev_feed)["items"]) >= 1

    # Run 2: NFL fails HTTP 500 while NBA succeeds
    nba_only_transport = _build_upstream_mock_transport(fixed_now)

    def partial_handler(request: httpx.Request) -> httpx.Response:
        if "/sports/americanfootball_nfl/odds" in request.url.path:
            return httpx.Response(500, json={"error": "nfl down"})
        return nba_only_transport.handle_request(request)

    with httpx.Client(transport=httpx.MockTransport(partial_handler)) as client:
        res_partial = run_live_slate_sync(
            session=session,
            redis_client=fake_redis,
            http_client=client,
            api_key="test_live_key",
            base_url="https://api.parlay-api.com/v1",
            now_utc=fixed_now + timedelta(seconds=30),
        )

    assert res_partial.source == "upstream"
    assert fake_redis.store[ev_feed_key("americanfootball_nfl")] == prior_nfl_ev_feed
    browser_all = json.loads(fake_redis.store["markets:browser:all"])
    assert {g["sportKey"] for g in browser_all["games"]} == {"nfl", "nba"}


def test_upcoming_events_with_empty_props_falls_back_to_seed(
    db_session: tuple[Session, Any, Any],
) -> None:
    """Upstream returning future events with zero props triggers deterministic seed fallback."""
    session, _, _ = db_session
    fake_redis = FakeRedisClient()
    fixed_now = datetime(2026, 11, 12, 15, 0, tzinfo=UTC)

    def empty_props_handler(request: httpx.Request) -> httpx.Response:
        sport_key = request.url.path.split("/")[3]
        home = "Buffalo Bills" if "nfl" in sport_key else "New York Knicks"
        away = "Kansas City Chiefs" if "nfl" in sport_key else "Boston Celtics"
        return httpx.Response(
            200,
            json=[
                {
                    "id": f"empty_props_{sport_key}",
                    "sport_key": sport_key,
                    "commence_time": (fixed_now + timedelta(hours=4)).strftime(
                        "%Y-%m-%dT%H:%M:%SZ"
                    ),
                    "home_team": home,
                    "away_team": away,
                    "bookmakers": [],
                }
            ],
        )

    with httpx.Client(transport=httpx.MockTransport(empty_props_handler)) as client:
        result = run_live_slate_sync(
            session=session,
            redis_client=fake_redis,
            http_client=client,
            api_key="test_live_key",
            base_url="https://api.parlay-api.com/v1",
            now_utc=fixed_now,
        )

    assert result.source == "seed"
    assert result.market_browser_props == 12


def test_seed_rows_retired_upon_upstream_recovery(
    db_session: tuple[Session, Any, Any],
) -> None:
    """Transient seed_* events/props are retired (CANCELLED/SUSPENDED) when live upstream recovers."""
    session, _, _ = db_session
    fake_redis = FakeRedisClient()
    fixed_now = datetime(2026, 11, 12, 15, 0, tzinfo=UTC)

    # First run with placeholder key seeds the DB
    run_live_slate_sync(
        session=session,
        redis_client=fake_redis,
        api_key="",
        now_utc=fixed_now,
    )
    assert any(e.external_provider_id.startswith("seed_") for e in session.scalars(select(Event)))

    # Second run recovers with upstream feed
    with httpx.Client(transport=_build_upstream_mock_transport(fixed_now)) as client:
        res_recovered = run_live_slate_sync(
            session=session,
            redis_client=fake_redis,
            http_client=client,
            api_key="test_live_key",
            base_url="https://api.parlay-api.com/v1",
            now_utc=fixed_now + timedelta(seconds=30),
        )

    assert res_recovered.source == "upstream"
    seed_events = list(
        session.scalars(select(Event).where(Event.external_provider_id.like("seed_%"))).all()
    )
    seed_props = list(
        session.scalars(
            select(PlayerProp).where(PlayerProp.external_provider_id.like("seed_%"))
        ).all()
    )
    assert seed_events and all(ev.status == "CANCELLED" for ev in seed_events)
    assert seed_props and all(pr.status == "SUSPENDED" for pr in seed_props)

    browser_all = json.loads(fake_redis.store["markets:browser:all"])
    assert len(browser_all["games"]) == 4
    assert all(
        p["eventId"] in {g["eventId"] for g in browser_all["games"]} for p in browser_all["props"]
    )


def test_moved_flipped_dropped_and_rejected_props_suspended_on_synced_events(
    db_session: tuple[Session, Any, Any],
) -> None:
    """Missing/moved/side-flipped/malformed props on synced events retire prior ACTIVE rows to SUSPENDED."""
    session, _, _ = db_session
    fake_redis = FakeRedisClient()
    fixed_now = datetime(2026, 11, 12, 15, 0, tzinfo=UTC)

    teams = [
        IngestedTeam(
            external_provider_id="papi_nba_team_bos",
            sport_key="basketball_nba",
            name="Boston Celtics",
            abbreviation="BOS",
            is_dome=True,
        ),
        IngestedTeam(
            external_provider_id="papi_nba_team_nyk",
            sport_key="basketball_nba",
            name="New York Knicks",
            abbreviation="NYK",
            is_dome=True,
        ),
    ]
    evt = IngestedEvent(
        external_provider_id="papi_nba_evt_rot",
        sport_key="basketball_nba",
        home_team_external_id="papi_nba_team_nyk",
        away_team_external_id="papi_nba_team_bos",
        commence_time=fixed_now + timedelta(hours=3),
        is_dome=True,
    )

    def prop(
        ext_id: str,
        player: str,
        selection: str = "OVER",
        line: Decimal = Decimal("20.5"),
        sharp: Decimal = Decimal("1.90"),
    ) -> IngestedProp:
        return IngestedProp(
            external_provider_id=ext_id,
            event_external_id="papi_nba_evt_rot",
            sport_key="basketball_nba",
            team_external_id="papi_nba_team_bos",
            player_name=player,
            market_key="player_points",
            selection=selection,  # type: ignore[arg-type]
            line_value=line,
            offered_decimal_odds=Decimal("2.0200"),
            sharp_decimal_odds=sharp,
            opposite_sharp_decimal_odds=Decimal("1.9000"),
        )

    slate_1 = IngestedSlate(
        source="upstream",
        generated_at=fixed_now,
        teams=teams,
        events=[evt],
        props=[
            prop("papi_prop_keep", "Keep Player"),
            prop("papi_prop_moved_old", "Moved Player", line=Decimal("20.5")),
            prop("papi_prop_flipped_old", "Flipped Player", selection="OVER"),
            prop("papi_prop_dropped", "Dropped Player"),
            prop("papi_prop_bad", "Degraded Player"),
        ],
    )
    upsert_slate_to_db(session, slate_1, now_utc=fixed_now, redis_client=fake_redis)

    # Poll 2: Keep remains, Moved moves line, Flipped flips UNDER, Dropped omitted, Degraded fails validation
    slate_2 = IngestedSlate(
        source="upstream",
        generated_at=fixed_now + timedelta(seconds=30),
        teams=teams,
        events=[evt],
        props=[
            prop("papi_prop_keep", "Keep Player"),
            prop("papi_prop_moved_new", "Moved Player", line=Decimal("22.5")),
            prop("papi_prop_flipped_new", "Flipped Player", selection="UNDER"),
            prop(
                "papi_prop_bad", "Degraded Player", sharp=Decimal("5.0000")
            ),  # sub-1 overround -> rejected!
        ],
    )
    res_2 = upsert_slate_to_db(
        session, slate_2, now_utc=fixed_now + timedelta(seconds=30), redis_client=fake_redis
    )
    assert res_2.props_skipped_malformed == 1

    props_by_ext = {
        p.external_provider_id: p.status for p in session.scalars(select(PlayerProp)).all()
    }
    assert props_by_ext["papi_prop_keep"] == "ACTIVE"
    assert props_by_ext["papi_prop_moved_new"] == "ACTIVE"
    assert props_by_ext["papi_prop_flipped_new"] == "ACTIVE"
    assert props_by_ext["papi_prop_moved_old"] == "SUSPENDED"
    assert props_by_ext["papi_prop_flipped_old"] == "SUSPENDED"
    assert props_by_ext["papi_prop_dropped"] == "SUSPENDED"
    assert props_by_ext["papi_prop_bad"] == "SUSPENDED"


def test_run_live_slate_sync_scopes_active_props_to_events_map(
    db_session: tuple[Session, Any, Any],
) -> None:
    """run_live_slate_sync scopes PlayerProp queries to scheduled events_map and excludes LIVE event props."""
    session, _, _ = db_session
    fake_redis = FakeRedisClient()
    fixed_now = datetime(2026, 11, 15, 18, 30, tzinfo=UTC)

    home = Team(
        external_provider_id="papi_nfl_team_sf",
        sport_key="americanfootball_nfl",
        name="San Francisco 49ers",
        abbreviation="SF",
    )
    away = Team(
        external_provider_id="papi_nfl_team_sea",
        sport_key="americanfootball_nfl",
        name="Seattle Seahawks",
        abbreviation="SEA",
    )
    session.add_all([home, away])
    session.flush()

    live_event = Event(
        external_provider_id="papi_nfl_live_evt",
        sport_key="americanfootball_nfl",
        home_team_id=home.team_id,
        away_team_id=away.team_id,
        commence_time=fixed_now + timedelta(hours=2),
        status="LIVE",
    )
    session.add(live_event)
    session.flush()

    orphan_active_prop = PlayerProp(
        external_provider_id="papi_prop_live_leak_test",
        event_id=live_event.event_id,
        team_id=home.team_id,
        player_name="Live Event Leak Player",
        market_key="player_pass_yds",
        selection="OVER",
        line_value=Decimal("240.50"),
        offered_decimal_odds=Decimal("2.0500"),
        sharp_decimal_odds=Decimal("1.9000"),
        fair_probability=Decimal("0.51000"),
        guarded_ev=Decimal("0.04550"),
        hit_rate_l10=Decimal("0.8000"),
        status="ACTIVE",
    )
    session.add(orphan_active_prop)
    session.commit()

    run_live_slate_sync(session=session, redis_client=fake_redis, api_key="", now_utc=fixed_now)
    assert "Live Event Leak Player" not in fake_redis.store["markets:browser:all"]
    assert "Live Event Leak Player" not in fake_redis.store["presets:feed:all"]
    for _, msg in fake_redis.published:
        assert "Live Event Leak Player" not in msg


# ---------------------------------------------------------------------------
# Matrix Row 9: Upstream parser edges, team resolution, status & DB/Redis safety
# ---------------------------------------------------------------------------


def test_under_favored_prop_selection_and_team_id_resolution(
    db_session: tuple[Session, Any, Any],
) -> None:
    """Bookmaker UNDER-favored selection, team metadata matching, and DB Team fallback populate PlayerProp.team_id."""
    session, _, _ = db_session
    fake_redis = FakeRedisClient()
    fixed_now = datetime(2026, 11, 12, 15, 0, tzinfo=UTC)

    raw_event = {
        "id": 0,  # integer 0 ID supported
        "sport_key": "americanfootball_nfl",
        "commence_time": (fixed_now + timedelta(hours=4)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "home_team": "Buffalo Bills",
        "away_team": "Kansas City Chiefs",
        "is_dome": None,  # null inherits home_team.is_dome (False)
        "bookmakers": [
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
                                "point": 275.5,
                                "team": "KC",
                            },
                            {
                                "name": "Under",
                                "description": "Patrick Mahomes",
                                "price": 1.92,
                                "point": 275.5,
                                "team": "KC",
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
                                "price": 1.80,
                                "point": 275.5,
                            },
                            {
                                "name": "Under",
                                "description": "Patrick Mahomes",
                                "price": 2.12,
                                "point": 275.5,
                            },
                        ],
                    }
                ],
            },
        ],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if "americanfootball_nfl" in request.url.path:
            return httpx.Response(200, json={"events": [raw_event], "data": [{"id": "ignored"}]})
        return httpx.Response(200, json={"events": [], "data": [{"id": "ignored_nba"}]})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        slate = fetch_upstream_slate(
            api_key="test_live_key",
            base_url="https://api.parlay-api.com/v1",
            http_client=client,
            now_utc=fixed_now,
        )

    assert len(slate.events) == 1
    assert slate.events[0].external_provider_id == "papi_nfl_0"
    assert slate.events[0].is_dome is False
    assert len(slate.props) == 1
    prop_in = slate.props[0]
    assert prop_in.selection == "UNDER"
    assert prop_in.offered_decimal_odds == Decimal("2.1200")
    assert prop_in.sharp_decimal_odds == Decimal("1.9200")
    assert prop_in.opposite_sharp_decimal_odds == Decimal("1.9000")
    assert prop_in.team_external_id is not None and "kc" in prop_in.team_external_id

    # Persist teams+event first, then upsert a standalone slate with teams=[] to verify DB Team fallback
    upsert_slate_to_db(session, slate, now_utc=fixed_now, redis_client=fake_redis)
    db_team = session.scalar(select(Team).where(Team.abbreviation == "KC"))
    assert db_team is not None

    standalone_prop = IngestedProp(
        external_provider_id="papi_prop_standalone_team_lookup",
        event_external_id=slate.events[0].external_provider_id,
        sport_key="americanfootball_nfl",
        team_external_id=db_team.external_provider_id,
        player_name="Travis Kelce",
        market_key="player_reception_yds",
        selection="OVER",
        line_value=Decimal("64.5"),
        offered_decimal_odds=Decimal("2.0500"),
        sharp_decimal_odds=Decimal("1.9000"),
        opposite_sharp_decimal_odds=Decimal("1.9200"),
    )
    upsert_slate_to_db(
        session,
        IngestedSlate(
            source="upstream",
            generated_at=fixed_now,
            teams=[],
            events=[],
            props=[standalone_prop],
        ),
        now_utc=fixed_now,
        redis_client=fake_redis,
    )
    kelce_row = session.scalar(
        select(PlayerProp).where(
            PlayerProp.external_provider_id == "papi_prop_standalone_team_lookup"
        )
    )
    assert kelce_row is not None
    assert kelce_row.team_id == db_team.team_id


def test_parse_odds_to_decimal_and_optional_decimal_consistency() -> None:
    """_parse_odds_to_decimal treats American & Decimal formats consistently across str/int/float/Decimal."""
    for american_pos in (150, 150.0, "150", "+150", Decimal("150"), Decimal("150.00")):
        assert _parse_odds_to_decimal(american_pos) == Decimal("2.5000")

    for american_neg in (-110, -110.0, "-110", Decimal("-110")):
        assert _parse_odds_to_decimal(american_neg) == Decimal("1.9091")

    for longshot_dec in (105.5, "105.5", Decimal("105.5")):
        assert _parse_odds_to_decimal(longshot_dec) == Decimal("105.5000")
    assert _parse_odds_to_decimal(10000) == Decimal("101.0000")

    assert _parse_optional_decimal("   ") is None
    assert _parse_optional_decimal("") is None
    assert _parse_optional_decimal(None) is None

    for bad_price in (
        "not-a-number",
        "",
        "+50",
        "-50",
        True,
        None,
        "NaN",
        float("inf"),
        0.99,
        10000.5,
        10000000,
    ):
        with pytest.raises(ValueError):
            _parse_odds_to_decimal(bad_price)

    with pytest.raises(ValueError):
        _parse_optional_decimal("bad_decimal")


def test_direct_props_selection_tokens_line_fallback_and_hit_rate_agreement(
    db_session: tuple[Session, Any, Any],
) -> None:
    """_extract_direct_props parses YES/NO, line fallback, hit rates, rejects unknown tokens, and avoids ev:feed/DB divergence."""
    session, _, _ = db_session
    fake_redis = FakeRedisClient()
    fixed_now = datetime(2026, 11, 12, 15, 0, tzinfo=UTC)

    raw_event = {
        "props": [
            {
                "id": "direct_yes",
                "player_name": "Jayson Tatum",
                "market_key": "player_points",
                "selection": "YES",
                "line_value": None,
                "line": 26.5,
                "offered_decimal_odds": 2.10,
                "sharp_decimal_odds": 1.90,
                "opposite_sharp_decimal_odds": 1.92,
                "hit_rate_l5": 0.80,
                "hit_rate_l10": 0.80,
                "hit_rate_season": 0.75,
                "team": "Boston Celtics",
            },
            {
                "id": "direct_no",
                "player_name": "Jalen Brunson",
                "market_key": "player_points",
                "selection": "NO",
                "line": 24.5,
                "offered_decimal_odds": 2.02,
                "sharp_decimal_odds": 1.90,
                "opposite_sharp_decimal_odds": 1.92,
            },
            {
                "id": "direct_invalid",
                "player_name": "Invalid Sel Player",
                "market_key": "player_points",
                "selection": "DRAW",
                "line": 10.5,
                "offered_decimal_odds": 2.00,
                "sharp_decimal_odds": 1.90,
                "opposite_sharp_decimal_odds": 1.90,
            },
        ]
    }
    props, malformed = _extract_direct_props(
        raw_event, event_external_id="papi_nba_evt_direct", sport_key="basketball_nba"
    )
    assert malformed == 1
    assert len(props) == 2
    assert props[0].selection == "OVER"
    assert props[0].line_value == Decimal("26.50")
    assert props[0].hit_rate_l5 == Decimal("0.8000")
    assert props[0].hit_rate_l10 == Decimal("0.8000")
    assert props[0].hit_rate_season == Decimal("0.7500")
    assert props[0].team_external_id is not None
    assert props[1].selection == "UNDER"
    assert props[1].line_value == Decimal("24.50")

    # Verify DB and ev:feed preserve explicit preset 0.8000 even when game_logs compute 0.5000
    teams = [
        IngestedTeam(
            external_provider_id=props[0].team_external_id or "papi_nba_team_bos",
            sport_key="basketball_nba",
            name="Boston Celtics",
            abbreviation="BOS",
            is_dome=True,
        ),
        IngestedTeam(
            external_provider_id="papi_nba_team_nyk",
            sport_key="basketball_nba",
            name="New York Knicks",
            abbreviation="NYK",
            is_dome=True,
        ),
    ]
    evt = IngestedEvent(
        external_provider_id="papi_nba_evt_direct",
        sport_key="basketball_nba",
        home_team_external_id="papi_nba_team_nyk",
        away_team_external_id=teams[0].external_provider_id,
        commence_time=fixed_now + timedelta(hours=3),
        is_dome=True,
    )
    conflicting_logs = [
        IngestedGameLog(
            player_name="Jayson Tatum",
            market_key="player_points",
            stats=[Decimal(v) for v in (30, 30, 30, 30, 30, 10, 10, 10, 10, 10)],  # 0.5000
        )
    ]
    upsert_slate_to_db(
        session,
        IngestedSlate(
            source="upstream",
            generated_at=fixed_now,
            teams=teams,
            events=[evt],
            props=[props[0]],
            game_logs=conflicting_logs,
        ),
        now_utc=fixed_now,
        redis_client=fake_redis,
    )

    tatum_db = session.scalar(
        select(PlayerProp).where(PlayerProp.external_provider_id == props[0].external_provider_id)
    )
    assert tatum_db is not None
    assert tatum_db.hit_rate_l10 == Decimal("0.8000")
    ev_nba = json.loads(fake_redis.store[ev_feed_key("basketball_nba")])
    assert Decimal(ev_nba["items"][0]["hit_rate_l10"]) == Decimal("0.8000")


def test_is_dome_null_provider_ids_outcome_conflicts_and_duplicate_outcomes(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Covers is_dome:null defaults, deterministic provider prefixing, name/description mismatch, and duplicate same-book outcomes."""
    saints = _resolve_team_metadata(
        {"name": "New Orleans Saints", "is_dome": None}, "americanfootball_nfl"
    )
    assert saints.is_dome is True

    det_1 = _ensure_provider_prefix("???", sport_short="nfl")
    det_2 = _ensure_provider_prefix("???", sport_short="nfl")
    assert det_1 == det_2
    assert det_1.startswith("papi_nfl_")

    long_a = _ensure_provider_prefix("x" * 140 + "A", sport_short="nba")
    long_b = _ensure_provider_prefix("x" * 140 + "B", sport_short="nba")
    assert len(long_a) <= 128 and len(long_b) <= 128 and long_a != long_b

    with pytest.raises(ValueError, match="Conflicting"):
        _split_outcome_player_and_side({"name": "Jayson Tatum Over", "description": "Jaylen Brown"})

    # Conflicting duplicate Over prices in FanDuel must warn, increment malformed, and not inflate offered odds to 2.80
    raw_event = {
        "bookmakers": [
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "player_points",
                        "outcomes": [
                            {"name": "Over", "description": "Tatum", "price": 1.91, "point": 26.5},
                            {"name": "Under", "description": "Tatum", "price": 1.91, "point": 26.5},
                        ],
                    }
                ],
            },
            {
                "key": "fanduel",
                "markets": [
                    {
                        "key": "player_points",
                        "outcomes": [
                            {"name": "Over", "description": "Tatum", "price": 1.95, "point": 26.5},
                            {"name": "Over", "description": "Tatum", "price": 2.80, "point": 26.5},
                            {"name": "Under", "description": "Tatum", "price": 1.80, "point": 26.5},
                        ],
                    }
                ],
            },
        ]
    }
    with caplog.at_level(logging.WARNING):
        extracted, malformed = _extract_props_from_bookmakers(
            raw_event, event_external_id="papi_nba_dup_test", sport_key="basketball_nba"
        )
    assert malformed >= 1
    assert "Conflicting duplicate" in caplog.text
    assert len(extracted) == 1
    # FanDuel conflicted group discarded so sharp 1.91 consensus is used rather than inflated 2.80
    assert extracted[0].offered_decimal_odds == Decimal("1.9100")

    # Identical duplicate same-book same-side outcome keeps deterministic price without inflating
    caplog.clear()
    raw_ident_dup = {
        "bookmakers": [
            raw_event["bookmakers"][0],
            {
                "key": "fanduel",
                "markets": [
                    {
                        "key": "player_points",
                        "outcomes": [
                            {"name": "Over", "description": "Tatum", "price": 2.02, "point": 26.5},
                            {"name": "Over", "description": "Tatum", "price": 2.02, "point": 26.5},
                            {"name": "Under", "description": "Tatum", "price": 1.82, "point": 26.5},
                        ],
                    }
                ],
            },
        ]
    }
    with caplog.at_level(logging.WARNING):
        ext_dup, mal_dup = _extract_props_from_bookmakers(
            raw_ident_dup, event_external_id="papi_nba_ident_dup", sport_key="basketball_nba"
        )
    assert mal_dup == 0
    assert "Duplicate identical" in caplog.text
    assert len(ext_dup) == 1
    assert ext_dup[0].offered_decimal_odds == Decimal("2.0200")

    # Event-level is_dome: null inherits True when home_team is Detroit Lions (dome)
    fixed_now = datetime(2026, 11, 12, 15, 0, tzinfo=UTC)
    dome_null_event: dict[str, Any] = {
        "id": "det_null_dome",
        "sport_key": "americanfootball_nfl",
        "commence_time": (fixed_now + timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "home_team": "Detroit Lions",
        "away_team": "Kansas City Chiefs",
        "is_dome": None,
        "bookmakers": [],
    }
    with httpx.Client(
        transport=httpx.MockTransport(lambda req: httpx.Response(200, json=[dome_null_event]))
    ) as client:
        dome_slate = fetch_upstream_slate(
            api_key="test_live_key",
            supported_sports=("americanfootball_nfl",),
            http_client=client,
            now_utc=fixed_now,
        )
    assert dome_slate.events[0].is_dome is True


def test_weather_bounds_outdoor_clear_badge_and_non_scheduled_status_preservation(
    db_session: tuple[Session, Any, Any],
) -> None:
    """Weather bounds enforce Numeric(5,2), outdoor events get Redis Clear badge, and LIVE/POSTPONED statuses are preserved."""
    session, _, _ = db_session
    fake_redis = FakeRedisClient()
    fixed_now = datetime(2026, 11, 12, 15, 0, tzinfo=UTC)

    for bad_kwargs in (
        {"weather_wind_mph": Decimal("-1")},
        {"weather_precip_prob": Decimal("101")},
        {"weather_temp_f": Decimal("1000")},
        {"status": "UNKNOWN_STATUS"},
    ):
        with pytest.raises(ValidationError):
            IngestedEvent(
                external_provider_id="papi_nfl_bad_w",
                sport_key="americanfootball_nfl",
                home_team_external_id="papi_nfl_team_buf",
                away_team_external_id="papi_nfl_team_kc",
                commence_time=fixed_now + timedelta(hours=3),
                **bad_kwargs,  # type: ignore[arg-type]
            )

    teams = [
        IngestedTeam(
            external_provider_id="papi_nfl_team_buf",
            sport_key="americanfootball_nfl",
            name="Buffalo Bills",
            abbreviation="BUF",
            is_dome=False,
        ),
        IngestedTeam(
            external_provider_id="papi_nfl_team_kc",
            sport_key="americanfootball_nfl",
            name="Kansas City Chiefs",
            abbreviation="KC",
            is_dome=False,
        ),
    ]
    outdoor_no_weather = IngestedEvent(
        external_provider_id="papi_nfl_outdoor_clear",
        sport_key="americanfootball_nfl",
        home_team_external_id="papi_nfl_team_buf",
        away_team_external_id="papi_nfl_team_kc",
        commence_time=fixed_now + timedelta(hours=4),
        is_dome=False,
    )
    slate = IngestedSlate(
        source="upstream", generated_at=fixed_now, teams=teams, events=[outdoor_no_weather]
    )
    upsert_slate_to_db(session, slate, now_utc=fixed_now, redis_client=fake_redis)

    ev_row = session.scalar(
        select(Event).where(Event.external_provider_id == "papi_nfl_outdoor_clear")
    )
    assert ev_row is not None
    weather_key = f"weather:event:{ev_row.event_id}"
    assert weather_key in fake_redis.store
    assert fake_redis.ttl(weather_key) == 45
    assert "Clear conditions" in fake_redis.store[weather_key]

    # Mark LIVE/POSTPONED in DB and verify next upsert preserves non-SCHEDULED status
    ev_row.status = "POSTPONED"
    session.commit()
    upsert_slate_to_db(
        session, slate, now_utc=fixed_now + timedelta(seconds=30), redis_client=fake_redis
    )
    session.refresh(ev_row)
    assert ev_row.status == "POSTPONED"


def test_upsert_slate_to_db_with_none_redis_does_not_connect_redis_and_isolates_log_errors(
    db_session: tuple[Session, Any, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """upsert_slate_to_db(..., redis_client=None) uses a no-op Redis stub and isolates hit-rate errors per prop."""
    session, _, _ = db_session
    fixed_now = datetime(2026, 11, 12, 15, 0, tzinfo=UTC)

    def fail_if_redis_opened() -> Any:
        raise AssertionError("get_redis_client must not be called when redis_client=None")

    monkeypatch.setattr(devig_module, "get_redis_client", fail_if_redis_opened)
    monkeypatch.setattr(ingestion_module, "get_redis_client", fail_if_redis_opened)

    teams = [
        IngestedTeam(
            external_provider_id="papi_nba_team_bos",
            sport_key="basketball_nba",
            name="Boston Celtics",
            abbreviation="BOS",
            is_dome=True,
        ),
        IngestedTeam(
            external_provider_id="papi_nba_team_nyk",
            sport_key="basketball_nba",
            name="New York Knicks",
            abbreviation="NYK",
            is_dome=True,
        ),
    ]
    evt = IngestedEvent(
        external_provider_id="papi_nba_evt_noredis",
        sport_key="basketball_nba",
        home_team_external_id="papi_nba_team_nyk",
        away_team_external_id="papi_nba_team_bos",
        commence_time=fixed_now + timedelta(hours=3),
        is_dome=True,
    )
    prop_ok = IngestedProp(
        external_provider_id="papi_prop_ok_noredis",
        event_external_id="papi_nba_evt_noredis",
        sport_key="basketball_nba",
        team_external_id="papi_nba_team_bos",
        player_name="Jayson Tatum",
        market_key="player_points",
        selection="OVER",
        line_value=Decimal("26.5"),
        offered_decimal_odds=Decimal("2.0200"),
        sharp_decimal_odds=Decimal("1.9000"),
        opposite_sharp_decimal_odds=Decimal("1.9200"),
    )
    prop_bad_logs = IngestedProp(
        external_provider_id="papi_prop_badlogs_noredis",
        event_external_id="papi_nba_evt_noredis",
        sport_key="basketball_nba",
        team_external_id="papi_nba_team_nyk",
        player_name="Bad Log Player",
        market_key="player_points",
        selection="OVER",
        line_value=Decimal("20.5"),
        offered_decimal_odds=Decimal("2.0200"),
        sharp_decimal_odds=Decimal("1.9000"),
        opposite_sharp_decimal_odds=Decimal("1.9200"),
    )

    bad_slate = IngestedSlate(
        source="upstream",
        generated_at=fixed_now,
        teams=teams,
        events=[evt],
        props=[prop_ok, prop_bad_logs],
        game_logs=[
            IngestedGameLog(
                player_name="Jayson Tatum", market_key="player_points", stats=[Decimal("30")]
            ),
            IngestedGameLog.model_construct(
                player_name="Bad Log Player", market_key="player_points", stats=[Decimal("NaN")]
            ),
        ],
    )
    res = upsert_slate_to_db(session, bad_slate, now_utc=fixed_now, redis_client=None)
    assert res.props_evaluated == 1
    assert res.props_skipped_malformed == 1


def test_fetch_upstream_empty_sports_and_event_prop_deduplication_and_session_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Covers empty supported_sports error, duplicate event/prop deduplication, and run_live_slate_sync session close on Redis error."""
    with pytest.raises(UpstreamIngestionError, match="No supported sports"):
        fetch_upstream_slate(api_key="test_live_key", supported_sports=())

    fixed_now = datetime(2026, 11, 12, 15, 0, tzinfo=UTC)
    dup_event = {
        "id": "dup_evt_1",
        "sport_key": "basketball_nba",
        "commence_time": (fixed_now + timedelta(hours=4)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "home_team": "New York Knicks",
        "away_team": "Boston Celtics",
        "props": [
            {
                "id": "shared_prop_1",
                "player_name": "Jayson Tatum",
                "market_key": "player_points",
                "selection": "OVER",
                "line": 26.5,
                "offered_decimal_odds": 2.02,
                "sharp_decimal_odds": 1.90,
                "opposite_sharp_decimal_odds": 1.92,
            }
        ],
    }
    with httpx.Client(
        transport=httpx.MockTransport(lambda req: httpx.Response(200, json=[dup_event, dup_event]))
    ) as client:
        slate = fetch_upstream_slate(
            api_key="test_live_key",
            supported_sports=("basketball_nba",),
            http_client=client,
            now_utc=fixed_now,
        )
    assert len(slate.events) == 1
    assert len(slate.props) == 1

    # Verify run_live_slate_sync closes owned session if get_redis_client raises
    engine = create_engine("sqlite:///:memory:")
    sf = create_session_factory(engine)
    closed_flags: list[bool] = []

    def tracked_sf() -> Session:
        s = sf()
        idx = len(closed_flags)
        closed_flags.append(False)
        orig_close = s.close

        def wrapped_close() -> None:
            closed_flags[idx] = True
            orig_close()

        monkeypatch.setattr(s, "close", wrapped_close)
        return s

    monkeypatch.setattr(ingestion_module, "create_session_factory", lambda: tracked_sf)
    monkeypatch.setattr(
        ingestion_module, "get_redis_client", lambda: (_ for _ in ()).throw(RuntimeError("boom"))
    )
    with pytest.raises(RuntimeError, match="boom"):
        run_live_slate_sync(api_key="", now_utc=fixed_now)
    assert closed_flags == [True]

    # Also verify _ensure_schema_initialized recreates missing player_props table when teams/events exist
    init_db(engine=engine)
    with engine.begin() as conn:
        conn.execute(text("DROP TABLE player_props"))
    assert not inspect(engine).has_table("player_props")
    with sf() as check_session:
        upsert_slate_to_db(
            check_session, build_local_seed_slate(now_utc=fixed_now), now_utc=fixed_now
        )
    assert inspect(engine).has_table("player_props")
    engine.dispose()


def test_prefix_outcome_names_team_tags_accents_and_two_way_fallback(
    db_session: tuple[Session, Any, Any],
) -> None:
    """Prefix Over/Under names with (TEAM) tags, accents, Alex/Alexandre compatibility, and two-way retail sharp fallback parse cleanly."""
    session, _, _ = db_session
    fake_redis = FakeRedisClient()
    fixed_now = datetime(2026, 11, 15, 19, 0, tzinfo=UTC)

    # 1. Unit checks on _split_outcome_player_and_side
    assert _split_outcome_player_and_side({"name": "Over Tari Eason (HOU)"}) == (
        "Tari Eason",
        "OVER",
    )
    assert _split_outcome_player_and_side({"name": "Under Tari Eason (HOU)"}) == (
        "Tari Eason",
        "UNDER",
    )
    assert _split_outcome_player_and_side({"name": "Over Trae Young"}) == (
        "Trae Young",
        "OVER",
    )
    assert _split_outcome_player_and_side({"name": "Under Bogdan Bogdanović"}) == (
        "Bogdan Bogdanović",
        "UNDER",
    )
    assert _split_outcome_player_and_side(
        {"name": "Over Alex Sarr (WAS)", "description": "Alexandre Sarr"}
    ) == ("Alexandre Sarr", "OVER")
    with pytest.raises(ValueError, match="Conflicting"):
        _split_outcome_player_and_side({"name": "Over Jayson Tatum", "description": "Jaylen Brown"})

    # 2. Direct team tag + diacritic merge + fallback two-way bookmaker (lowest overround) + one-way alt line tolerance
    home_t = _resolve_team_metadata("Washington Wizards", "basketball_nba", prefix="papi")
    away_t = _resolve_team_metadata("Houston Rockets", "basketball_nba", prefix="papi")
    raw_ev: dict[str, Any] = {
        "id": "148639d161a052f1bf6c66b5f5c4322c",
        "sport_key": "basketball_nba",
        "commence_time": (fixed_now + timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "home_team": "Washington Wizards",
        "away_team": "Houston Rockets",
        "bookmakers": [
            {
                # Retail-only books on this line -> fallback picks lowest overround two-way book (betmgm: 1/1.91+1/1.91 < draftkings: 1/1.80+1/2.00)
                "key": "betmgm",
                "markets": [
                    {
                        "key": "player_points",
                        "outcomes": [
                            {"name": "Over Tari Eason (HOU)", "price": 1.91, "point": 11.5},
                            {"name": "Under Tari Eason (HOU)", "price": 1.91, "point": 11.5},
                            # Accented Bogdanović merges with ASCII Bogdanovic from Pinnacle below
                            {"name": "Under Bogdan Bogdanović", "price": 2.04, "point": 13.5},
                            {"name": "Over Bogdan Bogdanović", "price": 1.82, "point": 13.5},
                            # One-way alternate milestone for Bogdan should not fail the valid main line
                            {"name": "Over Bogdan Bogdanović", "price": 3.50, "point": 19.5},
                        ],
                    }
                ],
            },
            {
                "key": "draftkings",
                "markets": [
                    {
                        "key": "player_points",
                        "outcomes": [
                            {"name": "Over Tari Eason (HOU)", "price": 2.02, "point": 11.5},
                            {"name": "Under Tari Eason (HOU)", "price": 1.80, "point": 11.5},
                            {"name": "Over Trae Young (WAS)", "price": 1.95, "point": 25.5},
                            {"name": "Under Trae Young (WAS)", "price": 1.87, "point": 25.5},
                        ],
                    }
                ],
            },
            {
                "key": "pinnacle",
                "markets": [
                    {
                        "key": "player_points",
                        "outcomes": [
                            {"name": "Over Trae Young", "price": 1.90, "point": 25.5},
                            {"name": "Under Trae Young", "price": 1.92, "point": 25.5},
                            {"name": "Over Bogdan Bogdanovic", "price": 1.92, "point": 13.5},
                            {"name": "Under Bogdan Bogdanovic", "price": 1.90, "point": 13.5},
                            # Standalone one-way Broken Player should still count as malformed
                            {"name": "Over Broken Prefix Player", "price": 1.90, "point": 9.5},
                        ],
                    }
                ],
            },
        ],
    }

    extracted, malformed = _extract_props_from_bookmakers(
        raw_ev,
        event_external_id="papi_nba_148639d161a052f1bf6c66b5f5c4322c",
        sport_key="basketball_nba",
        home_team=home_t,
        away_team=away_t,
    )
    assert malformed == 1  # Only standalone Broken Prefix Player
    by_player = {p.player_name: p for p in extracted}
    assert set(by_player.keys()) == {"Tari Eason", "Trae Young", "Bogdan Bogdanović"}
    # Team resolution from (HOU) & (WAS)
    assert by_player["Tari Eason"].team_external_id == away_t.external_provider_id
    assert by_player["Trae Young"].team_external_id == home_t.external_provider_id
    # Retail fallback picked BetMGM (1.91/1.91) as baseline vs DraftKings best offer (2.02)
    assert by_player["Tari Eason"].sharp_decimal_odds == Decimal("1.9100")
    assert by_player["Tari Eason"].opposite_sharp_decimal_odds == Decimal("1.9100")
    assert by_player["Tari Eason"].offered_decimal_odds == Decimal("2.0200")
    # Accented + unaccented Bogdanović merged onto Pinnacle sharp baseline with BetMGM's 2.04 Under offer
    assert by_player["Bogdan Bogdanović"].selection == "UNDER"
    assert by_player["Bogdan Bogdanović"].offered_decimal_odds == Decimal("2.0400")
    assert by_player["Bogdan Bogdanović"].sharp_decimal_odds == Decimal("1.9000")

    # 3. Full run_live_slate_sync over mocked HTTP stays source="upstream"
    with httpx.Client(
        transport=httpx.MockTransport(
            lambda req: httpx.Response(
                200,
                json=[raw_ev] if "basketball_nba" in str(req.url) else [],
            )
        )
    ) as http_client:
        result = run_live_slate_sync(
            session=session,
            redis_client=fake_redis,
            http_client=http_client,
            api_key="test_live_key",
            base_url="https://api.parlay-api.com/v1",
            now_utc=fixed_now,
        )
    assert result.source == "upstream"
    assert result.props_evaluated == 3
    eason_row = session.scalar(select(PlayerProp).where(PlayerProp.player_name == "Tari Eason"))
    assert eason_row is not None
    hou_row = session.scalar(
        select(Team).where(Team.external_provider_id == away_t.external_provider_id)
    )
    assert hou_row is not None
    assert eason_row.team_id == hou_row.team_id
