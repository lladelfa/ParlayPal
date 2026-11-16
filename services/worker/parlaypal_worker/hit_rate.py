"""Rolling consistency hit-rate calculation and Sofascore form tracker engine."""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from parlaypal_worker.models import PlayerProp

logger = logging.getLogger(__name__)

HIT_RATE_QUANTIZE: Decimal = Decimal("0.0001")


class HitRateError(ValueError):
    """Structured hit-rate calculation and statistical validation error."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "INVALID_HIT_RATE_DATA",
        retry_after: int = 0,
        cause: Exception | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retry_after = retry_after
        self.cause = cause

    def to_problem_details(self) -> dict[str, dict[str, Any]]:
        """Format error as standardized JSON Problem Details."""
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "retry_after": self.retry_after,
            }
        }


class PlayerGameStat(BaseModel):
    """Stat outcome recorded for a player in a completed game."""

    model_config = ConfigDict(frozen=True)

    stat_value: Decimal
    game_date: datetime | None = None
    opponent: str | None = None


class PropHitRateResult(BaseModel):
    """Rolling hit-rate calculations across L5, L10, and Season windows with form dots."""

    model_config = ConfigDict(frozen=True)

    total_games: int
    l5_hits: int = 0
    l5_total: int = 0
    l5_rate: Decimal | None = None
    l10_hits: int = 0
    l10_total: int = 0
    l10_rate: Decimal | None = None
    season_hits: int = 0
    season_total: int = 0
    season_rate: Decimal | None = None
    l5_formatted: str = ""
    l10_formatted: str = ""
    season_formatted: str = ""
    form_dots: str = ""
    form_sequence: list[bool] = Field(default_factory=list)
    l5_pushes: int = 0
    l10_pushes: int = 0
    season_pushes: int = 0


def normalize_selection(selection: str | None) -> str:
    """Normalize a bet side string (strip + upper-case); None becomes empty string."""
    return (selection or "").strip().upper()


def format_hit_rate_string(hits: int, total: int, rate: Decimal | None) -> str:
    """Format hit rate into plain-English string, e.g. '8/10 (80.0%)'."""
    if total == 0 or rate is None:
        return "0/0 (0.0%)"
    percentage = (rate * Decimal("100")).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    return f"{hits}/{total} ({percentage}%)"


def generate_sofascore_form_dots(form_sequence: Sequence[bool]) -> str:
    """Render 5-dot Sofascore rolling form string (e.g., 🔴🟢🔴🟢🟢)."""
    return "".join("🟢" if hit else "🔴" for hit in form_sequence)


def _to_decimal_stat(val: Any, idx: int) -> Decimal:
    """Coerce stat value to finite Decimal, rejecting booleans and invalid values."""
    if isinstance(val, PlayerGameStat):
        val = val.stat_value
    if isinstance(val, bool) or val is None:
        raise HitRateError(
            f"Invalid stat at index {idx}: boolean or None is not a valid statistic value."
        )
    try:
        dec = val if isinstance(val, Decimal) else Decimal(str(val).strip())
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise HitRateError(
            f"Invalid stat at index {idx} ('{val}'): could not parse as Decimal."
        ) from exc

    if not dec.is_finite():
        raise HitRateError(f"Invalid stat at index {idx} ('{val}'): must be finite number.")
    return dec


def compute_rolling_hit_rate(
    game_stats: Sequence[PlayerGameStat | Decimal | float | int | str],
    line_value: Decimal | float | int | str,
    selection: Literal["OVER", "UNDER"] = "OVER",
) -> PropHitRateResult:
    """Compute rolling player prop hit rates across L5, L10, and Season windows.

    - `game_stats`: list of statistical values ordered from MOST RECENT to OLDEST.
    - `line_value`: prop threshold.
    - `selection`: "OVER" (hits when stat > line) or "UNDER" (hits when stat < line).
      Pushes (stat == line) are excluded from both numerator and denominator of their window.
    """
    normalized = normalize_selection(selection) if isinstance(selection, str) else ""
    if normalized not in ("OVER", "UNDER"):
        raise HitRateError(f"selection must be 'OVER' or 'UNDER' (got {selection!r}).")
    selection = "UNDER" if normalized == "UNDER" else "OVER"

    if isinstance(line_value, bool) or line_value is None:
        raise HitRateError("line_value cannot be boolean or None.")
    try:
        target_line = (
            line_value if isinstance(line_value, Decimal) else Decimal(str(line_value).strip())
        )
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise HitRateError(
            f"Invalid line_value '{line_value}': could not parse as Decimal."
        ) from exc

    if not target_line.is_finite():
        raise HitRateError("line_value must be finite.")

    total_games = len(game_stats)
    if total_games == 0:
        return PropHitRateResult(
            total_games=0,
            l5_formatted="0/0 (0.0%)",
            l10_formatted="0/0 (0.0%)",
            season_formatted="0/0 (0.0%)",
        )

    parsed_stats = [_to_decimal_stat(val, i) for i, val in enumerate(game_stats)]

    # Tri-state outcome per game: True = hit, False = miss, None = push (stat == line).
    outcomes: list[bool | None] = [
        None if stat == target_line else ((stat > target_line) == (selection == "OVER"))
        for stat in parsed_stats
    ]

    def _window(window: Sequence[bool | None]) -> tuple[int, int, int, Decimal | None]:
        decided = [o for o in window if o is not None]
        hits = sum(1 for o in decided if o)
        total = len(decided)
        rate = (
            (Decimal(hits) / Decimal(total)).quantize(HIT_RATE_QUANTIZE, rounding=ROUND_HALF_UP)
            if total > 0
            else None
        )
        return hits, total, len(window) - total, rate

    l5_slice = outcomes[:5]
    l5_hits, l5_total, l5_pushes, l5_rate = _window(l5_slice)
    l10_hits, l10_total, l10_pushes, l10_rate = _window(outcomes[:10])
    season_hits, season_total, season_pushes, season_rate = _window(outcomes)

    # Form dots: chronological (oldest to newest) last-5 window; pushes are skipped.
    chronological_l5 = [o for o in reversed(l5_slice) if o is not None]
    form_dots = generate_sofascore_form_dots(chronological_l5)

    return PropHitRateResult(
        total_games=total_games,
        l5_hits=l5_hits,
        l5_total=l5_total,
        l5_rate=l5_rate,
        l5_pushes=l5_pushes,
        l10_hits=l10_hits,
        l10_total=l10_total,
        l10_rate=l10_rate,
        l10_pushes=l10_pushes,
        season_hits=season_hits,
        season_total=season_total,
        season_rate=season_rate,
        season_pushes=season_pushes,
        l5_formatted=format_hit_rate_string(l5_hits, l5_total, l5_rate),
        l10_formatted=format_hit_rate_string(l10_hits, l10_total, l10_rate),
        season_formatted=format_hit_rate_string(season_hits, season_total, season_rate),
        form_dots=form_dots,
        form_sequence=chronological_l5,
    )


def update_props_hit_rates(
    session: Session,
    player_game_logs: Mapping[Any, Sequence[Any]],
) -> int:
    """Batch compute and update hit rates on matching active PlayerProp records in PostgreSQL.

    `player_game_logs` can be keyed by either:
    - (player_name, market_key) for precise prop market targeting, or
    - player_name as a fallback across props.
    """
    if not player_game_logs:
        return 0

    updated_count = 0
    now_utc = datetime.now(UTC)

    try:
        player_names: set[str] = set()
        for key in player_game_logs.keys():
            if isinstance(key, tuple):
                player_names.add(key[0])
            else:
                player_names.add(str(key))

        stmt = select(PlayerProp).where(
            PlayerProp.player_name.in_(player_names),
            PlayerProp.status == "ACTIVE",
        )
        props = list(session.scalars(stmt).all())

        for prop in props:
            if prop.line_value is None:
                continue

            # Check specific (player_name, market_key) first, fallback to player_name
            logs = player_game_logs.get((prop.player_name, prop.market_key))
            if logs is None:
                logs = player_game_logs.get(prop.player_name)
            if not logs:
                continue

            selection_str: Literal["OVER", "UNDER"] = (
                "UNDER" if normalize_selection(prop.selection) == "UNDER" else "OVER"
            )
            hit_res = compute_rolling_hit_rate(
                game_stats=logs,
                line_value=prop.line_value,
                selection=selection_str,
            )

            prop.hit_rate_l5 = hit_res.l5_rate
            prop.hit_rate_l10 = hit_res.l10_rate
            prop.hit_rate_season = hit_res.season_rate
            prop.updated_at = now_utc
            updated_count += 1

        session.commit()
        return updated_count
    except Exception as exc:
        session.rollback()
        logger.error("Failed to update player prop hit rates: %s", exc)
        raise
