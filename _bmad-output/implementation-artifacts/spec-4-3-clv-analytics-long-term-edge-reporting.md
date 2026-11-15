---
title: 'Story 4.3: CLV Analytics & Long-Term Edge Reporting'
type: 'feature'
created: '2026-11-14'
status: 'done'
baseline_commit: 'ccc8f2dc3a6c26de34061aa20eb73e4cb4c7f1d7'
route: 'dispatch'
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Although Story 4.1 persists user bets and Story 4.2 stamps post-commence Closing Line Value (`clv_percentage`, `closing_fair_prob`, `closing_decimal_odds`), bettors have no aggregated analytics view, per-ticket CLV badges, or edge distribution breakdowns across sports and bookmakers to verify whether their betting strategy beats the closing market over time.

**Approach:** Extend the client ledger and `/api/bets` summary metrics (`apps/web/src/lib/ledger.ts`, `apps/web/src/types/bet.ts`, `apps/web/src/app/api/bets/*`) to compute Closing Line Beat Rate, stake-weighted Average CLV%, and edge distribution buckets by sport and sportsbook, and render the Bet Tracker Analytics view and per-ticket CLV badges in `apps/web/src/components/BetTrackerDashboard.tsx`.

## Boundaries & Constraints

**Always:**
- Enforce AD-1 service isolation: `apps/web` computes and renders CLV analytics from tracked bet records (`localStorage` and Redis `/api/bets`); never call `parlay-api.com` from Next.js.
- Treat `clvPercentage` as percent points (`+5.0` = `+5.0%`, quantized to 3 dp in storage and formatted to 1–2 dp in UI) and `closingFairProb` as a `0–1` probability (`(0, 1)`), matching Story 4.2.
- Enforce the positive-only `+10.0%` outlier circuit breaker: exclude any bet with `clvPercentage > 10.0` (or `< -999.999` / non-finite) from CLV analytics aggregation and reject `clvPercentage > 10.0` with HTTP 400 `SUSPECT_STALE_LINE` in `/api/bets` write routes.
- Adhere to dark-mode design tokens: base `#0a0e17`, cards `#121b2d`, borders `#1e293b`, Electric Cyan (`#06b6d4`), Mint Emerald (`#10b981`) for positive CLV / beat rate highlights, Amber (`#f59e0b`), and Rose (`#ef4444`) for negative CLV.

**Decisions (human-approved):**
1. **Eligible bets for CLV analytics:** Include all non-staged bets (`pending`, `won`, `settled_won`, `lost`, `settled_lost`, `push`, `void`) that carry a finite `clvPercentage` within `[-999.999, 10.0]`, since Story 4.2 stamps CLV 10 minutes post-commence while bets are still `pending`.
2. **Beat rate & headline Average CLV%:** A bet beats the closing line strictly when `clvPercentage > 0` (`closingLineBeatRate = (clvBeatCount / clvTrackedCount) * 100`). Headline `averageClvPercentage` is the stake-weighted mean (`sum(clvPercentage * stakeAmount) / sum(stakeAmount)`) across eligible CLV-stamped bets, falling back to the unweighted arithmetic mean when total eligible stake is `0` (and `0` when `clvTrackedCount === 0`). Also expose `unweightedAverageClvPercentage` on `BetSummaryMetrics`.
3. **Sport edge distribution bucketing:** Categorize single-sport tickets as `NFL` (`americanfootball_nfl` / `nfl` or NFL market keys) or `NBA` (`basketball_nba` / `nba` or NBA market keys), and cross-sport parlays (legs spanning both NFL and NBA) as `Multi-Sport` (with `Other` fallback only if a ticket's legs carry no recognizable sport).
4. **Deterministic CLV simulation on local settle:** When settling a `pending` bet via `updateTrackedBetStatus` (used by the dashboard's `"Simulate Settle: Won | Lost"` controls) and `clvPercentage` is `null`/`undefined`, automatically compute and stamp a deterministic realistic `closingFairProb`, `closingDecimalOdds`, and `clvPercentage` (derived from leg `guardedEv` when present or a deterministic hash of `betId`/`decimalOdds` within `[-3.5%, +5.5%]`) and sync via `PATCH /api/bets/[id]` so local/demo flows immediately populate CLV analytics. Never overwrite an already-stamped `clvPercentage`.

**Never:**
- Include `staged` slips or unstamped bets (`clvPercentage == null`) in `clvTrackedCount`, `closingLineBeatRate`, or `averageClvPercentage` denominators.
- Overwrite a bet's existing non-null `clvPercentage`, `closingFairProb`, or `closingDecimalOdds` during settlement.
- Modify `services/worker` CLV math or database schema in this story.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Mixed CLV-stamped pending & settled bets | 2 bets with `+4.0%` ($50 stake) & `+2.0%` ($25 stake), 1 bet with `-3.0%` ($25 stake) | `clvTrackedCount = 3`, `clvBeatCount = 2`, `closingLineBeatRate = 66.67%` (`67%` / `66.7%` UI), stake-weighted `averageClvPercentage = +1.75%` | N/A |
| Zero CLV-stamped bets | Only `staged` or unstamped `pending` bets exist | `clvTrackedCount = 0`, `clvBeatCount = 0`, `closingLineBeatRate = 0`, `averageClvPercentage = 0`; UI shows `0.0%` and `"0 of 0 bets beat closing line"` | No `NaN` or division-by-zero |
| Exact zero CLV (`0.000%`) | Stamped bet with `clvPercentage = 0` | Counted in `clvTrackedCount`, NOT counted in `clvBeatCount` (`clvPercentage > 0` required), included in `averageClvPercentage` | N/A |
| Suspect positive CLV outlier (`> +10.0%`) | Bet with `clvPercentage = 12.5` in storage or `POST`/`PATCH /api/bets` | Excluded from `calculateBetSummaryMetrics` CLV aggregations; `POST`/`PATCH /api/bets` returns HTTP 400 `SUSPECT_STALE_LINE` | Structured JSON error response |
| Multi-sport parlay attribution | Ticket with 1 NFL leg and 1 NBA leg, stamped `+3.2%` CLV | Bucketed under `Multi-Sport` in `metrics.bySport` and under its bookmaker in `metrics.bySportsbook` | N/A |
| Simulate Settle on unstamped pending bet | User clicks `"Won"` or `"Lost"` on pending bet with `clvPercentage == null` | `updateTrackedBetStatus` stamps deterministic `clvPercentage`, `closingFairProb`, `closingDecimalOdds` and `PATCH`es `/api/bets/[id]` | Preserves existing CLV if already stamped |

</frozen-after-approval>

## Code Map

- `apps/web/src/types/bet.ts` -- Extend `BetSummaryMetrics` with `clvTrackedCount`, `clvBeatCount`, `closingLineBeatRate`, `averageClvPercentage`, `unweightedAverageClvPercentage`, `bySport`, and `bySportsbook`; add `ClvEdgeBucket` and `SportEdgeCategory` types.
- `apps/web/src/lib/ledger.ts` -- Implement `resolveBetSportBucket`, `computeSimulatedClosingBenchmark`, and CLV aggregation inside `calculateBetSummaryMetrics`; update `updateTrackedBetStatus` to populate deterministic CLV fields when unstamped.
- `apps/web/src/lib/ledger.test.ts` -- Add unit tests covering all CLV matrix scenarios, stake-weighted vs unweighted average CLV, sport/bookmaker bucketing, outlier exclusion, and deterministic CLV stamping on settle.
- `apps/web/src/app/api/bets/route.ts` -- Preserve and validate optional `closingDecimalOdds`, `closingFairProb`, and `clvPercentage` in `POST /api/bets`; return updated `metrics` from `GET /api/bets`.
- `apps/web/src/app/api/bets/[id]/route.ts` -- Accept, validate, and persist optional `closingDecimalOdds`, `closingFairProb`, and `clvPercentage` in `PATCH /api/bets/[id]`.
- `apps/web/src/app/api/bets/route.test.ts` -- Add integration tests for CLV metrics in `GET /api/bets` and CLV field persistence/validation (`SUSPECT_STALE_LINE`, `INVALID_CLV`) in `POST` and `PATCH`.
- `apps/web/src/components/BetTrackerDashboard.tsx` -- Render CLV Analytics headline cards (`Closing Line Beat Rate` with `"X of Y bets beat closing line"`, `Avg CLV%` alongside `ROI%`), Edge Distribution panel (`By Sport` and `By Sportsbook`), and per-ticket CLV badges (`+4.2% CLV` / closing odds); pass stamped CLV fields in `handleSettle` `PATCH` payload.
- `apps/web/src/components/BetTrackerDashboard.test.tsx` -- Add component tests verifying Closing Line Beat Rate display, Average CLV% display alongside ROI, sport/sportsbook edge distribution rendering, and per-ticket CLV badges.

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/types/bet.ts` -- Add `ClvEdgeBucket`, `SportEdgeCategory`, and CLV fields on `BetSummaryMetrics` -- Establishes type contracts for CLV analytics and edge distribution reporting.
- [x] `apps/web/src/lib/ledger.test.ts` -- Write failing unit tests for every I/O & Edge-Case Matrix row (`calculateBetSummaryMetrics` CLV beat rate, stake-weighted average CLV%, zero-state, `0.0%` boundary, `>10%` outlier guard, `NFL`/`NBA`/`Multi-Sport` & sportsbook breakdowns, and deterministic CLV stamping in `updateTrackedBetStatus`) -- Red phase TDD per `AGENTS.md`.
- [x] `apps/web/src/lib/ledger.ts` -- Implement `resolveBetSportBucket`, `computeSimulatedClosingBenchmark`, `updateTrackedBetStatus` CLV stamping, and `calculateBetSummaryMetrics` CLV & edge distribution calculations -- Green phase core analytics logic.
- [x] `apps/web/src/app/api/bets/route.test.ts` -- Add failing API tests for `GET /api/bets` CLV metrics and `POST`/`PATCH` CLV persistence and `>10%` outlier rejection -- Red phase API TDD.
- [x] `apps/web/src/app/api/bets/route.ts` -- Validate and persist optional `closingDecimalOdds`, `closingFairProb`, and `clvPercentage` on `POST /api/bets` -- Ensures server-side bet creation preserves CLV benchmarks.
- [x] `apps/web/src/app/api/bets/[id]/route.ts` -- Validate and persist optional `closingDecimalOdds`, `closingFairProb`, and `clvPercentage` on `PATCH /api/bets/[id]` -- Syncs CLV benchmarks on settlement/update.
- [x] `apps/web/src/components/BetTrackerDashboard.test.tsx` -- Add failing component tests for Closing Line Beat Rate (`"67% of bets beat closing line"`), Average CLV% alongside ROI%, By Sport / By Sportsbook edge distribution rows, and per-ticket CLV badges -- Red phase UI TDD.
- [x] `apps/web/src/components/BetTrackerDashboard.tsx` -- Render CLV Analytics cards, By Sport and By Sportsbook edge distribution panels, per-ticket CLV badges/closing benchmarks, and include stamped CLV fields in `handleSettle` `PATCH` requests -- Completes user-facing CLV Analytics view.

**Acceptance Criteria:**
- Given tracked bets with stamped `clvPercentage` records, when viewing `BetTrackerDashboard`, then the UI displays the user's overall "Closing Line Beat Rate" (e.g., `67% of bets beat closing line`) and stake-weighted Average CLV% gain alongside standard win/loss ROI%.
- Given tracked bets across NFL, NBA, Multi-Sport, and multiple sportsbooks, when viewing the Bet Tracker Analytics view, then the UI renders visual edge distribution breakdowns by sport and by sportsbook showing tracked count, beat rate, and average CLV%.
- Given individual ticket cards in the Bet Tracker, when a bet has a stamped `clvPercentage`, then the card displays a color-coded CLV badge (Mint Emerald `#10b981` for positive, Rose `#ef4444` for negative) and closing line benchmark details.

## Implementation Notes

- Extended `apps/web/src/types/bet.ts` (`SportEdgeCategory`, `ClvEdgeBucket`, `BetSummaryMetrics`, `StageBetErrorCode`) and implemented CLV analytics, sport/bookmaker bucketing, `validateClvBenchmarkInput`, and deterministic simulated CLV stamping in `apps/web/src/lib/ledger.ts`.
- Updated `apps/web/src/app/api/bets/route.ts` and `apps/web/src/app/api/bets/[id]/route.ts` to validate/quantize optional CLV benchmark fields (`SUSPECT_STALE_LINE` for `> +10.0%`, `INVALID_CLV` for invalid bounds) and preserve non-null existing CLV records on settlement.
- Updated `apps/web/src/components/BetTrackerDashboard.tsx` with the CLV Analytics & Edge Reporting panel (`Closing Line Beat Rate`, stake-weighted `Avg CLV%` alongside `ROI%`, `By Sport` and `By Sportsbook` breakdowns), per-ticket CLV badges with closing benchmark odds/prob, and `performBetSettlement` PATCH payload syncing.

## Spec Change Log

## Review Triage Log

| ID | Source | Location | Severity | Verdict | Action & Notes |
| --- | --- | --- | --- | --- | --- |
| BH-1 | Blind Hunter | `apps/web/src/components/BetTrackerDashboard.tsx:617-621`, `apps/web/src/app/api/bets/[id]/route.ts:30,144`, `apps/web/src/app/api/bets/route.ts:252` | medium | patch | Normalize status checks via `.toLowerCase()` in `BetTrackerDashboard.tsx:617-621` (stops CLV badge leak onto `"STAGED"` slips and restores pills/controls on uppercase statuses) and status validation in `route.ts:252` / `[id]/route.ts:144`. |
| BH-2 | Blind Hunter | `apps/web/src/components/BetTrackerDashboard.tsx:734-755` | medium | patch | Suppress closing benchmark panel on `staged` bets, parse `decimalOdds` defensively, enforce `(1.01 <= odds <= 9999.9999)` before formatting American closing odds, and avoid rendering an empty wrapper `<div>` when bounds fail. |
| BH-3 | Blind Hunter | `apps/web/src/components/BetTrackerDashboard.tsx:517-578,673-677` | low | rejected | Pre-existing Story 4.1 `BetFilterStatus` design (`void`/`push` remain visible under `All`); adding a new filter tab adds unrequested UI surface. |
| BH-4 | Blind Hunter | `apps/web/src/components/BetTrackerDashboard.tsx:119-158,427-441` | low | patch | Remove `Math.max(4, ...)` floor when `beatRate === 0`, color the beat-rate bar by `bucket.beatRate >= 50` instead of `averageClvPercentage`, and add `role="progressbar"` with `aria-valuenow`/`aria-valuemin`/`aria-valuemax`/`aria-label`. |
| BH-5 | Blind Hunter | `apps/web/src/components/BetTrackerDashboard.tsx:51-89,302-309` | medium | patch | Sanitize CLV fields atomically (omit all CLV fields when `clvPercentage > 10.0` or out-of-range), fall back to `getGuestUserId()`, and surface HTTP `!res.ok` failures instead of swallowing them; `initialBets`-only sync and `parlaypal:bets_updated` are pre-existing Story 4.1 patterns. |
| BH-6 | Blind Hunter | `apps/web/src/components/BetTrackerDashboard.tsx:185-203` | medium | defer | Pre-existing Story 4.1 mount reconciliation overwrites local offline/failed-PATCH settlements and simulated CLV with stale server `pending` state; logged in `deferred-work.md`. |
| BH-7 | Blind Hunter | `apps/web/src/types/bet.ts`, `apps/web/src/components/BetTrackerDashboard.tsx:486-499` | false | rejected | Panel copy accurately explains that `> +10.0%` suspect outliers are excluded from `clvTrackedCount`; adding an extra public counter on `BetSummaryMetrics` is an unrequested schema change. |
| BH-8 | Blind Hunter | `apps/web/src/app/api/bets/[id]/route.ts:16-58`, `apps/web/src/app/api/bets/route.ts:118` | medium | patch | Reject `null`, arrays, and non-plain-object JSON request bodies with `400` in both `PATCH /api/bets/[id]` and `POST /api/bets` instead of crashing with `500`. |
| BH-9 | Blind Hunter | `apps/web/src/app/api/bets/[id]/route.ts:121-135`, `apps/web/src/lib/ledger.ts:782-891` | medium | patch | Preserve existing non-null CLV fields atomically in `PATCH /api/bets/[id]` whenever any existing CLV field is already non-null. Reject requiring all 3 fields / exact cross-field formula match because `bets.py` and existing tests allow partial CLV updates. |
| BH-10 | Blind Hunter | `apps/web/src/lib/ledger.ts:589-690` | medium | patch | Fix `"wnba"` matching `"nba"`, preserve `"OTHER_EXPLICIT"` legs so mixed `NFL+MLB` parlays bucket as `"Multi-Sport"` instead of `"NFL"`, and refine `marketDisplay` patterns so `"Kicking Points"` does not match NBA and NFL stats (`"touchdowns"`, `"pass yards"`, `"rush yards"`, `"receiving yards"`, `"turnovers"`) map cleanly. |
| BH-11 | Blind Hunter | `apps/web/src/lib/ledger.ts:692-702,949-955` | low | patch | Normalize sportsbook keys (strip spaces/punctuation/suffixes, map common aliases like `"Draft Kings"`/`"Caesars Sportsbook"`) and assign deterministic canonical display labels. |
| BH-12 | Blind Hunter | `apps/web/src/lib/ledger.ts:402-438,540-544` | medium | patch | Keep `updateTrackedBetStatus` transition compatibility per `bets.py` but skip simulated CLV on `"staged"` slips, check all 3 CLV fields (`closingFairProb`, `closingDecimalOdds`, `clvPercentage`) via `parseFiniteNumeric` for `hasExistingClv`, and fall back to `combinedDecimalOdds` when `decimalOdds` is `NaN` or `< 1.01`. |
| BH-13 | Blind Hunter | `apps/web/src/lib/ledger.ts:482-485` | low | rejected | `Number.toFixed` IEEE-754 half-even drift (~0.001 ULP in display/localStorage) vs Python `ROUND_HALF_UP` is negligible; arbitrary-exponent rounding adds unnecessary complexity. |
| BH-14 | Blind Hunter | `apps/web/src/lib/ledger.test.ts`, `apps/web/src/app/api/bets/route.test.ts`, `apps/web/src/components/BetTrackerDashboard.test.tsx` | medium | patch | Add unit and DOM interaction tests for interactive `"Won"` settle, `staged` CLV suppression in UI, `0.0%` badge, `0%` beat bucket, `snake_case` API CLV, `+10.0%` vs `10.001%` boundary, `PATCH null` body, direct `validateClvBenchmarkInput`, `"wnba"`, and `NFL+MLB` multi-sport bucketing. |
| EC-1 | Edge Case Hunter | `apps/web/src/lib/ledger.ts:695-701` | low | patch | Use `Object.hasOwn` (or `Map`) for sportsbook bucket lookup so prototype keys like `"constructor"` or `"toString"` do not collide. |
| EC-2 | Edge Case Hunter | `apps/web/src/lib/ledger.ts:660-689` | medium | patch | Covered alongside `BH-10`: track distinct `"OTHER_EXPLICIT"` legs so `NFL+MLB` parlays classify as `"Multi-Sport"`. |
| EC-3 | Edge Case Hunter | `apps/web/src/lib/ledger.ts:589-600` | medium | patch | Covered alongside `BH-10`: use boundary-safe sport token matching so `"wnba"` does not match `"nba"` and conflicting `"nfl_nba"` is not biased to `"nfl"`. |
| EC-4 | Edge Case Hunter | `apps/web/src/lib/ledger.ts:603-615` | low | patch | Check `.trim().length > 0` before taking primary sport field in `detectLegSport` so empty strings fall back to `sport_key`/`marketType`. |
| EC-5 | Edge Case Hunter | `apps/web/src/lib/ledger.ts:549-555` | low | patch | Guard `bet.legs` with `Array.isArray(bet.legs) ? bet.legs : []` in `computeSimulatedClosingBenchmark`. |
| EC-6 | Edge Case Hunter | `apps/web/src/lib/ledger.ts:663-669` | low | patch | Guard `bet.legs` with `Array.isArray(bet.legs) ? bet.legs : []` in `resolveBetSportBucket`. |
| EC-7 | Edge Case Hunter | `apps/web/src/lib/ledger.ts:414` | false | rejected | `BetStatus` TypeScript signature forbids `null`/`undefined`; failing loudly on an invalid untyped runtime call is expected. |
| EC-8 | Edge Case Hunter | `apps/web/src/lib/ledger.ts:416-435` | medium | patch | Covered alongside `BH-12`: use `parseFiniteNumeric` across all 3 CLV fields in `hasExistingClv` so `NaN`/`""` does not suppress simulation and partial `closingFairProb` is respected. |
| EC-9 | Edge Case Hunter | `apps/web/src/lib/ledger.ts:540-544` | medium | patch | Covered alongside `BH-12`: fall back to `combinedDecimalOdds` when `decimalOdds` is `NaN` or `< 1.01`. |
| EC-10 | Edge Case Hunter | `apps/web/src/lib/ledger.ts:568-580` | low | patch | Clamp/floor rounded `closingFairProb` in `computeSimulatedClosingBenchmark` so `closingFairProb * dExec - 1 <= 0.10` even at extreme odds (`>= 9173`). |
| EC-11 | Edge Case Hunter | `apps/web/src/lib/ledger.ts:738-750` | low | patch | Guard `Number.isFinite(weightedSum) && Number.isFinite(totalStake) && totalStake > 0` in `buildClvEdgeBucket` to prevent `Infinity / Infinity = NaN` on `1e308` stakes. |
| EC-12 | Edge Case Hunter | `apps/web/src/lib/ledger.ts:912-913` | low | patch | Use `parseFiniteNumeric(bet.stakeAmount) ?? parseFiniteNumeric(bet.stake) ?? 0` in `calculateBetSummaryMetrics` so `NaN` `stakeAmount` does not mask valid `stake`. |
| EC-13 | Edge Case Hunter | `apps/web/src/lib/ledger.ts:785-795` | low | rejected | Standard `camel ?? snake` key precedence matches existing ParlayPal routes; rejecting conflicting dual keys adds unrequested complexity. |
| EC-14 | Edge Case Hunter | `apps/web/src/app/api/bets/[id]/route.ts:121-135` | medium | patch | Covered alongside `BH-9`: atomically preserve all existing CLV fields when any CLV field is already non-null. |
| EC-15 | Edge Case Hunter | `apps/web/src/app/api/bets/route.ts:306-339` | low | patch | Strip CLV benchmark fields on `POST /api/bets` when status normalizes to `"staged"` so staged slips cannot carry stale CLV into `pending`. |
| EC-16 | Edge Case Hunter | `apps/web/src/components/BetTrackerDashboard.tsx:62-87` | medium | patch | Covered alongside `BH-5`: enforce atomic CLV bounds and HTTP `!res.ok` checks in `performBetSettlement`. |
| EC-17 | Edge Case Hunter | `apps/web/src/components/BetTrackerDashboard.tsx:617-637` | medium | patch | Covered alongside `BH-1`: use case-insensitive status checks in `BetTrackerDashboard.tsx`. |
| EC-18 | Edge Case Hunter | `apps/web/src/components/BetTrackerDashboard.tsx:737-754` | medium | patch | Covered alongside `BH-2`: suppress staged closing benchmark, check `<= 9999.9999`, and avoid empty wrapper `<div>`. |
| EC-19 | Edge Case Hunter | `apps/web/src/components/BetTrackerDashboard.tsx:28-35` | low | patch | Preserve precision up to 3 decimals (or normalize sign/color) in `formatClvPercent` so tiny non-zero CLV in `(-0.005, 0.005)` does not display `"0.00%"` / `"0.0%"` in green/red. |
| VG-1 | Verification Gap Reviewer | `apps/web/src/components/BetTrackerDashboard.test.tsx:332-365` | medium | patch | Strengthen dashboard render assertions to explicitly check `bySportsbook` telemetry, `"Unweighted:"`, `"Edge Verification Guard"`, American closing odds, and `"Fair Close:"`. |
| VG-2 | Verification Gap Reviewer | `apps/web/src/components/BetTrackerDashboard.tsx:51-89,302-309,864-878`, `apps/web/src/components/BetTrackerDashboard.test.tsx` | medium | patch | Add interactive DOM test (`createRoot` + `act`) clicking `"Won"` on a pending bet and asserting `performBetSettlement` omits CLV fields when `clvPercentage > 10.0`. |
| VG-3 | Verification Gap Reviewer | `apps/web/src/app/api/bets/[id]/route.ts:97`, `apps/web/src/app/api/bets/route.test.ts` | medium | patch | Verify and test uppercase `"WON"` / `"VOID"` rejection (`ALREADY_SETTLED`) in `PATCH /api/bets/[id]`. |
| VG-O1 | Verification Gap Reviewer | `apps/web/src/components/BetTrackerDashboard.tsx:617-635` | medium | patch | Covered alongside `BH-1`: normalize status with `.toLowerCase()` so uppercase statuses render and behave identically to lowercase. |
| VG-O2 | Verification Gap Reviewer | `apps/web/src/components/BetTrackerDashboard.tsx:62-86,289-299` | medium | patch | Extract a shared CLV-sync sanitization helper used by both `performBetSettlement` and `handleUndoDiscard` so `> 10%` or out-of-range CLV fields are never sent in `PATCH` and `!res.ok` is handled cleanly. |

## Verification

- `npm --prefix apps/web run typecheck` (`tsc --noEmit`): passed (exit 0) after final edits.
- `npm --prefix apps/web test -- --run` (`vitest --run`): passed — 18 test files passed (18), 194 tests passed (194) after final edits (`src/lib/ledger.test.ts`: 34, `src/app/api/bets/route.test.ts`: 19, `src/components/BetTrackerDashboard.test.tsx`: 13).
- `npm --prefix apps/web run build` (`next build`): passed (exit 0; compiled successfully, typecheck/lint valid, 3/3 static pages generated) after final edits.
- Review triage: 38 findings across 3 reviewers (Blind Hunter: 14, Edge Case Hunter: 19, Verification Gap Reviewer: 5) -> 32 `patch` (applied and verified), 5 `rejected`, 1 `defer` (`BH-6` recorded in `_bmad-output/implementation-artifacts/deferred-work.md`).

**Commands:**
- `npm --prefix apps/web run typecheck` -- expected: 0 TypeScript errors
- `npm --prefix apps/web test -- --run` -- expected: all Vitest suites pass
- `npm --prefix apps/web run build` -- expected: Next.js production build succeeds
