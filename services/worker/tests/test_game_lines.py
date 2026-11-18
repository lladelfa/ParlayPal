"""TDD tests for Story 8.1: game lines ingestion (spread, moneyline, total)."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from parlaypal_worker.celery_app import build_beat_schedule, celery_app, sync_game_lines
from parlaypal_worker.db import create_session_factory, init_db
from parlaypal_worker.ingestion import (
    GameLinesFetchResult,
    fetch_game_lines,
    run_game_lines_sync,
    upsert_game_lines,
)
from parlaypal_worker.models import Event, EventLine, Team
from parlaypal_worker.redis_client import game_lines_key

NOW = datetime(2026, 11, 18, 12, 0, 0, tzinfo=UTC)
SPORT = "americanfootball_nfl"
RAW_EVENT_ID = "evt1"
EXT_ID = "papi_nfl_evt1"
HOME = "Kansas City Chiefs"
AWAY = "Buffalo Bills"


class FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.ttls: dict[str, int | None] = {}

    def set(self, name: str, value: str, ex: int | None = None) -> bool:
        self.store[name] = value
        self.ttls[name] = ex
        return True

    def get(self, name: str) -> str | None:
        return self.store.get(name)

    def publish(self, channel: str, message: str) -> int:
        return 0


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:")
    init_db(engine=engine)
    session = create_session_factory(engine)()
    home = Team(external_provider_id="papi_kc", sport_key=SPORT, name=HOME, abbreviation="KC")
    away = Team(external_provider_id="papi_buf", sport_key=SPORT, name=AWAY, abbreviation="BUF")
    session.add_all([home, away])
    session.flush()
    event = Event(
        external_provider_id=EXT_ID,
        sport_key=SPORT,
        home_team_id=home.team_id,
        away_team_id=away.team_id,
        commence_time=NOW + timedelta(hours=5),
    )
    session.add(event)
    session.commit()
    try:
        yield session, event
    finally:
        session.close()
        engine.dispose()


def _book(key: str, markets: list[dict[str, Any]]) -> dict[str, Any]:
    return {"key": key, "markets": markets}


def _spread(home_pt: float, hp: Any, ap: Any) -> dict[str, Any]:
    return {
        "key": "spreads",
        "outcomes": [
            {"name": HOME, "price": hp, "point": home_pt},
            {"name": AWAY, "price": ap, "point": -home_pt if home_pt else 0},
        ],
    }


def _h2h(hp: Any, ap: Any) -> dict[str, Any]:
    return {
        "key": "h2h",
        "outcomes": [{"name": HOME, "price": hp}, {"name": AWAY, "price": ap}],
    }


def _total(pt: float, op: Any, up: Any) -> dict[str, Any]:
    return {
        "key": "totals",
        "outcomes": [
            {"name": "Over", "price": op, "point": pt},
            {"name": "Under", "price": up, "point": pt},
        ],
    }


def _event_payload(books: list[dict[str, Any]], raw_id: str = RAW_EVENT_ID) -> dict[str, Any]:
    return {
        "id": raw_id,
        "sport_key": SPORT,
        "commence_time": (NOW + timedelta(hours=5)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "home_team": HOME,
        "away_team": AWAY,
        "bookmakers": books,
    }


def _client(
    events: Any, *, status: int = 200, headers: dict[str, str] | None = None
) -> tuple[httpx.Client, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if "nfl" in request.url.path:
            return httpx.Response(status, json=events, headers=headers or {})
        return httpx.Response(200, json=[], headers=headers or {})

    return httpx.Client(transport=httpx.MockTransport(handler)), seen


FULL_BOOKS = [
    _book("pinnacle", [_h2h(1.80, 2.10), _spread(-3.5, 1.95, 1.91), _total(47.5, 1.92, 1.94)]),
    _book("draftkings", [_h2h(1.83, 2.05), _spread(-3.0, 1.91, 1.91), _total(48.0, 1.90, 1.90)]),
    _book("fanduel", [_h2h(1.77, 2.15), _spread(-3.5, 1.89, 1.93), _total(47.5, 1.91, 1.91)]),
]


def _fetch(client: httpx.Client) -> GameLinesFetchResult:
    return fetch_game_lines(
        api_key="k",
        base_url="https://x.test/v1",
        supported_sports=[SPORT],
        http_client=client,
        now_utc=NOW,
    )


def _lines(session: Session) -> dict[tuple[str, str], EventLine]:
    return {(r.market_key, r.side): r for r in session.scalars(select(EventLine))}


def test_full_lines_consensus_and_per_book_prices(db) -> None:
    session, event = db
    client, seen = _client([_event_payload(FULL_BOOKS)])
    result = _fetch(client)
    assert seen[0].url.params["markets"] == "h2h,spreads,totals"
    assert seen[0].url.params["oddsFormat"] == "decimal"
    redis = FakeRedis()
    upsert_game_lines(session, result, redis_client=redis, now_utc=NOW)
    rows = _lines(session)
    assert set(rows) == {
        ("h2h", "home"),
        ("h2h", "away"),
        ("spreads", "home"),
        ("spreads", "away"),
        ("totals", "over"),
        ("totals", "under"),
    }
    # sharp book (pinnacle) wins the consensus point
    assert rows[("spreads", "home")].point == Decimal("-3.50")
    assert rows[("spreads", "away")].point == Decimal("3.50")
    assert rows[("spreads", "home")].decimal_odds == Decimal("1.9500")
    assert rows[("totals", "over")].point == Decimal("47.50")
    assert rows[("h2h", "home")].point is None
    assert rows[("h2h", "away")].decimal_odds == Decimal("2.1000")
    books = rows[("spreads", "home")].book_prices
    assert {b["book"] for b in books} == {"pinnacle", "draftkings", "fanduel"}
    key = game_lines_key(SPORT, event.event_id)
    assert key == f"odds:lines:{SPORT}:{event.event_id}"
    assert redis.ttls[key] == 45
    payload = json.loads(redis.store[key])
    assert payload["fetched_at"] == "2026-11-18T12:00:00Z"
    assert payload["markets"]["spreads"]["home"]["point"] == "-3.50"
    assert payload["markets"]["h2h"]["home"]["point"] is None


def test_consensus_median_when_no_sharp_book(db) -> None:
    session, _ = db
    books = [
        _book("draftkings", [_spread(-3.0, 1.91, 1.91)]),
        _book("fanduel", [_spread(-3.5, 1.91, 1.91)]),
        _book("betmgm", [_spread(-3.5, 1.95, 1.87)]),
    ]
    client, _ = _client([_event_payload(books)])
    upsert_game_lines(session, _fetch(client), redis_client=FakeRedis(), now_utc=NOW)
    assert _lines(session)[("spreads", "home")].point == Decimal("-3.50")


def test_partial_lines_only_totals(db) -> None:
    session, event = db
    client, _ = _client([_event_payload([_book("pinnacle", [_total(220.5, 1.9, 1.9)])])])
    redis = FakeRedis()
    upsert_game_lines(session, _fetch(client), redis_client=redis, now_utc=NOW)
    assert set(_lines(session)) == {("totals", "over"), ("totals", "under")}
    payload = json.loads(redis.store[game_lines_key(SPORT, event.event_id)])
    assert set(payload["markets"]) == {"totals"}


def test_no_lines_keeps_event_and_writes_nothing(db) -> None:
    session, event = db
    client, _ = _client([_event_payload([])])
    redis = FakeRedis()
    upsert_game_lines(session, _fetch(client), redis_client=redis, now_utc=NOW)
    assert list(session.scalars(select(EventLine))) == []
    assert redis.store == {}
    assert session.get(Event, event.event_id) is not None


def test_pickem_zero_spread_preserved(db) -> None:
    session, _ = db
    client, _ = _client([_event_payload([_book("pinnacle", [_spread(0, 1.91, 1.91)])])])
    upsert_game_lines(session, _fetch(client), redis_client=FakeRedis(), now_utc=NOW)
    rows = _lines(session)
    assert rows[("spreads", "home")].point == Decimal("0")
    assert rows[("spreads", "away")].point == Decimal("0")


def test_missing_point_is_not_defaulted(db) -> None:
    session, _ = db
    market = {
        "key": "totals",
        "outcomes": [{"name": "Over", "price": 1.9}, {"name": "Under", "price": 1.9}],
    }
    client, _ = _client([_event_payload([_book("pinnacle", [market])])])
    upsert_game_lines(session, _fetch(client), redis_client=FakeRedis(), now_utc=NOW)
    assert list(session.scalars(select(EventLine))) == []


def test_bad_price_skipped_rest_kept(db) -> None:
    session, _ = db
    books = [
        _book("pinnacle", [_spread(-3.5, 0.5, 1.91)]),
        _book("draftkings", [_spread(-3.5, 1.91, 1.91)]),
    ]
    client, _ = _client([_event_payload(books)])
    upsert_game_lines(session, _fetch(client), redis_client=FakeRedis(), now_utc=NOW)
    rows = _lines(session)
    assert {b["book"] for b in rows[("spreads", "home")].book_prices} == {"draftkings"}
    assert rows[("spreads", "home")].decimal_odds == Decimal("1.9100")
    assert {b["book"] for b in rows[("spreads", "away")].book_prices} == {
        "pinnacle",
        "draftkings",
    }


@pytest.mark.parametrize("status,body", [(500, {"err": 1}), (200, []), (200, {"events": []})])
def test_provider_down_leaves_existing_rows(db, status: int, body: Any) -> None:
    session, _ = db
    good, _ = _client([_event_payload(FULL_BOOKS)])
    upsert_game_lines(session, _fetch(good), redis_client=FakeRedis(), now_utc=NOW)
    before = {k: v.decimal_odds for k, v in _lines(session).items()}
    bad, _ = _client(body, status=status)
    redis = FakeRedis()
    result = _fetch(bad)
    assert result.lines == []
    upsert_game_lines(session, result, redis_client=redis, now_utc=NOW)
    assert {k: v.decimal_odds for k, v in _lines(session).items()} == before
    assert redis.store == {}


def test_rerun_is_idempotent_and_drops_stale_markets(db) -> None:
    session, _ = db
    for _ in range(2):
        client, _ = _client([_event_payload(FULL_BOOKS)])
        upsert_game_lines(session, _fetch(client), redis_client=FakeRedis(), now_utc=NOW)
    assert len(list(session.scalars(select(EventLine)))) == 6
    moved = [_book("pinnacle", [_total(50.5, 1.9, 1.9)])]
    client, _ = _client([_event_payload(moved)])
    upsert_game_lines(session, _fetch(client), redis_client=FakeRedis(), now_utc=NOW)
    rows = _lines(session)
    assert rows[("totals", "over")].point == Decimal("50.50")
    assert set(rows) == {("totals", "over"), ("totals", "under")}


def test_unknown_event_is_skipped(db) -> None:
    session, _ = db
    client, _ = _client([_event_payload(FULL_BOOKS, raw_id="other")])
    upsert_game_lines(session, _fetch(client), redis_client=FakeRedis(), now_utc=NOW)
    assert list(session.scalars(select(EventLine))) == []


def test_run_sync_logs_credits_and_requests(db, caplog: pytest.LogCaptureFixture) -> None:
    session, _ = db
    client, _ = _client([_event_payload(FULL_BOOKS)], headers={"x-credits-remaining": "812"})
    with caplog.at_level(logging.INFO):
        summary = run_game_lines_sync(
            session=session,
            redis_client=FakeRedis(),
            http_client=client,
            api_key="k",
            base_url="https://x.test/v1",
            now_utc=NOW,
        )
    assert summary["status"] == "ok"
    assert summary["lines_written"] == 6
    assert summary["credits_remaining"] == 812
    assert summary["requests"] == 2
    assert any("812" in r.getMessage() and r.levelno == logging.INFO for r in caplog.records)


def test_credits_read_from_x_requests_remaining_header(db) -> None:
    session, _ = db
    client, _ = _client([_event_payload(FULL_BOOKS)], headers={"x-requests-remaining": "18910"})
    result = _fetch(client)
    assert result.credits_remaining == 18910


def test_started_event_is_ignored(db) -> None:
    session, _ = db
    started = _event_payload(FULL_BOOKS)
    started["commence_time"] = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")  # == now: already started
    client, _ = _client([started])
    result = _fetch(client)
    assert result.seen_event_external_ids == []
    redis = FakeRedis()
    upsert_game_lines(session, result, redis_client=redis, now_utc=NOW)
    assert list(session.scalars(select(EventLine))) == []
    assert redis.store == {}


def test_duplicate_event_in_response_does_not_break_unique_slot(db) -> None:
    session, _ = db
    client, _ = _client([_event_payload(FULL_BOOKS), _event_payload(FULL_BOOKS)])
    upsert_game_lines(session, _fetch(client), redis_client=FakeRedis(), now_utc=NOW)
    assert len(list(session.scalars(select(EventLine)))) == 6


def test_sync_game_lines_task_runs_with_injected_clients(db) -> None:
    session, _ = db
    client, _ = _client([_event_payload(FULL_BOOKS)])
    redis = FakeRedis()
    summary = sync_game_lines(
        session=session,
        redis_client=redis,
        http_client=client,
        api_key="k",
        base_url="https://x.test/v1",
        now="2026-11-18T12:00:00Z",
    )
    assert summary["lines_written"] == 6
    assert len(redis.store) == 1
    assert session.is_active  # injected session is not closed/invalidated by the task


def test_run_sync_without_key_does_nothing(db) -> None:
    session, _ = db
    summary = run_game_lines_sync(
        session=session, redis_client=FakeRedis(), api_key="", base_url="https://x.test/v1"
    )
    assert summary["status"] == "skipped"
    assert list(session.scalars(select(EventLine))) == []


def test_celery_task_and_beat_entry() -> None:
    assert "parlaypal_worker.sync_game_lines" in celery_app.tasks
    sched = build_beat_schedule(1800.0)
    assert sched["sync-game-lines"]["task"] == "parlaypal_worker.sync_game_lines"
    assert sched["sync-game-lines"]["schedule"] == 1800.0
    assert callable(sync_game_lines)
