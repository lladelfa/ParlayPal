"""Tests for Story 6.7: MoneyLine game-log provider adapter (NBA and NFL)."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from parlaypal_worker import moneyline
from parlaypal_worker.config import WorkerSettings
from parlaypal_worker.game_logs import (
    game_log_cache_key,
    is_game_log_source_configured,
    resolve_game_logs,
)
from parlaypal_worker.ingestion import _attach_upstream_game_logs, upsert_slate_to_db
from parlaypal_worker.models import PlayerProp
from parlaypal_worker.moneyline import current_season, normalize_player_name
from tests.test_ingestion import FakeRedisClient, _outcomes_slate, db_session

__all__ = ["db_session"]

NBA = "basketball_nba"
NFL = "americanfootball_nfl"
NOW = datetime(2026, 11, 16, 16, 0, tzinfo=UTC)
BASE = "https://ml.example.test/v1"


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(moneyline, "_utc_now", lambda: NOW)


def _settings(**overrides: Any) -> WorkerSettings:
    base: dict[str, Any] = {
        "game_log_provider": "moneyline",
        "moneyline_api_key": "test_ml_key",
        "moneyline_api_base_url": BASE,
        "moneyline_requests_per_minute": 1000,
    }
    base.update(overrides)
    return WorkerSettings(**base)


def _nba_row(
    day: int, points: Any = 20, reb: Any = 8, threes: Any = 3, *, kind: str = "regular"
) -> dict[str, Any]:
    stats: dict[str, Any] = {"minutes": 30}
    for key, value in (
        ("points", points),
        ("total_rebounds", reb),
        ("threepoint_goals_made", threes),
    ):
        if value is not None:
            stats[key] = value
    return {"gameDate": f"2026-11-{day:02d}T00:00:00.000Z", "gameType": kind, "stats": stats}


def _nfl_row(
    day: int, *, passing: Any = None, rushing: Any = None, kind: str = "regular"
) -> dict[str, Any]:
    stats: dict[str, Any] = {}
    if passing is not None:
        stats["passing"] = {"yards": passing, "comp_att": "20/30"}
    if rushing is not None:
        stats["rushing"] = {"yards": rushing, "total_rushes": 5}
    return {"gameDate": f"2026-10-{day:02d}T00:00:00.000Z", "gameType": kind, "stats": stats}


def _player(pid: str, name: str) -> dict[str, Any]:
    return {"playerId": pid, "name": name, "normalizedName": name.lower().replace(" ", "")}


class MockML:
    """MoneyLine double: paged roster per league and game logs per playerId."""

    def __init__(
        self,
        roster: dict[str, list[dict[str, Any]]] | None = None,
        logs: dict[str, list[dict[str, Any]]] | None = None,
        *,
        page_size: int = 100,
        status: int = 200,
        credits_remaining: str | None = None,
    ) -> None:
        self.roster = roster or {}
        self.logs = logs or {}
        self.page_size = page_size
        self.status = status
        self.credits_remaining = credits_remaining
        self.calls: list[httpx.Request] = []

    def urls(self) -> list[str]:
        return [str(r.url) for r in self.calls]

    def stat_calls(self) -> list[str]:
        return [u for u in self.urls() if "/stats" in u]

    def roster_calls(self) -> list[str]:
        return [u for u in self.urls() if "/players?" in u]

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self._handle))

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        headers = {}
        if self.credits_remaining is not None:
            headers["x-credits-remaining"] = self.credits_remaining
        if self.status != 200:
            return httpx.Response(self.status, json={"success": False}, headers=headers)
        path = request.url.path
        params = request.url.params
        if path.endswith("/stats"):
            pid = path.split("/")[-2]
            return httpx.Response(
                200, json={"success": True, "data": self.logs.get(pid, [])}, headers=headers
            )
        league = params.get("league", "")
        players = self.roster.get(league, [])
        page = int(params.get("page", "1"))
        size = self.page_size
        pages = max(1, -(-len(players) // size))
        chunk = players[(page - 1) * size : page * size]
        return httpx.Response(
            200,
            json={"success": True, "data": chunk, "meta": {"page": page, "pages": pages}},
            headers=headers,
        )


NBA_ROSTER = {
    "nba": [
        _player("nba-p-1", "Jayson Tatum"),
        _player("nba-p-2", "Cameron Johnson"),
        _player("nba-p-3", "Wendell Carter"),
        _player("nba-p-4", "Aaron Funk"),
        {"playerId": "nba-p-9", "name": "A. Funk", "normalizedName": "afunk"},  # placeholder row
        _player("nba-p-5", "Jalen Williams"),
        _player("nba-p-6", "Jalen Williams"),  # genuine duplicate name -> ambiguous
    ]
}


def _twenty() -> list[dict[str, Any]]:
    # Newest first, as the provider returns them.
    return [_nba_row(d, points=d, reb=d + 1, threes=d % 5) for d in range(20, 0, -1)]


# ---- pure helpers ----


@pytest.mark.parametrize(
    ("league", "today", "expected"),
    [
        ("nba", date(2026, 11, 16), "2026-27"),
        ("nba", date(2026, 10, 1), "2026-27"),
        ("nba", date(2026, 9, 30), "2025-26"),
        ("nba", date(2027, 3, 1), "2026-27"),
        ("nfl", date(2026, 11, 16), "2026-27"),
        ("nfl", date(2027, 1, 20), "2026-27"),
        ("nfl", date(2026, 8, 31), "2025-26"),
        ("nfl", date(2026, 9, 1), "2026-27"),
        ("nba", date(2099, 12, 1), "2099-00"),
    ],
)
def test_current_season_boundaries(league: str, today: date, expected: str) -> None:
    assert current_season(league, today) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Wendell Carter Jr.", "wendell carter"),
        ("Nikola Jokić", "nikola jokic"),
        ("De'Anthony Melton", "deanthony melton"),
        ("Karl-Anthony Towns", "karl anthony towns"),
        ("  Josh   Giddey ", "josh giddey"),
        ("Cam Johnson", "cam johnson"),
        ("Cameron Johnson", "cam johnson"),
        ("Joshua Giddey", "josh giddey"),
        ("Alexandre Sarr", "alex sarr"),
        ("Herb Jones", "herb jones"),
        ("Herbert Jones", "herb jones"),
    ],
)
def test_name_normalization_and_nickname_aliases(raw: str, expected: str) -> None:
    assert normalize_player_name(raw) == expected


# ---- config / selection ----


def test_source_configured_requires_provider_and_key() -> None:
    assert is_game_log_source_configured(_settings())
    assert not is_game_log_source_configured(_settings(moneyline_api_key=""))
    assert not is_game_log_source_configured(_settings(moneyline_api_key="  "))
    assert not is_game_log_source_configured(_settings(game_log_provider=""))
    assert not is_game_log_source_configured(_settings(game_log_provider="other"))


def test_provider_unset_keeps_generic_behaviour_and_makes_no_moneyline_calls() -> None:
    ml = MockML(NBA_ROSTER, {"nba-p-1": _twenty()})
    with ml.client() as http:
        out = resolve_game_logs(
            [(NBA, "Jayson Tatum", "player_points")],
            settings=_settings(game_log_provider=""),
            redis_client=FakeRedisClient(),
            http_client=http,
        )
    assert out == {} and ml.calls == []


# ---- happy paths ----


def test_nba_happy_path_returns_newest_first_points_rebounds_threes() -> None:
    redis = FakeRedisClient()
    ml = MockML(NBA_ROSTER, {"nba-p-1": _twenty()})
    targets = [
        (NBA, "Jayson Tatum", "player_points"),
        (NBA, "Jayson Tatum", "player_rebounds"),
        (NBA, "Jayson Tatum", "player_threes"),
    ]
    with ml.client() as http:
        out = resolve_game_logs(targets, settings=_settings(), redis_client=redis, http_client=http)
    pts = out[("Jayson Tatum", "player_points")]
    assert len(pts) == 20
    assert pts[0] == Decimal("20") and pts[-1] == Decimal("1")  # newest first
    assert out[("Jayson Tatum", "player_rebounds")][0] == Decimal("21")
    assert out[("Jayson Tatum", "player_threes")][0] == Decimal("0")
    assert all(isinstance(v, Decimal) for v in pts)
    assert len(ml.stat_calls()) == 1  # one call serves all three markets
    assert "season=2026-27" in ml.stat_calls()[0] and "type=game" in ml.stat_calls()[0]


def test_nfl_happy_path_reads_nested_passing_and_rushing_yards() -> None:
    logs = {
        "nfl-p-1": [_nfl_row(d, passing=200 + d, rushing=d) for d in range(28, 18, -1)],
        "nfl-p-2": [_nfl_row(d, rushing=50 + d) for d in range(28, 18, -1)],
    }
    roster = {"nfl": [_player("nfl-p-1", "Justin Herbert"), _player("nfl-p-2", "Derrick Henry")]}
    ml = MockML(roster, logs)
    with ml.client() as http:
        out = resolve_game_logs(
            [
                (NFL, "Justin Herbert", "player_pass_yds"),
                (NFL, "Justin Herbert", "player_rush_yds"),
                (NFL, "Derrick Henry", "player_rush_yds"),
            ],
            settings=_settings(),
            redis_client=FakeRedisClient(),
            http_client=http,
        )
    assert out[("Justin Herbert", "player_pass_yds")][0] == Decimal("228")
    assert out[("Justin Herbert", "player_rush_yds")][0] == Decimal("28")
    assert out[("Derrick Henry", "player_rush_yds")][0] == Decimal("78")
    assert len(out[("Derrick Henry", "player_rush_yds")]) == 10


def test_request_sends_api_key_header_and_never_logs_it(
    caplog: pytest.LogCaptureFixture,
) -> None:
    ml = MockML(NBA_ROSTER, {"nba-p-1": _twenty()})
    with caplog.at_level("DEBUG"), ml.client() as http:
        resolve_game_logs(
            [(NBA, "Jayson Tatum", "player_points")],
            settings=_settings(),
            redis_client=FakeRedisClient(),
            http_client=http,
        )
    assert ml.calls and all(r.headers["x-api-key"] == "test_ml_key" for r in ml.calls)
    assert all("authorization" not in r.headers for r in ml.calls)
    assert "test_ml_key" not in caplog.text


# ---- matching ----


def test_nickname_alias_matches_roster_full_name() -> None:
    ml = MockML(NBA_ROSTER, {"nba-p-2": _twenty()})
    with ml.client() as http:
        out = resolve_game_logs(
            [(NBA, "Cam Johnson", "player_points")],
            settings=_settings(),
            redis_client=FakeRedisClient(),
            http_client=http,
        )
    assert len(out[("Cam Johnson", "player_points")]) == 20
    assert "/players/nba-p-2/stats" in ml.stat_calls()[0]


@pytest.mark.parametrize("name", ["Nobody Real", "Jalen Williams"])
def test_unmatched_or_ambiguous_name_is_null_negative_cached_and_never_raises(name: str) -> None:
    redis = FakeRedisClient()
    ml = MockML(NBA_ROSTER, {"nba-p-5": _twenty(), "nba-p-6": _twenty()})
    with ml.client() as http:
        out = resolve_game_logs(
            [(NBA, name, "player_points")],
            settings=_settings(),
            redis_client=redis,
            http_client=http,
        )
    assert out == {}
    assert ml.stat_calls() == []  # never fetched stats for an unresolved player
    key = game_log_cache_key(NBA, name, "player_points")
    assert redis.store[key] == "null"
    assert redis.ttls[key] == WorkerSettings().game_log_negative_ttl_seconds


def test_placeholder_roster_row_is_ignored_so_full_name_stays_unique() -> None:
    ml = MockML(NBA_ROSTER, {"nba-p-4": _twenty()})
    with ml.client() as http:
        out = resolve_game_logs(
            [(NBA, "Aaron Funk", "player_points")],
            settings=_settings(),
            redis_client=FakeRedisClient(),
            http_client=http,
        )
    assert len(out[("Aaron Funk", "player_points")]) == 20
    assert "/players/nba-p-4/stats" in ml.stat_calls()[0]


def test_two_prop_names_for_one_player_cost_one_fetch_keyed_by_player_id() -> None:
    redis = FakeRedisClient()
    ml = MockML(NBA_ROSTER, {"nba-p-3": _twenty()})
    with ml.client() as http:
        out = resolve_game_logs(
            [
                (NBA, "Wendell Carter", "player_points"),
                (NBA, "Wendell Carter Jr.", "player_points"),
            ],
            settings=_settings(),
            redis_client=redis,
            http_client=http,
        )
    assert len(out[("Wendell Carter", "player_points")]) == 20
    assert len(out[("Wendell Carter Jr.", "player_points")]) == 20
    assert len(ml.stat_calls()) == 1
    assert any(k.startswith("ml:gamelog:nba:nba-p-3") for k in redis.store)


# ---- data shaping ----


def test_preseason_and_unknown_game_types_are_dropped() -> None:
    rows = [
        _nba_row(20, points=30, kind="preseason"),
        _nba_row(19, points=21, kind="postseason"),
        _nba_row(18, points=22, kind="regular"),
        _nba_row(17, points=99, kind="exhibition"),
        {**_nba_row(16, points=98), "gameType": None},
        _nba_row(15, points=23),
        _nba_row(14, points=24),
        _nba_row(13, points=25),
    ]
    ml = MockML(NBA_ROSTER, {"nba-p-1": rows})
    with ml.client() as http:
        out = resolve_game_logs(
            [(NBA, "Jayson Tatum", "player_points")],
            settings=_settings(),
            redis_client=FakeRedisClient(),
            http_client=http,
        )
    assert out[("Jayson Tatum", "player_points")] == [Decimal(v) for v in (21, 22, 23, 24, 25)]


def test_preseason_rows_do_not_count_toward_the_five_game_minimum() -> None:
    rows = [_nba_row(d, kind="preseason") for d in range(20, 15, -1)] + [
        _nba_row(d) for d in range(15, 12, -1)
    ]
    redis = FakeRedisClient()
    ml = MockML(NBA_ROSTER, {"nba-p-1": rows})
    with ml.client() as http:
        out = resolve_game_logs(
            [(NBA, "Jayson Tatum", "player_points")],
            settings=_settings(),
            redis_client=redis,
            http_client=http,
        )
    assert out == {}
    assert redis.store[game_log_cache_key(NBA, "Jayson Tatum", "player_points")] == "null"


def test_rows_are_sorted_newest_first_even_if_provider_order_differs() -> None:
    rows = list(reversed(_twenty()))
    ml = MockML(NBA_ROSTER, {"nba-p-1": rows})
    with ml.client() as http:
        out = resolve_game_logs(
            [(NBA, "Jayson Tatum", "player_points")],
            settings=_settings(),
            redis_client=FakeRedisClient(),
            http_client=http,
        )
    assert out[("Jayson Tatum", "player_points")][0] == Decimal("20")


@pytest.mark.parametrize("bad", [None, "n/a", True, {"x": 1}])
def test_row_with_missing_or_non_numeric_field_is_skipped_never_zero(bad: Any) -> None:
    rows = [_nba_row(d) for d in range(20, 10, -1)]
    rows[2] = _nba_row(18, points=bad)
    ml = MockML(NBA_ROSTER, {"nba-p-1": rows})
    with ml.client() as http:
        out = resolve_game_logs(
            [(NBA, "Jayson Tatum", "player_points")],
            settings=_settings(),
            redis_client=FakeRedisClient(),
            http_client=http,
        )
    series = out[("Jayson Tatum", "player_points")]
    assert len(series) == 9 and Decimal("0") not in series


def test_nfl_row_missing_stat_group_is_skipped() -> None:
    rows = [_nfl_row(d, rushing=40 + d) for d in range(28, 22, -1)] + [_nfl_row(21)]
    ml = MockML({"nfl": [_player("nfl-p-1", "Derrick Henry")]}, {"nfl-p-1": rows})
    with ml.client() as http:
        out = resolve_game_logs(
            [(NFL, "Derrick Henry", "player_rush_yds")],
            settings=_settings(),
            redis_client=FakeRedisClient(),
            http_client=http,
        )
    assert len(out[("Derrick Henry", "player_rush_yds")]) == 6


def test_empty_log_and_new_season_without_rows_are_null_negative_cached() -> None:
    redis = FakeRedisClient()
    ml = MockML(NBA_ROSTER, {"nba-p-1": []})
    with ml.client() as http:
        out = resolve_game_logs(
            [(NBA, "Jayson Tatum", "player_points")],
            settings=_settings(),
            redis_client=redis,
            http_client=http,
        )
    assert out == {}
    assert redis.store[game_log_cache_key(NBA, "Jayson Tatum", "player_points")] == "null"
    # The player-level cache holds the empty result for the full daily TTL, so the next cycle's
    # negative-cache expiry does not spend another credit re-polling a player with no games.
    assert redis.ttls["ml:gamelog:nba:nba-p-1"] == WorkerSettings().moneyline_log_ttl_seconds


def test_empty_log_is_not_repolled_after_the_target_negative_cache_expires() -> None:
    redis = FakeRedisClient()
    ml = MockML(NBA_ROSTER, {"nba-p-1": []})
    target = [(NBA, "Jayson Tatum", "player_points")]
    with ml.client() as http:
        resolve_game_logs(target, settings=_settings(), redis_client=redis, http_client=http)
        calls_after_first = len(ml.calls)
        del redis.store[game_log_cache_key(NBA, "Jayson Tatum", "player_points")]  # TTL expiry
        resolve_game_logs(target, settings=_settings(), redis_client=redis, http_client=http)
    assert len(ml.calls) == calls_after_first


def test_cycle_deadline_defers_everything_without_calls() -> None:
    redis = FakeRedisClient()
    ml = MockML(NBA_ROSTER, {"nba-p-1": _twenty()})
    with ml.client() as http:
        out = resolve_game_logs(
            [(NBA, "Jayson Tatum", "player_points")],
            settings=_settings(game_log_cycle_deadline_seconds=0.0),
            redis_client=redis,
            http_client=http,
        )
    assert out == {} and ml.calls == []
    assert game_log_cache_key(NBA, "Jayson Tatum", "player_points") not in redis.store


def test_example_placeholder_api_key_counts_as_not_configured() -> None:
    assert not is_game_log_source_configured(
        _settings(moneyline_api_key="replace_with_moneyline_api_key")
    )


def test_season_override_is_used_in_the_request() -> None:
    ml = MockML(NBA_ROSTER, {"nba-p-1": _twenty()})
    with ml.client() as http:
        resolve_game_logs(
            [(NBA, "Jayson Tatum", "player_points")],
            settings=_settings(moneyline_season_nba="2025-26"),
            redis_client=FakeRedisClient(),
            http_client=http,
        )
    assert "season=2025-26" in ml.stat_calls()[0]


def test_unmapped_market_is_null_without_any_provider_call() -> None:
    redis = FakeRedisClient()
    ml = MockML(NBA_ROSTER, {"nba-p-1": _twenty()})
    with ml.client() as http:
        out = resolve_game_logs(
            [(NBA, "Jayson Tatum", "player_assists")],
            settings=_settings(),
            redis_client=redis,
            http_client=http,
        )
    assert out == {} and ml.calls == []


def test_anytime_td_is_still_skipped() -> None:
    ml = MockML({"nfl": [_player("nfl-p-1", "Derrick Henry")]}, {})
    with ml.client() as http:
        out = resolve_game_logs(
            [(NFL, "Derrick Henry", "player_anytime_td")],
            settings=_settings(),
            redis_client=FakeRedisClient(),
            http_client=http,
        )
    assert out == {} and ml.calls == []


# ---- caching ----


def test_second_cycle_makes_no_provider_calls_after_positive_cache() -> None:
    redis = FakeRedisClient()
    ml = MockML(NBA_ROSTER, {"nba-p-1": _twenty()})
    target = [(NBA, "Jayson Tatum", "player_points")]
    with ml.client() as http:
        resolve_game_logs(target, settings=_settings(), redis_client=redis, http_client=http)
        first = len(ml.calls)
        out = resolve_game_logs(target, settings=_settings(), redis_client=redis, http_client=http)
    assert len(ml.calls) == first and len(out[("Jayson Tatum", "player_points")]) == 20
    key = "ml:gamelog:nba:nba-p-1"
    assert redis.ttls[key] == WorkerSettings().moneyline_log_ttl_seconds == 20 * 3600


def test_roster_pages_are_cached_for_seven_days_and_reused_across_cycles() -> None:
    redis = FakeRedisClient()
    ml = MockML(NBA_ROSTER, {"nba-p-1": _twenty(), "nba-p-2": _twenty()})
    with ml.client() as http:
        resolve_game_logs(
            [(NBA, "Jayson Tatum", "player_points")],
            settings=_settings(),
            redis_client=redis,
            http_client=http,
        )
        roster_calls = len(ml.roster_calls())
        resolve_game_logs(
            [(NBA, "Cameron Johnson", "player_points")],
            settings=_settings(),
            redis_client=redis,
            http_client=http,
        )
    assert roster_calls == 1 and len(ml.roster_calls()) == 1  # second cycle reused cached roster
    page_keys = [k for k in redis.store if k.startswith("ml:roster:nba:")]
    assert page_keys and all(redis.ttls[k] == 7 * 24 * 3600 for k in page_keys)


# ---- rate limit, budget, credits ----


def test_http_429_defers_without_negative_cache_or_breaker() -> None:
    redis = FakeRedisClient()
    ml = MockML(NBA_ROSTER, {}, status=429)
    targets = [(NBA, f"Player {i}", "player_points") for i in range(6)]
    with ml.client() as http:
        out = resolve_game_logs(targets, settings=_settings(), redis_client=redis, http_client=http)
    assert out == {}
    assert not [k for k in redis.store if k.startswith("gamelog:")]  # nothing negative-cached
    assert len(ml.calls) == 1  # after the first 429 the rest of the cycle is deferred, no calls


def test_http_error_is_a_failure_that_negative_caches_and_trips_breaker() -> None:
    redis = FakeRedisClient()
    ml = MockML(NBA_ROSTER, {}, status=500)
    targets = [(NBA, "Jayson Tatum", "player_points")] * 1 + [
        (NBA, "Cameron Johnson", "player_points"),
        (NBA, "Wendell Carter", "player_points"),
        (NBA, "Aaron Funk", "player_points"),
    ]
    with ml.client() as http:
        out = resolve_game_logs(targets, settings=_settings(), redis_client=redis, http_client=http)
    assert out == {}
    assert len(ml.calls) <= 3  # breaker stops after consecutive failures


def test_per_minute_limiter_defers_remaining_targets_across_cycles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    redis = FakeRedisClient()
    ml = MockML(NBA_ROSTER, {"nba-p-1": _twenty(), "nba-p-2": _twenty(), "nba-p-3": _twenty()})
    targets = [
        (NBA, "Jayson Tatum", "player_points"),
        (NBA, "Cameron Johnson", "player_points"),
        (NBA, "Wendell Carter", "player_points"),
    ]
    settings = _settings(moneyline_requests_per_minute=2)  # roster page + 1 stats call
    with ml.client() as http:
        out = resolve_game_logs(targets, settings=settings, redis_client=redis, http_client=http)
    assert len(ml.calls) == 2 and len(out) == 1
    assert not any(k.startswith("gamelog:") and redis.store[k] == "null" for k in redis.store)
    # Next minute the limiter window resets and the deferred targets are served.
    later = datetime(2026, 11, 16, 16, 1, tzinfo=UTC)
    monkeypatch.setattr(moneyline, "_utc_now", lambda: later)
    with ml.client() as http:
        out2 = resolve_game_logs(targets, settings=settings, redis_client=redis, http_client=http)
    assert ("Cameron Johnson", "player_points") in out2


def test_per_cycle_call_budget_counts_http_calls_and_defers_the_rest() -> None:
    redis = FakeRedisClient()
    ml = MockML(NBA_ROSTER, {"nba-p-1": _twenty(), "nba-p-2": _twenty()})
    targets = [(NBA, "Jayson Tatum", "player_points"), (NBA, "Cameron Johnson", "player_points")]
    settings = _settings(game_log_fetch_budget_per_cycle=2)  # roster page + one stats call
    with ml.client() as http:
        out = resolve_game_logs(targets, settings=settings, redis_client=redis, http_client=http)
    assert len(ml.calls) == 2 and len(out) == 1
    assert redis.store.get(game_log_cache_key(NBA, "Cameron Johnson", "player_points")) is None


def test_credits_exhausted_header_stops_the_cycle() -> None:
    ml = MockML(NBA_ROSTER, {"nba-p-1": _twenty(), "nba-p-2": _twenty()}, credits_remaining="0")
    targets = [(NBA, "Jayson Tatum", "player_points"), (NBA, "Cameron Johnson", "player_points")]
    with ml.client() as http:
        resolve_game_logs(
            targets, settings=_settings(), redis_client=FakeRedisClient(), http_client=http
        )
    assert len(ml.calls) == 1  # first response reported no credits left; no further calls


def test_summary_reports_credit_balance_and_call_count(
    caplog: pytest.LogCaptureFixture,
) -> None:
    ml = MockML(NBA_ROSTER, {"nba-p-1": _twenty()}, credits_remaining="742")
    targets = [(NBA, "Jayson Tatum", "player_points")]
    with caplog.at_level("INFO"), ml.client() as http:
        resolve_game_logs(
            targets, settings=_settings(), redis_client=FakeRedisClient(), http_client=http
        )
    cycle_logs = [r for r in caplog.records if "MoneyLine game-log cycle" in r.getMessage()]
    assert len(cycle_logs) == 1
    assert cycle_logs[0].levelname == "INFO"
    message = cycle_logs[0].getMessage()
    assert f"{len(ml.calls)} MoneyLine calls" in message
    assert "742 credits remaining" in message


def test_summary_reports_unknown_credits_when_header_missing(
    caplog: pytest.LogCaptureFixture,
) -> None:
    ml = MockML(NBA_ROSTER, {"nba-p-1": _twenty()})
    targets = [(NBA, "Jayson Tatum", "player_points")]
    with caplog.at_level("INFO"), ml.client() as http:
        resolve_game_logs(
            targets, settings=_settings(), redis_client=FakeRedisClient(), http_client=http
        )
    message = next(
        r.getMessage() for r in caplog.records if "MoneyLine game-log cycle" in r.getMessage()
    )
    assert "credits remaining unknown" in message


def test_incomplete_roster_defers_targets_and_completes_over_later_cycles() -> None:
    roster = {"nba": [_player(f"nba-p-{i}", f"Filler Player{i}") for i in range(10, 16)]}
    roster["nba"].append(_player("nba-p-1", "Jayson Tatum"))  # lands on page 4 with page_size=2
    redis = FakeRedisClient()
    ml = MockML(roster, {"nba-p-1": _twenty()}, page_size=2)
    target = [(NBA, "Jayson Tatum", "player_points")]
    settings = _settings(game_log_fetch_budget_per_cycle=2)
    with ml.client() as http:
        out1 = resolve_game_logs(target, settings=settings, redis_client=redis, http_client=http)
        assert out1 == {}
        assert redis.store.get(game_log_cache_key(NBA, "Jayson Tatum", "player_points")) is None
        out2 = resolve_game_logs(target, settings=settings, redis_client=redis, http_client=http)
        assert out2 == {}  # pages 3 and 4 still needed; the stats call has no budget left yet
        out3 = resolve_game_logs(
            target,
            settings=_settings(game_log_fetch_budget_per_cycle=20),
            redis_client=redis,
            http_client=http,
        )
    assert len(out3[("Jayson Tatum", "player_points")]) == 20
    pages = [u for u in ml.roster_calls()]
    assert len(pages) == len(set(pages)) == 4  # each roster page fetched exactly once


def test_redis_failure_never_raises() -> None:
    class BrokenRedis:
        def get(self, name: str) -> Any:
            raise RuntimeError("down")

        def set(self, name: str, value: str, ex: int | None = None) -> Any:
            raise RuntimeError("down")

        def publish(self, channel: str, message: str) -> Any:
            return 0

    ml = MockML(NBA_ROSTER, {"nba-p-1": _twenty()})
    with ml.client() as http:
        resolve_game_logs(
            [(NBA, "Jayson Tatum", "player_points")],
            settings=_settings(),
            redis_client=BrokenRedis(),  # type: ignore[arg-type]
            http_client=http,
        )


def test_malformed_json_payload_is_a_failure_not_a_crash() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="{nope")

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        out = resolve_game_logs(
            [(NBA, "Jayson Tatum", "player_points")],
            settings=_settings(),
            redis_client=FakeRedisClient(),
            http_client=http,
        )
    assert out == {}


# ---- integration with the 6.5 hit-rate path ----


def test_attached_moneyline_logs_populate_side_aware_hit_rates(
    db_session: tuple[Session, Any, Any],
) -> None:
    session, _, _ = db_session
    slate = _outcomes_slate(NOW, None, selection="UNDER")  # Jayson Tatum player_points 26.5
    rows = [_nba_row(d, points=10) for d in range(20, 5, -1)]
    ml = MockML({"nba": [_player("nba-p-1", "Jayson Tatum")]}, {"nba-p-1": rows})
    with ml.client() as http:
        attached = _attach_upstream_game_logs(
            slate, settings=_settings(), redis_client=FakeRedisClient(), http_client=http
        )
    assert len(attached.game_logs) == 1
    upsert_slate_to_db(session, attached, now_utc=NOW, redis_client=None)
    row = session.scalar(select(PlayerProp))
    assert row is not None
    assert row.hit_rate_l10 == Decimal("1.0000")
    assert row.recent_outcomes is not None and len(row.recent_outcomes) == 10


def test_unmatched_player_leaves_hit_rate_null_and_cycle_completes(
    db_session: tuple[Session, Any, Any],
) -> None:
    session, _, _ = db_session
    slate = _outcomes_slate(NOW, None)
    ml = MockML({"nba": [_player("nba-p-7", "Someone Else")]}, {})
    with ml.client() as http:
        attached = _attach_upstream_game_logs(
            slate, settings=_settings(), redis_client=FakeRedisClient(), http_client=http
        )
    assert attached.game_logs == []
    upsert_slate_to_db(session, attached, now_utc=NOW, redis_client=None)
    row = session.scalar(select(PlayerProp))
    assert row is not None and row.hit_rate_l10 is None and row.recent_outcomes is None


def test_cached_payload_shape_is_json_of_decimal_strings() -> None:
    redis = FakeRedisClient()
    ml = MockML(NBA_ROSTER, {"nba-p-1": _twenty()})
    with ml.client() as http:
        resolve_game_logs(
            [(NBA, "Jayson Tatum", "player_points")],
            settings=_settings(),
            redis_client=redis,
            http_client=http,
        )
    cached = json.loads(redis.store[game_log_cache_key(NBA, "Jayson Tatum", "player_points")])
    assert cached[0] == "20" and all(isinstance(v, str) for v in cached)
