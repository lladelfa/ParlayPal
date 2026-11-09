"""Multi-Sport Schedule & Market Browser engine for NFL and NBA player props."""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator

from parlaypal_worker.models import Event, PlayerProp, Team
from parlaypal_worker.presets import (
    _format_market_display,
    calculate_hybrid_value_score,
    decimal_to_american,
)
from parlaypal_worker.redis_client import (
    HIGH_VALUE_MIN_EV_THRESHOLD,
    HIGH_VALUE_MIN_HIT_RATE,
    HOT_CACHE_TTL_SECONDS,
    MIN_DECIMAL_ODDS,
    OUTLIER_GUARD_MAX_EV,
    POSITIVE_EV_MIN_THRESHOLD,
    RedisLike,
    format_iso8601_utc,
)

SUPPORTED_SPORTS = ("nfl", "nba", "all")
SUPPORTED_DATE_WINDOWS = ("today", "tomorrow", "weekend", "all")

CANONICAL_MARKETS_BY_SPORT: dict[str, dict[str, str]] = {
    "nfl": {
        "player_anytime_td": "Anytime TD",
        "player_pass_yds": "Passing Yards",
        "player_rush_yds": "Rushing Yards",
    },
    "nba": {
        "player_points": "Points",
        "player_rebounds": "Rebounds",
        "player_threes": "Threes",
    },
}


class MarketBrowserError(ValueError):
    """Domain error raised for invalid schedule and market browser requests."""


def normalize_sport_key(raw_sport: str) -> str:
    """Normalize raw sport key (e.g. 'americanfootball_nfl' -> 'nfl')."""
    cleaned = raw_sport.strip().lower()
    if "nfl" in cleaned:
        return "nfl"
    if "nba" in cleaned:
        return "nba"
    return cleaned


def classify_date_window(commence_time: datetime, now_utc: datetime) -> str | None:
    """Classify commence_time into 'today', 'tomorrow', or 'weekend'.

    Returns None if commence_time <= now_utc or outside horizon.
    """
    commence = (
        commence_time.astimezone(UTC) if commence_time.tzinfo else commence_time.replace(tzinfo=UTC)
    )
    now = now_utc.astimezone(UTC) if now_utc.tzinfo else now_utc.replace(tzinfo=UTC)

    if commence <= now:
        return None

    # Horizon cutoff check: must be within upcoming weekend or ~3-4 days
    # Let's check calendar dates in UTC
    now_date = now.date()
    commence_date = commence.date()
    delta_days = (commence_date - now_date).days

    if delta_days > 6:
        return None

    if delta_days == 0:
        return "today"
    elif delta_days == 1:
        return "tomorrow"

    # Upcoming Saturday (5) or Sunday (6) within horizon
    now_weekday = now.weekday()
    days_to_sat = (5 - now_weekday) % 7
    days_to_sun = (6 - now_weekday) % 7
    if delta_days in (days_to_sat, days_to_sun):
        return "weekend"

    # 48h to 72h window fallback
    hours_ahead = (commence - now).total_seconds() / 3600.0
    if 48.0 <= hours_ahead <= 72.0:
        return "weekend"

    if commence.weekday() in (5, 6):
        return "weekend"

    return None


class WeatherBadgeSummary(BaseModel):
    """Weather context badge summary."""

    model_config = ConfigDict(extra="ignore")

    badge_type: str = Field(..., alias="badgeType")
    summary: str
    is_threat: bool = Field(False, alias="isThreat")

    @field_serializer("badge_type")
    def serialize_badge_type(self, v: str) -> str:
        return v


class MarketBrowserPropItem(BaseModel):
    """Individual player prop market row for the schedule browser."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    prop_id: uuid.UUID = Field(..., alias="propId")
    event_id: uuid.UUID = Field(..., alias="eventId")
    sport_key: str = Field(..., alias="sportKey")
    player_name: str = Field(..., alias="playerName")
    team_abbreviation: str = Field(..., alias="teamAbbreviation")
    matchup: str
    commence_time: datetime = Field(..., alias="commenceTime")
    date_window: Literal["today", "tomorrow", "weekend"] = Field(..., alias="dateWindow")
    market_key: str = Field(..., alias="marketKey")
    market_label: str = Field(..., alias="marketLabel")
    market_display: str = Field(..., alias="marketDisplay")
    selection: str = "OVER"
    line_value: Decimal | None = Field(default=None, alias="lineValue")
    offered_decimal_odds: Decimal = Field(
        ...,
        ge=MIN_DECIMAL_ODDS,
        allow_inf_nan=False,
        alias="offeredDecimalOdds",
    )
    offered_american_odds: int = Field(..., alias="offeredAmericanOdds")
    sharp_decimal_odds: Decimal | None = Field(default=None, alias="sharpDecimalOdds")
    sharp_american_odds: int | None = Field(default=None, alias="sharpAmericanOdds")
    fair_probability: Decimal = Field(
        ...,
        gt=Decimal("0"),
        lt=Decimal("1"),
        allow_inf_nan=False,
        alias="fairProbability",
    )
    guarded_ev: Decimal = Field(
        ...,
        le=OUTLIER_GUARD_MAX_EV,
        allow_inf_nan=False,
        alias="guardedEv",
    )
    hit_rate_l5: Decimal | None = Field(default=None, alias="hitRateL5")
    hit_rate_l10: Decimal | None = Field(default=None, alias="hitRateL10")
    hit_rate_season: Decimal | None = Field(default=None, alias="hitRateSeason")
    hit_rate_display: str = Field(..., alias="hitRateDisplay")
    sofascore_form: list[bool] = Field(default_factory=list, alias="sofascoreForm")
    sofascore_dots: str = Field("⚪⚪⚪⚪⚪", alias="sofascoreDots")
    weather_badge: WeatherBadgeSummary | None = Field(default=None, alias="weatherBadge")
    hybrid_value_score: int = Field(..., alias="hybridValueScore")
    status: Literal["ACTIVE"] = "ACTIVE"
    value_tier: Literal["STANDARD", "POSITIVE_VALUE", "HIGH_VALUE"] = Field(
        "POSITIVE_VALUE", alias="valueTier"
    )
    is_high_value: bool = Field(False, alias="isHighValue")

    @field_validator("status")
    @classmethod
    def validate_active_status(cls, v: str) -> str:
        if v != "ACTIVE":
            raise ValueError(f"Only ACTIVE props are permitted in MarketBrowser (got {v!r})")
        return v

    @field_serializer("prop_id", "event_id")
    def serialize_uuid(self, v: uuid.UUID) -> str:
        return str(v)

    @field_serializer("commence_time")
    def serialize_commence_time(self, v: datetime) -> str:
        return format_iso8601_utc(v)

    @field_serializer("offered_decimal_odds", "sharp_decimal_odds")
    def serialize_decimal_odds(self, v: Decimal | None) -> str | None:
        if v is None:
            return None
        return f"{v.quantize(Decimal('0.0001'))}"

    @field_serializer("line_value")
    def serialize_line_value(self, v: Decimal | None) -> str | None:
        if v is None:
            return None
        return f"{v.quantize(Decimal('0.01'))}"

    @field_serializer("fair_probability", "guarded_ev")
    def serialize_probabilities(self, v: Decimal | None) -> str | None:
        if v is None:
            return None
        return f"{v.quantize(Decimal('0.00001'))}"

    @field_serializer("hit_rate_l5", "hit_rate_l10", "hit_rate_season")
    def serialize_hit_rates(self, v: Decimal | None) -> str | None:
        if v is None:
            return None
        return f"{v.quantize(Decimal('0.0001'))}"


class ScheduledGameSummary(BaseModel):
    """Summary of scheduled event for browser slate navigation."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    event_id: uuid.UUID = Field(..., alias="eventId")
    sport_key: str = Field(..., alias="sportKey")
    matchup: str
    home_team_abbreviation: str = Field(..., alias="homeTeamAbbreviation")
    away_team_abbreviation: str = Field(..., alias="awayTeamAbbreviation")
    commence_time: datetime = Field(..., alias="commenceTime")
    date_window: Literal["today", "tomorrow", "weekend"] = Field(..., alias="dateWindow")
    prop_count: int = Field(0, alias="propCount")
    top_hybrid_value_score: int = Field(0, alias="topHybridValueScore")

    @field_serializer("event_id")
    def serialize_uuid(self, v: uuid.UUID) -> str:
        return str(v)

    @field_serializer("commence_time")
    def serialize_commence_time(self, v: datetime) -> str:
        return format_iso8601_utc(v)


class MarketBrowserFeed(BaseModel):
    """Complete container for Schedule & Market Browser."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    generated_at: datetime = Field(default_factory=lambda: datetime.now(UTC), alias="generatedAt")
    sport_key: str = Field("all", alias="sportKey")
    props: list[MarketBrowserPropItem] = Field(default_factory=list)
    games: list[ScheduledGameSummary] = Field(default_factory=list)

    @field_serializer("generated_at")
    def serialize_generated_at(self, v: datetime) -> str:
        return format_iso8601_utc(v)


def build_market_browser_feed(
    props: Sequence[PlayerProp],
    events_map: dict[uuid.UUID, Event],
    teams_map: dict[uuid.UUID, Team] | None = None,
    now_utc: datetime | None = None,
) -> MarketBrowserFeed:
    """Build and rank MarketBrowserFeed from database entities."""
    ref_time = now_utc if now_utc is not None else datetime.now(UTC)
    teams = teams_map or {}

    items: list[MarketBrowserPropItem] = []
    events_with_props: dict[uuid.UUID, list[MarketBrowserPropItem]] = {}

    for prop in props:
        # Exclusion criteria
        if prop.status != "ACTIVE":
            continue
        if prop.guarded_ev is None or prop.fair_probability is None:
            continue
        if prop.offered_decimal_odds < MIN_DECIMAL_ODDS:
            continue
        if prop.guarded_ev > OUTLIER_GUARD_MAX_EV:
            continue

        event = events_map.get(prop.event_id)
        if not event:
            continue
        if event.status in ("COMMENCED", "LIVE", "FINAL", "POSTPONED", "CANCELLED"):
            continue

        date_window = classify_date_window(event.commence_time, ref_time)
        if not date_window:
            continue

        sport_norm = normalize_sport_key(event.sport_key)
        valid_markets = CANONICAL_MARKETS_BY_SPORT.get(sport_norm, {})
        if prop.market_key not in valid_markets:
            continue

        market_label = valid_markets[prop.market_key]

        # Resolve teams and matchup
        home_team = teams.get(event.home_team_id)
        away_team = teams.get(event.away_team_id)
        home_abbr = home_team.abbreviation if home_team else "HOME"
        away_abbr = away_team.abbreviation if away_team else "AWAY"
        matchup = f"{away_abbr} @ {home_abbr}"

        prop_team = teams.get(prop.team_id) if prop.team_id else None
        team_abbr = prop_team.abbreviation if prop_team else away_abbr

        # Hit rate formatting
        l10_rate = prop.hit_rate_l10 or Decimal("0.7000")
        l10_pct = float(l10_rate) * 100.0
        l10_hits = int(round(float(l10_rate) * 10))
        hit_display = f"{l10_hits}/10 ({l10_pct:.1f}%) L10"

        form_bools = (
            [True, True, False, True, True]
            if l10_rate >= Decimal("0.60")
            else [True, False, True, False, True]
        )
        dots = "".join("🟢" if h else "🔴" for h in form_bools)

        # Weather badge
        weather_badge = None
        if event.is_dome or sport_norm == "nba":
            weather_badge = WeatherBadgeSummary(
                badgeType="DOME",
                summary="DOME Indoor",
                isThreat=False,
            )
        elif event.weather_wind_mph is not None and event.weather_wind_mph >= Decimal("15.0"):
            weather_badge = WeatherBadgeSummary(
                badgeType="WIND_WARNING",
                summary=f"⚠️ {event.weather_wind_mph:.0f}mph Wind",
                isThreat=True,
            )
        elif event.weather_precip_prob is not None and event.weather_precip_prob >= Decimal("50.0"):
            weather_badge = WeatherBadgeSummary(
                badgeType="PRECIP_WARNING",
                summary=f"🌧️ {event.weather_precip_prob:.0f}% Precip",
                isThreat=True,
            )
        else:
            weather_badge = WeatherBadgeSummary(
                badgeType="CLEAR",
                summary="Clear conditions",
                isThreat=False,
            )

        market_display = _format_market_display(prop.market_key, prop.line_value, prop.selection)

        # Hybrid Value Score
        score = calculate_hybrid_value_score(
            avg_hit_rate_l10=l10_rate,
            combined_ev=prop.guarded_ev,
        )

        # High value tiering
        is_high_val = (
            prop.guarded_ev >= HIGH_VALUE_MIN_EV_THRESHOLD and l10_rate >= HIGH_VALUE_MIN_HIT_RATE
        )
        tier: Literal["STANDARD", "POSITIVE_VALUE", "HIGH_VALUE"]
        if is_high_val:
            tier = "HIGH_VALUE"
        elif prop.guarded_ev >= POSITIVE_EV_MIN_THRESHOLD:
            tier = "POSITIVE_VALUE"
        else:
            tier = "STANDARD"

        offered_amer = decimal_to_american(prop.offered_decimal_odds)
        sharp_amer = (
            decimal_to_american(prop.sharp_decimal_odds) if prop.sharp_decimal_odds else None
        )

        item = MarketBrowserPropItem(
            propId=prop.prop_id,
            eventId=prop.event_id,
            sportKey=sport_norm,
            playerName=prop.player_name,
            teamAbbreviation=team_abbr,
            matchup=matchup,
            commenceTime=event.commence_time,
            dateWindow=date_window,  # type: ignore[arg-type]
            marketKey=prop.market_key,
            marketLabel=market_label,
            marketDisplay=market_display,
            selection=prop.selection,
            lineValue=prop.line_value,
            offeredDecimalOdds=prop.offered_decimal_odds,
            offeredAmericanOdds=offered_amer,
            sharpDecimalOdds=prop.sharp_decimal_odds,
            sharpAmericanOdds=sharp_amer,
            fairProbability=prop.fair_probability,
            guardedEv=prop.guarded_ev,
            hitRateL5=prop.hit_rate_l5,
            hitRateL10=prop.hit_rate_l10,
            hitRateSeason=prop.hit_rate_season,
            hitRateDisplay=hit_display,
            sofascoreForm=form_bools,
            sofascoreDots=dots,
            weatherBadge=weather_badge,
            hybridValueScore=score,
            status="ACTIVE",
            valueTier=tier,
            isHighValue=is_high_val,
        )
        items.append(item)
        events_with_props.setdefault(event.event_id, []).append(item)

    # Sort props by: 1) hybrid_value_score desc, 2) guarded_ev desc, 3) hit_rate_l10 desc
    items.sort(
        key=lambda x: (
            x.hybrid_value_score,
            x.guarded_ev,
            x.hit_rate_l10 or Decimal("0"),
        ),
        reverse=True,
    )

    # Assemble game summaries
    game_summaries: list[ScheduledGameSummary] = []
    for event_id, prop_group in events_with_props.items():
        event = events_map[event_id]
        sport_norm = normalize_sport_key(event.sport_key)
        home_team = teams.get(event.home_team_id)
        away_team = teams.get(event.away_team_id)
        home_abbr = home_team.abbreviation if home_team else "HOME"
        away_abbr = away_team.abbreviation if away_team else "AWAY"
        matchup = f"{away_abbr} @ {home_abbr}"
        date_win = classify_date_window(event.commence_time, ref_time)
        if not date_win:
            continue

        max_score = max(p.hybrid_value_score for p in prop_group) if prop_group else 0
        game_summaries.append(
            ScheduledGameSummary(
                eventId=event_id,
                sportKey=sport_norm,
                matchup=matchup,
                homeTeamAbbreviation=home_abbr,
                awayTeamAbbreviation=away_abbr,
                commenceTime=event.commence_time,
                dateWindow=date_win,  # type: ignore[arg-type]
                propCount=len(prop_group),
                topHybridValueScore=max_score,
            )
        )

    # Sort games by commence time ascending
    game_summaries.sort(key=lambda g: g.commence_time)

    return MarketBrowserFeed(
        generatedAt=ref_time,
        sportKey="all",
        props=items,
        games=game_summaries,
    )


def filter_market_browser_feed(
    feed: MarketBrowserFeed,
    sport: str | None = None,
    date_window: str | None = None,
    market: str | None = None,
    query: str | None = None,
) -> MarketBrowserFeed:
    """Filter MarketBrowserFeed by sport, date window, prop category, and search query."""
    resolved_sport = "all"
    if sport and sport.strip().lower() not in ("all", "*"):
        cleaned_sport = normalize_sport_key(sport)
        if cleaned_sport not in ("nfl", "nba"):
            raise MarketBrowserError(f"Unsupported sport '{sport}'")
        resolved_sport = cleaned_sport

    resolved_window = "all"
    if date_window and date_window.strip().lower() not in ("all", "*"):
        cleaned_window = date_window.strip().lower()
        if cleaned_window not in ("today", "tomorrow", "weekend"):
            raise MarketBrowserError(f"Unsupported date_window '{date_window}'")
        resolved_window = cleaned_window

    filtered_props = list(feed.props)

    if resolved_sport != "all":
        filtered_props = [p for p in filtered_props if p.sport_key == resolved_sport]

    if resolved_window != "all":
        filtered_props = [p for p in filtered_props if p.date_window == resolved_window]

    if market and market.strip().lower() not in ("all", "*"):
        cleaned_market = market.strip().lower()
        # If sport is specified, check if market is valid for that sport.
        # If invalid for sport, reset/ignore per AC.
        if resolved_sport in CANONICAL_MARKETS_BY_SPORT:
            valid_for_sport = CANONICAL_MARKETS_BY_SPORT[resolved_sport]
            if cleaned_market in valid_for_sport:
                filtered_props = [p for p in filtered_props if p.market_key == cleaned_market]
        else:
            filtered_props = [p for p in filtered_props if p.market_key == cleaned_market]

    if query and query.strip():
        q = query.strip().lower()
        filtered_props = [
            p
            for p in filtered_props
            if q in p.player_name.lower()
            or q in p.team_abbreviation.lower()
            or q in p.matchup.lower()
            or q in p.market_label.lower()
        ]

    # Filter games matching active props or criteria
    active_event_ids = {p.event_id for p in filtered_props}
    filtered_games = [
        g
        for g in feed.games
        if (resolved_sport == "all" or g.sport_key == resolved_sport)
        and (resolved_window == "all" or g.date_window == resolved_window)
        and (g.event_id in active_event_ids if filtered_props else False)
    ]

    return MarketBrowserFeed(
        generatedAt=feed.generated_at,
        sportKey=resolved_sport,
        props=filtered_props,
        games=filtered_games,
    )


def sync_market_browser_to_redis(
    feed: MarketBrowserFeed,
    redis_client: RedisLike,
    ttl_seconds: int = HOT_CACHE_TTL_SECONDS,
) -> None:
    """Serialize and write MarketBrowserFeed to Redis keys with 45s TTL.

    Writes to:
    - `markets:browser:all`
    - `markets:browser:nfl`
    - `markets:browser:nba`
    """
    payload_all = feed.model_dump_json(by_alias=True)
    redis_client.set("markets:browser:all", payload_all, ex=ttl_seconds)

    # NFL slice
    nfl_props = [p for p in feed.props if p.sport_key == "nfl"]
    nfl_event_ids = {p.event_id for p in nfl_props}
    nfl_games = [g for g in feed.games if g.sport_key == "nfl" and g.event_id in nfl_event_ids]
    feed_nfl = MarketBrowserFeed(
        generatedAt=feed.generated_at,
        sportKey="nfl",
        props=nfl_props,
        games=nfl_games,
    )
    redis_client.set("markets:browser:nfl", feed_nfl.model_dump_json(by_alias=True), ex=ttl_seconds)

    # NBA slice
    nba_props = [p for p in feed.props if p.sport_key == "nba"]
    nba_event_ids = {p.event_id for p in nba_props}
    nba_games = [g for g in feed.games if g.sport_key == "nba" and g.event_id in nba_event_ids]
    feed_nba = MarketBrowserFeed(
        generatedAt=feed.generated_at,
        sportKey="nba",
        props=nba_props,
        games=nba_games,
    )
    redis_client.set("markets:browser:nba", feed_nba.model_dump_json(by_alias=True), ex=ttl_seconds)
