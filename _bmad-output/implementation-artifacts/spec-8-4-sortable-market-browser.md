---
title: 'Story 8.4: Sortable Market Browser'
type: 'feature'
created: '2026-11-22'
status: 'done'
baseline_commit: '74fa39a2a5da43c572a686d88d1b15e838a55f27'
route: 'oneshot'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The market browser's prop list is fixed to score-descending order, so a bettor cannot rank props by player, team, market, line, odds, EV or hit rate.

**Approach:** Add a sort bar above the prop list (a button per field; clicking the active one flips direction) that sorts the already-filtered rows. Fields: player, team, market, line, odds, EV, hit rate, score. Missing values (null line, no hit rate) always sort last in either direction. The choice lives in the URL (`?sort=<field>&dir=asc|desc`), composing with the existing `?game=` param; the default (score, desc) leaves the URL clean. Sorting is applied at render, so live SSE odds updates keep the chosen order.

</frozen-after-approval>

## Implementation Notes

- New pure helpers in `apps/web/src/lib/market-sort.ts` (`sortMarketProps`, `parseSortParam`, `withSortParam`), tested first in `market-sort.test.ts`.
- `MarketBrowser.tsx`: sort state initialised from the URL in the existing mount effect, mirrored with `history.replaceState` (same pattern as `?game=`); sort bar rendered above the list. No change to filtering, SSE, scoring or the worker.
- Odds sort on `offeredDecimalOdds`; EV on `guardedEv`; hit rate on `hitRateL10` (null/blank = missing).

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Route / evidence |
|---|---|---|
| Sort bar used `aria-pressed`, breaking the slate test's "nothing selected" check | low | patch: `aria-current` used instead |
| Blind-hunter subagent review skipped (no subagent authorization this session); inline self-review only | n/a | typecheck, 274 tests and build pass |

## Verification

**Commands:**
- `npm --prefix apps/web run typecheck` -- expected: no errors
- `npm --prefix apps/web test -- --run` -- expected: all pass
- `npm --prefix apps/web run build` -- expected: succeeds
