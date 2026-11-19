"""Celery application and foundational worker tasks for ParlayPal."""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from celery import Celery
from sqlalchemy.orm import Session

from parlaypal_worker.clv import ClosingOddsProviderError, stamp_due_bets
from parlaypal_worker.config import get_settings
from parlaypal_worker.db import create_session_factory
from parlaypal_worker.devig import (
    TwoWayPropMarketInput,
    process_and_publish_ev_props,
)
from parlaypal_worker.redis_client import (
    RedisLike,
    format_iso8601_utc,
    get_redis_client,
    publish_odds_delta,
)

logger = logging.getLogger(__name__)

settings = get_settings()


def build_beat_schedule(live_slate_interval_seconds: float) -> dict[str, dict[str, Any]]:
    """Beat schedule; the live-slate poll interval is configurable to protect API credits."""
    return {
        "sync-live-slate": {
            "task": "parlaypal_worker.sync_live_slate",
            "schedule": live_slate_interval_seconds,
            "options": {"expires": live_slate_interval_seconds * 0.9},
        },
        "sync-game-lines": {
            "task": "parlaypal_worker.sync_game_lines",
            "schedule": live_slate_interval_seconds,
            "options": {"expires": live_slate_interval_seconds * 0.9},
        },
        "stamp-closing-line-value-every-minute": {
            "task": "parlaypal_worker.stamp_closing_line_value",
            "schedule": 60.0,
        },
    }


celery_app = Celery(
    "parlaypal_worker",
    broker=settings.redis_url,
    backend=settings.redis_url,
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    beat_schedule=build_beat_schedule(settings.live_slate_poll_interval_seconds),
)


@celery_app.task(name="parlaypal_worker.health_check")
def health_check() -> dict[str, str]:
    """Return worker health status and ISO 8601 UTC timestamp."""
    return {
        "status": "ok",
        "service": "parlaypal_worker",
        "timestamp": format_iso8601_utc(datetime.now(UTC)),
    }


@celery_app.task(name="parlaypal_worker.ingest_odds_delta")
def ingest_odds_delta(payload: dict[str, Any]) -> str:
    """Validate and broadcast an odds delta frame to Redis cache and Pub/Sub."""
    client = get_redis_client()
    try:
        return publish_odds_delta(client, payload)
    finally:
        close_fn = getattr(client, "close", None)
        if callable(close_fn):
            close_fn()


@celery_app.task(name="parlaypal_worker.evaluate_prop_markets")
def evaluate_prop_markets(
    payload_or_sport_key: dict[str, Any] | str,
    prop_markets: Sequence[TwoWayPropMarketInput | dict[str, Any]] | None = None,
    *,
    session: Session | None = None,
    redis_client: RedisLike | None = None,
) -> dict[str, Any]:
    """Devig a batch of two-way player prop markets and cache non-outlier +EV props in Redis."""
    if isinstance(payload_or_sport_key, dict):
        resolved_sport_key = str(payload_or_sport_key.get("sport_key", ""))
        for key in ("markets", "props", "items"):
            if key in payload_or_sport_key and payload_or_sport_key[key] is not None:
                candidate = payload_or_sport_key[key]
                if isinstance(candidate, (str, bytes)) or not isinstance(candidate, Sequence):
                    raise ValueError(f"Payload '{key}' must be a sequence of prop market items.")
                resolved_markets: Sequence[TwoWayPropMarketInput | dict[str, Any]] = candidate
                break
        else:
            raise ValueError("Payload dict must contain a 'markets', 'props', or 'items' sequence.")
    else:
        if prop_markets is None:
            raise ValueError("prop_markets sequence is required when sport_key is passed as str.")
        resolved_sport_key = payload_or_sport_key
        resolved_markets = prop_markets

    owns_redis = redis_client is None
    owns_session = session is None
    client = redis_client if redis_client is not None else get_redis_client()
    active_session = session if session is not None else create_session_factory()()
    try:
        batch_result = process_and_publish_ev_props(
            sport_key=resolved_sport_key,
            prop_markets=resolved_markets,
            redis_client=client,
            session=active_session,
        )
        return batch_result.model_dump(mode="json")
    finally:
        if owns_session:
            close_session_fn = getattr(active_session, "close", None)
            if callable(close_session_fn):
                close_session_fn()
        if owns_redis:
            close_fn = getattr(client, "close", None)
            if callable(close_fn):
                close_fn()


@celery_app.task(name="parlaypal_worker.sync_player_hit_rates")
def sync_player_hit_rates(
    player_game_logs: Mapping[str, Sequence[Any]],
    *,
    session: Session | None = None,
) -> dict[str, Any]:
    """Compute and persist rolling hit rates for player props."""
    from parlaypal_worker.hit_rate import update_props_hit_rates

    owns_session = session is None
    active_session = session if session is not None else create_session_factory()()
    try:
        updated = update_props_hit_rates(active_session, player_game_logs)
        return {"status": "ok", "updated_props": updated}
    finally:
        if owns_session:
            close_session_fn = getattr(active_session, "close", None)
            if callable(close_session_fn):
                close_session_fn()


@celery_app.task(name="parlaypal_worker.sync_event_weather")
def sync_event_weather(
    weather_data: Sequence[dict[str, Any]],
    *,
    session: Session | None = None,
    redis_client: RedisLike | None = None,
) -> dict[str, Any]:
    """Ingest and persist weather telemetry for outdoor stadiums."""
    from parlaypal_worker.weather import ingest_events_weather

    owns_session = session is None
    owns_redis = redis_client is None
    active_session = session if session is not None else create_session_factory()()
    active_redis = redis_client if redis_client is not None else get_redis_client()
    try:
        updated = ingest_events_weather(active_session, weather_data, redis_client=active_redis)
        return {"status": "ok", "updated_events": updated}
    finally:
        if owns_session:
            close_session_fn = getattr(active_session, "close", None)
            if callable(close_session_fn):
                close_session_fn()
        if owns_redis:
            close_fn = getattr(active_redis, "close", None)
            if callable(close_fn):
                close_fn()


@celery_app.task(name="parlaypal_worker.sync_weather_and_hit_rates")
def sync_weather_and_hit_rates(
    payload: dict[str, Any],
    *,
    session: Session | None = None,
    redis_client: RedisLike | None = None,
) -> dict[str, Any]:
    """Coordinate both hit-rate and weather synchronization in a single batch pass."""
    from parlaypal_worker.hit_rate import update_props_hit_rates
    from parlaypal_worker.weather import ingest_events_weather

    owns_session = session is None
    owns_redis = redis_client is None
    active_session = session if session is not None else create_session_factory()()
    active_redis = redis_client if redis_client is not None else get_redis_client()
    try:
        updated_props = 0
        updated_events = 0
        if "player_game_logs" in payload and payload["player_game_logs"]:
            updated_props = update_props_hit_rates(active_session, payload["player_game_logs"])
        if "weather_data" in payload and payload["weather_data"]:
            updated_events = ingest_events_weather(
                active_session, payload["weather_data"], redis_client=active_redis
            )
        return {
            "status": "ok",
            "updated_props": updated_props,
            "updated_events": updated_events,
        }
    finally:
        if owns_session:
            close_session_fn = getattr(active_session, "close", None)
            if callable(close_session_fn):
                close_session_fn()
        if owns_redis:
            close_fn = getattr(active_redis, "close", None)
            if callable(close_fn):
                close_fn()


@celery_app.task(name="parlaypal_worker.sync_preset_parlay_feed")
def sync_preset_parlay_feed(
    *,
    session: Session | None = None,
    redis_client: RedisLike | None = None,
    target_count: int = 3,
) -> dict[str, Any]:
    """Generate curated preset parlay cards from database and sync to Redis."""
    from sqlalchemy import select

    from parlaypal_worker.models import Event, PlayerProp, Team
    from parlaypal_worker.presets import generate_curated_presets, sync_preset_feed_to_redis

    owns_session = session is None
    owns_redis = redis_client is None
    active_session = session if session is not None else create_session_factory()()
    active_redis = redis_client if redis_client is not None else get_redis_client()
    try:
        now_utc = datetime.now(UTC)
        props_stmt = select(PlayerProp).where(PlayerProp.status == "ACTIVE")
        props = list(active_session.scalars(props_stmt).all())

        events_stmt = select(Event).where(Event.commence_time > now_utc)
        events = list(active_session.scalars(events_stmt).all())
        events_map = {e.event_id: e for e in events}

        teams_stmt = select(Team)
        teams = list(active_session.scalars(teams_stmt).all())
        teams_map = {t.team_id: t for t in teams}

        feed = generate_curated_presets(
            props=props,
            events_map=events_map,
            teams_map=teams_map,
            target_count=target_count,
            now_utc=now_utc,
        )

        sync_preset_feed_to_redis(feed, active_redis, ttl_seconds=45)
        return {
            "status": "ok",
            "presets_generated": len(feed.cards),
            "generated_at": format_iso8601_utc(feed.generated_at),
        }
    finally:
        if owns_session:
            close_session_fn = getattr(active_session, "close", None)
            if callable(close_session_fn):
                close_session_fn()
        if owns_redis:
            close_fn = getattr(active_redis, "close", None)
            if callable(close_fn):
                close_fn()


@celery_app.task(name="parlaypal_worker.sync_market_browser_feed")
def sync_market_browser_feed(
    *,
    session: Session | None = None,
    redis_client: RedisLike | None = None,
) -> dict[str, Any]:
    """Assemble schedule and market browser feed from database and sync to Redis."""
    from sqlalchemy import select

    from parlaypal_worker.market_browser import (
        build_market_browser_feed,
        sync_market_browser_to_redis,
    )
    from parlaypal_worker.models import Event, PlayerProp, Team

    owns_session = session is None
    owns_redis = redis_client is None
    active_session = session if session is not None else create_session_factory()()
    active_redis = redis_client if redis_client is not None else get_redis_client()
    try:
        now_utc = datetime.now(UTC)
        props_stmt = select(PlayerProp).where(PlayerProp.status == "ACTIVE")
        props = list(active_session.scalars(props_stmt).all())

        events_stmt = select(Event).where(Event.commence_time > now_utc)
        events = list(active_session.scalars(events_stmt).all())
        events_map = {e.event_id: e for e in events}

        teams_stmt = select(Team)
        teams = list(active_session.scalars(teams_stmt).all())
        teams_map = {t.team_id: t for t in teams}

        feed = build_market_browser_feed(
            props=props,
            events_map=events_map,
            teams_map=teams_map,
            now_utc=now_utc,
        )

        sync_market_browser_to_redis(feed, active_redis, ttl_seconds=45)
        return {
            "status": "ok",
            "props_cached": len(feed.props),
            "games_cached": len(feed.games),
            "generated_at": format_iso8601_utc(feed.generated_at),
        }
    finally:
        if owns_session:
            close_session_fn = getattr(active_session, "close", None)
            if callable(close_session_fn):
                close_session_fn()
        if owns_redis:
            close_fn = getattr(active_redis, "close", None)
            if callable(close_fn):
                close_fn()


@celery_app.task(name="parlaypal_worker.price_sgp_event")
def price_sgp_event(
    event_id: str,
    legs: Sequence[dict[str, Any]],
    *,
    sport_key: str = "americanfootball_nfl",
    redis_client: RedisLike | None = None,
) -> dict[str, Any]:
    """Price Same-Game Parlay selections, audit intra-game correlation, and cache to Redis."""
    from parlaypal_worker.sgp import SgpLegSelection, price_sgp

    owns_redis = redis_client is None
    active_redis = redis_client if redis_client is not None else get_redis_client()
    try:
        parsed_legs = [SgpLegSelection(**leg) for leg in legs]
        response = price_sgp(
            event_id=event_id,
            sport_key=sport_key,
            legs=parsed_legs,
            redis_client=active_redis,
        )
        return response.model_dump(mode="json")
    finally:
        if owns_redis:
            close_fn = getattr(active_redis, "close", None)
            if callable(close_fn):
                close_fn()


@celery_app.task(
    name="parlaypal_worker.stamp_closing_line_value",
    autoretry_for=(ClosingOddsProviderError,),
    retry_backoff=True,
    max_retries=3,
)
def stamp_closing_line_value(
    *,
    session: Session | None = None,
    http_client: Any = None,
    now: datetime | str | None = None,
) -> dict[str, Any]:
    """Sweep due pending bets (>= 10 min post-commence) and stamp sharp closing-line CLV%."""
    owns_session = session is None
    active_session = session if session is not None else create_session_factory()()
    try:
        summary = stamp_due_bets(
            active_session,
            now=now,
            http_client=http_client,
        )
        return {
            "status": "ok",
            "checked_bets": summary.checked_bets,
            "stamped_bets": summary.stamped_bets,
            "skipped_suspect": summary.skipped_suspect,
            "skipped_invalid": summary.skipped_invalid,
            "skipped_not_due": summary.skipped_not_due,
            "events_fetched": summary.events_fetched,
            "timestamp": format_iso8601_utc(summary.processed_at),
        }
    except ClosingOddsProviderError as exc:
        logger.error("CLV worker provider failure (eligible for retry): %s", exc)
        raise
    finally:
        if owns_session:
            close_session_fn = getattr(active_session, "close", None)
            if callable(close_session_fn):
                close_session_fn()


@celery_app.task(name="parlaypal_worker.sync_live_slate")
def sync_live_slate(
    *,
    session: Session | None = None,
    redis_client: RedisLike | None = None,
    http_client: Any = None,
    api_key: str | None = None,
    base_url: str | None = None,
    now: datetime | str | None = None,
) -> dict[str, Any]:
    """Poll upstream slate (or fallback seed), persist to DB, and refresh Redis feeds."""
    from parlaypal_worker.ingestion import _parse_iso_datetime, run_live_slate_sync

    owns_session = session is None
    owns_redis = redis_client is None
    active_session: Session | None = session
    active_redis: RedisLike | None = redis_client

    try:
        if active_session is None:
            active_session = create_session_factory()()
        if active_redis is None:
            active_redis = get_redis_client()
        now_utc = _parse_iso_datetime(now) if isinstance(now, str) else now
        result = run_live_slate_sync(
            session=active_session,
            redis_client=active_redis,
            http_client=http_client,
            api_key=api_key,
            base_url=base_url,
            now_utc=now_utc,
        )
        return result.model_dump(mode="json")
    finally:
        if owns_redis and active_redis is not None:
            close_redis_fn = getattr(active_redis, "close", None)
            if callable(close_redis_fn):
                close_redis_fn()
        if owns_session and active_session is not None:
            close_session_fn = getattr(active_session, "close", None)
            if callable(close_session_fn):
                close_session_fn()


@celery_app.task(name="parlaypal_worker.sync_game_lines")
def sync_game_lines(
    *,
    session: Session | None = None,
    redis_client: RedisLike | None = None,
    http_client: Any = None,
    api_key: str | None = None,
    base_url: str | None = None,
    now: datetime | str | None = None,
) -> dict[str, Any]:
    """Poll upstream spread/moneyline/total lines, persist consensus lines, and cache them."""
    from parlaypal_worker.ingestion import _parse_iso_datetime, run_game_lines_sync

    owns_session = session is None
    owns_redis = redis_client is None
    active_session: Session | None = session
    active_redis: RedisLike | None = redis_client

    try:
        if active_session is None:
            active_session = create_session_factory()()
        if active_redis is None:
            active_redis = get_redis_client()
        now_utc = _parse_iso_datetime(now) if isinstance(now, str) else now
        return run_game_lines_sync(
            session=active_session,
            redis_client=active_redis,
            http_client=http_client,
            api_key=api_key,
            base_url=base_url,
            now_utc=now_utc,
        )
    finally:
        if owns_redis and active_redis is not None:
            close_redis_fn = getattr(active_redis, "close", None)
            if callable(close_redis_fn):
                close_redis_fn()
        if owns_session and active_session is not None:
            close_session_fn = getattr(active_session, "close", None)
            if callable(close_session_fn):
                close_session_fn()
