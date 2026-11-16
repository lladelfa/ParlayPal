"""Tests for Story 6.5: game-log ingestion for upstream players."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from parlaypal_worker.config import WorkerSettings, get_settings
from parlaypal_worker.game_logs import game_log_cache_key, resolve_game_logs
from parlaypal_worker.ingestion import (
    _attach_upstream_game_logs,
    build_local_seed_slate,
    run_live_slate_sync,
    upsert_slate_to_db,
)
from parlaypal_worker.models import PlayerProp
from tests.test_ingestion import (
    FakeRedisClient,
    _build_upstream_mock_transport,
    _outcomes_slate,
    db_session,
)

__all__ = ["db_session"]

SPORT = "americanfootball_nfl"


def _settings(**overrides: Any) -> WorkerSettings:
    base: dict[str, Any] = {
        "game_log_base_url": "https://stats.example.test",
        "game_log_path_template": "/logs/{sport}/{player}/{market}",
        "game_log_response_path": "games",
        "game_log_stat_field": "value",
    }
    base.update(overrides)
    return WorkerSettings(**base)


def _client(
    games: list[Any] | None = None,
    *,
    status: int = 200,
    raise_timeout: bool = False,
    bad_json: bool = False,
    calls: list[str] | None = None,
) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(str(request.url))
        if raise_timeout:
            raise httpx.ReadTimeout("slow", request=request)
        if bad_json:
            return httpx.Response(200, text="{nope")
        if status != 200:
            return httpx.Response(status, json={})
        return httpx.Response(200, json={"games": [{"value": g} for g in (games or [])]})

    return httpx.Client(transport=httpx.MockTransport(handler))


def _twelve() -> list[int]:
    return [300, 250, 310, 290, 280, 260, 320, 240, 330, 270, 200, 350]


def test_happy_path_returns_decimal_logs_and_caches_positive() -> None:
    redis = FakeRedisClient()
    with _client(_twelve()) as http:
        out = resolve_game_logs(
            [(SPORT, "Patrick Mahomes", "player_pass_yds")],
            settings=_settings(),
            redis_client=redis,
            http_client=http,
        )
    stats = out[("Patrick Mahomes", "player_pass_yds")]
    assert len(stats) == 12 and all(isinstance(s, Decimal) for s in stats)
    key = game_log_cache_key(SPORT, "Patrick Mahomes", "player_pass_yds")
    assert redis.ttl(key) == 6 * 60 * 60


@pytest.mark.parametrize(
    "kwargs",
    [
        {"games": [1, 2, 3, 4]},
        {"status": 500},
        {"raise_timeout": True},
        {"bad_json": True},
        {"games": ["abc"] * 6},
    ],
    ids=["short", "5xx", "timeout", "bad_json", "malformed"],
)
def test_short_or_failed_lookup_is_empty_and_negative_cached(kwargs: dict[str, Any]) -> None:
    redis = FakeRedisClient()
    with _client(**kwargs) as http:
        out = resolve_game_logs(
            [(SPORT, "P", "player_pass_yds")],
            settings=_settings(),
            redis_client=redis,
            http_client=http,
        )
    assert out == {}
    assert redis.ttl(game_log_cache_key(SPORT, "P", "player_pass_yds")) == 15 * 60


def test_cache_hit_makes_no_provider_call() -> None:
    redis = FakeRedisClient()
    calls: list[str] = []
    target = [(SPORT, "P", "player_pass_yds")]
    with _client(_twelve(), calls=calls) as http:
        resolve_game_logs(target, settings=_settings(), redis_client=redis, http_client=http)
        out = resolve_game_logs(target, settings=_settings(), redis_client=redis, http_client=http)
    assert len(calls) == 1
    assert len(out[("P", "player_pass_yds")]) == 12


def test_negative_cache_hit_makes_no_provider_call() -> None:
    redis = FakeRedisClient()
    calls: list[str] = []
    target = [(SPORT, "P", "player_pass_yds")]
    with _client(status=500, calls=calls) as http:
        resolve_game_logs(target, settings=_settings(), redis_client=redis, http_client=http)
        resolve_game_logs(target, settings=_settings(), redis_client=redis, http_client=http)
    assert len(calls) == 1


def test_budget_exhausted_defers_remaining_players_to_later_cycle() -> None:
    redis = FakeRedisClient()
    calls: list[str] = []
    targets = [(SPORT, f"P{i}", "player_pass_yds") for i in range(5)]
    settings = _settings(game_log_fetch_budget_per_cycle=2)
    with _client(_twelve(), calls=calls) as http:
        first = resolve_game_logs(targets, settings=settings, redis_client=redis, http_client=http)
        assert len(first) == 2 and len(calls) == 2
        second = resolve_game_logs(targets, settings=settings, redis_client=redis, http_client=http)
    assert len(second) == 4 and len(calls) == 4


def test_cycle_deadline_stops_provider_calls() -> None:
    calls: list[str] = []
    with _client(_twelve(), calls=calls) as http:
        out = resolve_game_logs(
            [(SPORT, f"P{i}", "player_pass_yds") for i in range(3)],
            settings=_settings(game_log_cycle_deadline_seconds=0.0),
            redis_client=FakeRedisClient(),
            http_client=http,
        )
    assert out == {} and calls == []


def test_unconfigured_source_makes_no_calls() -> None:
    calls: list[str] = []
    with _client(_twelve(), calls=calls) as http:
        out = resolve_game_logs(
            [(SPORT, "P", "player_pass_yds")],
            settings=_settings(game_log_base_url=""),
            redis_client=FakeRedisClient(),
            http_client=http,
        )
    assert out == {} and calls == []


def test_anytime_td_is_skipped() -> None:
    calls: list[str] = []
    with _client(_twelve(), calls=calls) as http:
        out = resolve_game_logs(
            [(SPORT, "Derrick Henry", "player_anytime_td")],
            settings=_settings(),
            redis_client=FakeRedisClient(),
            http_client=http,
        )
    assert out == {} and calls == []


def test_oldest_first_source_is_reversed() -> None:
    with _client([1, 2, 3, 4, 5, 6]) as http:
        out = resolve_game_logs(
            [(SPORT, "P", "player_pass_yds")],
            settings=_settings(game_log_newest_first=False),
            redis_client=FakeRedisClient(),
            http_client=http,
        )
    assert out[("P", "player_pass_yds")][0] == Decimal("6")


def test_redis_failure_never_raises() -> None:
    class BrokenRedis:
        def get(self, name: str) -> Any:
            raise RuntimeError("down")

        def set(self, name: str, value: str, ex: int | None = None) -> Any:
            raise RuntimeError("down")

        def publish(self, channel: str, message: str) -> Any:
            return 0

    with _client(_twelve()) as http:
        out = resolve_game_logs(
            [(SPORT, "P", "player_pass_yds")],
            settings=_settings(),
            redis_client=BrokenRedis(),
            http_client=http,
        )
    assert len(out[("P", "player_pass_yds")]) == 12


def _capturing_client(captured: list[httpx.Request]) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"games": [{"value": g} for g in _twelve()]})

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_request_url_is_percent_encoded_and_bearer_header_sent() -> None:
    captured: list[httpx.Request] = []
    with _capturing_client(captured) as http:
        out = resolve_game_logs(
            [(SPORT, "A.J. Brown / Jr", "player_pass_yds")],
            settings=_settings(game_log_api_key="k"),
            redis_client=FakeRedisClient(),
            http_client=http,
        )
    assert out
    request = captured[0]
    assert request.url.raw_path.decode().startswith(
        "/logs/americanfootball_nfl/A.J.%20Brown%20%2F%20Jr/"
    )
    assert request.headers["authorization"] == "Bearer k"
    assert request.extensions["timeout"]["read"] <= 10.0


def test_no_authorization_header_without_api_key() -> None:
    captured: list[httpx.Request] = []
    with _capturing_client(captured) as http:
        resolve_game_logs(
            [(SPORT, "P", "player_pass_yds")],
            settings=_settings(),
            redis_client=FakeRedisClient(),
            http_client=http,
        )
    assert "authorization" not in captured[0].headers


@pytest.mark.parametrize("template", ["/logs/{nope}", "/logs/{player.x}", "/logs/{"])
def test_invalid_path_template_is_negative_cached_not_raised(template: str) -> None:
    redis = FakeRedisClient()
    calls: list[str] = []
    with _client(_twelve(), calls=calls) as http:
        out = resolve_game_logs(
            [(SPORT, "P", "player_pass_yds")],
            settings=_settings(game_log_path_template=template),
            redis_client=redis,
            http_client=http,
        )
    assert out == {} and calls == []
    assert redis.ttl(game_log_cache_key(SPORT, "P", "player_pass_yds")) == 15 * 60


def test_duplicate_targets_cost_one_call_and_empty_names_are_skipped() -> None:
    calls: list[str] = []
    targets = [(SPORT, "P", "player_pass_yds")] * 3 + [(SPORT, "  ", "player_pass_yds")]
    with _client(_twelve(), calls=calls) as http:
        out = resolve_game_logs(
            targets, settings=_settings(), redis_client=FakeRedisClient(), http_client=http
        )
    assert len(calls) == 1 and len(out) == 1


def test_consecutive_failures_stop_provider_calls_for_the_cycle() -> None:
    calls: list[str] = []
    targets = [(SPORT, f"P{i}", "player_pass_yds") for i in range(8)]
    with _client(status=503, calls=calls) as http:
        out = resolve_game_logs(
            targets, settings=_settings(), redis_client=FakeRedisClient(), http_client=http
        )
    assert out == {} and len(calls) == 3


def test_non_positive_ttl_still_caches_with_valid_expiry() -> None:
    redis = FakeRedisClient()
    with _client(_twelve()) as http:
        resolve_game_logs(
            [(SPORT, "P", "player_pass_yds")],
            settings=_settings(game_log_positive_ttl_seconds=0),
            redis_client=redis,
            http_client=http,
        )
    assert redis.ttl(game_log_cache_key(SPORT, "P", "player_pass_yds")) == 1


def test_corrupt_cache_entry_is_refetched() -> None:
    redis = FakeRedisClient()
    redis.set(game_log_cache_key(SPORT, "P", "player_pass_yds"), '{"a": 1}', ex=60)
    calls: list[str] = []
    with _client(_twelve(), calls=calls) as http:
        out = resolve_game_logs(
            [(SPORT, "P", "player_pass_yds")],
            settings=_settings(),
            redis_client=redis,
            http_client=http,
        )
    assert len(calls) == 1 and len(out[("P", "player_pass_yds")]) == 12


def test_attach_preserves_existing_logs_and_skips_props_without_line() -> None:
    slate = _outcomes_slate(NOW, [1, 2, 3, 4, 5, 6])
    calls: list[str] = []
    with _client(_twelve(), calls=calls) as http:
        kept = _attach_upstream_game_logs(
            slate, settings=_settings(), redis_client=FakeRedisClient(), http_client=http
        )
    assert kept.game_logs == slate.game_logs  # existing seed-style log not replaced or duplicated

    calls.clear()
    no_line = slate.model_copy(
        update={
            "game_logs": [],
            "props": [slate.props[0].model_copy(update={"line_value": None})],
        }
    )
    with _client(_twelve(), calls=calls) as http:
        out = _attach_upstream_game_logs(
            no_line, settings=_settings(), redis_client=FakeRedisClient(), http_client=http
        )
    assert out.game_logs == [] and calls == []


# ---- Integration with run_live_slate_sync ----

NOW = datetime(2026, 11, 12, 16, 0, tzinfo=UTC)


@pytest.fixture()
def configured_source(monkeypatch: pytest.MonkeyPatch) -> WorkerSettings:
    settings = get_settings()
    monkeypatch.setattr(settings, "game_log_base_url", "https://stats.example.test")
    monkeypatch.setattr(settings, "game_log_path_template", "/logs/{sport}/{player}/{market}")
    monkeypatch.setattr(settings, "game_log_response_path", "games")
    monkeypatch.setattr(settings, "game_log_stat_field", "value")
    return settings


def _live(session: Session, redis: FakeRedisClient, game_http: httpx.Client | None) -> Any:
    with httpx.Client(transport=_build_upstream_mock_transport(NOW)) as http:
        return run_live_slate_sync(
            session=session,
            redis_client=redis,
            http_client=http,
            api_key="test_live_key",
            base_url="https://api.parlay-api.com/v1",
            now_utc=NOW,
            game_log_http_client=game_http,
        )


def test_live_sync_populates_rates_and_outcomes(
    db_session: tuple[Session, Any, Any], configured_source: WorkerSettings
) -> None:
    session, _, _ = db_session
    with _client(_twelve()) as game_http:
        result = _live(session, FakeRedisClient(), game_http)
    assert result.source == "upstream"
    props = list(session.scalars(select(PlayerProp)).all())
    pass_props = [p for p in props if p.market_key == "player_pass_yds"]
    assert pass_props
    for p in pass_props:
        assert p.hit_rate_l5 is not None
        assert p.hit_rate_l10 is not None
        assert p.hit_rate_season is not None
        assert p.recent_outcomes is not None and len(p.recent_outcomes) == 10
    td = [p for p in props if p.market_key == "player_anytime_td"]
    assert td and all(p.hit_rate_l10 is None and p.recent_outcomes is None for p in td)


@pytest.mark.parametrize(("selection", "expected"), [("UNDER", "1.0000"), ("OVER", "0.0000")])
def test_attached_logs_use_side_aware_rule_for_upstream_props(
    db_session: tuple[Session, Any, Any], selection: str, expected: str
) -> None:
    session, _, _ = db_session
    slate = _outcomes_slate(NOW, None, selection=selection)  # type: ignore[arg-type]
    # Line 26.5; every fetched game is 10, far below it: Under always hits, Over never.
    with _client([10] * 12) as game_http:
        attached = _attach_upstream_game_logs(
            slate,
            settings=_settings(),
            redis_client=FakeRedisClient(),
            http_client=game_http,
        )
    assert len(attached.game_logs) == 1
    upsert_slate_to_db(session, attached, now_utc=NOW, redis_client=None)
    row = session.scalar(select(PlayerProp))
    assert row is not None
    assert row.hit_rate_l10 == Decimal(expected)
    assert row.recent_outcomes is not None and len(row.recent_outcomes) == 10


def test_live_sync_lookup_failure_leaves_null_and_completes(
    db_session: tuple[Session, Any, Any], configured_source: WorkerSettings
) -> None:
    session, _, _ = db_session
    with _client(raise_timeout=True) as game_http:
        result = _live(session, FakeRedisClient(), game_http)
    assert result.status == "ok"
    props = list(session.scalars(select(PlayerProp)).all())
    assert props and all(p.hit_rate_l10 is None and p.recent_outcomes is None for p in props)


def test_live_sync_unconfigured_source_never_calls_provider(
    db_session: tuple[Session, Any, Any],
) -> None:
    session, _, _ = db_session
    calls: list[str] = []
    with _client(_twelve(), calls=calls) as game_http:
        result = _live(session, FakeRedisClient(), game_http)
    assert result.status == "ok" and calls == []
    assert all(p.hit_rate_l10 is None for p in session.scalars(select(PlayerProp)).all())


def test_seed_slate_never_calls_provider(
    db_session: tuple[Session, Any, Any], configured_source: WorkerSettings
) -> None:
    session, _, _ = db_session
    calls: list[str] = []
    with _client(_twelve(), calls=calls) as game_http:
        result = run_live_slate_sync(
            session=session,
            redis_client=FakeRedisClient(),
            api_key="",
            now_utc=NOW,
            game_log_http_client=game_http,
        )
    assert result.source == "seed" and calls == []
    assert build_local_seed_slate(now_utc=NOW).game_logs
