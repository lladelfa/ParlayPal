---
title: 'Story 6.2: Selection-Aware Hit Rate for Under Legs'
type: 'bugfix'
created: '2026-11-15'
status: 'in-progress'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `compute_rolling_hit_rate` already compares Under with strict `<`, but a push (stat == line) is counted as a miss and stays in every window denominator, so Under (and Over) rates are understated on whole-number lines. `generate_conviction_rationale` has no selection or line input and only has Over wording ("surpassed", "cleared"), so an Under leg's badge and copy contradict the pick.

**Approach:** Make each game a tri-state (hit / miss / push) and exclude pushes from the denominator. Pass selection and line into the rationale and word Unders in the under direction. Over output and anytime-TD copy stay byte-identical.

## Boundaries & Constraints

**Always:**
- Over hit = stat strictly above line; Under hit = strictly below; push = neither, excluded from numerator and denominator of its window. Windows are the most recent 5 / 10 games (pushes inside a window shrink it; do not pull in older games). Season uses all games.
- A window with zero non-push games has rate `None` (never 0, never a default); 6.1's missing-history behaviour applies.
- Normalize selection with one shared helper (`.strip().upper()`) used by `hit_rate.py`, `update_props_hit_rates`, and the `ingestion.py` backfill (replacing the case-sensitive `== "UNDER"` checks).
- Anytime-TD (`market_key` contains `td`) rationale stays Over-style regardless of selection.
- Keep `Decimal` math, existing `compute_rolling_hit_rate` signature, and `PropHitRateResult` field names; add only optional fields with defaults (e.g. `l5_pushes`, `l10_pushes`, `season_pushes`). Windows with no pushes must produce identical results to today.
- `generate_conviction_rationale` gains trailing keyword args `selection: str = "OVER"` and `line_value: Decimal | None = None`; defaults reproduce current output exactly.
- Under copy example: "{player} stayed under 28.5 rush yds in 6/10 (60.0%) L10"; never "surpassed"/"cleared"/"has scored" for an Under non-TD leg.

**Never:**
- Never change devigging, the `SUSPECT_STALE_LINE` guard, Redis TTLs, or provider calls (Story 6.5).
- Never implement real form dots (Story 6.3) or evidence-based rationale (Story 6.4). Form dots skip pushes; placeholder dot patterns stay.
- Never change Over rates or Over copy; no new DB columns or hit/total persistence.
- `N/10` display in `presets.py` / `market_browser.py` keeps deriving from the rate (decision: pushes are rare on half-point lines and persisting counts is out of scope).

</frozen-after-approval>

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Notes |
|---|---|---|---|
| Under with push | stats [24,20,25,28,22], Under 25 | 24, 20, 22 hit; 28 miss; 25 push excluded → L5 = 3/4 = 0.7500 | push excluded |
| Over unchanged | stats [30,20,26,28,22], Over 25 | 3/5 = 0.6000 | identical to today |
| Over push | stats [25,30,20], Over 25 | 1/2 = 0.5000 | push excluded |
| All pushes | stats [25,25], any side | rate `None`, pushes=2 | no default |
| Mixed window | 10 games, 2 pushes | L10 denominator 8, not 10 | most recent 10 only |
| Lowercase selection | `"under"` in update/backfill | treated as UNDER | shared helper |
| Invalid selection | `"SIDEWAYS"` | `HitRateError` as today | unchanged |
| Under rationale | UNDER, rush yds, line 28.5, 6/10 | contains "stayed under 28.5" and "6/10 (60.0%) L10"; no "surpassed" | |
| Under TD | UNDER, anytime TD | Over-style TD copy | per epic |
| Over rationale | OVER, any market, defaults | byte-identical to today | |

## Code Map

- `services/worker/parlaypal_worker/hit_rate.py:115-216` -- `compute_rolling_hit_rate`: tri-state outcomes, push exclusion, totals; `PropHitRateResult` (:60-79) optional push fields; `update_props_hit_rates` (:260) use helper.
- `services/worker/parlaypal_worker/ingestion.py:2184` -- backfill selection check; `:2053-2071` passes normalized `IngestedProp.selection` (already uppercase).
- `services/worker/parlaypal_worker/presets.py:106-174` -- `generate_conviction_rationale` Under branches; call site `:451-457` passes `prop.selection`, `prop.line_value`; `_generate_history_free_rationale` (:75) stays untouched; `_format_market_display` (:321) gives unit wording to reuse.
- `services/worker/tests/test_hit_rate.py:72` -- `test_under_prop_with_push_handling` currently asserts push = miss (3/5); update to 3/4 = 0.7500.
- `services/worker/tests/test_presets.py` -- add Under/TD/Over-default rationale tests (existing Over tests at :86, :98, :109 must pass unchanged).
- `apps/web` -- no change (passes rationale and rates through).

## Tasks & Acceptance

**Execution (TDD per `AGENTS.md`):**
- [ ] `services/worker/tests/test_hit_rate.py`, `test_presets.py` -- Red: failing tests for every matrix row; update the push test expectation per the matrix.
- [ ] `hit_rate.py` -- tri-state outcomes, push-excluded denominators, optional push fields, shared selection helper.
- [ ] `ingestion.py`, `hit_rate.py:260` -- use shared helper for selection.
- [ ] `presets.py` -- selection/line-aware rationale; pass them at the call site.
- [ ] Matrix audit; run all verification commands.

**Acceptance Criteria:**
- Given an UNDER prop with push games, when hit rates compute, then pushes are in neither numerator nor denominator.
- Given an UNDER non-TD leg, when its rationale is generated, then it reads in the under direction with the line value and never "surpassed".
- Given OVER props or anytime-TD props, then rates and copy are unchanged.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Verification

**Commands:**
- `uv run --directory services/worker ruff check parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker ruff format --check parlaypal_worker tests` -- expected: formatted
- `uv run --directory services/worker mypy parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker pytest -v` -- expected: all pass
- `npm --prefix apps/web run typecheck` and `npm --prefix apps/web test -- --run` -- expected: pass (no web changes expected)
