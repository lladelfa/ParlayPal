"""Celery application and foundational worker tasks for ParlayPal."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from celery import Celery

from parlaypal_worker.config import get_settings
from parlaypal_worker.redis_client import (
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
        "timestamp": format_iso8601_utc(datetime.now(timezone.utc)),
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
