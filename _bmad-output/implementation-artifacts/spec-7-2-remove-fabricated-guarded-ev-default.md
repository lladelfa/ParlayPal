---
title: 'Story 7.2: Remove Fabricated guarded_ev Default'
type: 'bugfix'
created: '2026-11-17'
status: 'done'
baseline_commit: '741dc0ba5bed91154afa02c4311010a4228c328f'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `generate_curated_presets` builds each `PresetLeg` with `guarded_ev=prop.guarded_ev or Decimal("0.0200")`, so a prop with no edge estimate is shown and ranked as +2% EV, and a real EV of exactly `0` is also overwritten by 2%. The same `or` in the candidate sort turns a missing EV into 0.

**Approach:** `PresetLeg.guarded_ev` becomes `Decimal | None` and is passed through untouched. Legs with no EV stay in the feed but rank after legs with real EV, and the web renders a missing EV as absent ("—"), never as 0.00% or 2.00%.

## Boundaries & Constraints

**Always:**
- Use explicit `is None` checks; a real `guarded_ev` of `0` (or negative) is preserved.
- Decision: a leg with `None` EV is NOT excluded. Card `combined_ev` and `hybrid_value_score` are already derived from fair probability and odds (not leg `guarded_ev`), so scoring never used the fabricated value; only the sort order and the leg field did.
- Outlier breaker unchanged: EV > 0.10 still dropped.
- Web parses a missing/null/non-numeric `guardedEv` to `null`, not `"0.0000"`.

**Never:** change `combined_ev` math, the market-browser feed (it already drops `None` EV), Redis schema keys, or DB columns; invent any other default EV.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Missing EV | prop `guarded_ev=None` | leg serialized with `guarded_ev: null`; sorts after legs with real EV | N/A |
| Zero EV | prop `guarded_ev=Decimal("0")` | leg `guarded_ev == 0`, sorted as 0 | N/A |
| Real EV | `0.045` | unchanged | N/A |
| Web null EV | payload `guarded_ev: null` or absent | `guardedEv: null`; UI shows "—" | no NaN% text |
| Web zero EV | payload `"0.0000"` | displays `0.0%`, not absent | N/A |

</frozen-after-approval>

## Code Map

- `services/worker/parlaypal_worker/presets.py` -- `PresetLeg.guarded_ev` (~L230), sort key (~L486), `or Decimal("0.0200")` (~L566); `_format_ev` already None-safe.
- `apps/web/src/types/preset.ts`, `types/parlay.ts` -- `guardedEv: string` -> `string | null`.
- `apps/web/src/lib/presets.ts` (~L107) -- default `"0.0000"` -> null; fixtures keep their values.
- `apps/web/src/lib/parlay.ts` (~L436, 453, 517) -- NaN-safe use of nullable EV.
- `apps/web/src/lib/quickpick.ts` (~L243) -- `?? "0"` only feeds the >10% check; leave.
- `apps/web/src/components/LegSwapperModal.tsx`, `MarketBrowser.tsx` -- use `MarketPropRow` (always numeric); leave.
- Tests: `services/worker/tests/test_presets.py`, `apps/web/src/lib/presets.test.ts`, `parlay` tests.

## Tasks & Acceptance

**Execution:**
- [x] Tests first: `services/worker/tests/test_presets.py` (None stays None, 0 preserved, None sorts last), `apps/web/src/lib/presets.test.ts` (null EV parsed, "0.0000" kept)
- [x] `presets.py` -- `guarded_ev: Decimal | None = None`; pass through; sort key `is None` aware
- [x] `types/preset.ts`, `types/parlay.ts`, `lib/presets.ts`, `lib/parlay.ts` -- nullable EV end to end; typecheck clean

**Acceptance Criteria:**
- Given a prop with `guarded_ev` NULL, when presets are built, then the `PresetLeg` has `guarded_ev is None` and no `0.0200` appears.
- Given a real `guarded_ev` of exactly 0, then it is preserved.
- Given a null EV on the web, then no "0.00%" or "2.00%" is rendered for that leg.

## Implementation Notes

- Worker: `PresetLeg.guarded_ev` is `Decimal | None`; passed through; sort key puts real EV (including 0 and negatives) before None. 3 new tests in `test_presets.py`.
- Web: `guardedEv` nullable in `PresetLeg`/`ParlayLeg`; `presets.ts` parses via `coerceNullableString`; `ParlayDrawer` maps null to `undefined` for `BetLeg`. 2 new tests in `presets.test.ts`.
- No web component renders `PresetLeg.guardedEv` (only card `combinedEv` and `MarketPropRow` EV, which is always numeric), so no UI change was needed for the "absent" AC beyond the type/parse change.
- Gates: ruff, format, mypy, pytest (405), typecheck, vitest (223), build all pass.

## Spec Change Log

## Review Triage Log

Self-review of the diff (no subagent reviewers authorised): no findings. Consumers of nullable `guardedEv` checked: `ledger.ts` and bets routes already null-safe; `parlay.ts`/`LegSwapperModal`/`MarketBrowser` use `MarketPropRow` (non-null); `ParlayDrawer` maps null to undefined.

## Verification

**Commands:**
- `uv run --directory services/worker ruff check parlaypal_worker tests` / `ruff format --check` / `mypy parlaypal_worker tests` / `pytest -v` -- expected: pass
- `npm --prefix apps/web run typecheck` / `npm --prefix apps/web test -- --run` / `npm --prefix apps/web run build` -- expected: pass
