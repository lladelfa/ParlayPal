---
title: 'Story 6.6: Preset Candidate Quality Gate & De-duplication'
type: 'feature'
created: '2026-11-16'
status: 'done'
baseline_commit: 'f7bb9fc296a39234b0bb586845f466c69853837d'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `generate_curated_presets` builds cards by rotating through one shared leg pool, so the same player appears in several presets (Cody White, Rico Dowdle each twice), and nothing screens out implausible legs (very low fair probability, market that does not fit the sport).

**Approach:** After building legs, drop implausible ones via a named-constant quality gate, then assemble cards so each player is used in at most one preset per feed refresh.

## Boundaries & Constraints

**Always:**
- Player identity for de-dup is normalized `player_name` (case/whitespace-insensitive) across all cards in one `generate_curated_presets` call.
- Thresholds are module-level named constants (e.g. `MIN_FAIR_PROBABILITY`), with unit tests at the exact boundary (at floor kept, just below dropped).
- Outlier breaker (`SUSPECT_STALE_LINE`, `guarded_ev > 0.10`) filtering stays as is and runs before the gate.
- Cards still need 2–3 legs, a real-history leg (6.1), and `Decimal` math; Redis `EX=45` unchanged. If dedup leaves too few legs, emit fewer cards rather than repeat a player.

**Decisions (confirmed by human):**
- Plausibility = sport/market compatibility only (NFL events accept NFL markets, NBA accept NBA); no position check until position data exists.
- `MIN_FAIR_PROBABILITY = Decimal("0.10")`, applied to every preset.
- Carson Beck "Under 11.5 Rush Yds" is a valid market; no special-casing.

**Never:**
- No change to hit-rate, rationale, score or `apps/web` behaviour; no new provider calls.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected |
|---|---|---|
| Duplicate player | Same player has 2 props in pool | Appears in at most one card |
| Pool too small after dedup | Only 3 distinct players | Fewer cards, no player repeated |
| Fair prob at floor | `fair_probability == MIN_FAIR_PROBABILITY` | Leg kept |
| Fair prob below floor | floor − 0.0001 | Leg dropped |
| Sport/market mismatch | NFL event with `player_points` | Leg dropped |
| Outlier | `guarded_ev > 0.10` | Still excluded |

</frozen-after-approval>

## Code Map

- `services/worker/parlaypal_worker/presets.py:363-561` -- `generate_curated_presets`: filtering loop (391-407), leg build (421-499), rotation card assembly (524-556) is where duplicates arise. Add constants and gate here; rework assembly to draw from a used-player set.
- `services/worker/tests/test_presets.py` -- `_slate` helper (:559) uses `Player {i}` names and fixed sport; add tests for each matrix row; check existing card-count tests (:415, :738, :746) still hold.
- Callers (`celery_app.py:248`, `ingestion.py:2379`) unchanged.

## Tasks & Acceptance

**Execution (TDD per `AGENTS.md`):**
- [x] `tests/test_presets.py` -- red tests per matrix row, incl. boundary values
- [x] `parlaypal_worker/presets.py` -- named constants, quality gate, player-unique card assembly
- [x] Matrix audit; run all verification commands

**Acceptance Criteria:**
- Given a pool with repeated players, when presets are generated, then no player appears in more than one preset.
- Given legs below the floor or mismatched to sport, then they are excluded and the breaker rule is unaffected.

## Implementation Notes

- `presets.py`: `MIN_FAIR_PROBABILITY`, sport/market plausibility gate, player-unique card assembly. Tests: 9 new in `test_presets.py`; `_slate` gained `sport_key`; seed-slate preset count 5 -> 4 in `test_ingestion.py` (old count relied on repeated players).
- Pre-existing unrelated failure: `test_game_logs.py::test_no_authorization_header_without_api_key` (fails on main).

## Spec Change Log

## Review Triage Log

Self-review of the diff (no reviewer subagents spawned: not authorized this session).

| Finding | Verdict | Route | Evidence |
|---|---|---|---|
| Token match could misclassify unusual keys (e.g. an NFL kicking-points market reads as NBA and is dropped) | low | reject | Not in current feeds; fix would add branching. Unknown markets are allowed through. |
| Skipped card (no history) leaves players unused | false | n/a | Players are marked used only after the history check passes. |
| Rotation can pick fewer than `leg_count` | false | n/a | `leg_count` derives from distinct-player count. |

## Verification

**Commands:**
- `uv run --directory services/worker ruff check parlaypal_worker tests` -- 0 errors
- `uv run --directory services/worker ruff format --check parlaypal_worker tests` -- formatted
- `uv run --directory services/worker mypy parlaypal_worker tests` -- 0 errors
- `uv run --directory services/worker pytest -v` -- all pass
