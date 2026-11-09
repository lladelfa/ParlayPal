"""Quantitative two-way devigging, Brent root-solving, and Outlier Circuit Breaker engine."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from scipy.optimize import brentq
from sqlalchemy import select
from sqlalchemy.orm import Session

from parlaypal_worker.models import PlayerProp
from parlaypal_worker.redis_client import (
    HOT_CACHE_TTL_SECONDS,
    MAX_DECIMAL_ODDS,
    MIN_DECIMAL_ODDS,
    EvaluatedPropFeedItem,
    RedisLike,
    _validate_provider_prefix,
    _validate_sport_key,
    cache_ev_feed,
    format_iso8601_utc,
    get_redis_client,
)

logger = logging.getLogger(__name__)

ODDS_QUANTIZE: Decimal = Decimal("0.0001")
HIT_RATE_QUANTIZE: Decimal = Decimal("0.0001")
FAIR_PROB_QUANTIZE: Decimal = Decimal("0.00001")
GUARDED_EV_QUANTIZE: Decimal = Decimal("0.00001")
MIN_FAIR_PROB: Decimal = Decimal("0.00001")
MAX_FAIR_PROB: Decimal = Decimal("0.99999")
MIN_GUARDED_EV: Decimal = Decimal("-99.99999")
MAX_GUARDED_EV: Decimal = Decimal("99.99999")

POSITIVE_EV_THRESHOLD: Decimal = Decimal("0.01500")
HIGH_VALUE_EV_THRESHOLD: Decimal = Decimal("0.03500")
OUTLIER_EV_THRESHOLD: Decimal = Decimal("0.10000")
HIGH_VALUE_HIT_RATE_THRESHOLD: Decimal = Decimal("0.7000")

PropStatus = Literal["ACTIVE", "SUSPECT_STALE_LINE"]
ValueTier = Literal["HIGH_VALUE", "POSITIVE_VALUE", "NEUTRAL", "SUSPECT_STALE_LINE"]


class DeviggingError(ValueError):
    """Structured quantitative devigging and odds validation error."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "INVALID_MARKET_ODDS",
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


def _to_finite_decimal(value: Decimal | float | str | int, field_name: str = "odds") -> Decimal:
    """Coerce input to a finite Decimal or raise DeviggingError."""
    if isinstance(value, bool) or value is None:
        raise DeviggingError(
            f"Invalid {field_name}: boolean or null values are not permitted.",
            code="INVALID_MARKET_ODDS",
        )
    try:
        dec = value if isinstance(value, Decimal) else Decimal(str(value).strip())
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise DeviggingError(
            f"Invalid {field_name} value '{value}': could not parse as Decimal.",
            code="INVALID_MARKET_ODDS",
            cause=exc,
        ) from exc

    if not dec.is_finite():
        raise DeviggingError(
            f"Invalid {field_name} value '{value}': NaN and Infinity are not permitted.",
            code="INVALID_MARKET_ODDS",
        )
    return dec


def _validate_decimal_odds(
    value: Decimal | float | str | int,
    field_name: str = "decimal_odds",
) -> Decimal:
    """Validate Decimal odds are finite and within [1.01, 9999.9999]."""
    dec = _to_finite_decimal(value, field_name=field_name)
    if dec < MIN_DECIMAL_ODDS or dec > MAX_DECIMAL_ODDS:
        raise DeviggingError(
            f"{field_name} must be between {MIN_DECIMAL_ODDS} and {MAX_DECIMAL_ODDS} (got {dec}).",
            code="INVALID_MARKET_ODDS",
        )
    return dec


def _validate_hit_rate(
    value: Decimal | float | str | int | None,
    field_name: str = "hit_rate",
) -> Decimal | None:
    """Validate optional empirical rolling hit rate in [0.0, 1.0]."""
    if value is None:
        return None
    dec = _to_finite_decimal(value, field_name=field_name)
    if dec < Decimal("0") or dec > Decimal("1"):
        raise DeviggingError(
            f"{field_name} must be between 0.0000 and 1.0000 (got {dec}).",
            code="INVALID_MARKET_ODDS",
        )
    return dec.quantize(HIT_RATE_QUANTIZE, rounding=ROUND_HALF_UP)


def _quantize_fair_prob(value: Decimal) -> Decimal:
    """Quantize fair probability to Numeric(6, 5) (`0.00001`) clamped to [0.00001, 0.99999]."""
    clamped = min(max(value, MIN_FAIR_PROB), MAX_FAIR_PROB)
    return clamped.quantize(FAIR_PROB_QUANTIZE, rounding=ROUND_HALF_UP)


def _quantize_ev(value: Decimal) -> Decimal:
    """Quantize EV to Numeric(7, 5) (`0.00001`) clamped to [-99.99999, 99.99999]."""
    clamped = min(max(value, MIN_GUARDED_EV), MAX_GUARDED_EV)
    return clamped.quantize(GUARDED_EV_QUANTIZE, rounding=ROUND_HALF_UP)


def american_to_decimal(american_odds: int | float | str | Decimal) -> Decimal:
    """Convert American odds (+150, -110) at ingestion boundary to Decimal odds (quantized 0.0001).

    Rejects values in (-100, +100) and any resulting decimal odds outside [1.01, 9999.9999].
    """
    dec_am = _to_finite_decimal(american_odds, field_name="american_odds")
    if Decimal("-100") < dec_am < Decimal("100"):
        raise DeviggingError(
            f"American odds must be <= -100 or >= +100 (got {american_odds}).",
            code="INVALID_MARKET_ODDS",
        )

    if dec_am >= Decimal("100"):
        raw_decimal = Decimal("1") + (dec_am / Decimal("100"))
    else:
        raw_decimal = Decimal("1") + (Decimal("100") / abs(dec_am))

    try:
        quantized = raw_decimal.quantize(ODDS_QUANTIZE, rounding=ROUND_HALF_UP)
    except InvalidOperation as exc:
        raise DeviggingError(
            f"American odds '{american_odds}' produced out-of-range Decimal odds.",
            code="INVALID_MARKET_ODDS",
            cause=exc,
        ) from exc
    return _validate_decimal_odds(quantized, field_name="decimal_odds")


def decimal_to_american(decimal_odds: Decimal | float | str | int) -> int:
    """Convert Decimal odds (>= 1.01) to integer American odds at display boundary."""
    dec = _validate_decimal_odds(decimal_odds, field_name="decimal_odds")
    if dec >= Decimal("2.0000"):
        american = ((dec - Decimal("1")) * Decimal("100")).quantize(
            Decimal("1"),
            rounding=ROUND_HALF_UP,
        )
        return int(american)

    american = (Decimal("-100") / (dec - Decimal("1"))).quantize(
        Decimal("1"),
        rounding=ROUND_HALF_UP,
    )
    return int(american)


def _compute_multiplicative_raw(
    sharp_odds_1: Decimal | float | str | int,
    sharp_odds_2: Decimal | float | str | int,
) -> tuple[Decimal, Decimal, Decimal]:
    """Return high-precision (p_fair_1, p_fair_2, overround) using Multiplicative method."""
    d1 = _validate_decimal_odds(sharp_odds_1, field_name="sharp_odds_1")
    d2 = _validate_decimal_odds(sharp_odds_2, field_name="sharp_odds_2")

    p1 = Decimal("1") / d1
    p2 = Decimal("1") / d2
    overround = p1 + p2

    if overround <= Decimal("1.0"):
        raise DeviggingError(
            f"Two-way sharp market must carry positive bookmaker overround > 1.0 (got {overround:.5f}).",
            code="INVALID_MARKET_ODDS",
        )

    return p1 / overround, p2 / overround, overround


def devig_multiplicative(
    sharp_odds_1: Decimal | float | str | int,
    sharp_odds_2: Decimal | float | str | int,
) -> tuple[Decimal, Decimal]:
    """Devig a two-way sharp market using the Multiplicative (proportional) method.

    P_{fair, mult, i} = P_i / (P_1 + P_2), where P_i = 1 / D_{sharp, i}.
    Returns fair probabilities quantized to Numeric(6, 5) (`0.00001`).
    """
    p1_raw, p2_raw, _ = _compute_multiplicative_raw(sharp_odds_1, sharp_odds_2)
    p1_q = _quantize_fair_prob(p1_raw)
    p2_q = _quantize_fair_prob(p2_raw)
    return p1_q, p2_q


def _compute_power_raw(
    sharp_odds_1: Decimal | float | str | int,
    sharp_odds_2: Decimal | float | str | int,
) -> tuple[Decimal, Decimal, Decimal]:
    """Return high-precision (p_fair_1, p_fair_2, overround) using Power method via Brent's solver."""
    d1 = _validate_decimal_odds(sharp_odds_1, field_name="sharp_odds_1")
    d2 = _validate_decimal_odds(sharp_odds_2, field_name="sharp_odds_2")

    p1 = Decimal("1") / d1
    p2 = Decimal("1") / d2
    overround = p1 + p2

    if overround <= Decimal("1.0"):
        raise DeviggingError(
            f"Two-way sharp market must carry positive bookmaker overround > 1.0 (got {overround:.5f}).",
            code="INVALID_MARKET_ODDS",
        )

    p1_f = float(p1)
    p2_f = float(p2)

    def objective(k: float) -> float:
        return float((p1_f**k) + (p2_f**k) - 1.0)

    lower_bound = 1.0
    upper_bound = 100.0
    while objective(upper_bound) >= 0.0 and upper_bound < 16384.0:
        upper_bound *= 2.0

    try:
        k_root = float(
            brentq(
                objective,
                lower_bound,
                upper_bound,
                xtol=1e-12,
                rtol=1e-12,
                maxiter=200,
            )
        )
    except (ValueError, RuntimeError) as exc:
        raise DeviggingError(
            "Power devigging root solver failed to converge on two-way sharp odds.",
            code="INVALID_MARKET_ODDS",
            cause=exc,
        ) from exc

    p1_pow = Decimal(str(p1_f**k_root))
    p2_pow = Decimal(str(p2_f**k_root))
    norm = p1_pow + p2_pow
    return p1_pow / norm, p2_pow / norm, overround


def devig_power(
    sharp_odds_1: Decimal | float | str | int,
    sharp_odds_2: Decimal | float | str | int,
) -> tuple[Decimal, Decimal]:
    """Devig a two-way sharp market using the Power method solved via `scipy.optimize.brentq`.

    Solves P_1^k + P_2^k - 1.0 = 0 for k > 1 and sets P_{fair, power, i} = P_i^k.
    Returns fair probabilities quantized to Numeric(6, 5) (`0.00001`).
    """
    p1_raw, p2_raw, _ = _compute_power_raw(sharp_odds_1, sharp_odds_2)
    p1_q = _quantize_fair_prob(p1_raw)
    p2_q = _quantize_fair_prob(p2_raw)
    return p1_q, p2_q


def combine_independent_fair_probabilities(
    probabilities: Sequence[Decimal | float | str],
) -> Decimal:
    """Compute joint fair probability for an independent cross-game parlay: prod(P_{fair, i})."""
    if not probabilities:
        raise DeviggingError(
            "At least one leg fair probability is required to compute joint parlay probability.",
            code="INVALID_MARKET_ODDS",
        )

    joint_prob = Decimal("1")
    for idx, prob in enumerate(probabilities):
        dec_prob = _to_finite_decimal(prob, field_name=f"probabilities[{idx}]")
        if dec_prob <= Decimal("0") or dec_prob >= Decimal("1"):
            raise DeviggingError(
                f"Fair probability at index {idx} must be strictly between 0 and 1 (got {dec_prob}).",
                code="INVALID_MARKET_ODDS",
            )
        joint_prob *= dec_prob

    return _quantize_fair_prob(joint_prob)


class PropDevigResult(BaseModel):
    """Result of two-way quantitative devigging, guarded EV calculation, and outlier classification."""

    model_config = ConfigDict(frozen=True)

    sharp_primary_odds: Decimal
    sharp_secondary_odds: Decimal
    offered_decimal_odds: Decimal
    offered_american_odds: int
    sharp_american_odds: int
    overround: Decimal
    fair_probability_mult: Decimal
    fair_probability_power: Decimal
    fair_probability: Decimal
    ev_mult: Decimal
    ev_power: Decimal
    guarded_ev: Decimal
    hit_rate_l10: Decimal | None = None
    status: PropStatus
    value_tier: ValueTier
    is_positive_ev: bool
    is_high_value: bool
    is_outlier: bool

    @property
    def offered_odds(self) -> Decimal:
        """Alias for offered_decimal_odds."""
        return self.offered_decimal_odds

    @property
    def is_suspect_stale_line(self) -> bool:
        """Return True when the Outlier Circuit Breaker stamped SUSPECT_STALE_LINE."""
        return self.status == "SUSPECT_STALE_LINE"


def evaluate_two_way_prop(
    sharp_primary_odds: Decimal | float | str | int,
    sharp_secondary_odds: Decimal | float | str | int,
    offered_odds: Decimal | float | str | int,
    hit_rate_l10: Decimal | float | str | int | None = None,
    *,
    hit_rate: Decimal | float | str | int | None = None,
    target_side: int = 0,
) -> PropDevigResult:
    """Evaluate a two-way prop market with Multiplicative + Power devigging and Outlier Circuit Breaker.

    - Computes P_{fair, mult} and P_{fair, power} (via Brent's root solver).
    - Computes EV_{mult} and EV_{power} where EV = (P_{fair} * D_{offered}) - 1.
    - Sets P_{fair} = min(P_{fair, mult}, P_{fair, power}) and EV_{guarded} = min(EV_{mult}, EV_{power}).
    - Stamps EV_{guarded} > 10.0% (0.10000) as `SUSPECT_STALE_LINE`.
    - Flags 1.5% <= EV_{guarded} <= 10.0% as positive value (`is_positive_ev = True`).
    - Upgrades 3.5% <= EV_{guarded} <= 10.0% with rolling hit rate >= 70% to `HIGH_VALUE`.
    """
    if target_side not in (0, 1):
        raise DeviggingError(
            f"target_side must be 0 or 1 (got {target_side}).",
            code="INVALID_MARKET_ODDS",
        )

    d_sharp_1 = _validate_decimal_odds(
        sharp_primary_odds, field_name="sharp_primary_odds"
    ).quantize(ODDS_QUANTIZE, rounding=ROUND_HALF_UP)
    d_sharp_2 = _validate_decimal_odds(
        sharp_secondary_odds, field_name="sharp_secondary_odds"
    ).quantize(ODDS_QUANTIZE, rounding=ROUND_HALF_UP)
    d_offered = _validate_decimal_odds(offered_odds, field_name="offered_odds").quantize(
        ODDS_QUANTIZE, rounding=ROUND_HALF_UP
    )

    resolved_hit_rate = _validate_hit_rate(
        hit_rate_l10 if hit_rate_l10 is not None else hit_rate,
        field_name="hit_rate_l10",
    )

    mult_p1_raw, mult_p2_raw, overround_raw = _compute_multiplicative_raw(d_sharp_1, d_sharp_2)
    pow_p1_raw, pow_p2_raw, _ = _compute_power_raw(d_sharp_1, d_sharp_2)

    p_mult_raw = mult_p1_raw if target_side == 0 else mult_p2_raw
    p_power_raw = pow_p1_raw if target_side == 0 else pow_p2_raw

    p_mult_q = _quantize_fair_prob(p_mult_raw)
    p_power_q = _quantize_fair_prob(p_power_raw)
    p_fair_q = min(p_mult_q, p_power_q)

    ev_mult_q = _quantize_ev((p_mult_raw * d_offered) - Decimal("1"))
    ev_power_q = _quantize_ev((p_power_raw * d_offered) - Decimal("1"))
    guarded_ev_q = min(ev_mult_q, ev_power_q)

    if guarded_ev_q > OUTLIER_EV_THRESHOLD:
        status: PropStatus = "SUSPECT_STALE_LINE"
        value_tier: ValueTier = "SUSPECT_STALE_LINE"
        is_positive_ev = False
        is_high_value = False
        is_outlier = True
    elif guarded_ev_q >= POSITIVE_EV_THRESHOLD:
        status = "ACTIVE"
        is_positive_ev = True
        is_outlier = False
        if (
            guarded_ev_q >= HIGH_VALUE_EV_THRESHOLD
            and resolved_hit_rate is not None
            and resolved_hit_rate >= HIGH_VALUE_HIT_RATE_THRESHOLD
        ):
            is_high_value = True
            value_tier = "HIGH_VALUE"
        else:
            is_high_value = False
            value_tier = "POSITIVE_VALUE"
    else:
        status = "ACTIVE"
        value_tier = "NEUTRAL"
        is_positive_ev = False
        is_high_value = False
        is_outlier = False

    target_sharp_odds = d_sharp_1 if target_side == 0 else d_sharp_2
    opposite_sharp_odds = d_sharp_2 if target_side == 0 else d_sharp_1

    return PropDevigResult(
        sharp_primary_odds=target_sharp_odds,
        sharp_secondary_odds=opposite_sharp_odds,
        offered_decimal_odds=d_offered,
        offered_american_odds=decimal_to_american(d_offered),
        sharp_american_odds=decimal_to_american(target_sharp_odds),
        overround=overround_raw.quantize(FAIR_PROB_QUANTIZE, rounding=ROUND_HALF_UP),
        fair_probability_mult=p_mult_q,
        fair_probability_power=p_power_q,
        fair_probability=p_fair_q,
        ev_mult=ev_mult_q,
        ev_power=ev_power_q,
        guarded_ev=guarded_ev_q,
        hit_rate_l10=resolved_hit_rate,
        status=status,
        value_tier=value_tier,
        is_positive_ev=is_positive_ev,
        is_high_value=is_high_value,
        is_outlier=is_outlier,
    )


class TwoWayPropMarketInput(BaseModel):
    """Normalized two-way player prop input payload for worker batch evaluation."""

    model_config = ConfigDict(extra="ignore")

    prop_id: uuid.UUID = Field(default_factory=uuid.uuid4)
    external_provider_id: str
    event_id: uuid.UUID = Field(default_factory=uuid.uuid4)
    team_id: uuid.UUID | None = None
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
    opposite_sharp_decimal_odds: Decimal = Field(
        ...,
        ge=MIN_DECIMAL_ODDS,
        le=MAX_DECIMAL_ODDS,
        allow_inf_nan=False,
    )
    hit_rate_l5: Decimal | None = Field(
        default=None,
        ge=Decimal("0"),
        le=Decimal("1"),
        allow_inf_nan=False,
    )
    hit_rate_l10: Decimal | None = Field(
        default=None,
        ge=Decimal("0"),
        le=Decimal("1"),
        allow_inf_nan=False,
    )
    hit_rate_season: Decimal | None = Field(
        default=None,
        ge=Decimal("0"),
        le=Decimal("1"),
        allow_inf_nan=False,
    )

    @model_validator(mode="before")
    @classmethod
    def normalize_ingestion_odds_aliases(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        normalized = dict(data)

        numeric_fields = (
            "line_value",
            "offered_decimal_odds",
            "sharp_decimal_odds",
            "opposite_sharp_decimal_odds",
            "hit_rate_l5",
            "hit_rate_l10",
            "hit_rate_season",
            "offered_odds",
            "offered_american_odds",
            "sharp_primary_odds",
            "sharp_over_odds",
            "sharp_odds",
            "sharp_american_odds",
            "sharp_secondary_odds",
            "sharp_under_odds",
            "opposite_sharp_odds",
            "opposite_sharp_american_odds",
        )
        for field_name in numeric_fields:
            if field_name in normalized and isinstance(normalized[field_name], bool):
                raise ValueError(
                    f"Boolean value is not permitted for numeric field '{field_name}'."
                )

        # Offered odds aliases & American conversion at ingestion boundary
        if "offered_decimal_odds" not in normalized or normalized["offered_decimal_odds"] is None:
            if "offered_odds" in normalized and normalized["offered_odds"] is not None:
                normalized["offered_decimal_odds"] = normalized["offered_odds"]
            elif (
                "offered_american_odds" in normalized
                and normalized["offered_american_odds"] is not None
            ):
                normalized["offered_decimal_odds"] = american_to_decimal(
                    normalized["offered_american_odds"]
                )

        # Primary sharp odds aliases & American conversion
        if "sharp_decimal_odds" not in normalized or normalized["sharp_decimal_odds"] is None:
            for alias in ("sharp_primary_odds", "sharp_over_odds", "sharp_odds"):
                if alias in normalized and normalized[alias] is not None:
                    normalized["sharp_decimal_odds"] = normalized[alias]
                    break
            else:
                if (
                    "sharp_american_odds" in normalized
                    and normalized["sharp_american_odds"] is not None
                ):
                    normalized["sharp_decimal_odds"] = american_to_decimal(
                        normalized["sharp_american_odds"]
                    )

        # Opposite sharp odds aliases & American conversion
        if (
            "opposite_sharp_decimal_odds" not in normalized
            or normalized["opposite_sharp_decimal_odds"] is None
        ):
            for alias in ("sharp_secondary_odds", "sharp_under_odds", "opposite_sharp_odds"):
                if alias in normalized and normalized[alias] is not None:
                    normalized["opposite_sharp_decimal_odds"] = normalized[alias]
                    break
            else:
                if (
                    "opposite_sharp_american_odds" in normalized
                    and normalized["opposite_sharp_american_odds"] is not None
                ):
                    normalized["opposite_sharp_decimal_odds"] = american_to_decimal(
                        normalized["opposite_sharp_american_odds"]
                    )

        return normalized

    @field_validator("external_provider_id")
    @classmethod
    def check_provider_prefix(cls, value: str) -> str:
        return _validate_provider_prefix(value)


class EvaluatedPropRecord(BaseModel):
    """Full audit record of an evaluated player prop market (including neutral and outlier props)."""

    model_config = ConfigDict(frozen=True)

    prop_id: uuid.UUID
    event_id: uuid.UUID
    external_provider_id: str
    sport_key: str
    player_name: str
    market_key: str
    selection: str
    line_value: Decimal | None = None
    offered_decimal_odds: Decimal
    sharp_decimal_odds: Decimal
    opposite_sharp_decimal_odds: Decimal
    offered_american_odds: int
    sharp_american_odds: int
    fair_probability_mult: Decimal
    fair_probability_power: Decimal
    fair_probability: Decimal
    ev_mult: Decimal
    ev_power: Decimal
    guarded_ev: Decimal
    hit_rate_l10: Decimal | None = None
    status: PropStatus
    value_tier: ValueTier
    is_positive_ev: bool
    is_high_value: bool
    is_outlier: bool


class BatchDevigResult(BaseModel):
    """Summary and feed payload produced by `process_and_publish_ev_props`."""

    model_config = ConfigDict(frozen=True)

    sport_key: str
    updated_at: str
    evaluated: list[EvaluatedPropRecord]
    published_items: list[EvaluatedPropFeedItem]
    outlier_count: int
    positive_ev_count: int
    high_value_count: int
    cached_payload: str


def process_and_publish_ev_props(
    sport_key: str,
    prop_markets: Sequence[TwoWayPropMarketInput | dict[str, Any]],
    redis_client: RedisLike | None = None,
    session: Session | None = None,
    *,
    ttl_seconds: int = HOT_CACHE_TTL_SECONDS,
) -> BatchDevigResult:
    """Devig a batch of two-way player props, persist telemetry to PostgreSQL, and cache +EV feed.

    - Stamps any market with EV_{guarded} > 10.0% as `SUSPECT_STALE_LINE` in PostgreSQL,
      logs the circuit-breaker trigger, and excludes it from `ev:feed:{sport_key}`.
    - Publishes only `ACTIVE` positive-EV markets (1.5% <= EV_{guarded} <= 10.0%) to
      `ev:feed:{sport_key}` with a strict 45-second TTL.
    """
    if isinstance(redis_client, Session) and not isinstance(session, Session):
        session, redis_client = redis_client, session  # type: ignore[assignment]

    validated_sport_key = _validate_sport_key(sport_key)

    parsed_inputs: list[TwoWayPropMarketInput] = [
        item
        if isinstance(item, TwoWayPropMarketInput)
        else TwoWayPropMarketInput.model_validate(item)
        for item in prop_markets
    ]

    evaluated_records: list[EvaluatedPropRecord] = []
    feed_items: list[EvaluatedPropFeedItem] = []
    outlier_count = 0
    positive_ev_count = 0
    high_value_count = 0
    now_utc = datetime.now(UTC)

    try:
        for market in parsed_inputs:
            existing_prop: PlayerProp | None = None
            if session is not None:
                existing_prop = session.scalar(
                    select(PlayerProp).where(
                        (PlayerProp.external_provider_id == market.external_provider_id)
                        | (PlayerProp.prop_id == market.prop_id)
                    )
                )

            effective_hit_rate_l10 = market.hit_rate_l10
            if effective_hit_rate_l10 is None and existing_prop is not None:
                effective_hit_rate_l10 = existing_prop.hit_rate_l10

            evaluation = evaluate_two_way_prop(
                sharp_primary_odds=market.sharp_decimal_odds,
                sharp_secondary_odds=market.opposite_sharp_decimal_odds,
                offered_odds=market.offered_decimal_odds,
                hit_rate_l10=effective_hit_rate_l10,
            )

            resolved_prop_id = (
                existing_prop.prop_id if existing_prop is not None else market.prop_id
            )
            resolved_event_id = (
                existing_prop.event_id if existing_prop is not None else market.event_id
            )

            if session is not None:
                if existing_prop is not None:
                    existing_prop.player_name = market.player_name
                    existing_prop.market_key = market.market_key
                    existing_prop.selection = market.selection
                    if market.team_id is not None:
                        existing_prop.team_id = market.team_id
                    existing_prop.offered_decimal_odds = evaluation.offered_decimal_odds
                    existing_prop.sharp_decimal_odds = evaluation.sharp_primary_odds
                    existing_prop.fair_probability = evaluation.fair_probability
                    existing_prop.guarded_ev = evaluation.guarded_ev
                    existing_prop.status = evaluation.status
                    existing_prop.updated_at = now_utc
                    if market.line_value is not None:
                        existing_prop.line_value = market.line_value
                    if market.hit_rate_l5 is not None:
                        existing_prop.hit_rate_l5 = market.hit_rate_l5
                    if evaluation.hit_rate_l10 is not None:
                        existing_prop.hit_rate_l10 = evaluation.hit_rate_l10
                    if market.hit_rate_season is not None:
                        existing_prop.hit_rate_season = market.hit_rate_season
                    session.flush()
                else:
                    new_prop = PlayerProp(
                        prop_id=resolved_prop_id,
                        external_provider_id=market.external_provider_id,
                        event_id=resolved_event_id,
                        team_id=market.team_id,
                        player_name=market.player_name,
                        market_key=market.market_key,
                        selection=market.selection,
                        line_value=market.line_value,
                        offered_decimal_odds=evaluation.offered_decimal_odds,
                        sharp_decimal_odds=evaluation.sharp_primary_odds,
                        fair_probability=evaluation.fair_probability,
                        guarded_ev=evaluation.guarded_ev,
                        hit_rate_l5=market.hit_rate_l5,
                        hit_rate_l10=evaluation.hit_rate_l10,
                        hit_rate_season=market.hit_rate_season,
                        status=evaluation.status,
                    )
                    session.add(new_prop)
                    session.flush()

            record = EvaluatedPropRecord(
                prop_id=resolved_prop_id,
                event_id=resolved_event_id,
                external_provider_id=market.external_provider_id,
                sport_key=validated_sport_key,
                player_name=market.player_name,
                market_key=market.market_key,
                selection=market.selection,
                line_value=market.line_value,
                offered_decimal_odds=evaluation.offered_decimal_odds,
                sharp_decimal_odds=evaluation.sharp_primary_odds,
                opposite_sharp_decimal_odds=evaluation.sharp_secondary_odds,
                offered_american_odds=evaluation.offered_american_odds,
                sharp_american_odds=evaluation.sharp_american_odds,
                fair_probability_mult=evaluation.fair_probability_mult,
                fair_probability_power=evaluation.fair_probability_power,
                fair_probability=evaluation.fair_probability,
                ev_mult=evaluation.ev_mult,
                ev_power=evaluation.ev_power,
                guarded_ev=evaluation.guarded_ev,
                hit_rate_l10=evaluation.hit_rate_l10,
                status=evaluation.status,
                value_tier=evaluation.value_tier,
                is_positive_ev=evaluation.is_positive_ev,
                is_high_value=evaluation.is_high_value,
                is_outlier=evaluation.is_outlier,
            )
            evaluated_records.append(record)

            if evaluation.is_outlier:
                outlier_count += 1
                logger.warning(
                    "Outlier Circuit Breaker triggered for prop %s (%s %s %s): guarded_ev=%s > %s; stamped SUSPECT_STALE_LINE and excluded from ev:feed:%s.",
                    market.external_provider_id,
                    market.player_name,
                    market.market_key,
                    market.selection,
                    evaluation.guarded_ev,
                    OUTLIER_EV_THRESHOLD,
                    validated_sport_key,
                )
                continue

            if evaluation.is_positive_ev and evaluation.status == "ACTIVE":
                positive_ev_count += 1
                if evaluation.is_high_value:
                    high_value_count += 1
                feed_items.append(
                    EvaluatedPropFeedItem(
                        prop_id=resolved_prop_id,
                        event_id=resolved_event_id,
                        external_provider_id=market.external_provider_id,
                        sport_key=validated_sport_key,
                        player_name=market.player_name,
                        market_key=market.market_key,
                        selection=market.selection,
                        line_value=market.line_value,
                        offered_decimal_odds=evaluation.offered_decimal_odds,
                        sharp_decimal_odds=evaluation.sharp_primary_odds,
                        opposite_sharp_decimal_odds=evaluation.sharp_secondary_odds,
                        offered_american_odds=evaluation.offered_american_odds,
                        sharp_american_odds=evaluation.sharp_american_odds,
                        fair_probability_mult=evaluation.fair_probability_mult,
                        fair_probability_power=evaluation.fair_probability_power,
                        fair_probability=evaluation.fair_probability,
                        guarded_ev=evaluation.guarded_ev,
                        hit_rate_l10=evaluation.hit_rate_l10,
                        status="ACTIVE",
                        value_tier="HIGH_VALUE" if evaluation.is_high_value else "POSITIVE_VALUE",
                        is_positive_ev=True,
                        is_high_value=evaluation.is_high_value,
                        updated_at=now_utc,
                    )
                )

        if session is not None:
            session.commit()
    except Exception:
        if session is not None:
            session.rollback()
        raise

    owns_redis = redis_client is None
    active_redis = redis_client if redis_client is not None else get_redis_client()
    try:
        cached_payload = cache_ev_feed(
            active_redis,
            validated_sport_key,
            feed_items,
            ttl_seconds=ttl_seconds,
        )
    finally:
        if owns_redis:
            close_fn = getattr(active_redis, "close", None)
            if callable(close_fn):
                close_fn()

    return BatchDevigResult(
        sport_key=validated_sport_key,
        updated_at=format_iso8601_utc(now_utc),
        evaluated=evaluated_records,
        published_items=feed_items,
        outlier_count=outlier_count,
        positive_ev_count=positive_ev_count,
        high_value_count=high_value_count,
        cached_payload=cached_payload,
    )
