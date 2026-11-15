"""Asynchronous Closing Line Value (CLV) client, market matcher, and sweep engine."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Mapping, Sequence
from contextlib import ExitStack
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from urllib.parse import quote

import httpx
from pydantic import BaseModel, ConfigDict
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from parlaypal_worker.bets import BetNotFoundError, InvalidBetError, stamp_bet_clv
from parlaypal_worker.config import get_settings
from parlaypal_worker.devig import (
    ODDS_QUANTIZE,
    DeviggingError,
    _to_finite_decimal,
    _validate_decimal_odds,
    combine_independent_fair_probabilities,
    devig_power,
)
from parlaypal_worker.models import Event, PlayerProp, UserBet

logger = logging.getLogger(__name__)

CLOSING_ODDS_DELAY = timedelta(minutes=10)
MAX_SWEEP_AGE = timedelta(days=7)
CLV_PERCENT_QUANTIZE = Decimal("0.001")
MAX_POSITIVE_CLV_PERCENT = Decimal("10.000")

DEFAULT_HTTP_TIMEOUT_SECONDS: float = 10.0

SHARP_BOOKMAKER_PRIORITY: dict[str, int] = {
    "pinnacle": 0,
    "circa": 1,
    "bookmaker": 2,
    "betonlineag": 3,
    "lowvig": 4,
    "novig": 5,
}

_OPPOSITE_SIDE: dict[str, str] = {
    "over": "under",
    "under": "over",
    "yes": "no",
    "no": "yes",
}
_ALT_SIDE_EQUIVALENTS: dict[str, str] = {
    "over": "yes",
    "under": "no",
    "yes": "over",
    "no": "under",
}
_YES_NO_MARKET_KEYS = frozenset(
    {
        "player_anytime_td",
        "anytime_td",
        "player_first_td",
        "player_last_td",
        "player_2plus_td",
        "player_double_double",
        "player_triple_double",
        "btts",
        "both_teams_to_score",
    }
)
_GENERIC_SIDE_TOKENS = frozenset(_OPPOSITE_SIDE.keys())
_EXCLUDED_EVENT_STATUSES = frozenset({"POSTPONED", "CANCELLED"})


class ClosingOddsProviderError(RuntimeError):
    """Transient provider error (5xx, timeout, transport error, 429) eligible for Celery retry."""


class ClosingOddsClientError(ValueError):
    """Non-retryable client or configuration error (missing API key, non-429 4xx)."""


class BetClosingEvaluation(BaseModel):
    """Computed closing-line benchmark metrics for a single bet."""

    model_config = ConfigDict(frozen=True)

    closing_decimal_odds: Decimal
    closing_fair_prob: Decimal
    clv_percentage: Decimal
    is_suspect_stale_line: bool


class ClvSweepResult(BaseModel):
    """Summary counts from a CLV sweep run."""

    model_config = ConfigDict(frozen=True)

    checked_bets: int
    stamped_bets: int
    skipped_suspect: int
    skipped_invalid: int
    skipped_not_due: int
    events_fetched: int
    processed_at: datetime


@dataclass(frozen=True)
class _EventSnapshot:
    event_id: uuid.UUID
    external_provider_id: str | None
    sport_key: str | None
    commence_time: datetime | None
    status: str | None = None


@dataclass(frozen=True)
class _ParsedOutcome:
    name_raw: str
    name_lower: str
    name_prefix: str | None
    side_token: str
    player_lower: str | None
    effective_player: str | None
    has_conflicting_player: bool
    point: Decimal | None
    price: Any


def _normalize_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _coerce_now(now: datetime | str | None) -> datetime:
    if now is None:
        return datetime.now(UTC)
    if isinstance(now, str):
        cleaned = now.strip()
        if cleaned.endswith("Z"):
            cleaned = cleaned[:-1] + "+00:00"
        return _normalize_utc(datetime.fromisoformat(cleaned))
    return _normalize_utc(now)


def _ensure_uuid(value: Any) -> uuid.UUID | None:
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value).strip())
    except (ValueError, TypeError, AttributeError):
        return None


def calculate_clv(
    closing_fair_prob: Decimal | float | str | int,
    execution_decimal_odds: Decimal | float | str | int,
) -> Decimal:
    """Compute CLV% in percentage points: ((P_fair_close * D_exec) - 1) * 100, quantized to 3 dp."""
    prob = _to_finite_decimal(closing_fair_prob, field_name="closing_fair_prob")
    if prob <= Decimal("0") or prob >= Decimal("1"):
        raise DeviggingError(
            f"closing_fair_prob must be strictly between 0 and 1 (got {prob}).",
            code="INVALID_MARKET_ODDS",
        )
    d_exec = _validate_decimal_odds(execution_decimal_odds, field_name="execution_decimal_odds")
    raw_clv_pct = ((prob * d_exec) - Decimal("1")) * Decimal("100")
    return raw_clv_pct.quantize(CLV_PERCENT_QUANTIZE, rounding=ROUND_HALF_UP)


def fetch_closing_odds(
    sport_key: str,
    event_id: str,
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    http_client: httpx.Client | None = None,
    timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Fetch sharp closing odds from GET /v1/historical/sports/{sport_key}/closing-odds?event_id={event_id}."""
    cleaned_sport = str(sport_key or "").strip()
    if not cleaned_sport:
        raise ClosingOddsClientError("sport_key is required to fetch closing odds.")

    cleaned_event_id = str(event_id or "").strip()
    if not cleaned_event_id:
        raise ClosingOddsClientError("external_provider_id is required to fetch closing odds.")

    settings = get_settings()
    resolved_api_key = api_key if api_key is not None else settings.parlay_api_key
    resolved_base_url = base_url if base_url is not None else settings.parlay_api_base_url

    if not resolved_api_key or not resolved_api_key.strip():
        raise ClosingOddsClientError("PARLAY_API_KEY is missing; failing fast without retry.")

    url = (
        f"{resolved_base_url.rstrip('/')}/historical/sports/"
        f"{quote(cleaned_sport, safe='')}/closing-odds"
    )
    headers = {
        "Authorization": f"Bearer {resolved_api_key.strip()}",
        "Accept": "application/json",
    }
    params = {"event_id": cleaned_event_id}

    client = http_client if http_client is not None else httpx.Client(timeout=timeout_seconds)
    owns_client = http_client is None
    try:
        try:
            response = client.get(url, headers=headers, params=params)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            logger.warning(
                "Transient transport error fetching closing odds for %s (%s): %s",
                cleaned_event_id,
                cleaned_sport,
                exc,
            )
            raise ClosingOddsProviderError(
                f"ParlayAPI closing-odds transport error for event {cleaned_event_id}: {exc}"
            ) from exc
        except httpx.HTTPError as exc:
            logger.error(
                "Client HTTP error fetching closing odds for %s (%s): %s",
                cleaned_event_id,
                cleaned_sport,
                exc,
            )
            raise ClosingOddsClientError(
                f"ParlayAPI closing-odds request error for event {cleaned_event_id}: {exc}"
            ) from exc
    finally:
        if owns_client:
            client.close()

    if response.status_code == 429 or response.status_code >= 500:
        logger.warning(
            "Retryable HTTP %s from ParlayAPI closing-odds for event %s (%s).",
            response.status_code,
            cleaned_event_id,
            cleaned_sport,
        )
        raise ClosingOddsProviderError(
            f"ParlayAPI closing-odds returned HTTP {response.status_code} for event {cleaned_event_id}."
        )

    if response.status_code in (400, 404, 422):
        logger.warning(
            "Event-level HTTP %s from ParlayAPI closing-odds for event %s (%s); skipping event.",
            response.status_code,
            cleaned_event_id,
            cleaned_sport,
        )
        raise DeviggingError(
            f"ParlayAPI closing-odds returned HTTP {response.status_code} for event {cleaned_event_id}.",
            code="INVALID_MARKET_ODDS",
        )

    if response.status_code != 200:
        logger.error(
            "Non-retryable HTTP %s from ParlayAPI closing-odds for event %s (%s).",
            response.status_code,
            cleaned_event_id,
            cleaned_sport,
        )
        raise ClosingOddsClientError(
            f"ParlayAPI closing-odds returned HTTP {response.status_code} for event {cleaned_event_id}."
        )

    try:
        payload = response.json()
    except (ValueError, TypeError) as exc:
        raise DeviggingError(
            f"Closing-odds response for event {cleaned_event_id} is not valid JSON.",
            code="INVALID_MARKET_ODDS",
            cause=exc,
        ) from exc

    if not isinstance(payload, dict):
        raise DeviggingError(
            f"Closing-odds payload for event {cleaned_event_id} must be a JSON object.",
            code="INVALID_MARKET_ODDS",
        )

    if "event_id" in payload and payload["event_id"] is not None:
        payload_event_id = str(payload["event_id"]).strip()
        if payload_event_id != cleaned_event_id:
            raise DeviggingError(
                f"Closing-odds payload event_id '{payload_event_id}' does not match '{cleaned_event_id}'.",
                code="INVALID_MARKET_ODDS",
            )

    return payload


def _extract_leg_descriptor(
    leg: Mapping[str, Any],
) -> tuple[str | None, str, str | None, Decimal | None]:
    raw_market = (
        leg.get("marketKey")
        or leg.get("market_key")
        or leg.get("marketType")
        or leg.get("market_type")
    )
    leg_market_key = (
        str(raw_market).strip().lower()
        if raw_market is not None and str(raw_market).strip()
        else None
    )

    raw_selection = leg.get("selection") or leg.get("side") or leg.get("outcome")
    if raw_selection is None or not str(raw_selection).strip():
        raise DeviggingError("Bet leg is missing required selection.", code="INVALID_MARKET_ODDS")
    leg_selection = str(raw_selection).strip()

    raw_player = leg.get("playerName") or leg.get("player_name")
    leg_player = (
        str(raw_player).strip().lower()
        if raw_player is not None and str(raw_player).strip()
        else None
    )

    raw_line: Any = None
    for line_key in ("line", "lineValue", "line_value"):
        if line_key in leg and leg[line_key] is not None:
            raw_line = leg[line_key]
            break

    leg_line = _to_finite_decimal(raw_line, field_name="leg.line") if raw_line is not None else None
    return leg_market_key, leg_selection, leg_player, leg_line


def _split_name_entity_and_side(name_lower: str) -> tuple[str | None, str]:
    if name_lower in _GENERIC_SIDE_TOKENS:
        return None, name_lower
    for side in _GENERIC_SIDE_TOKENS:
        suffix = f" {side}"
        if name_lower.endswith(suffix):
            prefix = name_lower[: -len(suffix)].strip()
            if prefix:
                return prefix, side
    return None, name_lower


def _parse_outcome(outcome: Any) -> _ParsedOutcome:
    if not isinstance(outcome, Mapping):
        raise DeviggingError("Outcome entry must be an object.", code="INVALID_MARKET_ODDS")

    name_raw = str(outcome.get("name") or "").strip()
    if not name_raw:
        raise DeviggingError("Outcome entry is missing name.", code="INVALID_MARKET_ODDS")

    raw_player = (
        outcome.get("description")
        or outcome.get("player_name")
        or outcome.get("playerName")
        or outcome.get("participant")
    )
    player_lower = (
        str(raw_player).strip().lower()
        if raw_player is not None and str(raw_player).strip()
        else None
    )

    name_lower = name_raw.lower()
    name_prefix, side_token = _split_name_entity_and_side(name_lower)
    has_conflicting_player = (
        player_lower is not None and name_prefix is not None and player_lower != name_prefix
    )
    effective_player = player_lower if player_lower is not None else name_prefix

    raw_point = outcome.get("point")
    point = (
        _to_finite_decimal(raw_point, field_name="outcome.point") if raw_point is not None else None
    )

    return _ParsedOutcome(
        name_raw=name_raw,
        name_lower=name_lower,
        name_prefix=name_prefix,
        side_token=side_token,
        player_lower=player_lower,
        effective_player=effective_player,
        has_conflicting_player=has_conflicting_player,
        point=point,
        price=outcome.get("price"),
    )


def _is_yes_no_market(market_key: str | None, leg_market_key: str | None) -> bool:
    for key in (leg_market_key, market_key):
        if key is not None and (
            key in _YES_NO_MARKET_KEYS or "anytime_td" in key or "yes_no" in key
        ):
            return True
    return leg_market_key is None and market_key is None


def _is_spread_market(market_key: str | None, leg_market_key: str | None) -> bool:
    return any(
        key is not None and (key in ("spreads", "spread") or "spread" in key)
        for key in (leg_market_key, market_key)
    )


def _outcome_matches_player(
    parsed: _ParsedOutcome,
    leg_player: str | None,
    *,
    market_has_player_metadata: bool,
) -> bool:
    if parsed.has_conflicting_player:
        return False
    if leg_player is None:
        return True
    if parsed.effective_player is not None:
        return parsed.effective_player == leg_player
    if parsed.side_token in _GENERIC_SIDE_TOKENS:
        return not market_has_player_metadata
    return parsed.name_lower == leg_player


def _outcome_matches_line(parsed: _ParsedOutcome, expected_line: Decimal | None) -> bool:
    if (expected_line is None) != (parsed.point is None):
        return False
    if expected_line is not None and parsed.point != expected_line:
        return False
    return True


def _match_leg_in_market(
    market: Mapping[str, Any],
    *,
    leg_market_key: str | None,
    leg_selection: str,
    leg_player: str | None,
    leg_line: Decimal | None,
) -> tuple[Decimal, Decimal] | None:
    raw_market_key = market.get("key")
    market_key = (
        str(raw_market_key).strip().lower()
        if raw_market_key is not None and str(raw_market_key).strip()
        else None
    )
    if leg_market_key is not None and market_key != leg_market_key:
        return None

    raw_outcomes = market.get("outcomes")
    if not isinstance(raw_outcomes, Sequence) or isinstance(raw_outcomes, (str, bytes)):
        return None

    parsed_outcomes = [_parse_outcome(o) for o in raw_outcomes]
    market_has_player_metadata = any(
        p.player_lower is not None or p.name_prefix is not None for p in parsed_outcomes
    )

    player_matched = [
        p
        for p in parsed_outcomes
        if _outcome_matches_player(
            p, leg_player, market_has_player_metadata=market_has_player_metadata
        )
    ]

    sel_lower = leg_selection.lower()
    target_candidates: list[_ParsedOutcome] = []
    for p in player_matched:
        if not _outcome_matches_line(p, leg_line):
            continue
        if sel_lower in _OPPOSITE_SIDE:
            if p.side_token == sel_lower:
                target_candidates.append(p)
        elif p.name_lower == sel_lower:
            target_candidates.append(p)

    # Two-way Yes/No <-> OVER/UNDER equivalence for anytime TD / Yes-No markets.
    if (
        not target_candidates
        and sel_lower in _ALT_SIDE_EQUIVALENTS
        and _is_yes_no_market(market_key, leg_market_key)
    ):
        alt_side = _ALT_SIDE_EQUIVALENTS[sel_lower]
        for p in player_matched:
            if _outcome_matches_line(p, leg_line) and p.side_token == alt_side:
                target_candidates.append(p)
        if not target_candidates and leg_line in (None, Decimal("0.5")):
            for p in player_matched:
                line_relaxed_match = (leg_line == Decimal("0.5") and p.point is None) or (
                    leg_line is None and p.point == Decimal("0.5")
                )
                if line_relaxed_match and p.side_token in (sel_lower, alt_side):
                    target_candidates.append(p)

    if not target_candidates:
        return None
    if len(target_candidates) > 1:
        raise DeviggingError(
            f"Ambiguous duplicate target outcomes for selection '{leg_selection}'.",
            code="INVALID_MARKET_ODDS",
        )

    target = target_candidates[0]
    is_spread = _is_spread_market(market_key, leg_market_key)
    if is_spread and leg_line is not None:
        expected_opp_line: Decimal | None = -leg_line if leg_line != Decimal("0") else Decimal("0")
    else:
        expected_opp_line = target.point

    opposite_candidates: list[_ParsedOutcome] = []
    for p in parsed_outcomes:
        if p is target or p.has_conflicting_player:
            continue
        if not _outcome_matches_line(p, expected_opp_line):
            continue
        if p.effective_player != target.effective_player:
            continue

        if sel_lower in _OPPOSITE_SIDE:
            expected_opp_side = _OPPOSITE_SIDE.get(target.side_token)
            if expected_opp_side is not None and p.side_token == expected_opp_side:
                opposite_candidates.append(p)
        else:
            opposite_candidates.append(p)

    if len(opposite_candidates) != 1:
        raise DeviggingError(
            f"Expected exactly 1 opposite outcome for '{leg_selection}', found {len(opposite_candidates)}.",
            code="INVALID_MARKET_ODDS",
        )

    opposite = opposite_candidates[0]
    d_target = _validate_decimal_odds(target.price, field_name="closing_target_odds")
    d_opposite = _validate_decimal_odds(opposite.price, field_name="closing_opposite_odds")
    return d_target, d_opposite


def parse_closing_leg_prices(
    payload: Mapping[str, Any],
    legs: Sequence[Mapping[str, Any]],
    *,
    expected_event_id: str | None = None,
) -> list[tuple[Decimal, Decimal]]:
    """Extract Pinnacle-first two-way closing decimal odds pairs [(target, opposite), ...] per leg."""
    if not isinstance(payload, Mapping):
        raise DeviggingError("Closing-odds payload must be a mapping.", code="INVALID_MARKET_ODDS")

    if expected_event_id is not None and "event_id" in payload and payload["event_id"] is not None:
        payload_event_id = str(payload["event_id"]).strip()
        if payload_event_id != expected_event_id.strip():
            raise DeviggingError(
                f"Closing-odds payload event_id '{payload_event_id}' does not match '{expected_event_id}'.",
                code="INVALID_MARKET_ODDS",
            )

    if not legs:
        raise DeviggingError(
            "At least one bet leg is required to match closing odds.",
            code="INVALID_MARKET_ODDS",
        )

    raw_bookmakers = payload.get("bookmakers")
    if not isinstance(raw_bookmakers, Sequence) or isinstance(raw_bookmakers, (str, bytes)):
        raise DeviggingError(
            "Closing-odds payload is missing bookmakers list.",
            code="INVALID_MARKET_ODDS",
        )
    if not raw_bookmakers:
        raise DeviggingError(
            "Closing-odds payload contains no bookmakers.",
            code="INVALID_MARKET_ODDS",
        )

    sharp_books: list[tuple[int, int, Mapping[str, Any]]] = []
    for idx, b in enumerate(raw_bookmakers):
        if not isinstance(b, Mapping):
            continue
        book_key = str(b.get("key") or "").strip().lower()
        priority = SHARP_BOOKMAKER_PRIORITY.get(book_key)
        if priority is not None:
            sharp_books.append((priority, idx, b))

    if not sharp_books:
        raise DeviggingError(
            "Closing-odds payload contains no sharp benchmark bookmakers.",
            code="MISSING_CLOSING_MARKET",
        )

    sharp_books.sort(key=lambda item: (item[0], item[1]))
    ordered_books = [b for _, _, b in sharp_books]

    leg_pairs: list[tuple[Decimal, Decimal]] = []
    for leg in legs:
        if not isinstance(leg, Mapping):
            raise DeviggingError("Bet leg entry must be a mapping.", code="INVALID_MARKET_ODDS")
        leg_market_key, leg_selection, leg_player, leg_line = _extract_leg_descriptor(leg)

        matched_pair: tuple[Decimal, Decimal] | None = None
        last_validation_error: DeviggingError | None = None
        for book in ordered_books:
            book_key = str(book.get("key") or "").strip().lower()
            markets = book.get("markets")
            if not isinstance(markets, Sequence) or isinstance(markets, (str, bytes)):
                continue
            for market in markets:
                if not isinstance(market, Mapping):
                    continue
                try:
                    pair = _match_leg_in_market(
                        market,
                        leg_market_key=leg_market_key,
                        leg_selection=leg_selection,
                        leg_player=leg_player,
                        leg_line=leg_line,
                    )
                except DeviggingError as exc:
                    last_validation_error = exc
                    logger.warning(
                        "Sharp book '%s' rejected closing market for %s (%s): %s; trying fallback.",
                        book_key,
                        leg_player or leg_selection,
                        leg_market_key or "unspecified",
                        exc,
                    )
                    continue
                if pair is not None:
                    if book_key != "pinnacle":
                        logger.info(
                            "Pinnacle closing line unavailable for %s (%s); using fallback book '%s'.",
                            leg_player or leg_selection,
                            leg_market_key or "unspecified",
                            book_key or "unknown",
                        )
                    matched_pair = pair
                    break
            if matched_pair is not None:
                break

        if matched_pair is None:
            if last_validation_error is not None:
                raise last_validation_error
            raise DeviggingError(
                f"Could not resolve two-way closing odds for leg '{leg_player or ''} {leg_selection}'.",
                code="MISSING_CLOSING_MARKET",
            )
        leg_pairs.append(matched_pair)

    return leg_pairs


def compute_bet_closing(
    execution_decimal_odds: Decimal | float | str,
    leg_closing_pairs: Sequence[tuple[Decimal, Decimal]],
) -> BetClosingEvaluation:
    """Devig each leg with Power method, combine multi-leg fair probabilities, and compute CLV%."""
    d_exec = _validate_decimal_odds(execution_decimal_odds, field_name="execution_decimal_odds")
    if not leg_closing_pairs:
        raise DeviggingError(
            "At least one leg closing odds pair is required.",
            code="INVALID_MARKET_ODDS",
        )

    leg_fair_probs: list[Decimal] = []
    combined_closing_odds = Decimal("1")
    for target_raw, opp_raw in leg_closing_pairs:
        d_target = _validate_decimal_odds(target_raw, field_name="closing_target_odds").quantize(
            ODDS_QUANTIZE, rounding=ROUND_HALF_UP
        )
        d_opp = _validate_decimal_odds(opp_raw, field_name="closing_opposite_odds").quantize(
            ODDS_QUANTIZE, rounding=ROUND_HALF_UP
        )
        p_target, _ = devig_power(d_target, d_opp)
        leg_fair_probs.append(p_target)
        combined_closing_odds *= d_target

    closing_decimal_odds_q = _validate_decimal_odds(
        combined_closing_odds.quantize(ODDS_QUANTIZE, rounding=ROUND_HALF_UP),
        field_name="closing_decimal_odds",
    )
    closing_fair_prob_q = combine_independent_fair_probabilities(leg_fair_probs)
    clv_pct = calculate_clv(closing_fair_prob_q, d_exec)
    is_suspect = clv_pct > MAX_POSITIVE_CLV_PERCENT

    return BetClosingEvaluation(
        closing_decimal_odds=closing_decimal_odds_q,
        closing_fair_prob=closing_fair_prob_q,
        clv_percentage=clv_pct,
        is_suspect_stale_line=is_suspect,
    )


def _snapshot_from_event(event: Event) -> _EventSnapshot:
    commence_utc = _normalize_utc(event.commence_time) if event.commence_time is not None else None
    provider_id = (
        str(event.external_provider_id).strip()
        if event.external_provider_id is not None and str(event.external_provider_id).strip()
        else None
    )
    sport_key = (
        str(event.sport_key).strip()
        if event.sport_key is not None and str(event.sport_key).strip()
        else None
    )
    raw_status = getattr(event, "status", None)
    status = (
        str(raw_status).strip().upper()
        if raw_status is not None and str(raw_status).strip()
        else None
    )
    return _EventSnapshot(
        event_id=event.event_id,
        external_provider_id=provider_id,
        sport_key=sport_key,
        commence_time=commence_utc,
        status=status,
    )


def _get_event_snapshot(
    session: Session,
    event_id: uuid.UUID,
    events_cache: dict[uuid.UUID, _EventSnapshot | None],
    events_by_provider_cache: dict[str, _EventSnapshot | None] | None = None,
) -> _EventSnapshot | None:
    if event_id in events_cache:
        return events_cache[event_id]

    event = session.get(Event, event_id)
    if event is None:
        events_cache[event_id] = None
        return None

    snapshot = _snapshot_from_event(event)
    events_cache[event_id] = snapshot
    if events_by_provider_cache is not None and snapshot.external_provider_id is not None:
        events_by_provider_cache[snapshot.external_provider_id] = snapshot
    return snapshot


def _get_event_snapshot_by_provider_id(
    session: Session,
    provider_event_id: str,
    events_cache: dict[uuid.UUID, _EventSnapshot | None],
    events_by_provider_cache: dict[str, _EventSnapshot | None],
) -> _EventSnapshot | None:
    if provider_event_id in events_by_provider_cache:
        return events_by_provider_cache[provider_event_id]

    event = session.scalar(select(Event).where(Event.external_provider_id == provider_event_id))
    if event is None:
        events_by_provider_cache[provider_event_id] = None
        return None

    snapshot = _snapshot_from_event(event)
    events_cache[snapshot.event_id] = snapshot
    events_by_provider_cache[provider_event_id] = snapshot
    return snapshot


def _resolve_bet_legs(session: Session, bet: UserBet) -> list[dict[str, Any]]:
    if bet.legs_json is not None:
        if not isinstance(bet.legs_json, list) or len(bet.legs_json) == 0:
            raise DeviggingError(
                "Bet legs_json must be a non-empty list.", code="INVALID_MARKET_ODDS"
            )
        for item in bet.legs_json:
            if not isinstance(item, Mapping):
                raise DeviggingError(
                    "Bet legs_json entries must be objects.", code="INVALID_MARKET_ODDS"
                )
        return [dict(item) for item in bet.legs_json]

    if bet.prop_id is not None:
        prop = session.get(PlayerProp, bet.prop_id)
        if prop is not None:
            return [
                {
                    "propId": str(prop.prop_id),
                    "playerName": prop.player_name,
                    "marketKey": prop.market_key,
                    "selection": prop.selection,
                    "line": prop.line_value,
                    "eventId": str(prop.event_id),
                }
            ]

    raise DeviggingError(
        "Bet has neither legs_json nor a valid prop_id to resolve closing odds.",
        code="INVALID_MARKET_ODDS",
    )


def _resolve_leg_event(
    leg: Mapping[str, Any],
    bet_event: _EventSnapshot | None,
    session: Session,
    events_cache: dict[uuid.UUID, _EventSnapshot | None],
    events_by_provider_cache: dict[str, _EventSnapshot | None] | None = None,
) -> _EventSnapshot | None:
    raw_leg_event = leg.get("eventId") or leg.get("event_id")
    if raw_leg_event is None or not str(raw_leg_event).strip():
        return bet_event

    raw_str = str(raw_leg_event).strip()
    if bet_event is not None and (
        raw_str == str(bet_event.event_id)
        or (
            bet_event.external_provider_id is not None and raw_str == bet_event.external_provider_id
        )
    ):
        return bet_event

    provider_cache = events_by_provider_cache if events_by_provider_cache is not None else {}
    leg_event_uuid = _ensure_uuid(raw_str)
    if leg_event_uuid is not None:
        return _get_event_snapshot(session, leg_event_uuid, events_cache, provider_cache)

    if raw_str.startswith("papi_"):
        return _get_event_snapshot_by_provider_id(session, raw_str, events_cache, provider_cache)

    raise DeviggingError(f"Leg references invalid eventId '{raw_str}'.", code="INVALID_MARKET_ODDS")


def _has_valid_event_metadata(snapshot: _EventSnapshot | None) -> bool:
    return (
        snapshot is not None
        and snapshot.commence_time is not None
        and bool(snapshot.external_provider_id)
        and bool(snapshot.sport_key)
    )


def _is_event_due(
    snapshot: _EventSnapshot | None,
    *,
    latest_commence: datetime,
    earliest_commence: datetime,
) -> bool:
    if not _has_valid_event_metadata(snapshot):
        return False
    assert snapshot is not None and snapshot.commence_time is not None
    if snapshot.status in _EXCLUDED_EVENT_STATUSES:
        return False
    return earliest_commence <= snapshot.commence_time <= latest_commence


def stamp_due_bets(
    session: Session,
    now: datetime | str | None = None,
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    http_client: httpx.Client | None = None,
) -> ClvSweepResult:
    """Sweep pending unstamped bets >= 10 minutes after commence (within 7 days) and stamp CLV."""
    now_utc = _coerce_now(now)
    latest_commence = now_utc - CLOSING_ODDS_DELAY
    earliest_commence = now_utc - MAX_SWEEP_AGE

    stmt = (
        select(UserBet)
        .outerjoin(Event, UserBet.event_id == Event.event_id)
        .where(
            UserBet.status.in_(("PENDING", "pending")),
            UserBet.clv_percentage.is_(None),
            or_(
                and_(
                    UserBet.event_id.is_(None),
                    UserBet.placed_at >= earliest_commence,
                ),
                and_(
                    Event.commence_time.is_not(None),
                    Event.commence_time <= latest_commence,
                    Event.commence_time >= earliest_commence,
                    func.upper(func.coalesce(Event.status, "")).not_in(
                        tuple(_EXCLUDED_EVENT_STATUSES)
                    ),
                ),
            ),
        )
        .order_by(UserBet.placed_at.asc())
    )
    candidate_bets = list(session.scalars(stmt).all())

    events_cache: dict[uuid.UUID, _EventSnapshot | None] = {}
    events_by_provider_cache: dict[str, _EventSnapshot | None] = {}
    payloads_cache: dict[tuple[str, str], dict[str, Any]] = {}
    payload_errors_cache: dict[tuple[str, str], Exception] = {}
    provider_errors: list[ClosingOddsProviderError] = []

    checked_bets = 0
    stamped_bets = 0
    skipped_suspect = 0
    skipped_invalid = 0
    skipped_not_due = 0

    with ExitStack() as client_stack:
        owned_client: httpx.Client | None = None

        for bet in candidate_bets:
            if bet.status not in ("PENDING", "pending") or bet.clv_percentage is not None:
                continue

            bet_id = bet.bet_id
            bet_decimal_odds = bet.decimal_odds
            bet_event_id = bet.event_id
            checked_bets += 1

            try:
                bet_event = (
                    _get_event_snapshot(
                        session, bet_event_id, events_cache, events_by_provider_cache
                    )
                    if bet_event_id is not None
                    else None
                )
                legs = _resolve_bet_legs(session, bet)
                leg_events = [
                    _resolve_leg_event(
                        leg, bet_event, session, events_cache, events_by_provider_cache
                    )
                    for leg in legs
                ]

                if any(not _has_valid_event_metadata(ev) for ev in leg_events):
                    skipped_invalid += 1
                    logger.warning(
                        "Skipping CLV stamp for bet %s [INVALID_EVENT_METADATA]: missing event, commence_time, sport_key, or external_provider_id.",
                        bet_id,
                    )
                    continue

                if any(
                    not _is_event_due(
                        ev,
                        latest_commence=latest_commence,
                        earliest_commence=earliest_commence,
                    )
                    for ev in leg_events
                ):
                    skipped_not_due += 1
                    continue

                leg_pairs: list[tuple[Decimal, Decimal]] = []
                had_transient_provider_error = False
                for leg, ev in zip(legs, leg_events, strict=True):
                    assert ev is not None
                    assert ev.sport_key is not None
                    assert ev.external_provider_id is not None
                    cache_key = (ev.sport_key, ev.external_provider_id)

                    if cache_key in payload_errors_cache:
                        cached_exc = payload_errors_cache[cache_key]
                        if isinstance(cached_exc, ClosingOddsProviderError):
                            had_transient_provider_error = True
                            break
                        raise cached_exc

                    if cache_key not in payloads_cache:
                        if http_client is None and owned_client is None:
                            owned_client = client_stack.enter_context(
                                httpx.Client(timeout=DEFAULT_HTTP_TIMEOUT_SECONDS)
                            )
                        active_client = http_client if http_client is not None else owned_client
                        try:
                            payloads_cache[cache_key] = fetch_closing_odds(
                                ev.sport_key,
                                ev.external_provider_id,
                                api_key=api_key,
                                base_url=base_url,
                                http_client=active_client,
                            )
                        except ClosingOddsClientError:
                            raise
                        except ClosingOddsProviderError as exc:
                            payload_errors_cache[cache_key] = exc
                            provider_errors.append(exc)
                            had_transient_provider_error = True
                            break
                        except DeviggingError as exc:
                            payload_errors_cache[cache_key] = exc
                            raise

                    pair = parse_closing_leg_prices(
                        payloads_cache[cache_key],
                        [leg],
                        expected_event_id=ev.external_provider_id,
                    )[0]
                    leg_pairs.append(pair)

                if had_transient_provider_error:
                    continue

                evaluation = compute_bet_closing(bet_decimal_odds, leg_pairs)
                if evaluation.is_suspect_stale_line:
                    skipped_suspect += 1
                    logger.warning(
                        "SUSPECT_STALE_LINE: skipping CLV stamp for bet %s (clv_percentage=%s%% > +%s%%).",
                        bet_id,
                        evaluation.clv_percentage,
                        MAX_POSITIVE_CLV_PERCENT,
                    )
                    continue

                stamp_bet_clv(
                    session,
                    bet_id,
                    closing_decimal_odds=evaluation.closing_decimal_odds,
                    closing_fair_prob=evaluation.closing_fair_prob,
                    clv_percentage=evaluation.clv_percentage,
                    commit=True,
                )
                stamped_bets += 1
            except ClosingOddsClientError:
                raise
            except (
                DeviggingError,
                ArithmeticError,
                AttributeError,
                TypeError,
                ValueError,
                InvalidBetError,
                BetNotFoundError,
            ) as exc:
                session.rollback()
                skipped_invalid += 1
                error_code = getattr(exc, "code", "INVALID_MARKET_ODDS")
                logger.warning(
                    "Skipping CLV stamp for bet %s [%s]: %s",
                    bet_id,
                    error_code,
                    exc,
                )
                continue

    if provider_errors:
        raise provider_errors[0]

    return ClvSweepResult(
        checked_bets=checked_bets,
        stamped_bets=stamped_bets,
        skipped_suspect=skipped_suspect,
        skipped_invalid=skipped_invalid,
        skipped_not_due=skipped_not_due,
        events_fetched=len(payloads_cache),
        processed_at=now_utc,
    )
