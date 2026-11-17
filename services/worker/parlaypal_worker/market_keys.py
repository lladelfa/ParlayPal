"""Canonical prop market keys: one place that maps provider spellings to one `market_key`."""

from __future__ import annotations

import logging
from collections.abc import Mapping

from sqlalchemy import select
from sqlalchemy.orm import Session

from parlaypal_worker.models import PlayerProp

logger = logging.getLogger(__name__)

# Provider spelling -> canonical key. Canonical keys are the ones the market browser, hit-rate
# computation and MoneyLine stat mapping use. Anytime-TD is already canonical.
MARKET_KEY_ALIASES: dict[str, str] = {
    "player_threes_made": "player_threes",
    "player_rushing_yards": "player_rush_yds",
    "player_rush_yards": "player_rush_yds",
    "player_rushing_yds": "player_rush_yds",
    "player_passing_yards": "player_pass_yds",
    "player_pass_yards": "player_pass_yds",
    "player_passing_yds": "player_pass_yds",
    "player_receiving_yards": "player_reception_yds",
    "player_receiving_yds": "player_reception_yds",
}

# Canonical keys that are recognised but need no aliasing. Anything outside this set and the alias
# table is "unknown": stored as received and logged once.
_KNOWN_CANONICAL_KEYS: frozenset[str] = frozenset(
    {
        "player_anytime_td",
        "player_first_td",
        "player_last_td",
        "player_2plus_td",
        "player_pass_yds",
        "player_pass_tds",
        "player_pass_completions",
        "player_pass_attempts",
        "player_rush_yds",
        "player_rush_attempts",
        "player_receptions",
        "player_reception_yds",
        "player_rush_reception_yds",
        "player_interceptions",
        "player_turnovers",
        "player_kicking_points",
        "player_field_goals",
        "player_tackles_assists",
        "player_points",
        "player_rebounds",
        "player_assists",
        "player_threes",
        "player_blocks",
        "player_steals",
        "player_double_double",
        "player_triple_double",
        "player_points_rebounds_assists",
        "player_points_rebounds",
        "player_points_assists",
        "player_rebounds_assists",
    }
)

_LOGGED_UNKNOWN: set[str] = set()


def canonicalize_market_key(raw_key: str, *, log_unknown: bool = True) -> str:
    """Return the canonical key for `raw_key`; unknown keys are returned as received (lowercased).

    An unknown key is logged once per process, never dropped. Callers that filter unknown keys out
    (so they are not stored) pass `log_unknown=False`.
    """
    key = raw_key.strip().lower()
    canonical = MARKET_KEY_ALIASES.get(key)
    if canonical is not None:
        return canonical
    if log_unknown and key and key not in _KNOWN_CANONICAL_KEYS and key not in _LOGGED_UNKNOWN:
        _LOGGED_UNKNOWN.add(key)
        logger.warning("Unknown prop market_key %r stored as received.", key)
    return key


def rewrite_stored_market_keys(session: Session) -> Mapping[str, int]:
    """Rewrite stored `player_props.market_key` aliases to canonical keys.

    Returns `{old_key: rows_rewritten}`. The caller commits.
    """
    counts: dict[str, int] = {}
    stmt = select(PlayerProp).where(PlayerProp.market_key.in_(list(MARKET_KEY_ALIASES)))
    for prop in session.scalars(stmt).all():
        old = prop.market_key
        prop.market_key = MARKET_KEY_ALIASES[old]
        counts[old] = counts.get(old, 0) + 1
    return counts
