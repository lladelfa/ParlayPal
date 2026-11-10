---
title: 'Story 3.1: Multi-Sportsbook Lineshopper Comparison'
type: 'feature'
created: '2026-11-09'
status: 'done'
route: 'dispatch'
baseline_commit: '13a36ebabfc1d19733d5365b9c591d90b3e254c4'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Bettors assembling custom or preset multi-leg parlays in ParlayPal have no immediate visibility into price discrepancies across rival sportsbooks for their exact ticket, frequently surrendering 15% to 35% in compounding expected payout by locking in inferior odds at their default bookmaker.

**Approach:** Build a dedicated, reactive Multi-Sportsbook Lineshopper component within the Parlay Drawer and supporting pricing engine in `apps/web` that dynamically prices active parlay legs across DraftKings, FanDuel, BetMGM, and Caesars. The widget prominently highlights the "Best Value Book" with an emerald badge and calculated profit edge (both dollar advantage on a standard $50 stake and odds differential), flags unavailable legs gracefully, and enables 1-click selection of the active target book for downstream QuickPick handoff.

## Boundaries & Constraints

**Always:**
- Execute all internal bookmaker odds comparisons in `Decimal` format ($D \ge 1.01$), converting to American payout odds (`+420`, `-110`) strictly at presentation boundaries.
- Compare four major integrated retail books: FanDuel (`fanduel`), DraftKings (`draftkings`), BetMGM (`betmgm`), and Caesars (`caesars`).
- Highlight the single sportsbook offering the maximum combined decimal payout as the "Best Value Book" when at least 2 legs are present and priced.
- Calculate and display comparative edge against the runner-up / consensus bookmaker (e.g. `FanDuel (+420) vs DraftKings (+370)` and `+$25 Edge on $50 bet`).
- When an individual leg is not offered by a bookmaker, mark that bookmaker as `Unavailable` / `Missing Leg(s)` without failing the lineshopper for remaining books.
- When an assembled parlay has 0 legs or 1 leg, render an informative prompt state (`Add 2+ legs to compare parlay lines across sportsbooks`).
- Persist user bookmaker selection in `ParlayDrawerContext` (`selectedSportsbook`), defaulting to the "Best Value Book" upon price calculation unless explicitly chosen by user.
- Render typography in tabular `JetBrains Mono` for all payouts, odds, and edge deltas to prevent layout shifts during reactive updates.

**Never:**
- Never call external `parlay-api.com` or third-party sportsbook scrapers directly from browser client code (per AD-1 polyglot isolation).
- Never allow a sportsbook with missing/unavailable legs to be designated as the "Best Value Book".
- Never block drawer interactions or leg removal/swapping if lineshopper price calculation is evaluating.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Multi-Book Comparison (Happy Path) | 2-leg parlay (Henry TD + St. Brown O6.5 Rec); FanDuel: 5.20 (+420), DraftKings: 4.70 (+370), BetMGM: 4.90 (+390), Caesars: 4.50 (+350) | FanDuel designated Best Value Book; emerald border; display `+420`, edge `+$25 on $50 bet (vs DK +370)`; all 4 cards selectable | Valid comparison |
| Single Book Partial Leg Absence | 3-leg parlay; Caesars does not offer Leg 3 | FanDuel, DraftKings, BetMGM display full combined odds; Caesars displays `Line Unavailable` and cannot win Best Value | Handled gracefully, no crash |
| Identical Top Odds Tiebreaker | FanDuel: 5.00 (+400), DraftKings: 5.00 (+400) | First integrated book (FanDuel) selected as primary best, edge shows `+$0 Edge (Even with DK)` | Tie handled deterministically |
| 1-Leg Slip State | Parlay Drawer has exactly 1 leg | Lineshopper displays single-prop odds comparison across books without parlay multiplier label | Valid single-market mode |
| Empty Slip State | Parlay Drawer has 0 legs | Lineshopper widget renders subtle empty state placeholder or collapses cleanly | No null pointer or division by zero |
| User Sportsbook Selection | User clicks BetMGM card (+390) | `selectedSportsbook` updates to `betmgm`; card active state updates to Electric Cyan ring | Selection persists in drawer context |

</frozen-after-approval>

## Code Map

- `apps/web/src/types/lineshopper.ts` -- Domain interfaces: `SportsbookId`, `SportsbookQuote`, `BookmakerParlayPricing`, `LineshopperComparisonResult`.
- `apps/web/src/lib/lineshopper.ts` -- Pricing logic: compute per-book parlay odds from leg quotes, determine Best Value Book, calculate dollar edge and odds differential, handle unavailable lines.
- `apps/web/src/lib/lineshopper.test.ts` -- Unit test suite validating pricing math, edge cases, tiebreakers, and missing book quotes.
- `apps/web/src/components/LineshopperWidget.tsx` -- Interactive UI component: 4-book grid, Best Value emerald badge, odds pills, dollar advantage, click-to-select bookmaker.
- `apps/web/src/components/LineshopperWidget.test.tsx` -- Component tests verifying rendering, bookmaker selection, edge display, and missing line handling.
- `apps/web/src/context/ParlayDrawerContext.tsx` -- State management: `selectedSportsbook`, `lineshopperComparison`, and update actions.
- `apps/web/src/components/ParlayDrawer.tsx` -- Drawer integration: embed `LineshopperWidget` above the QuickPick checkout button in both desktop and mobile drawer views.

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/types/lineshopper.ts` -- Define domain types and constants for sportsbooks, quotes, and lineshopper comparison state -- Establishes strict contracts across web app.
- [x] `apps/web/src/lib/lineshopper.ts` -- Implement `compareMultiBookOdds`, `calculateBookmakerPayout`, and edge calculation helpers -- Core quantitative comparison logic.
- [x] `apps/web/src/lib/lineshopper.test.ts` -- Implement comprehensive unit tests for lineshopper calculation, edge cases, and missing quotes -- Satisfies TDD Red/Green verification.
- [x] `apps/web/src/components/LineshopperWidget.tsx` -- Build responsive Lineshopper widget with DESIGN.md tokens, Best Value highlighting, and click selection -- User-facing UI component.
- [x] `apps/web/src/components/LineshopperWidget.test.tsx` -- Unit and interaction tests for `LineshopperWidget` with Vitest and React Testing Library -- Frontend verification.
- [x] `apps/web/src/context/ParlayDrawerContext.tsx` -- Integrate `selectedSportsbook` and auto-evaluation of lineshopper pricing into parlay state -- Connects lineshopper with active slip.
- [x] `apps/web/src/components/ParlayDrawer.tsx` -- Mount `LineshopperWidget` in desktop and mobile drawer views above QuickPick CTA -- Completes user journey.

**Acceptance Criteria:**
- Given an assembled parlay in the Parlay Drawer with 2 or more legs, when lineshopper pricing evaluates, then comparative payouts are displayed for DraftKings, FanDuel, BetMGM, and Caesars in tabular `JetBrains Mono`.
- Given differing bookmaker odds across sportsbooks, then the bookmaker offering the highest decimal payout is highlighted with an emerald border (`#10b981`) and "Best Value" indicator, displaying the calculated dollar edge on a $50 stake.
- Given a user clicking on any available sportsbook card, then that sportsbook is set as the active `selectedSportsbook` with a cyan focus indicator (`#06b6d4`).
- Given a sportsbook missing a line for one of the active legs, then that bookmaker displays `Unavailable` and is disqualified from the Best Value designation.

## Implementation Notes

- Implemented `SPORTSBOOK_REGISTRY` and `INTEGRATED_SPORTSBOOKS` with FanDuel, DraftKings, BetMGM, and Caesars.
- Added pure functions `compareMultiBookOdds`, `calculateBookmakerPayout`, `calculateDollarEdge`, and deterministic quote fallbacks in `apps/web/src/lib/lineshopper.ts`.
- Implemented `LineshopperWidget` featuring JetBrains Mono tabular numeric typography (`font-telemetry`), emerald borders/badges for Best Value, and cyan ring focus indicators for selected sportsbooks.
- Integrated `selectedSportsbook` and `lineshopperComparison` reactive state into `ParlayDrawerContext` and mounted the widget into both desktop and mobile views of `ParlayDrawer`.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Evidence |
|---------|---------|----------|
| 1-leg slips designate a Best Value Book | `medium` | `compareMultiBookOdds` sets `isBestValue` on 1-leg slips, violating the spec constraint requiring at least 2 legs for Best Value parlay designation. |
| Active selection does not invalidate when chosen sportsbook becomes unavailable | `high` | QuickPick button in `ParlayDrawer` remains enabled when selected sportsbook is unavailable, and context does not fallback to an available book. |
| Missing component interaction tests for `LineshopperWidget` | `medium` | `LineshopperWidget.test.tsx` used `renderToStaticMarkup` exclusively; card click and keyboard events were never asserted. |
| Drawer header payout fails to reflect selected sportsbook | `false` | Consensus devigged odds on parlay ticket header vs retail lineshopper price comparison is by architectural design. |
| Deterministic fallback quote is static | `low` | Fallback multipliers are intentional deterministic placeholders when legs lack explicit provider quotes. |
| `benchmarkBookId` option is ignored | `low` | `CompareMultiBookOddsOptions` defined `benchmarkBookId` but `compareMultiBookOdds` always used dynamic runner-up. |
| Sub-dollar rounding artifact produces `+$0 Edge` | `low` | Rounding edge when diff is positive but $< 0.50$ displayed `+$0 Edge` instead of suppressing or formatting. |
| Duplicate `role="radiogroup"` between desktop/mobile | `low` | DrawerContent is mounted in both desktop and mobile views; adding unique IDs or aria-controls prevents ambiguity. |
| SGP correlation adjustments omitted in lineshopper | `false` | Story 3.1 covers cross-sportsbook lineshopper comparison; retail SGP correlation pricing across external books is outside Story 3.1 scope. |
| Missing arrow key navigation in radiogroup | `low` | Adding ArrowUp/ArrowDown handling enhances WAI-ARIA radio group standard accessibility. |
| `calculateBookmakerPayout` returns 1.0 on empty quotes | `low` | AGENTS.md invariant requires $D \ge 1.01$. |
| Generic `Unavailable` badge lacks missing leg count | `low` | Displaying `Unavailable (${missingLegCount} missing)` communicates why a book is disqualified. |
| Unverified auto-defaulting and manual override in `ParlayDrawerContext` | `medium` | Pre-verified verification gap: zero tests verified `setSelectedSportsbook` or auto-selection in context. |
| Quote decimal odds `Infinity` or non-finite | `low` | Adding `Number.isFinite(dec)` check prevents mathematical corruption on invalid input. |
| Missing key in `sportsbookQuotes` treated as synthetic quote | `medium` | When `leg.sportsbookQuotes` is populated, a missing book key indicates bookmaker unavailability and should not fall back to synthetic quotes. |

## Design Notes

- **Sportsbook Registry:**
  - `fanduel`: "FanDuel", brand color `#14805e` / `#2797ff`
  - `draftkings`: "DraftKings", brand color `#539f37`
  - `betmgm`: "BetMGM", brand color `#c4a265`
  - `caesars`: "Caesars", brand color `#0c2340` / `#caa150`
- **Dollar Edge Formula:**
  $$\text{Dollar Edge} = \left(D_{\text{best}} - D_{\text{runner\_up}}\right) \times \text{Reference Stake} \quad (\text{default } \$50)$$

## Verification

**Commands:**
- `npm --prefix apps/web test -- --run` -- expected: All Vitest unit tests pass including lineshopper tests.
- `npm --prefix apps/web run typecheck` -- expected: TypeScript compiles with 0 errors.
- `npm --prefix apps/web run build` -- expected: Production Next.js build succeeds.

**Manual checks (if no CLI):**
- Verify `LineshopperWidget` appears in desktop 360px Parlay Drawer and mobile bottom sheet.
- Verify clicking a sportsbook card toggles `selectedSportsbook` and updates the CTA button text to target that book.
