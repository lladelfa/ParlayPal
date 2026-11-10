"""Same-Game Parlay (SGP) pricing engine, correlation modeling, and Redis hot-cache auditing."""

from __future__ import annotations

import logging
import math
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import httpx
from pydantic import BaseModel, Field, field_validator

from parlaypal_worker.config import get_settings
from parlaypal_worker.presets import decimal_to_american
from parlaypal_worker.redis_client import (
    HOT_CACHE_TTL_SECONDS,
    RedisLike,
    cache_sgp_audit,
    format_iso8601_utc,
)

logger = logging.getLogger(__name__)


class SgpLegSelection(BaseModel):
    """Single leg selection submitted for Same-Game Parlay evaluation."""

    prop_id: str
    player_name: str
    team_abbreviation: str = "TBD"
    market_key: str
    selection: str = "OVER"
    line_value: Decimal | None = None
    offered_decimal_odds: Decimal
    fair_probability: Decimal

    @field_validator("prop_id", mode="before")
    @classmethod
    def serialize_prop_id(cls, v: Any) -> str:
        return str(v)

    @field_validator("offered_decimal_odds", mode="before")
    @classmethod
    def parse_decimal_odds(cls, v: Any) -> Decimal:
        return Decimal(str(v))

    @field_validator("fair_probability", mode="before")
    @classmethod
    def parse_fair_prob(cls, v: Any) -> Decimal:
        return Decimal(str(v))


class SgpAuditItem(BaseModel):
    """Pairwise correlation audit record between two legs of the same game."""

    leg_a_prop_id: str
    leg_b_prop_id: str
    leg_a_description: str
    leg_b_description: str
    correlation_coefficient: Decimal
    synergy_type: str = "neutral"  # "positive" | "negative" | "neutral"
    rationale: str

    @field_validator("correlation_coefficient", mode="before")
    @classmethod
    def parse_corr(cls, v: Any) -> Decimal:
        return Decimal(str(v))


class SgpPriceResponse(BaseModel):
    """Full SGP pricing evaluation response."""

    event_id: str
    sport_key: str
    unadjusted_fair_probability: Decimal
    sgp_fair_probability: Decimal
    sgp_decimal_odds: Decimal
    sgp_american_odds: int
    has_positive_synergy: bool
    correlation_audit: list[SgpAuditItem] = Field(default_factory=list)
    is_same_game_parlay: bool = True
    source: str = "api"  # "api" | "heuristic" | "cache"
    timestamp: str = Field(default_factory=lambda: format_iso8601_utc(datetime.now(UTC)))

    @field_validator("event_id", mode="before")
    @classmethod
    def serialize_event_id(cls, v: Any) -> str:
        return str(v)


def estimate_pair_correlation(
    sport_key: str,
    leg_a: SgpLegSelection,
    leg_b: SgpLegSelection,
) -> tuple[Decimal, str, str]:
    """Estimate correlation coefficient, synergy type, and rationale from domain heuristic matrix."""
    sport = sport_key.lower()
    same_team = (
        leg_a.team_abbreviation != "TBD"
        and leg_b.team_abbreviation != "TBD"
        and leg_a.team_abbreviation.upper() == leg_b.team_abbreviation.upper()
    )

    m_a = leg_a.market_key.lower()
    m_b = leg_b.market_key.lower()
    sel_a = leg_a.selection.upper()
    sel_b = leg_b.selection.upper()

    # NFL heuristics
    if "nfl" in sport:
        is_pass_a = "pass" in m_a
        is_pass_b = "pass" in m_b
        is_rec_a = "rec" in m_a or "touchdown" in m_a or "td" in m_a
        is_rec_b = "rec" in m_b or "touchdown" in m_b or "td" in m_b
        is_rush_a = "rush" in m_a
        is_rush_b = "rush" in m_b

        if same_team:
            # QB Passing + Receiver Receiving/TD synergy
            if (is_pass_a and is_rec_b) or (is_pass_b and is_rec_a):
                if sel_a == "OVER" and sel_b == "OVER":
                    return (
                        Decimal("0.48"),
                        "positive",
                        "Teammates QB Passing + Receiver production exhibit strong positive synergy.",
                    )
                elif sel_a == "UNDER" and sel_b == "UNDER":
                    return (
                        Decimal("0.40"),
                        "positive",
                        "Under passing volume correlates with under receiver production.",
                    )
            # QB Passing + RB Rushing volume competition
            if (is_pass_a and is_rush_b) or (is_pass_b and is_rush_a):
                if sel_a == "OVER" and sel_b == "OVER":
                    return (
                        Decimal("-0.15"),
                        "negative",
                        "Passing volume and rushing attempts often compete for team offensive possession shares.",
                    )
        else:
            # Opposing running backs
            if is_rush_a and is_rush_b and sel_a == "OVER" and sel_b == "OVER":
                return (
                    Decimal("-0.25"),
                    "negative",
                    "Opposing run games compete for possession time and game script dominance.",
                )

    # NBA heuristics
    elif "nba" in sport:
        is_ast_a = "assist" in m_a
        is_ast_b = "assist" in m_b
        is_pts_a = "point" in m_a or "three" in m_a
        is_pts_b = "point" in m_b or "three" in m_b
        is_reb_a = "rebound" in m_a
        is_reb_b = "rebound" in m_b

        if same_team:
            if (is_ast_a and is_pts_b) or (is_ast_b and is_pts_a):
                if sel_a == "OVER" and sel_b == "OVER":
                    return (
                        Decimal("0.35"),
                        "positive",
                        "Playmaker assist volume directly feeds teammate scoring opportunities.",
                    )
            if is_pts_a and is_pts_b and sel_a == "OVER" and sel_b == "OVER":
                return (
                    Decimal("-0.12"),
                    "negative",
                    "Teammates share the same team possession and usage ceiling.",
                )
            if is_reb_a and is_reb_b and sel_a == "OVER" and sel_b == "OVER":
                return (
                    Decimal("-0.18"),
                    "negative",
                    "Teammates directly compete for rebound opportunities.",
                )

    return (
        Decimal("0.00"),
        "neutral",
        "No significant intra-game correlation detected between selections.",
    )


def calculate_heuristic_sgp(
    event_id: str,
    sport_key: str,
    legs: list[SgpLegSelection],
) -> SgpPriceResponse:
    """Compute correlation-adjusted fair price using empirical pairwise correlation matrices."""
    if not legs:
        raise ValueError("Cannot calculate SGP for empty legs.")

    combined_decimal = Decimal("1.0000")
    unadjusted_fair_prob = Decimal("1.00000")

    for leg in legs:
        combined_decimal *= leg.offered_decimal_odds
        unadjusted_fair_prob *= leg.fair_probability

    audit_items: list[SgpAuditItem] = []
    total_delta = Decimal("0.00000")
    pair_count = 0

    n = len(legs)
    for i in range(n):
        for j in range(i + 1, n):
            leg_a = legs[i]
            leg_b = legs[j]
            corr, synergy, rationale = estimate_pair_correlation(sport_key, leg_a, leg_b)

            desc_a = f"{leg_a.player_name} {leg_a.selection} {leg_a.market_key}"
            desc_b = f"{leg_b.player_name} {leg_b.selection} {leg_b.market_key}"

            audit_items.append(
                SgpAuditItem(
                    leg_a_prop_id=leg_a.prop_id,
                    leg_b_prop_id=leg_b.prop_id,
                    leg_a_description=desc_a,
                    leg_b_description=desc_b,
                    correlation_coefficient=corr,
                    synergy_type=synergy,
                    rationale=rationale,
                )
            )

            p_a = float(leg_a.fair_probability)
            p_b = float(leg_b.fair_probability)
            var_term = math.sqrt(p_a * (1.0 - p_a) * p_b * (1.0 - p_b))
            delta = float(corr) * var_term
            total_delta += Decimal(str(delta))
            pair_count += 1

    if pair_count > 0:
        avg_delta = total_delta / Decimal(str(pair_count))
    else:
        avg_delta = Decimal("0.0")

    # Adjusted fair prob
    raw_adjusted = unadjusted_fair_prob + avg_delta

    # Bound safely within [0.0001, min(fair_prob) - 0.0001]
    min_leg_prob = min(leg.fair_probability for leg in legs)
    upper_bound = max(Decimal("0.0002"), min_leg_prob - Decimal("0.00001"))
    sgp_fair_prob = max(Decimal("0.0001"), min(raw_adjusted, upper_bound))

    # Positive synergy strictly requires adjusted prob > unadjusted AND correlation synergy detected
    has_positive_synergy = sgp_fair_prob > unadjusted_fair_prob and any(
        item.correlation_coefficient > Decimal("0.10") for item in audit_items
    )

    combined_decimal_quant = combined_decimal.quantize(Decimal("0.0001"))
    unadjusted_quant = unadjusted_fair_prob.quantize(Decimal("0.00001"))
    sgp_fair_quant = sgp_fair_prob.quantize(Decimal("0.00001"))
    american_odds = decimal_to_american(combined_decimal_quant)

    return SgpPriceResponse(
        event_id=event_id,
        sport_key=sport_key,
        unadjusted_fair_probability=unadjusted_quant,
        sgp_fair_probability=sgp_fair_quant,
        sgp_decimal_odds=combined_decimal_quant,
        sgp_american_odds=american_odds,
        has_positive_synergy=has_positive_synergy,
        correlation_audit=audit_items,
        is_same_game_parlay=True,
        source="heuristic",
    )


def price_sgp(
    event_id: str,
    sport_key: str,
    legs: list[SgpLegSelection],
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    http_client: httpx.Client | None = None,
    redis_client: RedisLike | None = None,
    ttl_seconds: int = HOT_CACHE_TTL_SECONDS,
) -> SgpPriceResponse:
    """Evaluate SGP pricing and correlation against ParlayAPI /v1/sgp/price with heuristic fallback.

    Persists audit result to Redis hot cache at `sgp:audit:{event_id}`.
    """
    settings = get_settings()
    resolved_api_key = api_key if api_key is not None else settings.parlay_api_key
    resolved_base_url = base_url if base_url is not None else settings.parlay_api_base_url

    response: SgpPriceResponse | None = None

    if resolved_api_key:
        url = f"{resolved_base_url.rstrip('/')}/sgp/price"
        headers = {
            "Authorization": f"Bearer {resolved_api_key}",
            "Content-Type": "application/json",
        }
        body = {
            "event_id": str(event_id),
            "sport_key": sport_key,
            "legs": [
                {
                    "prop_id": str(leg.prop_id),
                    "player_name": leg.player_name,
                    "team_abbreviation": leg.team_abbreviation,
                    "market_key": leg.market_key,
                    "selection": leg.selection,
                    "offered_decimal_odds": float(leg.offered_decimal_odds),
                    "fair_probability": float(leg.fair_probability),
                    "line_value": float(leg.line_value) if leg.line_value is not None else None,
                }
                for leg in legs
            ],
        }

        try:
            client = http_client if http_client is not None else httpx.Client(timeout=5.0)
            owns_client = http_client is None
            try:
                res = client.post(url, headers=headers, json=body)
                if res.status_code == 200:
                    data = res.json()
                    sgp_fair_prob = Decimal(str(data.get("sgp_fair_prob", "0.25000")))
                    unadjusted_prob = Decimal(str(data.get("unadjusted_prob", "0.25000")))

                    # Parse correlation audit items
                    audit_items: list[SgpAuditItem] = []
                    for item in data.get("correlation_audit", []):
                        corr_val = Decimal(str(item.get("correlation_coefficient", "0.0")))
                        impact = str(item.get("impact", "")).lower()
                        synergy = (
                            "positive"
                            if "pos" in impact or corr_val > 0
                            else ("negative" if "neg" in impact or corr_val < 0 else "neutral")
                        )
                        audit_items.append(
                            SgpAuditItem(
                                leg_a_prop_id=item.get(
                                    "leg_a_prop_id", legs[0].prop_id if legs else ""
                                ),
                                leg_b_prop_id=item.get(
                                    "leg_b_prop_id", legs[1].prop_id if len(legs) > 1 else ""
                                ),
                                leg_a_description=item.get("leg_1", "Leg 1"),
                                leg_b_description=item.get("leg_2", "Leg 2"),
                                correlation_coefficient=corr_val,
                                synergy_type=synergy,
                                rationale=item.get(
                                    "rationale", f"Correlation coefficient {corr_val}"
                                ),
                            )
                        )

                    combined_decimal = Decimal("1.0000")
                    for leg in legs:
                        combined_decimal *= leg.offered_decimal_odds
                    combined_decimal_quant = combined_decimal.quantize(Decimal("0.0001"))
                    american_odds = decimal_to_american(combined_decimal_quant)

                    has_pos_synergy = sgp_fair_prob > unadjusted_prob and (
                        any(a.correlation_coefficient > Decimal("0.10") for a in audit_items)
                        or len(audit_items) == 0
                    )

                    response = SgpPriceResponse(
                        event_id=str(event_id),
                        sport_key=sport_key,
                        unadjusted_fair_probability=unadjusted_prob.quantize(Decimal("0.00001")),
                        sgp_fair_probability=sgp_fair_prob.quantize(Decimal("0.00001")),
                        sgp_decimal_odds=combined_decimal_quant,
                        sgp_american_odds=american_odds,
                        has_positive_synergy=has_pos_synergy,
                        correlation_audit=audit_items,
                        is_same_game_parlay=True,
                        source="api",
                    )
                else:
                    logger.warning(
                        "ParlayAPI /v1/sgp/price returned status %s for event %s. Using heuristic fallback.",
                        res.status_code,
                        event_id,
                    )
            finally:
                if owns_client:
                    client.close()
        except Exception as exc:
            logger.warning(
                "ParlayAPI SGP request failed for event %s (%s). Using heuristic fallback.",
                event_id,
                exc,
            )

    # Heuristic fallback if API was not called or failed
    if response is None:
        response = calculate_heuristic_sgp(
            event_id=str(event_id),
            sport_key=sport_key,
            legs=legs,
        )

    # Cache in Redis hot cache sgp:audit:{event_id} with 45-second TTL
    if redis_client is not None:
        try:
            cache_sgp_audit(
                client=redis_client,
                event_id=event_id,
                audit_data=response.model_dump(mode="json"),
                ttl_seconds=ttl_seconds,
            )
        except Exception as exc:
            logger.warning("Failed to cache SGP audit to Redis for event %s: %s", event_id, exc)

    return response
