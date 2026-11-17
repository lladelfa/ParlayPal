---
title: 'Story 7.3: Canonical Prop Market Keys'
type: 'bugfix'
created: '2026-11-17'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The same market is stored under several provider spellings (`player_threes` 1,049 rows vs `player_threes_made` 83; `player_rush_yds`/`player_rushing_yards`/`player_rush_yards`; `player_pass_yds`/`player_passing_yards`), splitting filters, sorting and game-log/hit-rate lookups.

**Approach:** One alias table in a new `market_keys.py` maps every provider spelling to a canonical `market_key` at the ingestion boundary (both the bookmakers path and the structured-props path), and in the game-log lookups (`hit_rate`/`game_logs`/MoneyLine stat mapping). A key that is neither canonical nor an alias is kept as received and logged once per process. A one-off local script rewrites existing rows. Anytime-TD stays `player_anytime_td`. The web already filters on canonical keys; no web change beyond confirming it.

</frozen-after-approval>

## Implementation Notes

- Decision: on the Odds-API bookmakers path the per-sport browsable-market filter still applies after canonicalisation (that provider request is already restricted to those markets); "stored as received, logged once" applies to the structured-props path and to lookups.
- Decision: the one-off script rewrites `market_key` only; `external_provider_id` is left unchanged (solo dev; stale rows expire with their events).
- Files: new `market_keys.py` (alias table, `canonicalize_market_key`, `rewrite_stored_market_keys`); wired into `ingestion.py` (both paths + `to_player_game_logs`), `hit_rate.py`, `game_logs.py`, `moneyline.py`; one-off `services/worker/scripts/canonicalize_market_keys.py`; tests in `tests/test_market_keys.py`.
- Bookmakers path uses `log_unknown=False` because unknown keys there are filtered, not stored (existing test requires quiet skips).
- Web: `market-filters.ts`/`types/market.ts` already use canonical keys; no change. Run the script locally once: `uv run --directory services/worker python scripts/canonicalize_market_keys.py`.
- Gates: ruff, format, mypy, pytest (423) pass. Web untouched.

## Review Triage Log

Self-review (no subagent reviewers authorised): no findings. Residual: rewritten rows keep old `external_provider_id`, so an old row and a fresh canonical row for the same live prop can coexist until the event passes (accepted for solo dev).
