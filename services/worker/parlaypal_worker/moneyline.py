"""MoneyLine (mlapi.bet) game-log provider adapter for NBA and NFL (Story 6.7).

Worker-only. Plugs into `game_logs.resolve_game_logs` when `game_log_provider == "moneyline"`.
Players are keyed by MoneyLine `playerId`; there is no name-search endpoint, so prop names are
resolved against a paged roster that is cached per page and filled in over several cycles.
"""

from __future__ import annotations

import json
import logging
import re
import time
import unicodedata
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import quote

import httpx

from parlaypal_worker.config import WorkerSettings
from parlaypal_worker.market_keys import canonicalize_market_key
from parlaypal_worker.redis_client import RedisLike

logger = logging.getLogger(__name__)

LEAGUE_BY_SPORT: dict[str, str] = {
    "basketball_nba": "nba",
    "americanfootball_nfl": "nfl",
}

# (sport_key, market_key) -> key path inside a game row's `stats` object. NBA stats are flat,
# NFL stats are nested per category. An unmapped market has no log (NULL), never a guess.
STAT_PATHS: dict[tuple[str, str], tuple[str, ...]] = {
    ("basketball_nba", "player_points"): ("points",),
    ("basketball_nba", "player_rebounds"): ("total_rebounds",),
    ("basketball_nba", "player_threes"): ("threepoint_goals_made",),
    ("americanfootball_nfl", "player_pass_yds"): ("passing", "yards"),
    ("americanfootball_nfl", "player_rush_yds"): ("rushing", "yards"),
}

# Preseason rows are not comparable to real games and must not count toward hit rates.
COUNTED_GAME_TYPES: frozenset[str] = frozenset({"regular", "postseason"})

ROSTER_PAGE_SIZE: int = 100
RATE_LIMIT_KEY_TTL_SECONDS: int = 70
DEFAULT_REQUEST_TIMEOUT_SECONDS: float = 10.0

NAME_SUFFIXES: frozenset[str] = frozenset({"jr", "sr", "ii", "iii", "iv", "v"})

# First-name equivalences seen between prop names and the roster. Applied to the first token on
# both sides; a collision between two real roster players still resolves to NULL (ambiguous).
FIRST_NAME_ALIASES: dict[str, str] = {
    "joshua": "josh",
    "alexandre": "alex",
    "alexander": "alex",
    "herbert": "herb",
    "matthew": "matt",
    "cameron": "cam",
    "michael": "mike",
    "christopher": "chris",
    "nicholas": "nick",
    "william": "will",
}

# Stale placeholder roster rows carry an abbreviated first name, e.g. "A. Funk".
_PLACEHOLDER_NAME = re.compile(r"^[A-Za-z]\.\s+\S+$")


def _utc_now() -> datetime:
    return datetime.now(UTC)


class MoneyLineError(Exception):
    """A failed or malformed MoneyLine lookup (counts toward the 6.5 circuit breaker)."""


class MoneyLineDeferred(Exception):
    """Work postponed to a later cycle (rate limit, credits, budget, deadline, partial roster).

    Not a failure: nothing is negative-cached and the circuit breaker is not tripped.
    """


def current_season(league: str, today: date) -> str:
    """Return the `YYYY-YY` season containing `today` (NBA starts in October, NFL in September)."""
    start_month = 10 if league == "nba" else 9
    start_year = today.year if today.month >= start_month else today.year - 1
    return f"{start_year}-{(start_year + 1) % 100:02d}"


def normalize_player_name(name: str) -> str:
    """Normalize a player name for matching: accents, case, punctuation, suffixes, nicknames."""
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii").lower()
    text = re.sub(r"['.]", "", text)  # "De'Anthony" -> "deanthony", "C.J." -> "cj", "Jr." -> "jr"
    text = re.sub(r"[^a-z ]", " ", text)  # hyphens and stray symbols separate tokens
    tokens = [t for t in text.split() if t not in NAME_SUFFIXES]
    if tokens:
        tokens[0] = FIRST_NAME_ALIASES.get(tokens[0], tokens[0])
    return " ".join(tokens)


def _to_decimal(value: Any) -> Decimal | None:
    if isinstance(value, bool) or value is None or isinstance(value, (Mapping, list)):
        return None
    try:
        number = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None
    return number if number.is_finite() else None


def _dig(node: Any, path: Sequence[str]) -> Any:
    for part in path:
        if not isinstance(node, Mapping) or part not in node:
            return None
        node = node[part]
    return node


def extract_series(sport_key: str, rows: Sequence[Any]) -> dict[str, list[Decimal]]:
    """Build newest-first stat series per supported market from a player's game rows.

    Keeps only regular-season and postseason games; a row missing the mapped field is skipped,
    never counted as zero.
    """
    kept = [
        row
        for row in rows
        if isinstance(row, Mapping)
        and row.get("gameType") in COUNTED_GAME_TYPES
        and isinstance(row.get("gameDate"), str)
    ]
    kept.sort(key=lambda row: str(row["gameDate"]), reverse=True)
    series: dict[str, list[Decimal]] = {}
    for (sport, market), path in STAT_PATHS.items():
        if sport != sport_key:
            continue
        values: list[Decimal] = []
        for row in kept:
            value = _to_decimal(_dig(row.get("stats"), path))
            if value is not None:
                values.append(value)
        series[market] = values
    return series


class MoneyLineClient:
    """Per-cycle MoneyLine client: rate limiter, call budget, roster index and log extraction."""

    def __init__(
        self,
        settings: WorkerSettings,
        redis_client: RedisLike,
        http_client: httpx.Client,
        *,
        deadline_monotonic: float,
    ) -> None:
        self._settings = settings
        self._redis = redis_client
        self._http = http_client
        self._deadline = deadline_monotonic
        self._calls_left = max(0, settings.game_log_fetch_budget_per_cycle)
        self._blocked = False  # a 429 or an exhausted credit balance defers the rest of the cycle
        self._local_calls = 0
        self._rosters: dict[str, dict[str, set[str]]] = {}
        self._incomplete_rosters: set[str] = set()
        self.http_calls = 0
        self.credits_remaining: int | None = None  # last x-credits-remaining this cycle
        self.unmatched = 0
        self.ambiguous = 0

    # ---- public ----

    def fetch(
        self,
        sport_key: str,
        player_name: str,
        market_key: str,
        *,
        timeout: float = DEFAULT_REQUEST_TIMEOUT_SECONDS,
    ) -> list[Decimal]:
        """Return newest-first stats for one target; `[]` when it cannot be resolved.

        Raises MoneyLineDeferred to postpone and MoneyLineError for a real failure.
        """
        market_key = canonicalize_market_key(market_key)
        league = LEAGUE_BY_SPORT.get(sport_key)
        if league is None or (sport_key, market_key) not in STAT_PATHS:
            return []
        player_id = self._resolve_player_id(league, player_name, timeout)
        if player_id is None:
            return []
        return self._player_series(sport_key, league, player_id, timeout).get(market_key, [])

    # ---- HTTP, limiter, budget ----

    def _acquire_slot(self) -> None:
        if self._blocked or self._calls_left <= 0 or time.monotonic() >= self._deadline:
            raise MoneyLineDeferred("call budget, credits or deadline exhausted")
        limit = max(1, self._settings.moneyline_requests_per_minute)
        key = f"ml:rl:{int(_utc_now().timestamp() // 60)}"
        used = self._local_calls
        try:
            raw = self._redis.get(key)
            if raw is not None:
                text = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
                used = max(used, int(text))
        except Exception as exc:  # noqa: BLE001 - fall back to the in-cycle count
            logger.warning("Could not read MoneyLine rate-limit counter: %s", exc)
        if used >= limit:
            raise MoneyLineDeferred("per-minute request limit reached")
        # Get-then-set is not atomic; acceptable for a single beat worker.
        try:
            self._redis.set(key, str(used + 1), ex=RATE_LIMIT_KEY_TTL_SECONDS)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not update MoneyLine rate-limit counter: %s", exc)
        self._local_calls += 1
        self._calls_left -= 1

    def _get_json(self, path: str, timeout: float) -> Mapping[str, Any]:
        self._acquire_slot()
        url = f"{self._settings.moneyline_api_base_url.rstrip('/')}{path}"
        headers = {
            "x-api-key": self._settings.moneyline_api_key.strip(),
            "Accept": "application/json",
        }
        remaining = self._deadline - time.monotonic()
        self.http_calls += 1
        try:
            response = self._http.get(
                url, headers=headers, timeout=max(0.1, min(timeout, remaining))
            )
        except httpx.HTTPError as exc:
            raise MoneyLineError(f"Transport error: {type(exc).__name__}") from exc
        self._note_credits(response)
        if response.status_code == 429:
            self._blocked = True
            raise MoneyLineDeferred("HTTP 429")
        if response.status_code != 200:
            raise MoneyLineError(f"HTTP {response.status_code}")
        try:
            payload = response.json()
        except (ValueError, TypeError) as exc:
            raise MoneyLineError("Invalid JSON") from exc
        if not isinstance(payload, Mapping) or payload.get("success") is False:
            raise MoneyLineError("Unsuccessful response")
        return payload

    def _note_credits(self, response: httpx.Response) -> None:
        raw = response.headers.get("x-credits-remaining")
        if raw is None:
            return
        try:
            remaining = int(raw)
        except ValueError:
            return
        self.credits_remaining = remaining
        if remaining <= 0:
            self._blocked = True

    # ---- Redis JSON helpers (never raise) ----

    def _read_json(self, key: str) -> Any:
        try:
            raw = self._redis.get(key)
            if raw is None:
                return None
            return json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else str(raw))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Ignoring unreadable MoneyLine cache entry %s: %s", key, exc)
            return None

    def _write_json(self, key: str, value: Any, ttl: int) -> None:
        try:
            self._redis.set(key, json.dumps(value), ex=max(1, ttl))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not cache MoneyLine entry %s: %s", key, exc)

    # ---- roster / name matching ----

    def _roster_index(self, league: str, timeout: float) -> dict[str, set[str]]:
        if league in self._rosters:
            return self._rosters[league]
        if league in self._incomplete_rosters:
            raise MoneyLineDeferred("roster sync incomplete")
        entries: list[Sequence[str]] = []
        page = 1
        try:
            while True:
                cache_key = f"ml:roster:{league}:{page}"
                cached = self._read_json(cache_key)
                if isinstance(cached, Mapping) and isinstance(cached.get("players"), list):
                    total_pages = int(cached.get("pages", 1))
                    entries.extend(cached["players"])
                else:
                    payload = self._get_json(
                        f"/players?league={quote(league, safe='')}&limit={ROSTER_PAGE_SIZE}&page={page}",
                        timeout,
                    )
                    total_pages, page_entries = self._parse_roster_page(payload)
                    self._write_json(
                        cache_key,
                        {"pages": total_pages, "players": page_entries},
                        self._settings.moneyline_roster_ttl_seconds,
                    )
                    entries.extend(page_entries)
                if page >= total_pages:
                    break
                page += 1
        except MoneyLineDeferred:
            self._incomplete_rosters.add(league)
            raise
        index: dict[str, set[str]] = {}
        for entry in entries:
            if len(entry) == 2:
                index.setdefault(normalize_player_name(str(entry[1])), set()).add(str(entry[0]))
        self._rosters[league] = index
        return index

    @staticmethod
    def _parse_roster_page(payload: Mapping[str, Any]) -> tuple[int, list[list[str]]]:
        data = payload.get("data")
        meta = payload.get("meta")
        if not isinstance(data, list) or not isinstance(meta, Mapping):
            raise MoneyLineError("Malformed roster page")
        try:
            total_pages = max(1, int(meta.get("pages", 1)))
        except (TypeError, ValueError) as exc:
            raise MoneyLineError("Malformed roster page count") from exc
        players: list[list[str]] = []
        for item in data:
            if not isinstance(item, Mapping):
                continue
            player_id = str(item.get("playerId") or "").strip()
            name = str(item.get("name") or "").strip()
            if not player_id or not name or _PLACEHOLDER_NAME.match(name):
                continue
            players.append([player_id, name])
        return total_pages, players

    def _resolve_player_id(self, league: str, player_name: str, timeout: float) -> str | None:
        index = self._roster_index(league, timeout)
        ids = index.get(normalize_player_name(player_name), set())
        if len(ids) == 1:
            return next(iter(ids))
        if ids:
            self.ambiguous += 1
        else:
            self.unmatched += 1
        return None

    # ---- game logs ----

    def _season(self, league: str) -> str:
        override = (
            self._settings.moneyline_season_nba
            if league == "nba"
            else self._settings.moneyline_season_nfl
        ).strip()
        return override or current_season(league, _utc_now().date())

    def _player_series(
        self, sport_key: str, league: str, player_id: str, timeout: float
    ) -> dict[str, list[Decimal]]:
        season = self._season(league)
        cache_key = f"ml:gamelog:{league}:{player_id}"
        cached = self._read_json(cache_key)
        if (
            isinstance(cached, Mapping)
            and cached.get("season") == season
            and isinstance(cached.get("markets"), Mapping)
        ):
            try:
                return {
                    str(market): [Decimal(str(v)) for v in values]
                    for market, values in cached["markets"].items()
                }
            except (InvalidOperation, TypeError, ValueError):
                logger.warning("Ignoring corrupt MoneyLine game-log cache %s", cache_key)
        payload = self._get_json(
            f"/players/{quote(player_id, safe='')}/stats?type=game&season={quote(season, safe='')}",
            timeout,
        )
        rows = payload.get("data")
        if not isinstance(rows, list):
            raise MoneyLineError("Game-log payload is not a list")
        series = extract_series(sport_key, rows)
        # Empty logs are cached for the full TTL too: the vendor refreshes stats daily, so
        # re-polling a player with no games every few minutes only burns credits.
        self._write_json(
            cache_key,
            {"season": season, "markets": {m: [str(v) for v in vs] for m, vs in series.items()}},
            self._settings.moneyline_log_ttl_seconds,
        )
        return series

    def summary(self) -> str:
        credits = (
            f"{self.credits_remaining} credits remaining"
            if self.credits_remaining is not None
            else "credits remaining unknown"
        )
        return (
            f"{self.http_calls} MoneyLine calls, {credits}, {self.unmatched} unmatched, "
            f"{self.ambiguous} ambiguous"
        )
