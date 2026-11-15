"""Automated upstream schedule, player prop ingestion, local seed fallback, and feed orchestration."""

from __future__ import annotations

import hashlib
import logging
import re
import uuid
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Literal
from urllib.parse import quote

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy import Engine, inspect, select
from sqlalchemy.orm import Session

from parlaypal_worker.config import get_settings
from parlaypal_worker.db import create_session_factory, init_db
from parlaypal_worker.devig import (
    DeviggingError,
    TwoWayPropMarketInput,
    american_to_decimal,
    evaluate_two_way_prop,
    process_and_publish_ev_props,
)
from parlaypal_worker.hit_rate import compute_rolling_hit_rate
from parlaypal_worker.market_browser import (
    CANONICAL_MARKETS_BY_SPORT,
    build_market_browser_feed,
    normalize_sport_key,
    sync_market_browser_to_redis,
)
from parlaypal_worker.models import Event, PlayerProp, Team
from parlaypal_worker.presets import generate_curated_presets, sync_preset_feed_to_redis
from parlaypal_worker.redis_client import (
    HOT_CACHE_TTL_SECONDS,
    OUTLIER_GUARD_MAX_EV,
    OddsDeltaFrame,
    PropOddsQuote,
    RedisLike,
    _validate_provider_prefix,
    _validate_sport_key,
    format_iso8601_utc,
    get_redis_client,
    publish_odds_delta,
)
from parlaypal_worker.weather import ingest_events_weather

logger = logging.getLogger(__name__)

DEFAULT_HTTP_TIMEOUT_SECONDS: float = 10.0
PLACEHOLDER_API_KEYS: frozenset[str] = frozenset({"", "replace_with_parlay_api_key"})

SHARP_BOOKMAKER_PRIORITY: dict[str, int] = {
    "pinnacle": 0,
    "circa": 1,
    "bookmaker": 2,
    "betonlineag": 3,
    "lowvig": 4,
    "novig": 5,
}

_SKIP_MAINLINE_MARKETS: frozenset[str] = frozenset(
    {"h2h", "spreads", "totals", "h2h_lay", "outrights"}
)
_OVER_SIDE_TOKENS: frozenset[str] = frozenset({"over", "yes"})
_UNDER_SIDE_TOKENS: frozenset[str] = frozenset({"under", "no"})
_ALLOWED_EVENT_STATUSES: frozenset[str] = frozenset(
    {"SCHEDULED", "COMMENCED", "LIVE", "FINAL", "POSTPONED", "CANCELLED"}
)
_WEATHER_QUANTIZE: Decimal = Decimal("0.01")
_WEATHER_MIN_NUMERIC: Decimal = Decimal("-999.99")
_WEATHER_MAX_NUMERIC: Decimal = Decimal("999.99")
_HIT_RATE_QUANTIZE: Decimal = Decimal("0.0001")
_ODDS_QUANTIZE: Decimal = Decimal("0.0001")


class _NoOpRedisClient:
    """In-memory no-op Redis client used when DB-only upserts run without Redis."""

    def set(self, name: str, value: str, ex: int | None = None) -> bool:
        return True

    def get(self, name: str) -> None:
        return None

    def publish(self, channel: str, message: str) -> int:
        return 0


_TEAM_METADATA: dict[str, tuple[str, str, bool]] = {
    # NFL teams
    "arizona cardinals": ("ARI", "State Farm Stadium", True),
    "atlanta falcons": ("ATL", "Mercedes-Benz Stadium", True),
    "baltimore ravens": ("BAL", "M&T Bank Stadium", False),
    "buffalo bills": ("BUF", "Highmark Stadium", False),
    "carolina panthers": ("CAR", "Bank of America Stadium", False),
    "chicago bears": ("CHI", "Soldier Field", False),
    "cincinnati bengals": ("CIN", "Paycor Stadium", False),
    "cleveland browns": ("CLE", "Huntington Bank Field", False),
    "dallas cowboys": ("DAL", "AT&T Stadium", True),
    "denver broncos": ("DEN", "Empower Field at Mile High", False),
    "detroit lions": ("DET", "Ford Field", True),
    "green bay packers": ("GB", "Lambeau Field", False),
    "houston texans": ("HOU", "NRG Stadium", True),
    "indianapolis colts": ("IND", "Lucas Oil Stadium", True),
    "jacksonville jaguars": ("JAX", "EverBank Stadium", False),
    "kansas city chiefs": ("KC", "Arrowhead Stadium", False),
    "las vegas raiders": ("LV", "Allegiant Stadium", True),
    "los angeles chargers": ("LAC", "SoFi Stadium", True),
    "los angeles rams": ("LAR", "SoFi Stadium", True),
    "miami dolphins": ("MIA", "Hard Rock Stadium", False),
    "minnesota vikings": ("MIN", "U.S. Bank Stadium", True),
    "new england patriots": ("NE", "Gillette Stadium", False),
    "new orleans saints": ("NO", "Caesars Superdome", True),
    "new york giants": ("NYG", "MetLife Stadium", False),
    "new york jets": ("NYJ", "MetLife Stadium", False),
    "philadelphia eagles": ("PHI", "Lincoln Financial Field", False),
    "pittsburgh steelers": ("PIT", "Acrisure Stadium", False),
    "san francisco 49ers": ("SF", "Levi's Stadium", False),
    "seattle seahawks": ("SEA", "Lumen Field", False),
    "tampa bay buccaneers": ("TB", "Raymond James Stadium", False),
    "tennessee titans": ("TEN", "Nissan Stadium", False),
    "washington commanders": ("WAS", "Northwest Stadium", False),
    # NBA teams (all arenas indoor)
    "atlanta hawks": ("ATL", "State Farm Arena", True),
    "boston celtics": ("BOS", "TD Garden", True),
    "brooklyn nets": ("BKN", "Barclays Center", True),
    "charlotte hornets": ("CHA", "Spectrum Center", True),
    "chicago bulls": ("CHI", "United Center", True),
    "cleveland cavaliers": ("CLE", "Rocket Mortgage FieldHouse", True),
    "dallas mavericks": ("DAL", "American Airlines Center", True),
    "denver nuggets": ("DEN", "Ball Arena", True),
    "detroit pistons": ("DET", "Little Caesars Arena", True),
    "golden state warriors": ("GSW", "Chase Center", True),
    "houston rockets": ("HOU", "Toyota Center", True),
    "indiana pacers": ("IND", "Gainbridge Fieldhouse", True),
    "la clippers": ("LAC", "Intuit Dome", True),
    "los angeles clippers": ("LAC", "Intuit Dome", True),
    "los angeles lakers": ("LAL", "Crypto.com Arena", True),
    "memphis grizzlies": ("MEM", "FedExForum", True),
    "miami heat": ("MIA", "Kaseya Center", True),
    "milwaukee bucks": ("MIL", "Fiserv Forum", True),
    "minnesota timberwolves": ("MIN", "Target Center", True),
    "new orleans pelicans": ("NOP", "Smoothie King Center", True),
    "new york knicks": ("NYK", "Madison Square Garden", True),
    "oklahoma city thunder": ("OKC", "Paycom Center", True),
    "orlando magic": ("ORL", "Kia Center", True),
    "philadelphia 76ers": ("PHI", "Wells Fargo Center", True),
    "phoenix suns": ("PHX", "Footprint Center", True),
    "portland trail blazers": ("POR", "Moda Center", True),
    "sacramento kings": ("SAC", "Golden 1 Center", True),
    "san antonio spurs": ("SAS", "Frost Bank Center", True),
    "toronto raptors": ("TOR", "Scotiabank Arena", True),
    "utah jazz": ("UTA", "Delta Center", True),
    "washington wizards": ("WAS", "Capital One Arena", True),
}


class UpstreamIngestionError(RuntimeError):
    """Structured error raised when upstream odds/schedule polling fails."""


class IngestedTeam(BaseModel):
    """Normalized team record ready for PostgreSQL upsert."""

    model_config = ConfigDict(frozen=True)

    external_provider_id: str
    sport_key: str
    name: str
    abbreviation: str
    venue_name: str | None = None
    is_dome: bool = False

    @field_validator("external_provider_id")
    @classmethod
    def check_provider_id(cls, value: str) -> str:
        return _validate_provider_prefix(value)

    @field_validator("sport_key")
    @classmethod
    def check_sport_key(cls, value: str) -> str:
        return _validate_sport_key(value)


class IngestedEvent(BaseModel):
    """Normalized event record ready for PostgreSQL upsert."""

    model_config = ConfigDict(frozen=True)

    external_provider_id: str
    sport_key: str
    home_team_external_id: str
    away_team_external_id: str
    commence_time: datetime
    status: str = "SCHEDULED"
    is_dome: bool = False
    weather_wind_mph: Decimal | None = None
    weather_temp_f: Decimal | None = None
    weather_precip_prob: Decimal | None = None

    @field_validator("external_provider_id", "home_team_external_id", "away_team_external_id")
    @classmethod
    def check_provider_id(cls, value: str) -> str:
        return _validate_provider_prefix(value)

    @field_validator("sport_key")
    @classmethod
    def check_sport_key(cls, value: str) -> str:
        return _validate_sport_key(value)

    @field_validator("status")
    @classmethod
    def check_status(cls, value: str) -> str:
        if value not in _ALLOWED_EVENT_STATUSES:
            raise ValueError(
                f"Invalid event status {value!r}; expected one of {sorted(_ALLOWED_EVENT_STATUSES)}."
            )
        return value

    @field_validator("weather_wind_mph", "weather_temp_f", "weather_precip_prob")
    @classmethod
    def check_weather_metric(cls, value: Decimal | None, info: Any) -> Decimal | None:
        if value is None:
            return None
        if not value.is_finite():
            raise ValueError(f"{info.field_name} must be finite.")
        if value < _WEATHER_MIN_NUMERIC or value > _WEATHER_MAX_NUMERIC:
            raise ValueError(
                f"{info.field_name} must be within [{_WEATHER_MIN_NUMERIC}, {_WEATHER_MAX_NUMERIC}] (got {value})."
            )
        if info.field_name == "weather_wind_mph" and value < Decimal("0"):
            raise ValueError(f"weather_wind_mph must be >= 0 (got {value}).")
        if info.field_name == "weather_precip_prob" and (
            value < Decimal("0") or value > Decimal("100")
        ):
            raise ValueError(f"weather_precip_prob must be within [0, 100] (got {value}).")
        quantized = value.quantize(_WEATHER_QUANTIZE, rounding=ROUND_HALF_UP)
        if quantized < _WEATHER_MIN_NUMERIC or quantized > _WEATHER_MAX_NUMERIC:
            raise ValueError(
                f"{info.field_name} quantized out of Numeric(5, 2) bounds (got {quantized})."
            )
        return quantized


class IngestedProp(BaseModel):
    """Normalized two-way player prop record prior to Brent devigging."""

    model_config = ConfigDict(frozen=True)

    external_provider_id: str
    event_external_id: str
    sport_key: str
    team_external_id: str | None = None
    player_name: str
    market_key: str
    selection: Literal["OVER", "UNDER"] = "OVER"
    line_value: Decimal | None = None
    offered_decimal_odds: Decimal
    sharp_decimal_odds: Decimal
    opposite_sharp_decimal_odds: Decimal
    hit_rate_l5: Decimal | None = None
    hit_rate_l10: Decimal | None = None
    hit_rate_season: Decimal | None = None

    @field_validator("external_provider_id", "event_external_id")
    @classmethod
    def check_provider_id(cls, value: str) -> str:
        return _validate_provider_prefix(value)

    @field_validator("team_external_id")
    @classmethod
    def check_team_provider_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _validate_provider_prefix(value)

    @field_validator("sport_key")
    @classmethod
    def check_sport_key(cls, value: str) -> str:
        return _validate_sport_key(value)

    @field_validator("hit_rate_l5", "hit_rate_l10", "hit_rate_season")
    @classmethod
    def check_hit_rate(cls, value: Decimal | None, info: Any) -> Decimal | None:
        if value is None:
            return None
        if not value.is_finite():
            raise ValueError(f"{info.field_name} must be finite.")
        if value < Decimal("0") or value > Decimal("1"):
            raise ValueError(f"{info.field_name} must be within [0, 1] (got {value}).")
        return value.quantize(_HIT_RATE_QUANTIZE, rounding=ROUND_HALF_UP)


class IngestedGameLog(BaseModel):
    """Rolling historical stat log for a player prop market."""

    model_config = ConfigDict(frozen=True)

    player_name: str
    market_key: str
    stats: list[Decimal]


class IngestedSlate(BaseModel):
    """Normalized multi-sport slate produced by upstream poller or seed fallback."""

    model_config = ConfigDict(frozen=True)

    source: Literal["upstream", "seed"]
    generated_at: datetime
    teams: list[IngestedTeam] = Field(default_factory=list)
    events: list[IngestedEvent] = Field(default_factory=list)
    props: list[IngestedProp] = Field(default_factory=list)
    game_logs: list[IngestedGameLog] = Field(default_factory=list)
    skipped_malformed: int = 0

    def to_player_game_logs(self) -> dict[tuple[str, str], list[Decimal]]:
        """Convert structured game logs to mapping keyed by (player_name, market_key)."""
        return {
            (entry.player_name, entry.market_key): list(entry.stats) for entry in self.game_logs
        }


class UpsertSlateResult(BaseModel):
    """Counts produced by persisting an IngestedSlate to PostgreSQL and devigging props."""

    model_config = ConfigDict(frozen=True)

    teams_upserted: int
    events_upserted: int
    commenced_transitioned: int
    props_evaluated: int
    props_outlier_blocked: int
    props_skipped_malformed: int


class SlateSyncResult(BaseModel):
    """End-to-end summary returned by run_live_slate_sync and sync_live_slate."""

    model_config = ConfigDict(frozen=True)

    status: Literal["ok"] = "ok"
    source: Literal["upstream", "seed"]
    teams_upserted: int
    events_upserted: int
    commenced_transitioned: int
    props_evaluated: int
    props_outlier_blocked: int
    props_skipped_malformed: int
    presets_generated: int
    market_browser_props: int
    market_browser_games: int
    odds_deltas_published: int
    synced_at: str


def is_api_key_configured(api_key: str | None) -> bool:
    """Return True only when PARLAY_API_KEY is present and not a placeholder value."""
    if api_key is None:
        return False
    cleaned = api_key.strip()
    return cleaned.lower() not in PLACEHOLDER_API_KEYS


def _normalize_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _parse_iso_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        return _normalize_utc(value)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Invalid ISO datetime value: {value!r}")
    cleaned = value.strip()
    if cleaned.endswith("Z"):
        cleaned = cleaned[:-1] + "+00:00"
    return _normalize_utc(datetime.fromisoformat(cleaned))


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")
    return slug or "item"


def _first_present(mapping: Mapping[str, Any], *keys: str) -> Any:
    """Return the first non-None value present among keys in mapping."""
    for key in keys:
        value = mapping.get(key)
        if value is not None:
            return value
    return None


def _has_nonempty_id(value: Any) -> bool:
    """Return True for valid non-empty non-boolean identifier values, including integer 0."""
    if value is None or isinstance(value, bool):
        return False
    return str(value).strip() != ""


def _ensure_provider_prefix(
    raw_id: Any,
    *,
    prefix: str = "papi",
    sport_short: str | None = None,
) -> str:
    raw_text = "" if raw_id is None else str(raw_id).strip()
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", raw_text)
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    if not cleaned:
        digest = hashlib.sha1(raw_text.encode("utf-8")).hexdigest()[:12]
        cleaned = f"item_{digest}"

    if cleaned.startswith(("papi_", "seed_")) and len(cleaned) >= 3:
        candidate = cleaned
    elif sport_short:
        candidate = f"{prefix}_{sport_short}_{cleaned}"
    else:
        candidate = f"{prefix}_{cleaned}"

    if len(candidate) > 128:
        digest = hashlib.sha1(candidate.encode("utf-8")).hexdigest()[:12]
        head = candidate[: 128 - 13].rstrip("_")
        candidate = f"{head}_{digest}"

    return _validate_provider_prefix(candidate)


def _deterministic_prop_provider_id(
    prefix: str,
    event_external_id: str,
    market_key: str,
    player_name: str,
    selection: str,
    line_value: Decimal | None,
) -> str:
    line_str = f"{line_value:.2f}" if line_value is not None else "none"
    fingerprint_src = (
        f"{event_external_id}|{market_key}|{player_name.lower()}|{selection}|{line_str}"
    )
    digest = hashlib.sha1(fingerprint_src.encode("utf-8")).hexdigest()[:12]
    readable = _slugify(f"{player_name}_{market_key}")[:48]
    candidate = f"{prefix}_prop_{readable}_{digest}"[:128].rstrip("_")
    return _validate_provider_prefix(candidate)


def _resolve_team_metadata(
    raw_team: Any,
    sport_key: str,
    *,
    explicit_abbr: str | None = None,
    prefix: str = "papi",
) -> IngestedTeam:
    sport_short = normalize_sport_key(sport_key)
    default_is_dome = sport_short == "nba"

    if isinstance(raw_team, Mapping):
        name = str(raw_team.get("name") or raw_team.get("team_name") or "").strip()
        abbr = str(
            raw_team.get("abbreviation") or raw_team.get("abbr") or explicit_abbr or ""
        ).strip()
        venue = raw_team.get("venue_name") or raw_team.get("venue")
        raw_is_dome = raw_team.get("is_dome")
        is_dome = bool(raw_is_dome) if raw_is_dome is not None else default_is_dome
        raw_id = _first_present(raw_team, "external_provider_id", "id")
    else:
        name = str(raw_team or "").strip()
        abbr = str(explicit_abbr or "").strip()
        venue = None
        raw_is_dome = None
        is_dome = default_is_dome
        raw_id = None

    if not name:
        raise ValueError("Team name is missing in upstream event payload.")

    meta = _TEAM_METADATA.get(name.lower())
    if meta is not None:
        meta_abbr, meta_venue, meta_dome = meta
        abbr = abbr or meta_abbr
        venue = venue or meta_venue
        if not isinstance(raw_team, Mapping) or raw_is_dome is None:
            is_dome = meta_dome

    if not abbr:
        words = [w for w in re.split(r"\s+", name) if w]
        if len(words) >= 2:
            abbr = "".join(w[0] for w in words[:3]).upper()
        else:
            abbr = name[:3].upper()
    abbr = abbr[:16].upper()

    ext_id = (
        _ensure_provider_prefix(raw_id, prefix=prefix, sport_short=sport_short)
        if _has_nonempty_id(raw_id)
        else _ensure_provider_prefix(
            f"team_{_slugify(abbr)}_{_slugify(name)}", prefix=prefix, sport_short=sport_short
        )
    )

    return IngestedTeam(
        external_provider_id=ext_id,
        sport_key=sport_key,
        name=name[:128],
        abbreviation=abbr,
        venue_name=str(venue)[:128] if venue else None,
        is_dome=is_dome,
    )


def _resolve_prop_team_external_id(
    *sources: Mapping[str, Any] | None,
    sport_key: str,
    home_team: IngestedTeam | None = None,
    away_team: IngestedTeam | None = None,
    prefix: str = "papi",
) -> str | None:
    """Resolve an upstream prop outcome/item's player team external_provider_id if specified."""
    sport_short = normalize_sport_key(sport_key)
    raw_ext: Any = None
    raw_name: str = ""
    raw_abbr: str = ""
    raw_team_mapping: Mapping[str, Any] | None = None

    for src in sources:
        if src is None:
            continue
        raw_team_val = src.get("team")
        if raw_team_mapping is None and isinstance(raw_team_val, Mapping):
            raw_team_mapping = raw_team_val

        if not _has_nonempty_id(raw_ext):
            candidate_ext = _first_present(src, "team_external_id", "team_id")
            if not _has_nonempty_id(candidate_ext) and isinstance(raw_team_val, Mapping):
                candidate_ext = _first_present(raw_team_val, "external_provider_id", "id")
            if _has_nonempty_id(candidate_ext):
                raw_ext = candidate_ext

        if not raw_name:
            candidate_name = _first_present(src, "team_name", "teamName")
            if candidate_name is None and isinstance(raw_team_val, Mapping):
                candidate_name = _first_present(raw_team_val, "name", "team_name")
            elif candidate_name is None and isinstance(raw_team_val, str):
                candidate_name = raw_team_val
            if candidate_name is not None:
                raw_name = str(candidate_name).strip()

        if not raw_abbr:
            candidate_abbr = _first_present(src, "team_abbreviation", "team_abbr", "teamAbbr")
            if candidate_abbr is None and isinstance(raw_team_val, Mapping):
                candidate_abbr = _first_present(raw_team_val, "abbreviation", "abbr")
            if candidate_abbr is not None:
                raw_abbr = str(candidate_abbr).strip()

    if not _has_nonempty_id(raw_ext) and not raw_name and not raw_abbr and raw_team_mapping is None:
        return None

    event_teams = [t for t in (home_team, away_team) if t is not None]
    if _has_nonempty_id(raw_ext):
        raw_ext_str = str(raw_ext).strip()
        normalized_ext = _ensure_provider_prefix(raw_ext, prefix=prefix, sport_short=sport_short)
        for team_obj in event_teams:
            if (
                team_obj.external_provider_id == normalized_ext
                or team_obj.external_provider_id.lower() == raw_ext_str.lower()
            ):
                return team_obj.external_provider_id

    for team_obj in event_teams:
        if raw_name and (
            raw_name.lower() == team_obj.name.lower()
            or raw_name.lower() == team_obj.abbreviation.lower()
            or raw_name.lower() == team_obj.external_provider_id.lower()
        ):
            return team_obj.external_provider_id
        if raw_abbr and raw_abbr.lower() == team_obj.abbreviation.lower():
            return team_obj.external_provider_id

    if _has_nonempty_id(raw_ext):
        return _ensure_provider_prefix(raw_ext, prefix=prefix, sport_short=sport_short)

    if raw_team_mapping is not None or raw_name:
        try:
            resolved = _resolve_team_metadata(
                raw_team_mapping if raw_team_mapping is not None else raw_name,
                sport_key,
                explicit_abbr=raw_abbr or None,
                prefix=prefix,
            )
            return resolved.external_provider_id
        except ValueError:
            pass

    if raw_abbr:
        is_nba = sport_short == "nba"
        for meta_name, (meta_abbr, _, meta_dome) in _TEAM_METADATA.items():
            if meta_abbr.upper() == raw_abbr.upper() and meta_dome == is_nba:
                return _resolve_team_metadata(
                    meta_name, sport_key, explicit_abbr=raw_abbr, prefix=prefix
                ).external_provider_id
        return _ensure_provider_prefix(
            f"team_{_slugify(raw_abbr)}", prefix=prefix, sport_short=sport_short
        )

    return None


def _parse_odds_to_decimal(raw_price: Any) -> Decimal:
    """Convert raw upstream American or Decimal odds into validated Decimal odds [1.01, 9999.9999]."""
    if isinstance(raw_price, bool) or raw_price is None:
        raise ValueError("Price cannot be boolean or null.")

    explicit_american_sign = False
    if isinstance(raw_price, str):
        stripped = raw_price.strip()
        if not stripped:
            raise ValueError("Price cannot be empty string.")
        explicit_american_sign = stripped.startswith(("+", "-"))
        raw_input: Any = stripped
    else:
        raw_input = raw_price

    try:
        dec_val = raw_input if isinstance(raw_input, Decimal) else Decimal(str(raw_input).strip())
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError(f"Invalid price value {raw_price!r}: {exc}") from exc

    if not dec_val.is_finite():
        raise ValueError(f"Non-finite price {raw_price!r}.")

    is_integral = dec_val == dec_val.to_integral_value()
    if explicit_american_sign or (
        is_integral and (dec_val >= Decimal("100") or dec_val <= Decimal("-100"))
    ):
        try:
            dec_val = american_to_decimal(dec_val)
        except DeviggingError as exc:
            raise ValueError(str(exc)) from exc

    if not dec_val.is_finite() or dec_val < Decimal("1.01") or dec_val > Decimal("9999.9999"):
        raise ValueError(f"Decimal price out of bounds: {dec_val}")
    return dec_val.quantize(_ODDS_QUANTIZE, rounding=ROUND_HALF_UP)


def _parse_optional_decimal(raw_val: Any) -> Decimal | None:
    if raw_val is None or isinstance(raw_val, bool):
        return None
    if isinstance(raw_val, str):
        cleaned = raw_val.strip()
        if not cleaned:
            return None
        raw_input: Any = cleaned
    else:
        raw_input = raw_val

    try:
        dec = raw_input if isinstance(raw_input, Decimal) else Decimal(str(raw_input).strip())
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError(f"Invalid decimal value {raw_val!r}: {exc}") from exc

    if not dec.is_finite():
        raise ValueError(f"Non-finite decimal value: {raw_val!r}")
    return dec


def _parse_optional_hit_rate(raw_val: Any, field_name: str) -> Decimal | None:
    if raw_val is None:
        return None
    if isinstance(raw_val, bool):
        raise ValueError(f"{field_name} cannot be boolean.")
    dec = _parse_optional_decimal(raw_val)
    if dec is None:
        return None
    if dec < Decimal("0") or dec > Decimal("1"):
        raise ValueError(f"{field_name} must be within [0, 1] (got {dec}).")
    return dec.quantize(_HIT_RATE_QUANTIZE, rounding=ROUND_HALF_UP)


def _split_outcome_player_and_side(
    outcome: Mapping[str, Any],
) -> tuple[str, Literal["OVER", "UNDER"]]:
    raw_name = str(outcome.get("name") or "").strip()
    if not raw_name:
        raise ValueError("Outcome missing 'name'.")

    raw_player = (
        outcome.get("description")
        or outcome.get("player_name")
        or outcome.get("playerName")
        or outcome.get("participant")
    )
    explicit_player = str(raw_player or "").strip()
    name_lower = raw_name.lower()

    if name_lower in _OVER_SIDE_TOKENS:
        side: Literal["OVER", "UNDER"] = "OVER"
        player_name = explicit_player
    elif name_lower in _UNDER_SIDE_TOKENS:
        side = "UNDER"
        player_name = explicit_player
    else:
        matched_side: Literal["OVER", "UNDER"] | None = None
        parsed_player = ""
        for token in _OVER_SIDE_TOKENS:
            suffix = f" {token}"
            if name_lower.endswith(suffix):
                matched_side = "OVER"
                parsed_player = raw_name[: -len(suffix)].strip()
                break
        if matched_side is None:
            for token in _UNDER_SIDE_TOKENS:
                suffix = f" {token}"
                if name_lower.endswith(suffix):
                    matched_side = "UNDER"
                    parsed_player = raw_name[: -len(suffix)].strip()
                    break
        if matched_side is None:
            raise ValueError(f"Unrecognized two-way outcome side '{raw_name}'.")
        side = matched_side
        if parsed_player and explicit_player:
            if " ".join(parsed_player.split()).lower() != " ".join(explicit_player.split()).lower():
                raise ValueError(
                    f"Conflicting player names in outcome: prefix {parsed_player!r} vs description {explicit_player!r}."
                )
        player_name = explicit_player or parsed_player

    if not player_name:
        raise ValueError(f"Outcome '{raw_name}' is missing player_name/description.")
    return player_name, side


def _extract_props_from_bookmakers(
    raw_event: Mapping[str, Any],
    *,
    event_external_id: str,
    sport_key: str,
    home_team: IngestedTeam | None = None,
    away_team: IngestedTeam | None = None,
) -> tuple[list[IngestedProp], int]:
    """Extract two-way player props from Odds API v4 style bookmakers array."""
    raw_bookmakers = raw_event.get("bookmakers")
    if not isinstance(raw_bookmakers, Sequence) or isinstance(raw_bookmakers, (str, bytes)):
        return [], 0

    # Key: (market_key, player_name_lower, line_value) -> display_player, book_sides
    sharp_quotes: dict[
        tuple[str, str, Decimal | None], list[tuple[int, str, dict[str, Decimal]]]
    ] = {}
    retail_quotes: dict[tuple[str, str, Decimal | None], dict[str, list[Decimal]]] = {}
    player_display_names: dict[tuple[str, str, Decimal | None], str] = {}
    player_teams: dict[tuple[str, str, Decimal | None], str] = {}
    malformed_count = 0

    for book in raw_bookmakers:
        if not isinstance(book, Mapping):
            continue
        book_key = str(book.get("key") or "").strip().lower()
        markets = book.get("markets")
        if not isinstance(markets, Sequence) or isinstance(markets, (str, bytes)):
            continue
        sharp_priority = SHARP_BOOKMAKER_PRIORITY.get(book_key)

        for market in markets:
            if not isinstance(market, Mapping):
                continue
            market_key = str(market.get("key") or "").strip().lower()
            if not market_key or market_key in _SKIP_MAINLINE_MARKETS:
                continue
            outcomes = market.get("outcomes")
            if not isinstance(outcomes, Sequence) or isinstance(outcomes, (str, bytes)):
                continue

            grouped_in_book: dict[
                tuple[str, Decimal | None], tuple[str, dict[str, Decimal], str | None]
            ] = {}
            conflicted_in_book: set[tuple[str, Decimal | None]] = set()
            for outcome in outcomes:
                if not isinstance(outcome, Mapping):
                    malformed_count += 1
                    continue
                try:
                    player_name, side = _split_outcome_player_and_side(outcome)
                    raw_point = outcome.get("point")
                    line_val = _parse_optional_decimal(raw_point)
                    if line_val is None and "td" in market_key:
                        line_val = Decimal("0.50")
                    elif line_val is not None:
                        line_val = line_val.quantize(Decimal("0.01"))
                    decimal_price = _parse_odds_to_decimal(outcome.get("price"))
                    outcome_team_id = _resolve_prop_team_external_id(
                        outcome,
                        market,
                        sport_key=sport_key,
                        home_team=home_team,
                        away_team=away_team,
                    )
                except Exception as exc:
                    malformed_count += 1
                    logger.warning(
                        "Skipping malformed prop outcome in event %s (%s): %s",
                        event_external_id,
                        market_key,
                        exc,
                    )
                    continue

                gk = (player_name.lower(), line_val)
                if gk in conflicted_in_book:
                    continue
                if gk not in grouped_in_book:
                    grouped_in_book[gk] = (player_name, {}, outcome_team_id)
                existing_name, sides_dict, existing_team_id = grouped_in_book[gk]
                if existing_team_id is None and outcome_team_id is not None:
                    grouped_in_book[gk] = (existing_name, sides_dict, outcome_team_id)
                if side in sides_dict:
                    if sides_dict[side] == decimal_price:
                        logger.warning(
                            "Duplicate identical %s outcome ignored for %s (%s) in book %s on %s.",
                            side,
                            player_name,
                            market_key,
                            book_key,
                            event_external_id,
                        )
                    else:
                        malformed_count += 1
                        conflicted_in_book.add(gk)
                        grouped_in_book.pop(gk, None)
                        logger.warning(
                            "Conflicting duplicate %s outcome (%s vs %s) discarded for %s (%s) in book %s on %s.",
                            side,
                            sides_dict[side],
                            decimal_price,
                            player_name,
                            market_key,
                            book_key,
                            event_external_id,
                        )
                    continue
                sides_dict[side] = decimal_price

            for (player_lower, line_val), (
                display_name,
                sides,
                group_team_id,
            ) in grouped_in_book.items():
                full_key = (market_key, player_lower, line_val)
                player_display_names.setdefault(full_key, display_name)
                if group_team_id is not None:
                    player_teams.setdefault(full_key, group_team_id)
                if sharp_priority is not None:
                    sharp_quotes.setdefault(full_key, []).append((sharp_priority, book_key, sides))
                else:
                    bucket = retail_quotes.setdefault(full_key, {"OVER": [], "UNDER": []})
                    for side_key, price in sides.items():
                        bucket[side_key].append(price)

    extracted: list[IngestedProp] = []
    all_keys = sorted(
        set(sharp_quotes.keys()) | set(retail_quotes.keys()),
        key=lambda item: (item[0], item[1], str(item[2])),
    )

    for full_key in all_keys:
        market_key, _, line_val = full_key
        player_name = player_display_names[full_key]
        candidates = sorted(sharp_quotes.get(full_key, []), key=lambda x: x[0])

        selected_sharp: dict[str, Decimal] | None = None
        for _, _, sides in candidates:
            if "OVER" in sides and "UNDER" in sides:
                try:
                    # Verify sharp two-way market carries valid overround > 1.0
                    evaluate_two_way_prop(sides["OVER"], sides["UNDER"], sides["OVER"])
                    selected_sharp = sides
                    break
                except DeviggingError:
                    continue

        if selected_sharp is None:
            malformed_count += 1
            logger.warning(
                "Skipping prop %s (%s) on %s: missing valid two-way sharp quote.",
                player_name,
                market_key,
                event_external_id,
            )
            continue

        retail_sides = retail_quotes.get(full_key, {})
        over_offers = retail_sides.get("OVER", [])
        under_offers = retail_sides.get("UNDER", [])

        chosen_side: Literal["OVER", "UNDER"] = "OVER"
        if over_offers and under_offers:
            best_over = max(over_offers)
            best_under = max(under_offers)
            over_ratio = best_over / selected_sharp["OVER"]
            under_ratio = best_under / selected_sharp["UNDER"]
            if under_ratio > over_ratio:
                chosen_side = "UNDER"
                offered_odds = best_under
            else:
                chosen_side = "OVER"
                offered_odds = best_over
        elif over_offers:
            chosen_side = "OVER"
            offered_odds = max(over_offers)
        elif under_offers:
            chosen_side = "UNDER"
            offered_odds = max(under_offers)
        else:
            chosen_side = "OVER"
            offered_odds = selected_sharp["OVER"]

        sharp_primary = selected_sharp[chosen_side]
        sharp_opposite = selected_sharp["UNDER" if chosen_side == "OVER" else "OVER"]

        prop_ext_id = _deterministic_prop_provider_id(
            "papi",
            event_external_id,
            market_key,
            player_name,
            chosen_side,
            line_val,
        )
        extracted.append(
            IngestedProp(
                external_provider_id=prop_ext_id,
                event_external_id=event_external_id,
                sport_key=sport_key,
                team_external_id=player_teams.get(full_key),
                player_name=player_name[:128],
                market_key=market_key[:64],
                selection=chosen_side,
                line_value=line_val,
                offered_decimal_odds=offered_odds,
                sharp_decimal_odds=sharp_primary,
                opposite_sharp_decimal_odds=sharp_opposite,
            )
        )

    return extracted, malformed_count


def _extract_direct_props(
    raw_event: Mapping[str, Any],
    *,
    event_external_id: str,
    sport_key: str,
    home_team: IngestedTeam | None = None,
    away_team: IngestedTeam | None = None,
) -> tuple[list[IngestedProp], int]:
    """Extract normalized props if upstream event provides a direct 'props' list."""
    raw_props = raw_event.get("props")
    if not isinstance(raw_props, Sequence) or isinstance(raw_props, (str, bytes)):
        return [], 0

    extracted: list[IngestedProp] = []
    malformed_count = 0
    for item in raw_props:
        if not isinstance(item, Mapping):
            malformed_count += 1
            continue
        try:
            player_name = str(item.get("player_name") or item.get("playerName") or "").strip()
            market_key = str(item.get("market_key") or item.get("marketKey") or "").strip().lower()
            if not player_name or not market_key:
                raise ValueError("Missing player_name or market_key.")

            raw_selection = item.get("selection")
            if raw_selection is None:
                selection: Literal["OVER", "UNDER"] = "OVER"
            else:
                sel_token = str(raw_selection).strip().lower()
                if sel_token in _OVER_SIDE_TOKENS:
                    selection = "OVER"
                elif sel_token in _UNDER_SIDE_TOKENS:
                    selection = "UNDER"
                else:
                    raise ValueError(f"Unrecognized direct prop selection {raw_selection!r}.")

            raw_line = (
                item.get("line_value") if item.get("line_value") is not None else item.get("line")
            )
            line_val = _parse_optional_decimal(raw_line)
            if line_val is None and "td" in market_key:
                line_val = Decimal("0.50")
            elif line_val is not None:
                line_val = line_val.quantize(Decimal("0.01"))

            offered_raw = _first_present(
                item, "offered_decimal_odds", "offered_odds", "offered_american_odds"
            )
            sharp_raw = _first_present(
                item, "sharp_decimal_odds", "sharp_primary_odds", "sharp_american_odds"
            )
            opp_raw = _first_present(
                item,
                "opposite_sharp_decimal_odds",
                "sharp_secondary_odds",
                "opposite_sharp_american_odds",
            )
            offered_dec = _parse_odds_to_decimal(offered_raw)
            sharp_dec = _parse_odds_to_decimal(sharp_raw)
            opp_dec = _parse_odds_to_decimal(opp_raw)
            evaluate_two_way_prop(sharp_dec, opp_dec, offered_dec)

            team_ext_id = _resolve_prop_team_external_id(
                item,
                sport_key=sport_key,
                home_team=home_team,
                away_team=away_team,
            )

            hit_l5 = _parse_optional_hit_rate(
                item.get("hit_rate_l5") if "hit_rate_l5" in item else item.get("hitRateL5"),
                "hit_rate_l5",
            )
            hit_l10 = _parse_optional_hit_rate(
                item.get("hit_rate_l10") if "hit_rate_l10" in item else item.get("hitRateL10"),
                "hit_rate_l10",
            )
            hit_season = _parse_optional_hit_rate(
                item.get("hit_rate_season")
                if "hit_rate_season" in item
                else item.get("hitRateSeason"),
                "hit_rate_season",
            )

            raw_id = _first_present(item, "external_provider_id", "id")
            prop_ext_id = (
                _ensure_provider_prefix(
                    raw_id, prefix="papi", sport_short=normalize_sport_key(sport_key)
                )
                if _has_nonempty_id(raw_id)
                else _deterministic_prop_provider_id(
                    "papi", event_external_id, market_key, player_name, selection, line_val
                )
            )
            extracted.append(
                IngestedProp(
                    external_provider_id=prop_ext_id,
                    event_external_id=event_external_id,
                    sport_key=sport_key,
                    team_external_id=team_ext_id,
                    player_name=player_name[:128],
                    market_key=market_key[:64],
                    selection=selection,
                    line_value=line_val,
                    offered_decimal_odds=offered_dec,
                    sharp_decimal_odds=sharp_dec,
                    opposite_sharp_decimal_odds=opp_dec,
                    hit_rate_l5=hit_l5,
                    hit_rate_l10=hit_l10,
                    hit_rate_season=hit_season,
                )
            )
        except Exception as exc:
            malformed_count += 1
            logger.warning(
                "Skipping malformed direct prop in event %s: %s",
                event_external_id,
                exc,
            )
    return extracted, malformed_count


def fetch_upstream_slate(
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    supported_sports: Sequence[str] | None = None,
    http_client: httpx.Client | None = None,
    now_utc: datetime | None = None,
    timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS,
) -> IngestedSlate:
    """Poll upcoming NFL/NBA schedules, teams, and two-way prop markets from PARLAY_API_BASE_URL."""
    settings = get_settings()
    resolved_api_key = api_key if api_key is not None else settings.parlay_api_key
    resolved_base_url = (base_url if base_url is not None else settings.parlay_api_base_url).rstrip(
        "/"
    )
    sports_to_poll = (
        tuple(supported_sports) if supported_sports is not None else settings.supported_sports
    )
    ref_now = _normalize_utc(now_utc) if now_utc is not None else datetime.now(UTC)

    if not sports_to_poll:
        raise UpstreamIngestionError("No supported sports configured for upstream ingestion.")

    if not is_api_key_configured(resolved_api_key):
        raise UpstreamIngestionError("PARLAY_API_KEY is missing or placeholder.")

    headers = {
        "Authorization": f"Bearer {resolved_api_key.strip()}",
        "Accept": "application/json",
    }

    teams_by_ext_id: dict[str, IngestedTeam] = {}
    events_by_ext_id: dict[str, IngestedEvent] = {}
    props_by_ext_id: dict[str, IngestedProp] = {}
    malformed_total = 0
    sport_errors: list[str] = []

    client = http_client if http_client is not None else httpx.Client(timeout=timeout_seconds)
    owns_client = http_client is None
    try:
        for sport_key in sports_to_poll:
            sport_short = normalize_sport_key(sport_key)
            canonical_markets = CANONICAL_MARKETS_BY_SPORT.get(sport_short, {})
            markets_param = ",".join(canonical_markets.keys())
            url = f"{resolved_base_url}/sports/{quote(sport_key, safe='')}/odds"
            params: dict[str, str] = {"regions": "us", "oddsFormat": "decimal"}
            if markets_param:
                params["markets"] = markets_param

            try:
                response = client.get(url, headers=headers, params=params)
            except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPError) as exc:
                msg = f"HTTP transport error polling {sport_key}: {exc}"
                logger.warning(msg)
                sport_errors.append(msg)
                continue

            if response.status_code != 200:
                msg = f"Upstream returned HTTP {response.status_code} for {sport_key}."
                logger.warning(msg)
                sport_errors.append(msg)
                continue

            try:
                raw_payload = response.json()
            except (ValueError, TypeError) as exc:
                msg = f"Upstream returned invalid JSON for {sport_key}: {exc}"
                logger.warning(msg)
                sport_errors.append(msg)
                continue

            if isinstance(raw_payload, Mapping):
                if "events" in raw_payload and raw_payload["events"] is not None:
                    raw_events = raw_payload["events"]
                elif "data" in raw_payload and raw_payload["data"] is not None:
                    raw_events = raw_payload["data"]
                else:
                    raw_events = []
            elif isinstance(raw_payload, list):
                raw_events = raw_payload
            else:
                msg = f"Unexpected upstream payload type for {sport_key}: {type(raw_payload).__name__}"
                logger.warning(msg)
                sport_errors.append(msg)
                continue

            if not isinstance(raw_events, list):
                msg = f"Expected list of events for {sport_key}."
                logger.warning(msg)
                sport_errors.append(msg)
                continue

            for raw_event in raw_events:
                if not isinstance(raw_event, Mapping):
                    malformed_total += 1
                    continue
                try:
                    ev_sport = str(raw_event.get("sport_key") or sport_key).strip()
                    commence_dt = _parse_iso_datetime(raw_event.get("commence_time"))
                    if commence_dt <= ref_now:
                        continue

                    raw_ev_id = raw_event.get("external_provider_id")
                    if not _has_nonempty_id(raw_ev_id):
                        raw_ev_id = raw_event.get("id")
                    if not _has_nonempty_id(raw_ev_id):
                        raise ValueError("Event missing 'id'.")
                    event_ext_id = _ensure_provider_prefix(
                        raw_ev_id, prefix="papi", sport_short=sport_short
                    )

                    home_team = _resolve_team_metadata(
                        raw_event.get("home_team"),
                        ev_sport,
                        explicit_abbr=raw_event.get("home_team_abbreviation"),
                        prefix="papi",
                    )
                    away_team = _resolve_team_metadata(
                        raw_event.get("away_team"),
                        ev_sport,
                        explicit_abbr=raw_event.get("away_team_abbreviation"),
                        prefix="papi",
                    )
                    if home_team.external_provider_id == away_team.external_provider_id:
                        raise ValueError("home_team and away_team cannot be identical.")

                    teams_by_ext_id[home_team.external_provider_id] = home_team
                    teams_by_ext_id[away_team.external_provider_id] = away_team

                    raw_weather = raw_event.get("weather")
                    weather_obj: Mapping[str, Any] = (
                        raw_weather if isinstance(raw_weather, Mapping) else {}
                    )
                    wind_mph = _parse_optional_decimal(
                        weather_obj.get("wind_speed_mph", raw_event.get("weather_wind_mph"))
                    )
                    temp_f = _parse_optional_decimal(
                        weather_obj.get("temp_f", raw_event.get("weather_temp_f"))
                    )
                    precip_prob = _parse_optional_decimal(
                        weather_obj.get("precip_prob", raw_event.get("weather_precip_prob"))
                    )
                    raw_event_dome = raw_event.get("is_dome")
                    event_is_dome = (
                        bool(raw_event_dome) if raw_event_dome is not None else home_team.is_dome
                    )

                    event_model = IngestedEvent(
                        external_provider_id=event_ext_id,
                        sport_key=ev_sport,
                        home_team_external_id=home_team.external_provider_id,
                        away_team_external_id=away_team.external_provider_id,
                        commence_time=commence_dt,
                        status="SCHEDULED",
                        is_dome=event_is_dome,
                        weather_wind_mph=wind_mph,
                        weather_temp_f=temp_f,
                        weather_precip_prob=precip_prob,
                    )
                    events_by_ext_id[event_ext_id] = event_model

                    book_props, book_malformed = _extract_props_from_bookmakers(
                        raw_event,
                        event_external_id=event_ext_id,
                        sport_key=ev_sport,
                        home_team=home_team,
                        away_team=away_team,
                    )
                    direct_props, direct_malformed = _extract_direct_props(
                        raw_event,
                        event_external_id=event_ext_id,
                        sport_key=ev_sport,
                        home_team=home_team,
                        away_team=away_team,
                    )
                    for prop_model in (*book_props, *direct_props):
                        props_by_ext_id[prop_model.external_provider_id] = prop_model
                    malformed_total += book_malformed + direct_malformed
                except Exception as exc:
                    malformed_total += 1
                    logger.warning("Skipping malformed upstream event record: %s", exc)
                    continue
    finally:
        if owns_client:
            client.close()

    if len(sport_errors) == len(sports_to_poll) and not events_by_ext_id:
        raise UpstreamIngestionError("; ".join(sport_errors))

    return IngestedSlate(
        source="upstream",
        generated_at=ref_now,
        teams=list(teams_by_ext_id.values()),
        events=list(events_by_ext_id.values()),
        props=list(props_by_ext_id.values()),
        skipped_malformed=malformed_total,
    )


def _same_utc_day_commence(
    ref_now: datetime,
    *,
    preferred_offset_hours: int,
    fallback_seconds_before_eod: int,
) -> datetime:
    """Compute a future commence_time guaranteed to stay in ref_now's UTC calendar day whenever possible."""
    candidate = (ref_now + timedelta(hours=preferred_offset_hours)).replace(microsecond=0)
    if candidate.date() == ref_now.date() and candidate > ref_now:
        return candidate
    end_of_day = ref_now.replace(hour=23, minute=59, second=59, microsecond=999999)
    fallback = (end_of_day - timedelta(seconds=fallback_seconds_before_eod)).replace(microsecond=0)
    if fallback > ref_now:
        return fallback
    if end_of_day > ref_now:
        return end_of_day
    return candidate


def build_local_seed_slate(now_utc: datetime | None = None) -> IngestedSlate:
    """Build deterministic multi-sport NFL + NBA local seed slate anchored to now_utc across today, tomorrow, and weekend."""
    ref_now = _normalize_utc(now_utc) if now_utc is not None else datetime.now(UTC)

    today_nba_time = _same_utc_day_commence(
        ref_now, preferred_offset_hours=3, fallback_seconds_before_eod=900
    )
    today_nfl_time = _same_utc_day_commence(
        ref_now, preferred_offset_hours=5, fallback_seconds_before_eod=300
    )
    tomorrow_nba_time = (ref_now + timedelta(days=1)).replace(
        hour=18, minute=30, second=0, microsecond=0
    )
    tomorrow_nfl_time = (ref_now + timedelta(days=1)).replace(
        hour=20, minute=15, second=0, microsecond=0
    )
    weekend_nba_time = (ref_now + timedelta(hours=52)).replace(microsecond=0)
    weekend_nfl_time = (ref_now + timedelta(hours=56)).replace(microsecond=0)

    teams = [
        IngestedTeam(
            external_provider_id="seed_nba_team_bos",
            sport_key="basketball_nba",
            name="Boston Celtics",
            abbreviation="BOS",
            venue_name="TD Garden",
            is_dome=True,
        ),
        IngestedTeam(
            external_provider_id="seed_nba_team_nyk",
            sport_key="basketball_nba",
            name="New York Knicks",
            abbreviation="NYK",
            venue_name="Madison Square Garden",
            is_dome=True,
        ),
        IngestedTeam(
            external_provider_id="seed_nba_team_gsw",
            sport_key="basketball_nba",
            name="Golden State Warriors",
            abbreviation="GSW",
            venue_name="Chase Center",
            is_dome=True,
        ),
        IngestedTeam(
            external_provider_id="seed_nba_team_lal",
            sport_key="basketball_nba",
            name="Los Angeles Lakers",
            abbreviation="LAL",
            venue_name="Crypto.com Arena",
            is_dome=True,
        ),
        IngestedTeam(
            external_provider_id="seed_nba_team_dal",
            sport_key="basketball_nba",
            name="Dallas Mavericks",
            abbreviation="DAL",
            venue_name="American Airlines Center",
            is_dome=True,
        ),
        IngestedTeam(
            external_provider_id="seed_nba_team_den",
            sport_key="basketball_nba",
            name="Denver Nuggets",
            abbreviation="DEN",
            venue_name="Ball Arena",
            is_dome=True,
        ),
        IngestedTeam(
            external_provider_id="seed_nfl_team_kc",
            sport_key="americanfootball_nfl",
            name="Kansas City Chiefs",
            abbreviation="KC",
            venue_name="Arrowhead Stadium",
            is_dome=False,
        ),
        IngestedTeam(
            external_provider_id="seed_nfl_team_buf",
            sport_key="americanfootball_nfl",
            name="Buffalo Bills",
            abbreviation="BUF",
            venue_name="Highmark Stadium",
            is_dome=False,
        ),
        IngestedTeam(
            external_provider_id="seed_nfl_team_bal",
            sport_key="americanfootball_nfl",
            name="Baltimore Ravens",
            abbreviation="BAL",
            venue_name="M&T Bank Stadium",
            is_dome=False,
        ),
        IngestedTeam(
            external_provider_id="seed_nfl_team_pit",
            sport_key="americanfootball_nfl",
            name="Pittsburgh Steelers",
            abbreviation="PIT",
            venue_name="Acrisure Stadium",
            is_dome=False,
        ),
        IngestedTeam(
            external_provider_id="seed_nfl_team_det",
            sport_key="americanfootball_nfl",
            name="Detroit Lions",
            abbreviation="DET",
            venue_name="Ford Field",
            is_dome=True,
        ),
        IngestedTeam(
            external_provider_id="seed_nfl_team_min",
            sport_key="americanfootball_nfl",
            name="Minnesota Vikings",
            abbreviation="MIN",
            venue_name="U.S. Bank Stadium",
            is_dome=True,
        ),
    ]

    events = [
        IngestedEvent(
            external_provider_id="seed_nba_bos_nyk",
            sport_key="basketball_nba",
            home_team_external_id="seed_nba_team_nyk",
            away_team_external_id="seed_nba_team_bos",
            commence_time=today_nba_time,
            is_dome=True,
        ),
        IngestedEvent(
            external_provider_id="seed_nfl_kc_buf",
            sport_key="americanfootball_nfl",
            home_team_external_id="seed_nfl_team_buf",
            away_team_external_id="seed_nfl_team_kc",
            commence_time=today_nfl_time,
            is_dome=False,
            weather_wind_mph=Decimal("12.00"),
            weather_temp_f=Decimal("42.00"),
            weather_precip_prob=Decimal("15.00"),
        ),
        IngestedEvent(
            external_provider_id="seed_nba_gsw_lal",
            sport_key="basketball_nba",
            home_team_external_id="seed_nba_team_lal",
            away_team_external_id="seed_nba_team_gsw",
            commence_time=tomorrow_nba_time,
            is_dome=True,
        ),
        IngestedEvent(
            external_provider_id="seed_nfl_bal_pit",
            sport_key="americanfootball_nfl",
            home_team_external_id="seed_nfl_team_pit",
            away_team_external_id="seed_nfl_team_bal",
            commence_time=tomorrow_nfl_time,
            is_dome=False,
            weather_wind_mph=Decimal("18.50"),
            weather_temp_f=Decimal("39.00"),
            weather_precip_prob=Decimal("25.00"),
        ),
        IngestedEvent(
            external_provider_id="seed_nba_dal_den",
            sport_key="basketball_nba",
            home_team_external_id="seed_nba_team_den",
            away_team_external_id="seed_nba_team_dal",
            commence_time=weekend_nba_time,
            is_dome=True,
        ),
        IngestedEvent(
            external_provider_id="seed_nfl_det_min",
            sport_key="americanfootball_nfl",
            home_team_external_id="seed_nfl_team_min",
            away_team_external_id="seed_nfl_team_det",
            commence_time=weekend_nfl_time,
            is_dome=True,
        ),
    ]

    props = [
        IngestedProp(
            external_provider_id="seed_prop_nfl_mahomes_pass",
            event_external_id="seed_nfl_kc_buf",
            sport_key="americanfootball_nfl",
            team_external_id="seed_nfl_team_kc",
            player_name="Patrick Mahomes",
            market_key="player_pass_yds",
            selection="OVER",
            line_value=Decimal("274.50"),
            offered_decimal_odds=Decimal("2.0500"),
            sharp_decimal_odds=Decimal("1.9100"),
            opposite_sharp_decimal_odds=Decimal("1.9300"),
        ),
        IngestedProp(
            external_provider_id="seed_prop_nfl_allen_pass",
            event_external_id="seed_nfl_kc_buf",
            sport_key="americanfootball_nfl",
            team_external_id="seed_nfl_team_buf",
            player_name="Josh Allen",
            market_key="player_pass_yds",
            selection="OVER",
            line_value=Decimal("248.50"),
            offered_decimal_odds=Decimal("2.0200"),
            sharp_decimal_odds=Decimal("1.9000"),
            opposite_sharp_decimal_odds=Decimal("1.9400"),
        ),
        IngestedProp(
            external_provider_id="seed_prop_nfl_cook_rush",
            event_external_id="seed_nfl_kc_buf",
            sport_key="americanfootball_nfl",
            team_external_id="seed_nfl_team_buf",
            player_name="James Cook",
            market_key="player_rush_yds",
            selection="OVER",
            line_value=Decimal("64.50"),
            offered_decimal_odds=Decimal("1.9800"),
            sharp_decimal_odds=Decimal("1.8700"),
            opposite_sharp_decimal_odds=Decimal("1.9500"),
        ),
        IngestedProp(
            external_provider_id="seed_prop_nfl_henry_td",
            event_external_id="seed_nfl_bal_pit",
            sport_key="americanfootball_nfl",
            team_external_id="seed_nfl_team_bal",
            player_name="Derrick Henry",
            market_key="player_anytime_td",
            selection="OVER",
            line_value=Decimal("0.50"),
            offered_decimal_odds=Decimal("1.9500"),
            sharp_decimal_odds=Decimal("1.8000"),
            opposite_sharp_decimal_odds=Decimal("2.1000"),
        ),
        IngestedProp(
            external_provider_id="seed_prop_nfl_jackson_rush",
            event_external_id="seed_nfl_bal_pit",
            sport_key="americanfootball_nfl",
            team_external_id="seed_nfl_team_bal",
            player_name="Lamar Jackson",
            market_key="player_rush_yds",
            selection="OVER",
            line_value=Decimal("54.50"),
            offered_decimal_odds=Decimal("2.0000"),
            sharp_decimal_odds=Decimal("1.8800"),
            opposite_sharp_decimal_odds=Decimal("1.9400"),
        ),
        IngestedProp(
            external_provider_id="seed_prop_nfl_stbrown_td",
            event_external_id="seed_nfl_det_min",
            sport_key="americanfootball_nfl",
            team_external_id="seed_nfl_team_det",
            player_name="Amon-Ra St. Brown",
            market_key="player_anytime_td",
            selection="OVER",
            line_value=Decimal("0.50"),
            offered_decimal_odds=Decimal("2.1200"),
            sharp_decimal_odds=Decimal("1.9600"),
            opposite_sharp_decimal_odds=Decimal("1.9000"),
        ),
        IngestedProp(
            external_provider_id="seed_prop_nba_tatum_pts",
            event_external_id="seed_nba_bos_nyk",
            sport_key="basketball_nba",
            team_external_id="seed_nba_team_bos",
            player_name="Jayson Tatum",
            market_key="player_points",
            selection="OVER",
            line_value=Decimal("26.50"),
            offered_decimal_odds=Decimal("2.0000"),
            sharp_decimal_odds=Decimal("1.8800"),
            opposite_sharp_decimal_odds=Decimal("1.9500"),
        ),
        IngestedProp(
            external_provider_id="seed_prop_nba_brunson_pts",
            event_external_id="seed_nba_bos_nyk",
            sport_key="basketball_nba",
            team_external_id="seed_nba_team_nyk",
            player_name="Jalen Brunson",
            market_key="player_points",
            selection="OVER",
            line_value=Decimal("25.50"),
            offered_decimal_odds=Decimal("1.9800"),
            sharp_decimal_odds=Decimal("1.8700"),
            opposite_sharp_decimal_odds=Decimal("1.9500"),
        ),
        IngestedProp(
            external_provider_id="seed_prop_nba_tatum_reb",
            event_external_id="seed_nba_bos_nyk",
            sport_key="basketball_nba",
            team_external_id="seed_nba_team_bos",
            player_name="Jayson Tatum",
            market_key="player_rebounds",
            selection="OVER",
            line_value=Decimal("8.50"),
            offered_decimal_odds=Decimal("2.0200"),
            sharp_decimal_odds=Decimal("1.9000"),
            opposite_sharp_decimal_odds=Decimal("1.9300"),
        ),
        IngestedProp(
            external_provider_id="seed_prop_nba_curry_threes",
            event_external_id="seed_nba_gsw_lal",
            sport_key="basketball_nba",
            team_external_id="seed_nba_team_gsw",
            player_name="Stephen Curry",
            market_key="player_threes",
            selection="OVER",
            line_value=Decimal("4.50"),
            offered_decimal_odds=Decimal("2.0800"),
            sharp_decimal_odds=Decimal("1.9300"),
            opposite_sharp_decimal_odds=Decimal("1.9000"),
        ),
        IngestedProp(
            external_provider_id="seed_prop_nba_davis_reb",
            event_external_id="seed_nba_gsw_lal",
            sport_key="basketball_nba",
            team_external_id="seed_nba_team_lal",
            player_name="Anthony Davis",
            market_key="player_rebounds",
            selection="OVER",
            line_value=Decimal("11.50"),
            offered_decimal_odds=Decimal("2.0000"),
            sharp_decimal_odds=Decimal("1.8900"),
            opposite_sharp_decimal_odds=Decimal("1.9400"),
        ),
        IngestedProp(
            external_provider_id="seed_prop_nba_doncic_pts",
            event_external_id="seed_nba_dal_den",
            sport_key="basketball_nba",
            team_external_id="seed_nba_team_dal",
            player_name="Luka Doncic",
            market_key="player_points",
            selection="OVER",
            line_value=Decimal("29.50"),
            offered_decimal_odds=Decimal("2.0400"),
            sharp_decimal_odds=Decimal("1.9100"),
            opposite_sharp_decimal_odds=Decimal("1.9200"),
        ),
    ]

    game_logs = [
        IngestedGameLog(
            player_name="Patrick Mahomes",
            market_key="player_pass_yds",
            stats=[Decimal(v) for v in (304, 289, 261, 318, 295, 281, 240, 312, 279, 288)],
        ),
        IngestedGameLog(
            player_name="Josh Allen",
            market_key="player_pass_yds",
            stats=[Decimal(v) for v in (276, 262, 219, 288, 255, 264, 231, 294, 271, 252)],
        ),
        IngestedGameLog(
            player_name="James Cook",
            market_key="player_rush_yds",
            stats=[Decimal(v) for v in (82, 74, 58, 91, 69, 77, 48, 84, 71, 62)],
        ),
        IngestedGameLog(
            player_name="Derrick Henry",
            market_key="player_anytime_td",
            stats=[Decimal(v) for v in (1, 1, 0, 2, 1, 1, 0, 1, 1, 0)],
        ),
        IngestedGameLog(
            player_name="Lamar Jackson",
            market_key="player_rush_yds",
            stats=[Decimal(v) for v in (68, 61, 43, 75, 59, 64, 39, 71, 58, 52)],
        ),
        IngestedGameLog(
            player_name="Amon-Ra St. Brown",
            market_key="player_anytime_td",
            stats=[Decimal(v) for v in (1, 0, 1, 1, 1, 0, 1, 1, 1, 0)],
        ),
        IngestedGameLog(
            player_name="Jayson Tatum",
            market_key="player_points",
            stats=[Decimal(v) for v in (31, 28, 29, 24, 33, 27, 30, 22, 29, 34)],
        ),
        IngestedGameLog(
            player_name="Jalen Brunson",
            market_key="player_points",
            stats=[Decimal(v) for v in (28, 24, 31, 27, 26, 22, 29, 30, 21, 28)],
        ),
        IngestedGameLog(
            player_name="Jayson Tatum",
            market_key="player_rebounds",
            stats=[Decimal(v) for v in (10, 9, 7, 11, 9, 10, 8, 9, 12, 9)],
        ),
        IngestedGameLog(
            player_name="Stephen Curry",
            market_key="player_threes",
            stats=[Decimal(v) for v in (6, 5, 4, 7, 5, 5, 3, 6, 5, 6)],
        ),
        IngestedGameLog(
            player_name="Anthony Davis",
            market_key="player_rebounds",
            stats=[Decimal(v) for v in (14, 13, 10, 15, 12, 12, 9, 13, 14, 11)],
        ),
        IngestedGameLog(
            player_name="Luka Doncic",
            market_key="player_points",
            stats=[Decimal(v) for v in (35, 31, 27, 33, 30, 32, 28, 34, 31, 36)],
        ),
    ]

    return IngestedSlate(
        source="seed",
        generated_at=ref_now,
        teams=teams,
        events=events,
        props=props,
        game_logs=game_logs,
    )


def _ensure_schema_initialized(session: Session) -> None:
    bind = session.get_bind()
    if isinstance(bind, Engine):
        inspector = inspect(bind)
        if any(not inspector.has_table(table) for table in ("teams", "events", "player_props")):
            init_db(engine=bind)


def _transition_commenced_events(session: Session, ref_now: datetime) -> int:
    scheduled_events = list(session.scalars(select(Event).where(Event.status == "SCHEDULED")).all())
    transitioned = 0
    for event in scheduled_events:
        if _normalize_utc(event.commence_time) <= ref_now:
            event.status = "COMMENCED"
            event.updated_at = ref_now
            transitioned += 1
    if transitioned > 0:
        session.flush()
    return transitioned


def upsert_slate_to_db(
    session: Session,
    slate: IngestedSlate,
    *,
    now_utc: datetime | None = None,
    redis_client: RedisLike | None = None,
    ttl_seconds: int = HOT_CACHE_TTL_SECONDS,
    ensure_schema: bool = True,
) -> UpsertSlateResult:
    """Idempotently upsert teams/events, transition commenced games, ingest weather, devig props, and update hit rates."""
    ref_now = _normalize_utc(now_utc) if now_utc is not None else datetime.now(UTC)

    if ensure_schema:
        _ensure_schema_initialized(session)

    commenced_transitioned = _transition_commenced_events(session, ref_now)

    # 1. Upsert Teams keyed by external_provider_id
    teams_by_ext_id: dict[str, Team] = {}
    teams_upserted = 0
    for team_in in slate.teams:
        existing_team = session.scalar(
            select(Team).where(Team.external_provider_id == team_in.external_provider_id)
        )
        if existing_team is not None:
            existing_team.sport_key = team_in.sport_key
            existing_team.name = team_in.name
            existing_team.abbreviation = team_in.abbreviation
            existing_team.venue_name = team_in.venue_name
            existing_team.is_dome = team_in.is_dome
            existing_team.updated_at = ref_now
            team_row = existing_team
        else:
            team_row = Team(
                team_id=uuid.uuid4(),
                external_provider_id=team_in.external_provider_id,
                sport_key=team_in.sport_key,
                name=team_in.name,
                abbreviation=team_in.abbreviation,
                venue_name=team_in.venue_name,
                is_dome=team_in.is_dome,
            )
            session.add(team_row)
        session.flush()
        teams_by_ext_id[team_row.external_provider_id] = team_row
        teams_upserted += 1

    # 2. Upsert Events keyed by external_provider_id
    events_by_ext_id: dict[str, Event] = {}
    weather_payload: list[dict[str, Any]] = []
    events_upserted = 0

    for event_in in slate.events:
        home_team = teams_by_ext_id.get(event_in.home_team_external_id) or session.scalar(
            select(Team).where(Team.external_provider_id == event_in.home_team_external_id)
        )
        away_team = teams_by_ext_id.get(event_in.away_team_external_id) or session.scalar(
            select(Team).where(Team.external_provider_id == event_in.away_team_external_id)
        )
        if home_team is None or away_team is None or home_team.team_id == away_team.team_id:
            logger.warning(
                "Skipping event %s due to missing or identical teams (%s vs %s).",
                event_in.external_provider_id,
                event_in.away_team_external_id,
                event_in.home_team_external_id,
            )
            continue

        commence_utc = _normalize_utc(event_in.commence_time)
        incoming_effective_status = (
            "COMMENCED"
            if event_in.status == "SCHEDULED" and commence_utc <= ref_now
            else event_in.status
        )

        existing_event = session.scalar(
            select(Event).where(Event.external_provider_id == event_in.external_provider_id)
        )
        if existing_event is not None:
            if existing_event.status == "SCHEDULED":
                if incoming_effective_status == "COMMENCED":
                    commenced_transitioned += 1
                existing_event.status = incoming_effective_status
            existing_event.sport_key = event_in.sport_key
            existing_event.home_team_id = home_team.team_id
            existing_event.away_team_id = away_team.team_id
            existing_event.commence_time = commence_utc
            existing_event.is_dome = event_in.is_dome
            existing_event.updated_at = ref_now
            event_row = existing_event
        else:
            event_row = Event(
                event_id=uuid.uuid4(),
                external_provider_id=event_in.external_provider_id,
                sport_key=event_in.sport_key,
                home_team_id=home_team.team_id,
                away_team_id=away_team.team_id,
                commence_time=commence_utc,
                status=incoming_effective_status,
                is_dome=event_in.is_dome,
            )
            session.add(event_row)
        session.flush()
        events_by_ext_id[event_row.external_provider_id] = event_row
        events_upserted += 1

        weather_entry: dict[str, Any] = {
            "event_id": event_row.event_id,
            "is_dome": event_in.is_dome,
        }
        if event_in.weather_wind_mph is not None:
            weather_entry["wind_speed_mph"] = event_in.weather_wind_mph
        if event_in.weather_temp_f is not None:
            weather_entry["temp_f"] = event_in.weather_temp_f
        if event_in.weather_precip_prob is not None:
            weather_entry["precip_prob"] = event_in.weather_precip_prob
        weather_payload.append(weather_entry)

    # Retire stale transient fallback seed rows once live upstream events recover
    if slate.source == "upstream" and events_by_ext_id:
        seed_events = list(
            session.scalars(
                select(Event).where(
                    Event.external_provider_id.startswith("seed_", autoescape=True),
                    Event.status != "CANCELLED",
                )
            ).all()
        )
        for seed_ev in seed_events:
            seed_ev.status = "CANCELLED"
            seed_ev.updated_at = ref_now

        seed_props = list(
            session.scalars(
                select(PlayerProp).where(
                    PlayerProp.external_provider_id.startswith("seed_", autoescape=True),
                    PlayerProp.status.notin_(("SUSPENDED", "SETTLED")),
                )
            ).all()
        )
        for seed_prop in seed_props:
            seed_prop.status = "SUSPENDED"
            seed_prop.updated_at = ref_now

    session.commit()

    # 3. Weather ingestion (commits DB weather columns + caches 45s Redis weather badges)
    if weather_payload:
        ingest_events_weather(session, weather_payload, redis_client=redis_client)

    # 4. Prepare validated TwoWayPropMarketInput per sport and route through process_and_publish_ev_props
    game_logs_map = slate.to_player_game_logs()
    markets_by_sport: dict[str, list[TwoWayPropMarketInput]] = {
        sport_key: [] for sport_key in dict.fromkeys(p.sport_key for p in slate.props)
    }
    accepted_prop_ids_by_event: dict[uuid.UUID, set[str]] = {
        ev.event_id: set() for ev in events_by_ext_id.values()
    }
    accepted_market_index: dict[str, tuple[str, int]] = {}
    synced_prop_ext_ids: set[str] = set()
    skipped_malformed = slate.skipped_malformed

    for prop_in in slate.props:
        prop_event: Event | None = events_by_ext_id.get(prop_in.event_external_id)
        if prop_event is None:
            prop_event = session.scalar(
                select(Event).where(Event.external_provider_id == prop_in.event_external_id)
            )
        if prop_event is None:
            skipped_malformed += 1
            logger.warning(
                "Skipping prop %s: event %s not found.",
                prop_in.external_provider_id,
                prop_in.event_external_id,
            )
            continue

        if prop_event.status != "SCHEDULED" or _normalize_utc(prop_event.commence_time) <= ref_now:
            logger.info(
                "Skipping prop %s for non-scheduled/commenced event %s (status=%s).",
                prop_in.external_provider_id,
                prop_in.event_external_id,
                prop_event.status,
            )
            continue

        resolved_team_id: uuid.UUID | None = None
        if prop_in.team_external_id:
            prop_team: Team | None = teams_by_ext_id.get(prop_in.team_external_id)
            if prop_team is None:
                prop_team = session.scalar(
                    select(Team).where(Team.external_provider_id == prop_in.team_external_id)
                )
                if prop_team is not None:
                    teams_by_ext_id[prop_in.team_external_id] = prop_team
            if prop_team is not None:
                resolved_team_id = prop_team.team_id

        try:
            hit_l5 = prop_in.hit_rate_l5
            hit_l10 = prop_in.hit_rate_l10
            hit_season = prop_in.hit_rate_season
            if (
                (hit_l5 is None or hit_l10 is None or hit_season is None)
                and prop_in.line_value is not None
                and game_logs_map
            ):
                logs = game_logs_map.get((prop_in.player_name, prop_in.market_key))
                if logs:
                    hit_res = compute_rolling_hit_rate(
                        game_stats=logs,
                        line_value=prop_in.line_value,
                        selection=prop_in.selection,
                    )
                    hit_l5 = hit_l5 if hit_l5 is not None else hit_res.l5_rate
                    hit_l10 = hit_l10 if hit_l10 is not None else hit_res.l10_rate
                    hit_season = hit_season if hit_season is not None else hit_res.season_rate

            # Validate sharp/offered odds and Brent root convergence per prop so one bad record never aborts the batch
            evaluate_two_way_prop(
                sharp_primary_odds=prop_in.sharp_decimal_odds,
                sharp_secondary_odds=prop_in.opposite_sharp_decimal_odds,
                offered_odds=prop_in.offered_decimal_odds,
                hit_rate_l10=hit_l10,
            )
            market_input = TwoWayPropMarketInput(
                external_provider_id=prop_in.external_provider_id,
                event_id=prop_event.event_id,
                team_id=resolved_team_id,
                player_name=prop_in.player_name,
                market_key=prop_in.market_key,
                selection=prop_in.selection,
                line_value=prop_in.line_value,
                offered_decimal_odds=prop_in.offered_decimal_odds,
                sharp_decimal_odds=prop_in.sharp_decimal_odds,
                opposite_sharp_decimal_odds=prop_in.opposite_sharp_decimal_odds,
                hit_rate_l5=hit_l5,
                hit_rate_l10=hit_l10,
                hit_rate_season=hit_season,
            )
        except (DeviggingError, ValidationError, ValueError, TypeError, InvalidOperation) as exc:
            skipped_malformed += 1
            logger.warning(
                "Skipping malformed prop %s (%s): %s",
                prop_in.external_provider_id,
                prop_in.player_name,
                exc,
            )
            continue

        accepted_prop_ids_by_event.setdefault(prop_event.event_id, set()).add(
            prop_in.external_provider_id
        )
        synced_prop_ext_ids.add(prop_in.external_provider_id)
        sport_bucket = markets_by_sport.setdefault(prop_in.sport_key, [])
        if prop_in.external_provider_id in accepted_market_index:
            prev_sport, prev_idx = accepted_market_index[prop_in.external_provider_id]
            if prev_sport == prop_in.sport_key:
                sport_bucket[prev_idx] = market_input
        else:
            accepted_market_index[prop_in.external_provider_id] = (
                prop_in.sport_key,
                len(sport_bucket),
            )
            sport_bucket.append(market_input)

    # Retire moved, side-flipped, dropped, or malformed-rejected ACTIVE props on synced events
    synced_event_ids = [ev.event_id for ev in events_by_ext_id.values()]
    if synced_event_ids:
        stale_active_props = list(
            session.scalars(
                select(PlayerProp).where(
                    PlayerProp.event_id.in_(synced_event_ids),
                    PlayerProp.status == "ACTIVE",
                )
            ).all()
        )
        for existing_prop in stale_active_props:
            if existing_prop.external_provider_id not in accepted_prop_ids_by_event.get(
                existing_prop.event_id, set()
            ):
                existing_prop.status = "SUSPENDED"
                existing_prop.updated_at = ref_now
        session.flush()

    props_evaluated = 0
    props_outlier_blocked = 0
    effective_redis: RedisLike = redis_client if redis_client is not None else _NoOpRedisClient()
    if markets_by_sport:
        for sport_key, sport_markets in markets_by_sport.items():
            batch_result = process_and_publish_ev_props(
                sport_key=sport_key,
                prop_markets=sport_markets,
                redis_client=effective_redis,
                session=session,
                ttl_seconds=ttl_seconds,
            )
            props_evaluated += len(batch_result.evaluated)
            props_outlier_blocked += batch_result.outlier_count
    else:
        session.commit()

    # 5. Backfill rolling hit rates only for DB props missing preset rates without overriding explicit/published values
    if game_logs_map:
        player_names: set[str] = {player_name for player_name, _ in game_logs_map}
        if player_names:
            candidate_props = list(
                session.scalars(
                    select(PlayerProp).where(
                        PlayerProp.player_name.in_(player_names),
                        PlayerProp.status == "ACTIVE",
                        PlayerProp.line_value.is_not(None),
                    )
                ).all()
            )
            rates_updated = 0
            for db_prop in candidate_props:
                if db_prop.external_provider_id in synced_prop_ext_ids:
                    continue
                if (
                    db_prop.hit_rate_l5 is not None
                    and db_prop.hit_rate_l10 is not None
                    and db_prop.hit_rate_season is not None
                ):
                    continue
                logs = game_logs_map.get((db_prop.player_name, db_prop.market_key))
                if not logs or db_prop.line_value is None:
                    continue
                try:
                    sel_str: Literal["OVER", "UNDER"] = (
                        "UNDER" if db_prop.selection == "UNDER" else "OVER"
                    )
                    hit_res = compute_rolling_hit_rate(
                        game_stats=logs,
                        line_value=db_prop.line_value,
                        selection=sel_str,
                    )
                except (ValueError, TypeError, InvalidOperation) as exc:
                    logger.warning(
                        "Skipping rolling hit-rate backfill for %s: %s",
                        db_prop.external_provider_id,
                        exc,
                    )
                    continue
                if db_prop.hit_rate_l5 is None:
                    db_prop.hit_rate_l5 = hit_res.l5_rate
                if db_prop.hit_rate_l10 is None:
                    db_prop.hit_rate_l10 = hit_res.l10_rate
                if db_prop.hit_rate_season is None:
                    db_prop.hit_rate_season = hit_res.season_rate
                db_prop.updated_at = ref_now
                rates_updated += 1
            if rates_updated > 0:
                session.commit()

    return UpsertSlateResult(
        teams_upserted=teams_upserted,
        events_upserted=events_upserted,
        commenced_transitioned=commenced_transitioned,
        props_evaluated=props_evaluated,
        props_outlier_blocked=props_outlier_blocked,
        props_skipped_malformed=skipped_malformed,
    )


def _publish_live_odds_deltas(
    redis_client: RedisLike,
    events_map: dict[uuid.UUID, Event],
    active_props: Sequence[PlayerProp],
    *,
    now_utc: datetime,
    ttl_seconds: int = HOT_CACHE_TTL_SECONDS,
) -> int:
    props_by_event: dict[uuid.UUID, list[PlayerProp]] = {}
    for prop in active_props:
        if prop.status != "ACTIVE":
            continue
        if prop.guarded_ev is not None and prop.guarded_ev > OUTLIER_GUARD_MAX_EV:
            continue
        props_by_event.setdefault(prop.event_id, []).append(prop)

    published_count = 0
    for event_id, event in events_map.items():
        event_props = props_by_event.get(event_id, [])
        if not event_props:
            continue

        quotes = [
            PropOddsQuote(
                prop_id=prop.prop_id,
                external_provider_id=prop.external_provider_id,
                market_key=prop.market_key,
                player_name=prop.player_name,
                selection=prop.selection,
                line_value=prop.line_value,
                decimal_odds=prop.offered_decimal_odds,
                sportsbook="consensus",
            )
            for prop in event_props
        ]
        frame = OddsDeltaFrame(
            event_id=event.event_id,
            external_provider_id=event.external_provider_id,
            sport_key=event.sport_key,
            decimal_odds=quotes[0].decimal_odds,
            quotes=quotes,
            updated_at=now_utc,
        )
        publish_odds_delta(redis_client, frame, ttl_seconds=ttl_seconds)
        published_count += 1

    return published_count


def run_live_slate_sync(
    *,
    session: Session | None = None,
    redis_client: RedisLike | None = None,
    http_client: httpx.Client | None = None,
    api_key: str | None = None,
    base_url: str | None = None,
    now_utc: datetime | None = None,
    ttl_seconds: int = HOT_CACHE_TTL_SECONDS,
    ensure_schema: bool = True,
) -> SlateSyncResult:
    """Execute end-to-end schedule/prop ingestion, devigging, DB upsert, feed sync, and delta broadcast."""
    settings = get_settings()
    resolved_api_key = api_key if api_key is not None else settings.parlay_api_key
    resolved_base_url = base_url if base_url is not None else settings.parlay_api_base_url
    ref_now = _normalize_utc(now_utc) if now_utc is not None else datetime.now(UTC)

    owns_session = session is None
    owns_redis = redis_client is None
    active_session: Session | None = session
    active_redis: RedisLike | None = redis_client

    try:
        if active_session is None:
            active_session = create_session_factory()()
        if active_redis is None:
            active_redis = get_redis_client()

        if ensure_schema:
            _ensure_schema_initialized(active_session)

        slate: IngestedSlate
        if not is_api_key_configured(resolved_api_key):
            logger.info(
                "PARLAY_API_KEY is missing or placeholder; activating deterministic local seed slate fallback."
            )
            slate = build_local_seed_slate(now_utc=ref_now)
        else:
            try:
                slate = fetch_upstream_slate(
                    api_key=resolved_api_key,
                    base_url=resolved_base_url,
                    supported_sports=settings.supported_sports,
                    http_client=http_client,
                    now_utc=ref_now,
                )
            except UpstreamIngestionError as exc:
                logger.warning(
                    "Upstream schedule/prop ingestion failed (%s); falling back to deterministic local seed slate.",
                    exc,
                )
                slate = build_local_seed_slate(now_utc=ref_now)
            else:
                if not slate.events or not slate.props:
                    logger.warning(
                        "Upstream returned %d upcoming events and %d props; falling back to deterministic local seed slate.",
                        len(slate.events),
                        len(slate.props),
                    )
                    slate = build_local_seed_slate(now_utc=ref_now)

        upsert_summary = upsert_slate_to_db(
            active_session,
            slate,
            now_utc=ref_now,
            redis_client=active_redis,
            ttl_seconds=ttl_seconds,
            ensure_schema=False,
        )

        # Load persisted scheduled future events first, then scope active props to those events
        scheduled_events = list(
            active_session.scalars(select(Event).where(Event.status == "SCHEDULED")).all()
        )
        events_map: dict[uuid.UUID, Event] = {}
        for event in scheduled_events:
            commence_utc = _normalize_utc(event.commence_time)
            if commence_utc <= ref_now:
                continue
            # Ensure tz-aware UTC datetime for presets/browser generators even when backed by SQLite
            if event.commence_time.tzinfo is None:
                event.commence_time = commence_utc
            events_map[event.event_id] = event

        if events_map:
            active_props = [
                prop
                for prop in active_session.scalars(
                    select(PlayerProp).where(
                        PlayerProp.status == "ACTIVE",
                        PlayerProp.event_id.in_(list(events_map.keys())),
                    )
                ).all()
                if prop.guarded_ev is None or prop.guarded_ev <= OUTLIER_GUARD_MAX_EV
            ]
        else:
            active_props = []

        teams_map = {t.team_id: t for t in active_session.scalars(select(Team)).all()}

        preset_feed = generate_curated_presets(
            props=active_props,
            events_map=events_map,
            teams_map=teams_map,
            target_count=5,
            now_utc=ref_now,
        )
        sync_preset_feed_to_redis(preset_feed, active_redis, ttl_seconds=ttl_seconds)

        browser_feed = build_market_browser_feed(
            props=active_props,
            events_map=events_map,
            teams_map=teams_map,
            now_utc=ref_now,
        )
        sync_market_browser_to_redis(browser_feed, active_redis, ttl_seconds=ttl_seconds)

        deltas_published = _publish_live_odds_deltas(
            active_redis,
            events_map,
            active_props,
            now_utc=ref_now,
            ttl_seconds=ttl_seconds,
        )

        return SlateSyncResult(
            status="ok",
            source=slate.source,
            teams_upserted=upsert_summary.teams_upserted,
            events_upserted=upsert_summary.events_upserted,
            commenced_transitioned=upsert_summary.commenced_transitioned,
            props_evaluated=upsert_summary.props_evaluated,
            props_outlier_blocked=upsert_summary.props_outlier_blocked,
            props_skipped_malformed=upsert_summary.props_skipped_malformed,
            presets_generated=len(preset_feed.cards),
            market_browser_props=len(browser_feed.props),
            market_browser_games=len(browser_feed.games),
            odds_deltas_published=deltas_published,
            synced_at=format_iso8601_utc(ref_now),
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
