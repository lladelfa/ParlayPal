"""Celery application and foundational worker tasks for ParlayPal."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from celery import Celery
from sqlalchemy.orm import Session

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

settings = get_settings()

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
