"""Worker-only player game-log fetching with Redis caching and a per-cycle fetch budget (Story 6.5)."""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Mapping, Sequence
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import quote

import httpx

from parlaypal_worker.config import WorkerSettings
from parlaypal_worker.market_keys import canonicalize_market_key
from parlaypal_worker.moneyline import MoneyLineClient, MoneyLineDeferred
from parlaypal_worker.redis_client import RedisLike

logger = logging.getLogger(__name__)

MIN_GAMES_FOR_HIT_RATE: int = 5
DEFAULT_GAME_LOG_TIMEOUT_SECONDS: float = 10.0
MAX_CONSECUTIVE_FAILURES: int = 3
SKIPPED_MARKET_KEYS: frozenset[str] = frozenset({"player_anytime_td"})


def game_log_cache_key(sport_key: str, player_name: str, market_key: str) -> str:
    """Build Redis key `gamelog:{sport}:{player}:{market}`."""
    return f"gamelog:{sport_key}:{player_name}:{market_key}"


MONEYLINE_PROVIDER = "moneyline"
MONEYLINE_PLACEHOLDER_KEYS: frozenset[str] = frozenset({"", "replace_with_moneyline_api_key"})


def _uses_moneyline(settings: WorkerSettings) -> bool:
    return settings.game_log_provider.strip().lower() == MONEYLINE_PROVIDER


def is_game_log_source_configured(settings: WorkerSettings) -> bool:
    """Return True when the selected provider is usable.

    MoneyLine needs only its API key; the generic fetcher (default) needs both the base URL and
    the path template.
    """
    if _uses_moneyline(settings):
        return settings.moneyline_api_key.strip() not in MONEYLINE_PLACEHOLDER_KEYS
    return bool(settings.game_log_base_url.strip() and settings.game_log_path_template.strip())


class GameLogFetchError(Exception):
    """Raised internally for any failed or malformed game-log lookup."""


def _extract_stat_list(payload: Any, settings: WorkerSettings) -> list[Any]:
    node = payload
    for part in (p for p in settings.game_log_response_path.split(".") if p):
        if not isinstance(node, Mapping) or part not in node:
            raise GameLogFetchError(f"Response path segment '{part}' not found.")
        node = node[part]
    if not isinstance(node, list):
        raise GameLogFetchError("Game-log payload is not a list.")
    return node


def _parse_stats(items: Sequence[Any], settings: WorkerSettings) -> list[Decimal]:
    stats: list[Decimal] = []
    field = settings.game_log_stat_field.strip()
    for item in items:
        raw = item
        if field:
            if not isinstance(item, Mapping) or field not in item:
                raise GameLogFetchError("Game-log item is missing the configured stat field.")
            raw = item[field]
        if isinstance(raw, bool) or raw is None or isinstance(raw, (Mapping, list)):
            raise GameLogFetchError("Game-log stat is not numeric.")
        try:
            value = Decimal(str(raw).strip())
        except (InvalidOperation, ValueError) as exc:
            raise GameLogFetchError("Game-log stat is not numeric.") from exc
        if not value.is_finite():
            raise GameLogFetchError("Game-log stat must be finite.")
        stats.append(value)
    if not settings.game_log_newest_first:
        stats.reverse()
    return stats


def fetch_player_game_log(
    *,
    sport_key: str,
    player_name: str,
    market_key: str,
    settings: WorkerSettings,
    http_client: httpx.Client,
    timeout: float = DEFAULT_GAME_LOG_TIMEOUT_SECONDS,
) -> list[Decimal]:
    """Fetch one player's recent stats (most recent first). Raises GameLogFetchError on any failure."""
    try:
        path = settings.game_log_path_template.format(
            sport=quote(sport_key, safe=""),
            player=quote(player_name, safe=""),
            market=quote(market_key, safe=""),
        )
    except (KeyError, IndexError, ValueError, AttributeError, TypeError) as exc:
        raise GameLogFetchError(f"Invalid game-log path template: {exc}") from exc
    url = f"{settings.game_log_base_url.rstrip('/')}/{path.lstrip('/')}"
    headers = {"Accept": "application/json"}
    if settings.game_log_api_key.strip():
        headers["Authorization"] = f"Bearer {settings.game_log_api_key.strip()}"
    try:
        response = http_client.get(url, headers=headers, timeout=timeout)
    except httpx.HTTPError as exc:
        raise GameLogFetchError(f"Transport error: {exc}") from exc
    if response.status_code != 200:
        raise GameLogFetchError(f"HTTP {response.status_code}")
    try:
        payload = response.json()
    except (ValueError, TypeError) as exc:
        raise GameLogFetchError("Invalid JSON") from exc
    return _parse_stats(_extract_stat_list(payload, settings), settings)


def _read_cache(redis_client: RedisLike, key: str) -> tuple[bool, list[Decimal] | None]:
    """Return (hit, stats). hit with stats None means a negative-cache entry."""
    try:
        raw = redis_client.get(key)
        if raw is None:
            return False, None
        text = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
        data = json.loads(text)
        if data is None:
            return True, None
        if isinstance(data, list):
            return True, [Decimal(str(v)) for v in data]
    except Exception as exc:  # noqa: BLE001
        logger.warning("Ignoring unreadable game-log cache entry %s: %s", key, exc)
    return False, None


def _write_cache(redis_client: RedisLike, key: str, stats: list[Decimal] | None, ttl: int) -> None:
    value = "null" if stats is None else json.dumps([str(s) for s in stats])
    try:
        redis_client.set(key, value, ex=max(1, ttl))
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not cache game log %s: %s", key, exc)


def resolve_game_logs(
    targets: Sequence[tuple[str, str, str]],
    *,
    settings: WorkerSettings,
    redis_client: RedisLike,
    http_client: httpx.Client | None = None,
) -> dict[tuple[str, str], list[Decimal]]:
    """Resolve game logs for (sport_key, player_name, market_key) targets.

    Cache hits cost no budget; each provider call consumes one unit of
    `game_log_fetch_budget_per_cycle`. Returns only logs with at least 5 games, keyed
    by (player_name, market_key). Never raises.
    """
    result: dict[tuple[str, str], list[Decimal]] = {}
    if not is_game_log_source_configured(settings):
        return result

    budget = max(0, settings.game_log_fetch_budget_per_cycle)
    deadline = settings.game_log_cycle_deadline_seconds
    started = time.monotonic()
    consecutive_failures = 0
    fetched = failed = deferred = 0
    owns_client = http_client is None
    client: httpx.Client | None = http_client
    seen: set[tuple[str, str, str]] = set()
    use_moneyline = _uses_moneyline(settings)
    moneyline: MoneyLineClient | None = None
    try:
        for sport_key, player_name, raw_market_key in targets:
            market_key = canonicalize_market_key(raw_market_key)
            target = (sport_key, player_name, market_key)
            if not player_name.strip() or market_key in SKIPPED_MARKET_KEYS or target in seen:
                continue
            seen.add(target)
            key = game_log_cache_key(sport_key, player_name, market_key)
            hit, cached = _read_cache(redis_client, key)
            if hit:
                if cached is not None and len(cached) >= MIN_GAMES_FOR_HIT_RATE:
                    result[(player_name, market_key)] = cached
                continue
            remaining = deadline - (time.monotonic() - started)
            # MoneyLine counts its own HTTP calls (roster pages and logs) against the same budget.
            out_of_budget = budget <= 0 and not use_moneyline
            if out_of_budget or remaining <= 0 or consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                deferred += 1
                continue
            if not use_moneyline:
                budget -= 1
            if client is None:
                client = httpx.Client(timeout=DEFAULT_GAME_LOG_TIMEOUT_SECONDS)
            try:
                if use_moneyline:
                    if moneyline is None:
                        moneyline = MoneyLineClient(
                            settings,
                            redis_client,
                            client,
                            deadline_monotonic=started + deadline,
                        )
                    stats = moneyline.fetch(
                        sport_key,
                        player_name,
                        market_key,
                        timeout=min(DEFAULT_GAME_LOG_TIMEOUT_SECONDS, remaining),
                    )
                else:
                    stats = fetch_player_game_log(
                        sport_key=sport_key,
                        player_name=player_name,
                        market_key=market_key,
                        settings=settings,
                        http_client=client,
                        timeout=min(DEFAULT_GAME_LOG_TIMEOUT_SECONDS, remaining),
                    )
            except MoneyLineDeferred:
                deferred += 1  # postponed, not failed: no negative cache, breaker untouched
                continue
            except Exception as exc:  # noqa: BLE001 - never raise into the beat loop
                logger.warning("Game-log lookup failed for %s/%s: %s", player_name, market_key, exc)
                _write_cache(redis_client, key, None, settings.game_log_negative_ttl_seconds)
                consecutive_failures += 1
                failed += 1
                continue
            consecutive_failures = 0
            if len(stats) < MIN_GAMES_FOR_HIT_RATE:
                _write_cache(redis_client, key, None, settings.game_log_negative_ttl_seconds)
                continue
            _write_cache(redis_client, key, stats, settings.game_log_positive_ttl_seconds)
            result[(player_name, market_key)] = stats
            fetched += 1
    finally:
        if owns_client and client is not None:
            client.close()
    if moneyline is not None:
        logger.info("MoneyLine game-log cycle: %s", moneyline.summary())
    logger.info(
        "Game-log cycle: %d fetched, %d failed, %d deferred (budget/deadline/breaker), %d resolved",
        fetched,
        failed,
        deferred,
        len(result),
    )
    return result
