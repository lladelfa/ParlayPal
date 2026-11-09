"""Redis 7.2 hot cache (45s TTL) and Pub/Sub streaming helpers for ParlayPal worker."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
import json
from typing import Any, Protocol
import uuid

from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator
import redis

from parlaypal_worker.config import SUPPORTED_SPORT_KEYS, get_settings

HOT_CACHE_TTL_SECONDS: int = 45
MIN_DECIMAL_ODDS: Decimal = Decimal("1.01")
MAX_DECIMAL_ODDS: Decimal = Decimal("9999.9999")


class RedisLike(Protocol):
    """Protocol matching synchronous Redis client methods used by the worker."""

    def set(self, name: str, value: str, ex: int | None = None) -> Any: ...

    def get(self, name: str) -> Any: ...

    def publish(self, channel: str, message: str) -> Any: ...


def format_iso8601_utc(value: datetime) -> str:
    """Format a datetime as strict ISO 8601 UTC (`YYYY-MM-DDTHH:mm:ssZ`)."""
    if value.tzinfo is None:
        utc_dt = value.replace(tzinfo=timezone.utc)
    else:
        utc_dt = value.astimezone(timezone.utc)
    return utc_dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def odds_latest_key(sport_key: str, event_id: uuid.UUID | str) -> str:
    """Build namespaced Redis key `odds:latest:{sport_key}:{event_id}`."""
    return f"odds:latest:{sport_key}:{event_id}"


def ev_feed_key(sport_key: str) -> str:
    """Build namespaced Redis key `ev:feed:{sport_key}`."""
    return f"ev:feed:{sport_key}"


def sgp_audit_key(event_id: uuid.UUID | str) -> str:
    """Build namespaced Redis key `sgp:audit:{event_id}`."""
    return f"sgp:audit:{event_id}"


def odds_feed_channel(sport_key: str) -> str:
    """Build namespaced Redis Pub/Sub channel `odds:feed:{sport_key}`."""
    return f"odds:feed:{sport_key}"


def _validate_provider_prefix(value: str) -> str:
    stripped = value.strip()
    if (
        len(stripped) < 3
        or "_" not in stripped
        or stripped.startswith("_")
        or stripped.endswith("_")
    ):
        raise ValueError(
            "external_provider_id must include an explicit provider prefix (e.g., 'papi_nfl_12345')."
        )
    return stripped


def _validate_sport_key(value: str) -> str:
    cleaned = value.strip()
    if cleaned not in SUPPORTED_SPORT_KEYS:
        raise ValueError(
            f"Unsupported sport_key '{value}'. Expected one of: {', '.join(SUPPORTED_SPORT_KEYS)}."
        )
    return cleaned


class PropOddsQuote(BaseModel):
    """Validated individual prop market quote within an odds update frame."""

    model_config = ConfigDict(extra="forbid")

    prop_id: uuid.UUID = Field(default_factory=uuid.uuid4)
    external_provider_id: str
    market_key: str
    player_name: str
    selection: str = "OVER"
    line_value: Decimal | None = Field(default=None, allow_inf_nan=False)
    decimal_odds: Decimal = Field(
        ...,
        ge=MIN_DECIMAL_ODDS,
        le=MAX_DECIMAL_ODDS,
        allow_inf_nan=False,
    )
    sportsbook: str = "sharp_consensus"

    @field_validator("external_provider_id")
    @classmethod
    def check_provider_prefix(cls, value: str) -> str:
        return _validate_provider_prefix(value)

    @field_serializer("decimal_odds")
    def serialize_decimal_odds(self, value: Decimal) -> str:
        return f"{value.quantize(Decimal('0.0001'))}"

    @field_serializer("line_value")
    def serialize_line_value(self, value: Decimal | None) -> str | None:
        if value is None:
            return None
        return f"{value.quantize(Decimal('0.01'))}"


class OddsDeltaFrame(BaseModel):
    """Validated real-time odds delta payload for Redis hot cache and Pub/Sub broadcast."""

    model_config = ConfigDict(extra="forbid")

    event_id: uuid.UUID = Field(default_factory=uuid.uuid4)
    external_provider_id: str
    sport_key: str
    decimal_odds: Decimal = Field(
        ...,
        ge=MIN_DECIMAL_ODDS,
        le=MAX_DECIMAL_ODDS,
        allow_inf_nan=False,
    )
    quotes: list[PropOddsQuote] = Field(default_factory=list)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @field_validator("external_provider_id")
    @classmethod
    def check_provider_prefix(cls, value: str) -> str:
        return _validate_provider_prefix(value)

    @field_validator("sport_key")
    @classmethod
    def check_sport_key(cls, value: str) -> str:
        return _validate_sport_key(value)

    @field_serializer("decimal_odds")
    def serialize_decimal_odds(self, value: Decimal) -> str:
        return f"{value.quantize(Decimal('0.0001'))}"

    @field_serializer("updated_at")
    def serialize_updated_at(self, value: datetime) -> str:
        return format_iso8601_utc(value)


def get_redis_client(redis_url: str | None = None) -> redis.Redis:
    """Create a Redis 7.2 client decoded to UTF-8 strings."""
    resolved_url = redis_url or get_settings().redis_url
    return redis.Redis.from_url(resolved_url, decode_responses=True)


def publish_odds_delta(
    client: RedisLike,
    payload: OddsDeltaFrame | dict[str, Any],
    *,
    ttl_seconds: int = HOT_CACHE_TTL_SECONDS,
) -> str:
    """Validate odds delta, store in `odds:latest:{sport_key}:{event_id}` with 45s TTL,
    and publish JSON frame to `odds:feed:{sport_key}`.
    """
    frame = (
        payload
        if isinstance(payload, OddsDeltaFrame)
        else OddsDeltaFrame.model_validate(payload)
    )
    serialized = frame.model_dump_json()
    cache_key = odds_latest_key(frame.sport_key, frame.event_id)
    channel = odds_feed_channel(frame.sport_key)

    client.set(cache_key, serialized, ex=ttl_seconds)
    client.publish(channel, serialized)
    return serialized


def cache_ev_feed(
    client: RedisLike,
    sport_key: str,
    feed_items: list[dict[str, Any]],
    *,
    ttl_seconds: int = HOT_CACHE_TTL_SECONDS,
) -> str:
    """Cache +EV feed snapshot at `ev:feed:{sport_key}` with strict 45-second TTL."""
    validated_sport_key = _validate_sport_key(sport_key)
    envelope = {
        "sport_key": validated_sport_key,
        "updated_at": format_iso8601_utc(datetime.now(timezone.utc)),
        "items": feed_items,
    }
    serialized = json.dumps(envelope, default=str)
    client.set(ev_feed_key(validated_sport_key), serialized, ex=ttl_seconds)
    return serialized


def cache_sgp_audit(
    client: RedisLike,
    event_id: uuid.UUID | str,
    audit_data: dict[str, Any],
    *,
    ttl_seconds: int = HOT_CACHE_TTL_SECONDS,
) -> str:
    """Cache SGP pricing audit entry at `sgp:audit:{event_id}` with 45-second TTL."""
    envelope = {
        "event_id": str(event_id),
        "updated_at": format_iso8601_utc(datetime.now(timezone.utc)),
        "audit": audit_data,
    }
    serialized = json.dumps(envelope, default=str)
    client.set(sgp_audit_key(event_id), serialized, ex=ttl_seconds)
    return serialized
