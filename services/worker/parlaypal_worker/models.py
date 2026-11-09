"""SQLAlchemy 2.0 declarative models for ParlayPal PostgreSQL 16 substrate."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Uuid,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utc_now() -> datetime:
    """Return timezone-aware UTC timestamp."""
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    """Declarative base for all ParlayPal relational models."""


class Team(Base):
    """Sports team reference entity."""

    __tablename__ = "teams"
    __table_args__ = (
        CheckConstraint(
            r"external_provider_id LIKE '_%\_%_' ESCAPE '\' AND length(external_provider_id) >= 3",
            name="ck_teams_external_provider_id_prefix",
        ),
    )

    team_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    external_provider_id: Mapped[str] = mapped_column(
        String(128),
        unique=True,
        nullable=False,
    )
    sport_key: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    abbreviation: Mapped[str] = mapped_column(String(16), nullable=False)
    venue_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    is_dome: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        onupdate=utc_now,
    )


class Event(Base):
    """Scheduled or active sporting event."""

    __tablename__ = "events"
    __table_args__ = (
        Index("idx_events_sport_commence", "sport_key", "commence_time"),
        CheckConstraint(
            "status IN ('SCHEDULED', 'COMMENCED', 'LIVE', 'FINAL', 'POSTPONED', 'CANCELLED')",
            name="ck_events_status",
        ),
        CheckConstraint(
            "home_team_id != away_team_id",
            name="ck_events_distinct_teams",
        ),
        CheckConstraint(
            r"external_provider_id LIKE '_%\_%_' ESCAPE '\' AND length(external_provider_id) >= 3",
            name="ck_events_external_provider_id_prefix",
        ),
    )

    event_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    external_provider_id: Mapped[str] = mapped_column(
        String(128),
        unique=True,
        nullable=False,
    )
    sport_key: Mapped[str] = mapped_column(String(64), nullable=False)
    home_team_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("teams.team_id", ondelete="RESTRICT"),
        nullable=False,
    )
    away_team_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("teams.team_id", ondelete="RESTRICT"),
        nullable=False,
    )
    commence_time: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default="SCHEDULED",
    )
    weather_wind_mph: Mapped[Decimal | None] = mapped_column(
        Numeric(5, 2),
        nullable=True,
    )
    weather_temp_f: Mapped[Decimal | None] = mapped_column(
        Numeric(5, 2),
        nullable=True,
    )
    weather_precip_prob: Mapped[Decimal | None] = mapped_column(
        Numeric(5, 2),
        nullable=True,
    )
    is_dome: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        onupdate=utc_now,
    )


class PlayerProp(Base):
    """Player proposition market and quantitative telemetry."""

    __tablename__ = "player_props"
    __table_args__ = (
        Index("idx_player_props_event_market", "event_id", "market_key"),
        CheckConstraint(
            "offered_decimal_odds >= 1.01",
            name="ck_player_props_offered_decimal_odds_min",
        ),
        CheckConstraint(
            "sharp_decimal_odds IS NULL OR sharp_decimal_odds >= 1.01",
            name="ck_player_props_sharp_decimal_odds_min",
        ),
        CheckConstraint(
            "status IN ('ACTIVE', 'SUSPENDED', 'SUSPECT_STALE_LINE', 'SETTLED')",
            name="ck_player_props_status",
        ),
        CheckConstraint(
            r"external_provider_id LIKE '_%\_%_' ESCAPE '\' AND length(external_provider_id) >= 3",
            name="ck_player_props_external_provider_id_prefix",
        ),
    )

    prop_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    external_provider_id: Mapped[str] = mapped_column(
        String(128),
        unique=True,
        nullable=False,
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("events.event_id", ondelete="CASCADE"),
        nullable=False,
    )
    team_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("teams.team_id", ondelete="SET NULL"),
        nullable=True,
    )
    player_name: Mapped[str] = mapped_column(String(128), nullable=False)
    market_key: Mapped[str] = mapped_column(String(64), nullable=False)
    selection: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default="OVER",
    )
    line_value: Mapped[Decimal | None] = mapped_column(
        Numeric(8, 2),
        nullable=True,
    )
    offered_decimal_odds: Mapped[Decimal] = mapped_column(
        Numeric(8, 4),
        nullable=False,
    )
    sharp_decimal_odds: Mapped[Decimal | None] = mapped_column(
        Numeric(8, 4),
        nullable=True,
    )
    fair_probability: Mapped[Decimal | None] = mapped_column(
        Numeric(6, 5),
        nullable=True,
    )
    guarded_ev: Mapped[Decimal | None] = mapped_column(
        Numeric(7, 5),
        nullable=True,
    )
    hit_rate_l5: Mapped[Decimal | None] = mapped_column(
        Numeric(5, 4),
        nullable=True,
    )
    hit_rate_l10: Mapped[Decimal | None] = mapped_column(
        Numeric(5, 4),
        nullable=True,
    )
    hit_rate_season: Mapped[Decimal | None] = mapped_column(
        Numeric(5, 4),
        nullable=True,
    )
    status: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default="ACTIVE",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        onupdate=utc_now,
    )


class UserBet(Base):
    """Recorded user wager and closing line value tracking record."""

    __tablename__ = "user_bets"
    __table_args__ = (
        Index("idx_user_bets_user_placed", "user_id", "placed_at"),
        Index("idx_user_bets_event_pending", "event_id", "status"),
        CheckConstraint(
            "decimal_odds >= 1.01",
            name="ck_user_bets_decimal_odds_min",
        ),
        CheckConstraint(
            "closing_decimal_odds IS NULL OR closing_decimal_odds >= 1.01",
            name="ck_user_bets_closing_decimal_odds_min",
        ),
        CheckConstraint(
            "status IN ('PENDING', 'WON', 'LOST', 'PUSH', 'VOID')",
            name="ck_user_bets_status",
        ),
        CheckConstraint(
            r"external_provider_id IS NULL OR (external_provider_id LIKE '_%\_%_' ESCAPE '\' AND length(external_provider_id) >= 3)",
            name="ck_user_bets_external_provider_id_prefix",
        ),
    )

    bet_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        nullable=False,
        default=uuid.uuid4,
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("events.event_id", ondelete="CASCADE"),
        nullable=False,
    )
    prop_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("player_props.prop_id", ondelete="SET NULL"),
        nullable=True,
    )
    external_provider_id: Mapped[str | None] = mapped_column(
        String(128),
        unique=True,
        nullable=True,
    )
    sportsbook: Mapped[str] = mapped_column(String(64), nullable=False)
    decimal_odds: Mapped[Decimal] = mapped_column(
        Numeric(8, 4),
        nullable=False,
    )
    closing_decimal_odds: Mapped[Decimal | None] = mapped_column(
        Numeric(8, 4),
        nullable=True,
    )
    closing_fair_prob: Mapped[Decimal | None] = mapped_column(
        Numeric(6, 5),
        nullable=True,
    )
    clv_percentage: Mapped[Decimal | None] = mapped_column(
        Numeric(6, 3),
        nullable=True,
    )
    stake_amount: Mapped[Decimal] = mapped_column(
        Numeric(10, 2),
        nullable=False,
        default=Decimal("0.00"),
    )
    status: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default="PENDING",
    )
    placed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
    )
    settled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
