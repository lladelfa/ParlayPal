"""Environmental weather context ingestion and outdoor stadium warning engine."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from parlaypal_worker.models import Event, Team

logger = logging.getLogger(__name__)

WIND_WARNING_THRESHOLD_MPH: Decimal = Decimal("15.0")
PRECIP_WARNING_THRESHOLD_PROB: Decimal = Decimal("50.0")
FREEZING_WARNING_THRESHOLD_F: Decimal = Decimal("32.0")

WEATHER_METRIC_QUANTIZE: Decimal = Decimal("0.01")


class WeatherBadgeType(StrEnum):
    """Context badge classification types."""

    DOME = "DOME"
    WIND_WARNING = "WIND_WARNING"
    PRECIP_WARNING = "PRECIP_WARNING"
    FREEZING_WARNING = "FREEZING_WARNING"
    CLEAR = "CLEAR"


class WeatherBadgeSeverity(StrEnum):
    """Badge visual luminosity severity."""

    WARNING = "WARNING"
    NEUTRAL = "NEUTRAL"


class WeatherContextBadge(BaseModel):
    """Structured telemetry badge for weather or stadium conditions."""

    model_config = ConfigDict(frozen=True)

    badge_type: WeatherBadgeType
    severity: WeatherBadgeSeverity
    label: str
    impacted_markets: list[str] = Field(default_factory=list)


class StadiumWeatherForecast(BaseModel):
    """Raw or normalized stadium environmental weather forecast."""

    model_config = ConfigDict(frozen=True)

    venue_name: str
    is_dome: bool = False
    wind_speed_mph: Decimal = Field(default=Decimal("0.0"), allow_inf_nan=False)
    temp_f: Decimal = Field(default=Decimal("70.0"), allow_inf_nan=False)
    precip_prob: Decimal = Field(default=Decimal("0.0"), allow_inf_nan=False)
    precip_type: str = "none"


class StadiumWeatherAssessment(BaseModel):
    """Evaluated weather context badges and operational impact."""

    model_config = ConfigDict(frozen=True)

    venue_name: str
    is_dome: bool
    has_warning: bool
    badges: list[WeatherContextBadge] = Field(default_factory=list)


def evaluate_stadium_weather(forecast: StadiumWeatherForecast) -> StadiumWeatherAssessment:
    """Evaluate stadium weather conditions and return context badges.

    - Indoor Dome stadiums bypass all external weather warnings and return a neutral DOME badge.
    - Outdoor stadiums attach:
      - WIND_WARNING if wind_speed_mph >= 15.0 (flagging passing and kicking props).
      - PRECIP_WARNING if precip_prob >= 50.0.
      - FREEZING_WARNING if temp_f <= 32.0.
      - CLEAR neutral badge if no adverse weather warnings trigger.
    """
    if forecast.is_dome:
        dome_badge = WeatherContextBadge(
            badge_type=WeatherBadgeType.DOME,
            severity=WeatherBadgeSeverity.NEUTRAL,
            label="Indoor / Climate Controlled",
            impacted_markets=[],
        )
        return StadiumWeatherAssessment(
            venue_name=forecast.venue_name,
            is_dome=True,
            has_warning=False,
            badges=[dome_badge],
        )

    badges: list[WeatherContextBadge] = []

    # 1. Wind warning
    if forecast.wind_speed_mph >= WIND_WARNING_THRESHOLD_MPH:
        badges.append(
            WeatherContextBadge(
                badge_type=WeatherBadgeType.WIND_WARNING,
                severity=WeatherBadgeSeverity.WARNING,
                label=f"{forecast.wind_speed_mph} mph winds",
                impacted_markets=["player_pass_yds", "player_kicking_pts"],
            )
        )

    # 2. Precipitation warning
    if forecast.precip_prob >= PRECIP_WARNING_THRESHOLD_PROB:
        badges.append(
            WeatherContextBadge(
                badge_type=WeatherBadgeType.PRECIP_WARNING,
                severity=WeatherBadgeSeverity.WARNING,
                label=f"{forecast.precip_prob}% precip",
                impacted_markets=["player_pass_yds", "player_reception_yds"],
            )
        )

    # 3. Freezing / cold warning
    if forecast.temp_f <= FREEZING_WARNING_THRESHOLD_F:
        badges.append(
            WeatherContextBadge(
                badge_type=WeatherBadgeType.FREEZING_WARNING,
                severity=WeatherBadgeSeverity.WARNING,
                label=f"{forecast.temp_f}°F cold",
                impacted_markets=["player_kicking_pts"],
            )
        )

    # 4. Clear fallback
    if not badges:
        badges.append(
            WeatherContextBadge(
                badge_type=WeatherBadgeType.CLEAR,
                severity=WeatherBadgeSeverity.NEUTRAL,
                label="Clear conditions",
                impacted_markets=[],
            )
        )

    has_warning = any(b.severity == WeatherBadgeSeverity.WARNING for b in badges)

    return StadiumWeatherAssessment(
        venue_name=forecast.venue_name,
        is_dome=False,
        has_warning=has_warning,
        badges=badges,
    )


def _to_metric(val: Any) -> Decimal:
    """Convert input to 2-decimal place Numeric(5, 2) Decimal."""
    try:
        dec = val if isinstance(val, Decimal) else Decimal(str(val).strip())
        return dec.quantize(WEATHER_METRIC_QUANTIZE, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError(f"Invalid weather metric '{val}': {exc}") from exc


def ingest_events_weather(
    session: Session,
    event_weather_data: Sequence[dict[str, Any]],
    redis_client: Any = None,
) -> int:
    """Persist ingested stadium weather conditions to Event rows in PostgreSQL
    and optionally cache weather assessment badges in Redis (45s TTL).
    """
    if not event_weather_data:
        return 0

    updated_count = 0
    now_utc = datetime.now(UTC)

    try:
        for item in event_weather_data:
            raw_event_id = item.get("event_id")
            if not raw_event_id:
                continue

            try:
                target_event_id = (
                    raw_event_id
                    if isinstance(raw_event_id, uuid.UUID)
                    else uuid.UUID(str(raw_event_id).strip())
                )
            except (ValueError, TypeError, AttributeError):
                continue

            event = session.scalar(select(Event).where(Event.event_id == target_event_id))
            if event is None:
                continue

            # Check if home team is dome
            home_team = session.scalar(select(Team).where(Team.team_id == event.home_team_id))
            if "is_dome" in item and item["is_dome"] is not None:
                is_dome = bool(item["is_dome"])
            elif home_team is not None:
                is_dome = bool(home_team.is_dome)
            else:
                is_dome = False

            event.is_dome = is_dome

            if is_dome:
                event.weather_wind_mph = Decimal("0.00")
                event.weather_precip_prob = Decimal("0.00")
                if "temp_f" in item and item["temp_f"] is not None:
                    event.weather_temp_f = _to_metric(item["temp_f"])
                else:
                    event.weather_temp_f = Decimal("70.00")
            else:
                if "wind_speed_mph" in item and item["wind_speed_mph"] is not None:
                    event.weather_wind_mph = _to_metric(item["wind_speed_mph"])
                if "temp_f" in item and item["temp_f"] is not None:
                    event.weather_temp_f = _to_metric(item["temp_f"])
                if "precip_prob" in item and item["precip_prob"] is not None:
                    event.weather_precip_prob = _to_metric(item["precip_prob"])

            event.updated_at = now_utc

            # Evaluate context badges and cache to Redis if client provided
            if redis_client is not None:
                venue = home_team.venue_name if home_team and home_team.venue_name else "Stadium"
                assessment = evaluate_stadium_weather(
                    StadiumWeatherForecast(
                        venue_name=venue,
                        is_dome=is_dome,
                        wind_speed_mph=event.weather_wind_mph or Decimal("0.0"),
                        temp_f=event.weather_temp_f or Decimal("70.0"),
                        precip_prob=event.weather_precip_prob or Decimal("0.0"),
                    )
                )
                cache_key = f"weather:event:{event.event_id}"
                redis_client.set(cache_key, assessment.model_dump_json(), ex=45)

            updated_count += 1

        session.commit()
        return updated_count
    except Exception as exc:
        session.rollback()
        logger.error("Failed to ingest event weather: %s", exc)
        raise
