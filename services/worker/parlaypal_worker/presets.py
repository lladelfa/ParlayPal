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


_MARKET_UNITS: dict[str, str] = {
    "player_pass_yds": "pass yds",
    "player_rush_yds": "rush yds",
    "player_points": "points",
    "player_rebounds": "rebounds",
    "player_threes": "threes",
    "player_pass_tds": "pass TDs",
}

_LONG_SHOT_THRESHOLD = Decimal("0.10")


def _is_anytime_td(market_key: str) -> bool:
    key = market_key.lower()
    return "anytime" in key and "td" in key


def _format_american(decimal_odds: Decimal | None) -> str | None:
    """Format decimal odds as a signed American price, or None when unusable."""
    if decimal_odds is None or decimal_odds < Decimal("1.01"):
        return None
    return f"{decimal_to_american(decimal_odds):+d}"


def _format_fair_american(fair_probability: Decimal | None) -> str | None:
    """Format the devigged fair price (American) derived from a fair probability."""
    if fair_probability is None or fair_probability <= 0 or fair_probability >= 1:
        return None
    return _format_american(Decimal(1) / fair_probability)


def _format_ev(guarded_ev: Decimal | None) -> str | None:
    if guarded_ev is None:
        return None
    return f"{float(guarded_ev) * 100:+.1f}%"


def _weather_suffix(weather_badge_summary: str | None) -> str:
    if weather_badge_summary:
        lowered = weather_badge_summary.lower()
        if "wind" in lowered or "precip" in lowered:
            return f" ({weather_badge_summary})"
    return ""


def _line_target(market_key: str, line_value: Decimal | None) -> str:
    parts = [f"{line_value:.1f}" if line_value is not None else ""]
    parts.append(_MARKET_UNITS.get(market_key.lower(), ""))
    return " ".join(p for p in parts if p) or "the line"


def _market_label(market_key: str, selection: str, line_value: Decimal | None) -> str:
    if _is_anytime_td(market_key):
        return "anytime TD"
    side = "Under" if normalize_selection(selection) == "UNDER" else "Over"
    unit = _MARKET_UNITS.get(market_key.lower(), "")
    parts = [side, f"{line_value:.1f}" if line_value is not None else "", unit]
    return " ".join(p for p in parts if p) if (line_value is not None or unit) else "prop"


def generate_conviction_rationale(
    player_name: str,
    market_key: str,
    matchup: str,
    hit_rate_formatted: str | None,
    weather_badge_summary: str | None = None,
    *,
    selection: str = "OVER",
    line_value: Decimal | None = None,
    fair_probability: Decimal | None = None,
    offered_decimal_odds: Decimal | None = None,
    guarded_ev: Decimal | None = None,
) -> str:
    """Generate a one-sentence rationale built only from data present on the leg.

    Args:
        player_name: Player name (e.g. 'Derrick Henry').
        market_key: Prop market key (e.g. 'player_anytime_td', 'player_points').
        matchup: Game matchup (e.g. 'BAL @ PIT').
        hit_rate_formatted: Formatted hit rate (e.g. '7/10 (70.0%) L10'); None when unknown.
        weather_badge_summary: Optional weather badge text, quoted verbatim for wind/precip.
        selection: OVER or UNDER.
        line_value: Prop line.
        fair_probability: Devigged fair probability, when known.
        offered_decimal_odds: Offered decimal price, when known.
        guarded_ev: Raw guarded EV (fraction), when known.

    Returns:
        1-sentence statement citing only the supplied facts. A long shot (fair probability
        below 10%) intentionally omits the hit rate even when history exists. The matchup is
        cited only on the no-hit-rate / long-shot path. Weather badges are quoted verbatim
        for wind and precipitation only; other badges (e.g. DOME) are suppressed.
    """
    offered = _format_american(offered_decimal_odds)
    fair = _format_fair_american(fair_probability)
    ev = _format_ev(guarded_ev)
    weather = _weather_suffix(weather_badge_summary)
    long_shot = fair_probability is not None and fair_probability < _LONG_SHOT_THRESHOLD

    if offered and fair:
        price = f"{offered} offered vs {fair} fair"
    elif offered:
        price = f"{offered} offered"
    elif fair:
        price = f"{fair} fair"
    else:
        price = ""

    if hit_rate_formatted is not None and not long_shot:
        if _is_anytime_td(market_key):
            text = f"{player_name} scored in {hit_rate_formatted}"
        elif normalize_selection(selection) == "UNDER":
            text = (
                f"{player_name} stayed under {_line_target(market_key, line_value)} "
                f"in {hit_rate_formatted}"
            )
        else:
            text = (
                f"{player_name} cleared {_line_target(market_key, line_value)} "
                f"in {hit_rate_formatted}"
            )
        if price:
            text += f"; {price}"
        if ev:
            text += f" ({ev} EV)" if price else f"; {ev} EV"
        return f"{text}{weather}."

    text = f"{player_name}: {_market_label(market_key, selection, line_value)}"
    if price:
        text += f" at {price}"
    if long_shot and fair_probability is not None:
        text += f" ({float(fair_probability) * 100:.1f}% implied)"
    if ev:
        text += f" ({ev} EV)"
    return f"{text} in {matchup}{weather}."


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


MIN_FAIR_PROBABILITY = Decimal("0.10")
"""Quality-gate floor: legs with a lower devigged fair probability are never curated."""

_NBA_MARKET_TOKENS = ("points", "rebounds", "assists", "threes", "steals", "blocks")
_NFL_MARKET_TOKENS = ("td", "pass", "rush", "reception", "receiving", "rec_")


def _market_sport(market_key: str) -> str | None:
    """Return the sport a market key belongs to, or None when it cannot be classified."""
    key = market_key.lower()
    if any(token in key for token in _NFL_MARKET_TOKENS):
        return "nfl"
    if any(token in key for token in _NBA_MARKET_TOKENS):
        return "nba"
    return None


def _is_plausible_market(market_key: str, sport: str) -> bool:
    """A known market must fit the event's sport; unclassifiable markets are not penalised."""
    market_sport = _market_sport(market_key)
    return market_sport is None or market_sport == sport


def _player_identity(player_name: str) -> str:
    """Case- and whitespace-insensitive player identity used for de-duplication."""
    return " ".join(player_name.lower().split())


def _distinct_players(pairs: list[tuple[PresetLeg, datetime]]) -> set[str]:
    return {_player_identity(p[0].player_name) for p in pairs}


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
        if prop.fair_probability < MIN_FAIR_PROBABILITY:
            continue

        event = events_map.get(prop.event_id)
        if not event:
            continue
        if event.status in ("LIVE", "FINAL", "CANCELLED", "POSTPONED"):
            continue
        if event.commence_time <= ref_time:
            continue
        event_sport = "nfl" if "nfl" in event.sport_key.lower() else "nba"
        if not _is_plausible_market(prop.market_key, event_sport):
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
            fair_probability=prop.fair_probability,
            offered_decimal_odds=prop.offered_decimal_odds,
            guarded_ev=prop.guarded_ev,
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

    used_players: set[str] = set()

    for theme_title, theme_badge in all_themes:
        sport = "nfl" if "nfl" in theme_badge.lower() else "nba"
        available_sport = [
            p
            for p in legs_by_sport[sport]
            if _player_identity(p[0].player_name) not in used_players
        ]
        candidates = available_sport
        if len(_distinct_players(candidates)) < 2:
            # If not enough for this specific sport, borrow from general pool if available
            candidates = [
                p for p in all_legs if _player_identity(p[0].player_name) not in used_players
            ]

        if len(_distinct_players(candidates)) < 2:
            continue

        # Select 2 to 3 legs from distinct players, rotating to avoid identical cards
        leg_count = 2 if len(_distinct_players(candidates)) < 3 else 3
        start_idx = (theme_idx * 2) % len(candidates)
        rotated = candidates[start_idx:] + candidates[:start_idx]
        selected_pairs: list[tuple[PresetLeg, datetime]] = []
        card_players: set[str] = set()
        for pair in rotated:
            identity = _player_identity(pair[0].player_name)
            if identity in card_players:
                continue
            card_players.add(identity)
            selected_pairs.append(pair)
            if len(selected_pairs) == leg_count:
                break

        card_legs = [p[0] for p in selected_pairs]
        if not any(leg.hit_rate_l10 is not None for leg in card_legs):
            logger.info("Skipping preset %r: no leg has real hit-rate history", theme_title)
            theme_idx += 1
            continue
        earliest_time = min(p[1] for p in selected_pairs)
        used_players |= card_players

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
