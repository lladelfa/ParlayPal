"""Curated Preset Parlay Feed Engine with Conviction Micro-Copy and Hybrid Value Scoring."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, Field

from parlaypal_worker.hit_rate import build_recent_form_display, normalize_selection
from parlaypal_worker.models import Event, PlayerProp, Team

logger = logging.getLogger(__name__)


class PresetError(ValueError):
    """Domain error raised for preset parlay calculation and validation failures."""


def decimal_to_american(decimal_odds: Decimal) -> int:
    r"""Convert decimal odds ($D \ge 1.01$) to American odds ($+150, -110$).

    Args:
        decimal_odds: Decimal odds representation. Must be >= 1.01.

    Returns:
        Integer American odds representation (e.g., +485, -133).

    Raises:
        PresetError: If decimal odds < 1.01.
    """
    if decimal_odds < Decimal("1.01"):
        raise PresetError(f"Decimal odds must be >= 1.01, got {decimal_odds}")

    d_float = float(decimal_odds)
    if d_float >= 2.0:
        return int(round((d_float - 1.0) * 100))
    else:
        return int(round(-100 / (d_float - 1.0)))


def calculate_hybrid_value_score(
    avg_hit_rate_l10: Decimal | None,
    combined_ev: Decimal,
) -> int:
    """Calculate composite Hybrid Value Score (0–100 index) blending consistency and guarded EV.

    Formula:
        Score = clamp(0, 100, round(0.60 * HitRatePct + 0.40 * clamp(0, 100, (EV% * 10 + 50))))

    Args:
        avg_hit_rate_l10: Average L10 hit rate across legs (0.0 to 1.0), or None when no leg
            has real history (the score then uses the EV component only).
        combined_ev: Guarded expected value decimal (e.g. 0.042 for +4.2%).

    Returns:
        Integer score between 0 and 100.
    """
    ev_pct = float(combined_ev) * 100.0

    # EV component normalized: 0% EV -> 50, +5% EV -> 100, -5% EV -> 0
    ev_component = max(0.0, min(100.0, ev_pct * 10.0 + 50.0))

    if avg_hit_rate_l10 is None:
        composite = ev_component
    else:
        hit_pct = float(avg_hit_rate_l10) * 100.0
        composite = 0.60 * hit_pct + 0.40 * ev_component
    clamped_score = max(0, min(100, int(round(composite))))
    return clamped_score


def _generate_history_free_rationale(
    player_name: str,
    market_key: str,
    matchup: str,
    weather_badge_summary: str | None,
) -> str:
    """Rationale for legs without recent-form data: no past-performance claims."""
    key = market_key.lower()
    if "td" in key:
        subject = "anytime touchdown price"
    elif "pass" in key:
        subject = "passing line"
    elif "rush" in key:
        subject = "rushing line"
    elif "points" in key:
        subject = "scoring line"
    elif "rebounds" in key:
        subject = "rebounding line"
    elif "threes" in key:
        subject = "perimeter-shooting line"
    else:
        subject = "line"
    text = (
        f"{player_name}: limited recent-form history, so the {subject} "
        f"is judged on price and matchup in {matchup}"
    )
    if weather_badge_summary and "wind" in weather_badge_summary.lower():
        text += f" ({weather_badge_summary})"
    return text + "."


_UNDER_UNITS: dict[str, str] = {
    "player_pass_yds": "pass yds",
    "player_rush_yds": "rush yds",
    "player_points": "points",
    "player_rebounds": "rebounds",
    "player_threes": "threes",
}


def generate_conviction_rationale(
    player_name: str,
    market_key: str,
    matchup: str,
    hit_rate_formatted: str | None,
    weather_badge_summary: str | None = None,
    *,
    selection: str = "OVER",
    line_value: Decimal | None = None,
) -> str:
    """Generate concise 1-sentence plain-English conviction rationale.

    Args:
        player_name: Player name (e.g. 'Derrick Henry').
        market_key: Prop market key (e.g. 'player_anytime_td', 'player_points').
        matchup: Game matchup (e.g. 'BAL @ PIT').
        hit_rate_formatted: Formatted hit rate string (e.g. '7/10 (70.0%)'). When None, the
            rationale makes no claim about past performance.
        weather_badge_summary: Optional weather context summary (e.g. '⚠️ 19mph Wind').

    Returns:
        1-sentence plain-English conviction statement.
    """
    if hit_rate_formatted is None:
        return _generate_history_free_rationale(
            player_name, market_key, matchup, weather_badge_summary
        )
    is_td = "td" in market_key.lower()
    if not is_td and normalize_selection(selection) == "UNDER":
        parts = [f"{line_value:.1f}" if line_value is not None else ""]
        parts.append(_UNDER_UNITS.get(market_key.lower(), ""))
        target = " ".join(p for p in parts if p)
        target = f"{target} " if target else ""
        return (
            f"{player_name} stayed under {target}in "
            f"{hit_rate_formatted}; price and matchup in {matchup} set the angle."
        )
    if is_td:
        if weather_badge_summary and "wind" in weather_badge_summary.lower():
            return (
                f"{player_name} has scored a touchdown in {hit_rate_formatted}; strong ground-game script "
                f"expected in {matchup} ({weather_badge_summary})."
            )
        return (
            f"{player_name} has scored a touchdown in {hit_rate_formatted}; red-zone focal point "
            f"in high-leverage {matchup} matchup."
        )
    elif "pass" in market_key.lower():
        if weather_badge_summary and "wind" in weather_badge_summary.lower():
            return (
                f"{player_name} cleared passing line in {hit_rate_formatted}; weather threat "
                f"({weather_badge_summary}) elevates short-yardage target volume in {matchup}."
            )
        return (
            f"{player_name} cleared passing mark in {hit_rate_formatted}; "
            f"averaging high-volume attempts heading into {matchup}."
        )
    elif "rush" in market_key.lower():
        return (
            f"{player_name} surpassed rushing line in {hit_rate_formatted}; "
            f"heavy touch volume established heading into {matchup}."
        )
    elif "points" in market_key.lower():
        return (
            f"{player_name} surpassed scoring target in {hit_rate_formatted}; "
            f"commanding primary offensive usage in {matchup}."
        )
    elif "rebounds" in market_key.lower():
        return (
            f"{player_name} secured rebound target in {hit_rate_formatted}; "
            f"consistently cleaning the glass heading into {matchup}."
        )
    elif "threes" in market_key.lower():
        return (
            f"{player_name} sank perimeter target in {hit_rate_formatted}; "
            f"high-efficiency catch-and-shoot volume in {matchup}."
        )
    else:
        return (
            f"{player_name} satisfied line in {hit_rate_formatted}; "
            f"reliable statistical trajectory leading into {matchup}."
        )


class PresetLeg(BaseModel):
    """Individual player prop leg within a curated preset card."""

    prop_id: uuid.UUID
    event_id: uuid.UUID
    player_name: str
    team_abbreviation: str = "TBD"
    matchup: str
    market_key: str
    market_display: str
    selection: str = "OVER"
    line_value: Decimal | None = None
    offered_decimal_odds: Decimal
    offered_american_odds: int
    sharp_decimal_odds: Decimal | None = None
    sharp_american_odds: int | None = None
    fair_probability: Decimal
    guarded_ev: Decimal
    hit_rate_l5: Decimal | None = None
    hit_rate_l10: Decimal | None = None
    hit_rate_season: Decimal | None = None
    hit_rate_display: str | None = None
    sofascore_form: list[bool] = Field(default_factory=list)
    sofascore_dots: str = ""
    weather_badge: dict[str, Any] | None = None
    conviction_rationale: str


class CombinedParlayResult(BaseModel):
    """Priced multi-leg parlay mathematical evaluation."""

    combined_decimal_odds: Decimal
    combined_american_odds: int
    combined_fair_probability: Decimal
    combined_ev: Decimal


def calculate_combined_parlay(legs: list[PresetLeg]) -> CombinedParlayResult:
    """Calculate independent joint probability and payout for cross-game parlay legs.

    Args:
        legs: List of PresetLeg instances.

    Returns:
        CombinedParlayResult containing decimal odds, American odds, fair prob, and EV.
    """
    if not legs:
        raise PresetError("Cannot calculate combined parlay for empty legs list")

    combined_decimal = Decimal("1.0000")
    combined_fair_prob = Decimal("1.00000")

    for leg in legs:
        combined_decimal *= leg.offered_decimal_odds
        combined_fair_prob *= leg.fair_probability

    # Quantize
    combined_decimal = combined_decimal.quantize(Decimal("0.0001"))
    combined_fair_prob = combined_fair_prob.quantize(Decimal("0.00001"))

    # EV = (P_fair * D_offered) - 1
    combined_ev = ((combined_fair_prob * combined_decimal) - Decimal("1.0")).quantize(
        Decimal("0.0001")
    )
    combined_american = decimal_to_american(combined_decimal)

    return CombinedParlayResult(
        combined_decimal_odds=combined_decimal,
        combined_american_odds=combined_american,
        combined_fair_probability=combined_fair_prob,
        combined_ev=combined_ev,
    )


class PresetCard(BaseModel):
    """Curated preset parlay card with 2 to 4 legs."""

    preset_id: uuid.UUID
    title: str
    sport_key: str
    theme_badge: str
    legs: list[PresetLeg]
    combined_decimal_odds: Decimal
    combined_american_odds: int
    combined_fair_probability: Decimal
    combined_ev: Decimal
    hybrid_value_score: int
    status: str = "ACTIVE"
    commence_time: datetime
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @classmethod
    def create(
        cls,
        preset_id: uuid.UUID,
        title: str,
        sport_key: str,
        theme_badge: str,
        legs: list[PresetLeg],
        commence_time: datetime | None = None,
        status: str = "ACTIVE",
    ) -> PresetCard:
        """Create and price a curated preset card enforcing 2 to 4 legs invariant."""
        if len(legs) < 2 or len(legs) > 4:
            raise PresetError(
                f"Curated preset card must have between 2 and 4 legs, got {len(legs)}"
            )

        math_result = calculate_combined_parlay(legs)

        # Average L10 hit rate across legs with real history only (None when no leg has any)
        l10_rates = [float(leg.hit_rate_l10) for leg in legs if leg.hit_rate_l10 is not None]
        avg_l10 = Decimal(str(sum(l10_rates) / len(l10_rates))) if l10_rates else None

        hybrid_score = calculate_hybrid_value_score(
            avg_hit_rate_l10=avg_l10,
            combined_ev=math_result.combined_ev,
        )

        earliest_commence = commence_time if commence_time is not None else datetime.now(UTC)

        return cls(
            preset_id=preset_id,
            title=title,
            sport_key=sport_key,
            theme_badge=theme_badge,
            legs=legs,
            combined_decimal_odds=math_result.combined_decimal_odds,
            combined_american_odds=math_result.combined_american_odds,
            combined_fair_probability=math_result.combined_fair_probability,
            combined_ev=math_result.combined_ev,
            hybrid_value_score=hybrid_score,
            status=status,
            commence_time=earliest_commence,
        )


class CuratedPresetFeed(BaseModel):
    """Container holding active curated preset parlay cards."""

    generated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    cards: list[PresetCard] = Field(default_factory=list)


def _format_market_display(market_key: str, line_value: Decimal | None, selection: str) -> str:
    """Format human-readable prop line display."""
    key = market_key.lower()
    val_str = f"{line_value:.1f}" if line_value is not None else ""
    if "td" in key:
        return "Anytime Touchdown"
    elif "pass" in key:
        return f"{selection.capitalize()} {val_str} Pass Yds"
    elif "rush" in key:
        return f"{selection.capitalize()} {val_str} Rush Yds"
    elif "points" in key:
        return f"{selection.capitalize()} {val_str} Points"
    elif "rebounds" in key:
        return f"{selection.capitalize()} {val_str} Rebounds"
    elif "threes" in key:
        return f"{selection.capitalize()} {val_str} Threes"
    return f"{selection.capitalize()} {val_str} {market_key}"


def generate_curated_presets(
    props: list[PlayerProp],
    events_map: dict[uuid.UUID, Event],
    teams_map: dict[uuid.UUID, Team] | None = None,
    target_count: int = 3,
    now_utc: datetime | None = None,
) -> CuratedPresetFeed:
    """Generate 3 to 5 curated preset cards filtering stale lines and commenced games.

    Args:
        props: Available candidate PlayerProp records.
        events_map: Map of event_id to Event entity.
        teams_map: Optional map of team_id to Team entity.
        target_count: Target number of preset cards (default 3, max 5).
        now_utc: Reference time for commenced game checking.

    Returns:
        CuratedPresetFeed containing 3 to 5 curated PresetCard items.
    """
    ref_time = now_utc if now_utc is not None else datetime.now(UTC)
    teams = teams_map or {}

    # 1. Filter eligible props:
    # - Not suspended, not settled
    # - Outlier breaker: status != "SUSPECT_STALE_LINE" and guarded_ev <= 0.10
    # - Game not commenced: event exists, status != "LIVE", commence_time > ref_time
    # - Fair probability and guarded EV present
    clean_candidates: list[tuple[PlayerProp, Event]] = []
    for prop in props:
        if prop.status in ("SUSPECT_STALE_LINE", "SUSPENDED", "SETTLED"):
            continue
        if prop.guarded_ev is not None and prop.guarded_ev > Decimal("0.1000"):
            continue
        if prop.fair_probability is None or prop.offered_decimal_odds < Decimal("1.01"):
            continue

        event = events_map.get(prop.event_id)
        if not event:
            continue
        if event.status in ("LIVE", "FINAL", "CANCELLED", "POSTPONED"):
            continue
        if event.commence_time <= ref_time:
            continue

        clean_candidates.append((prop, event))

    # Sort clean candidates by descending guarded EV and hit rate
    clean_candidates.sort(
        key=lambda item: (
            item[0].guarded_ev or Decimal("0.0"),
            item[0].hit_rate_l10 if item[0].hit_rate_l10 is not None else Decimal("-1"),
        ),
        reverse=True,
    )

    # Convert candidates to PresetLeg instances
    legs_by_sport: dict[str, list[tuple[PresetLeg, datetime]]] = {"nfl": [], "nba": []}

    for prop, event in clean_candidates:
        sport = "nfl" if "nfl" in event.sport_key.lower() else "nba"

        # Resolve team abbreviations and matchup
        home_team = teams.get(event.home_team_id)
        away_team = teams.get(event.away_team_id)
        home_abbr = home_team.abbreviation if home_team else "HOME"
        away_abbr = away_team.abbreviation if away_team else "AWAY"
        matchup = f"{away_abbr} @ {home_abbr}"

        # Resolve player team
        prop_team = teams.get(prop.team_id) if prop.team_id else None
        team_abbr = prop_team.abbreviation if prop_team else away_abbr

        # Format hit rates (a missing hit rate stays missing; never invent one)
        hit_display, form_bools, dots = build_recent_form_display(
            prop.hit_rate_l10, prop.recent_outcomes
        )

        # Weather badge
        weather_badge = None
        if event.is_dome:
            weather_badge = {"badge_type": "DOME", "summary": "DOME Indoor", "is_threat": False}
        elif event.weather_wind_mph is not None and event.weather_wind_mph >= Decimal("15.0"):
            weather_badge = {
                "badge_type": "WIND_WARNING",
                "summary": f"⚠️ {event.weather_wind_mph:.0f}mph Wind",
                "is_threat": True,
            }
        elif event.weather_precip_prob is not None and event.weather_precip_prob >= Decimal("50.0"):
            weather_badge = {
                "badge_type": "PRECIP_WARNING",
                "summary": f"🌧️ {event.weather_precip_prob:.0f}% Precip",
                "is_threat": True,
            }

        market_display = _format_market_display(prop.market_key, prop.line_value, prop.selection)
        weather_summary_str = (
            str(weather_badge["summary"]) if weather_badge and "summary" in weather_badge else None
        )
        rationale = generate_conviction_rationale(
            player_name=prop.player_name,
            market_key=prop.market_key,
            matchup=matchup,
            hit_rate_formatted=hit_display,
            weather_badge_summary=weather_summary_str,
            selection=prop.selection,
            line_value=prop.line_value,
        )

        assert prop.fair_probability is not None
        preset_leg = PresetLeg(
            prop_id=prop.prop_id,
            event_id=prop.event_id,
            player_name=prop.player_name,
            team_abbreviation=team_abbr,
            matchup=matchup,
            market_key=prop.market_key,
            market_display=market_display,
            selection=prop.selection,
            line_value=prop.line_value,
            offered_decimal_odds=prop.offered_decimal_odds,
            offered_american_odds=decimal_to_american(prop.offered_decimal_odds),
            sharp_decimal_odds=prop.sharp_decimal_odds,
            sharp_american_odds=decimal_to_american(prop.sharp_decimal_odds)
            if prop.sharp_decimal_odds
            else None,
            fair_probability=prop.fair_probability,
            guarded_ev=prop.guarded_ev or Decimal("0.0200"),
            hit_rate_l5=prop.hit_rate_l5,
            hit_rate_l10=prop.hit_rate_l10,
            hit_rate_season=prop.hit_rate_season,
            hit_rate_display=hit_display,
            sofascore_form=form_bools,
            sofascore_dots=dots,
            weather_badge=weather_badge,
            conviction_rationale=rationale,
        )
        legs_by_sport[sport].append((preset_leg, event.commence_time))

    # Theme templates
    nfl_themes = [
        ("The Red Zone Express", "NFL · 2-Leg Anytime TD"),
        ("Prime Time Aerial Attack", "NFL · 3-Leg Passing & Receiving"),
        ("Sunday Ground & Pound", "NFL · 2-Leg Rushing Surge"),
    ]
    nba_themes = [
        ("The Floor Generals", "NBA · 2-Leg Playmakers"),
        ("Downtown Splash", "NBA · 3-Leg Perimeter Snipers"),
        ("Glass Cleaners", "NBA · 2-Leg Rebound Specialists"),
    ]

    cards: list[PresetCard] = []

    # Assemble cards alternating sports or grouping
    all_legs = legs_by_sport["nfl"] + legs_by_sport["nba"]
    if not all_legs:
        return CuratedPresetFeed(generated_at=ref_time, cards=[])

    # Build up to 5 cards (min 3)
    theme_idx = 0
    all_themes = nfl_themes + nba_themes

    for theme_title, theme_badge in all_themes:
        sport = "nfl" if "nfl" in theme_badge.lower() else "nba"
        candidates = legs_by_sport[sport]
        if len(candidates) < 2:
            # If not enough for this specific sport, borrow from general pool if available
            candidates = all_legs

        if len(candidates) < 2:
            continue

        # Select 2 to 3 distinct legs
        leg_count = 2 if len(candidates) < 3 else 3
        # Rotate selection to avoid identical cards
        start_idx = (theme_idx * 2) % len(candidates)
        selected_pairs = [candidates[(start_idx + i) % len(candidates)] for i in range(leg_count)]

        card_legs = [p[0] for p in selected_pairs]
        if not any(leg.hit_rate_l10 is not None for leg in card_legs):
            logger.info("Skipping preset %r: no leg has real hit-rate history", theme_title)
            theme_idx += 1
            continue
        earliest_time = min(p[1] for p in selected_pairs)

        card = PresetCard.create(
            preset_id=uuid.uuid4(),
            title=theme_title,
            sport_key=sport,
            theme_badge=theme_badge,
            legs=card_legs,
            commence_time=earliest_time,
        )
        cards.append(card)
        theme_idx += 1

        if len(cards) >= max(3, min(5, target_count)):
            break

    return CuratedPresetFeed(generated_at=ref_time, cards=cards)


def sync_preset_feed_to_redis(
    feed: CuratedPresetFeed,
    redis_client: Any,
    ttl_seconds: int = 45,
) -> None:
    """Serialize CuratedPresetFeed and write to Redis hot (45s) and snapshot (24h) keys.

    Writes to:
    - `presets:feed:all`, `presets:feed:nfl`, `presets:feed:nba`
    - `presets:feed:snapshot:all`, `presets:feed:snapshot:nfl`, `presets:feed:snapshot:nba`
    """
    snapshot_ttl = max(ttl_seconds, 86400)
    slices: tuple[tuple[str, CuratedPresetFeed], ...] = (
        ("all", feed),
        (
            "nfl",
            CuratedPresetFeed(
                generated_at=feed.generated_at,
                cards=[c for c in feed.cards if c.sport_key == "nfl"],
            ),
        ),
        (
            "nba",
            CuratedPresetFeed(
                generated_at=feed.generated_at,
                cards=[c for c in feed.cards if c.sport_key == "nba"],
            ),
        ),
    )
    for suffix, slice_feed in slices:
        serialized = slice_feed.model_dump_json()
        redis_client.set(f"presets:feed:{suffix}", serialized, ex=ttl_seconds)
        redis_client.set(f"presets:feed:snapshot:{suffix}", serialized, ex=snapshot_ttl)
