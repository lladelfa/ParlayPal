"""Redis 7.2 hot cache (45s TTL) and Pub/Sub streaming helpers for ParlayPal worker."""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from functools import lru_cache
from typing import Any, Literal, Protocol

import redis
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_serializer,
    field_validator,
    model_validator,
)

from parlaypal_worker.config import SUPPORTED_SPORT_KEYS, get_settings

HOT_CACHE_TTL_SECONDS: int = 45
MIN_DECIMAL_ODDS: Decimal = Decimal("1.01")
MAX_DECIMAL_ODDS: Decimal = Decimal("9999.9999")
POSITIVE_EV_MIN_THRESHOLD: Decimal = Decimal("0.01500")
HIGH_VALUE_MIN_EV_THRESHOLD: Decimal = Decimal("0.03500")
HIGH_VALUE_MIN_HIT_RATE: Decimal = Decimal("0.7000")
OUTLIER_GUARD_MAX_EV: Decimal = Decimal("0.10000")


class RedisLike(Protocol):
    """Protocol matching synchronous Redis client methods used by the worker."""

    def set(self, name: str, value: str, ex: int | None = None) -> Any: ...

    def get(self, name: str) -> Any: ...

    def publish(self, channel: str, message: str) -> Any: ...


def format_iso8601_utc(value: datetime) -> str:
    """Format a datetime as strict ISO 8601 UTC (`YYYY-MM-DDTHH:mm:ssZ`)."""
    if value.tzinfo is None:
        utc_dt = value.replace(tzinfo=UTC)
    else:
        utc_dt = value.astimezone(UTC)
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


def markets_browser_key(sport_key: str | None = None) -> str:
    """Build namespaced Redis key `markets:browser:{sport_key}`."""
    if not sport_key or sport_key.strip().lower() in ("all", "*"):
        return "markets:browser:all"
    cleaned = sport_key.strip().lower()
    if "nfl" in cleaned:
        return "markets:browser:nfl"
    if "nba" in cleaned:
        return "markets:browser:nba"
    return f"markets:browser:{cleaned}"


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
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

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


class EvaluatedPropFeedItem(BaseModel):
    """Validated non-outlier positive-EV player prop item for `ev:feed:{sport_key}`."""

    model_config = ConfigDict(extra="forbid")

    prop_id: uuid.UUID = Field(default_factory=uuid.uuid4)
    event_id: uuid.UUID = Field(default_factory=uuid.uuid4)
    external_provider_id: str
    sport_key: str
    player_name: str
    market_key: str
    selection: str = "OVER"
    line_value: Decimal | None = Field(default=None, allow_inf_nan=False)
    offered_decimal_odds: Decimal = Field(
        ...,
        ge=MIN_DECIMAL_ODDS,
        le=MAX_DECIMAL_ODDS,
        allow_inf_nan=False,
    )
    sharp_decimal_odds: Decimal = Field(
        ...,
        ge=MIN_DECIMAL_ODDS,
        le=MAX_DECIMAL_ODDS,
        allow_inf_nan=False,
    )
    opposite_sharp_decimal_odds: Decimal | None = Field(
        default=None,
        ge=MIN_DECIMAL_ODDS,
        le=MAX_DECIMAL_ODDS,
        allow_inf_nan=False,
    )
    offered_american_odds: int | None = None
    sharp_american_odds: int | None = None
    fair_probability_mult: Decimal | None = Field(
        default=None,
        gt=Decimal("0"),
        lt=Decimal("1"),
        allow_inf_nan=False,
    )
    fair_probability_power: Decimal | None = Field(
        default=None,
        gt=Decimal("0"),
        lt=Decimal("1"),
        allow_inf_nan=False,
    )
    fair_probability: Decimal = Field(
        ...,
        gt=Decimal("0"),
        lt=Decimal("1"),
        allow_inf_nan=False,
    )
    guarded_ev: Decimal = Field(
        ...,
        ge=POSITIVE_EV_MIN_THRESHOLD,
        le=OUTLIER_GUARD_MAX_EV,
        allow_inf_nan=False,
    )
    hit_rate_l10: Decimal | None = Field(
        default=None,
        ge=Decimal("0"),
        le=Decimal("1"),
        allow_inf_nan=False,
    )
    status: Literal["ACTIVE"] = "ACTIVE"
    value_tier: Literal["POSITIVE_VALUE", "HIGH_VALUE"] = "POSITIVE_VALUE"
    is_positive_ev: bool = True
    is_high_value: bool = False
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @field_validator("external_provider_id")
    @classmethod
    def check_provider_prefix(cls, value: str) -> str:
        return _validate_provider_prefix(value)

    @field_validator("sport_key")
    @classmethod
    def check_sport_key(cls, value: str) -> str:
        return _validate_sport_key(value)

    @model_validator(mode="after")
    def enforce_public_feed_invariants(self) -> EvaluatedPropFeedItem:
        if self.status != "ACTIVE" or not self.is_positive_ev:
            raise ValueError("Only ACTIVE positive-EV props may be cached in ev:feed.")
        if self.guarded_ev < POSITIVE_EV_MIN_THRESHOLD:
            raise ValueError(
                "Sub-threshold props with guarded_ev < 1.5% cannot be cached in ev:feed."
            )
        if self.guarded_ev > OUTLIER_GUARD_MAX_EV:
            raise ValueError("Outlier props with guarded_ev > 10.0% cannot be cached in ev:feed.")

        qualifies_high_value = (
            self.guarded_ev >= HIGH_VALUE_MIN_EV_THRESHOLD
            and self.hit_rate_l10 is not None
            and self.hit_rate_l10 >= HIGH_VALUE_MIN_HIT_RATE
        )
        if self.is_high_value != (self.value_tier == "HIGH_VALUE"):
            raise ValueError("is_high_value must match value_tier == 'HIGH_VALUE'.")
        if self.is_high_value and not qualifies_high_value:
            raise ValueError(
                "HIGH_VALUE requires guarded_ev >= 0.03500 and hit_rate_l10 >= 0.7000."
            )
        if not self.is_high_value and qualifies_high_value:
            raise ValueError(
                "Props with guarded_ev >= 0.03500 and hit_rate_l10 >= 0.7000 must be HIGH_VALUE."
            )
        return self

    @field_serializer(
        "offered_decimal_odds",
        "sharp_decimal_odds",
        "opposite_sharp_decimal_odds",
    )
    def serialize_odds(self, value: Decimal | None) -> str | None:
        if value is None:
            return None
        return f"{value.quantize(Decimal('0.0001'), rounding=ROUND_HALF_UP)}"

    @field_serializer(
        "fair_probability_mult",
        "fair_probability_power",
        "fair_probability",
        "guarded_ev",
    )
    def serialize_quant_metrics(self, value: Decimal | None) -> str | None:
        if value is None:
            return None
        return f"{value.quantize(Decimal('0.00001'), rounding=ROUND_HALF_UP)}"

    @field_serializer("hit_rate_l10")
    def serialize_hit_rate(self, value: Decimal | None) -> str | None:
        if value is None:
            return None
        return f"{value.quantize(Decimal('0.0001'), rounding=ROUND_HALF_UP)}"

    @field_serializer("line_value")
    def serialize_line_value(self, value: Decimal | None) -> str | None:
        if value is None:
            return None
        return f"{value.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)}"

    @field_serializer("updated_at")
    def serialize_updated_at(self, value: datetime) -> str:
        return format_iso8601_utc(value)


@lru_cache(maxsize=8)
def _build_redis_pool(resolved_url: str) -> redis.ConnectionPool:
    """Create and cache a synchronous Redis connection pool per URL."""
    return redis.ConnectionPool.from_url(resolved_url, decode_responses=True)


def get_redis_pool(redis_url: str | None = None) -> redis.ConnectionPool:
    """Return a shared Redis 7.2 ConnectionPool decoded to UTF-8 strings."""
    resolved_url = redis_url or get_settings().redis_url
    return _build_redis_pool(resolved_url)


def get_redis_client(redis_url: str | None = None) -> redis.Redis:
    """Create a Redis 7.2 client backed by the shared connection pool."""
    pool = get_redis_pool(redis_url)
    return redis.Redis(connection_pool=pool)


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
        payload if isinstance(payload, OddsDeltaFrame) else OddsDeltaFrame.model_validate(payload)
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
    feed_items: Sequence[EvaluatedPropFeedItem | dict[str, Any]],
    *,
    ttl_seconds: int = HOT_CACHE_TTL_SECONDS,
) -> str:
    """Cache +EV feed snapshot at `ev:feed:{sport_key}` with strict 45-second TTL.

    Rejects any item stamped `SUSPECT_STALE_LINE` or with `guarded_ev > 10.0%`.
    """
    validated_sport_key = _validate_sport_key(sport_key)
    normalized_items: list[dict[str, Any]] = []
    for item in feed_items:
        if isinstance(item, EvaluatedPropFeedItem):
            if item.sport_key != validated_sport_key:
                raise ValueError(
                    f"Feed item sport_key '{item.sport_key}' does not match '{validated_sport_key}'."
                )
            normalized_items.append(item.model_dump(mode="json"))
        elif isinstance(item, dict):
            item_sport_key = item.get("sport_key")
            if (
                item_sport_key is not None
                and _validate_sport_key(str(item_sport_key)) != validated_sport_key
            ):
                raise ValueError(
                    f"Feed item sport_key '{item_sport_key}' does not match '{validated_sport_key}'."
                )
            status_val = item.get("status")
            if status_val is not None and status_val != "ACTIVE":
                raise ValueError(
                    f"Cannot publish non-ACTIVE market (status={status_val!r}) to ev:feed."
                )
            tier_val = item.get("value_tier")
            if tier_val is not None and tier_val not in ("POSITIVE_VALUE", "HIGH_VALUE"):
                raise ValueError(f"Cannot publish market with value_tier={tier_val!r} to ev:feed.")
            if item.get("is_positive_ev") is False:
                raise ValueError("Cannot publish market with is_positive_ev=False to ev:feed.")

            raw_ev = item.get("guarded_ev", item.get("ev"))
            if raw_ev is not None:
                if isinstance(raw_ev, bool):
                    raise ValueError("Invalid boolean EV value in ev:feed item.")
                try:
                    ev_dec = raw_ev if isinstance(raw_ev, Decimal) else Decimal(str(raw_ev).strip())
                except (InvalidOperation, ValueError, TypeError) as exc:
                    raise ValueError(f"Invalid EV value '{raw_ev}' in ev:feed item.") from exc
                if not ev_dec.is_finite():
                    raise ValueError("Non-finite EV value is not permitted in ev:feed.")
                if ev_dec > OUTLIER_GUARD_MAX_EV:
                    raise ValueError("Cannot publish market with EV > 10.0% to ev:feed.")
                if ev_dec < POSITIVE_EV_MIN_THRESHOLD:
                    raise ValueError(
                        "Cannot publish sub-threshold market with EV < 1.5% to ev:feed."
                    )

            if {
                "external_provider_id",
                "player_name",
                "market_key",
                "offered_decimal_odds",
                "sharp_decimal_odds",
                "fair_probability",
                "guarded_ev",
            }.issubset(item.keys()):
                item_payload = {**item, "sport_key": validated_sport_key}
                validated_item = EvaluatedPropFeedItem.model_validate(item_payload)
                normalized_items.append(validated_item.model_dump(mode="json"))
            else:
                normalized_items.append(item)
        else:
            raise TypeError(f"Unsupported feed item type: {type(item)!r}")

    envelope = {
        "sport_key": validated_sport_key,
        "updated_at": format_iso8601_utc(datetime.now(UTC)),
        "items": normalized_items,
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
        "updated_at": format_iso8601_utc(datetime.now(UTC)),
        "audit": audit_data,
    }
    serialized = json.dumps(envelope, default=str)
    client.set(sgp_audit_key(event_id), serialized, ex=ttl_seconds)
    return serialized
