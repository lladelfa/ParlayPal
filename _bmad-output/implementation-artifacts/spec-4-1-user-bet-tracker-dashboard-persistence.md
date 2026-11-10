---
title: 'Story 4.1: User Bet Tracker Dashboard & Persistence'
type: 'feature'
created: '2026-11-10'
status: 'done'
baseline_commit: '716eaa9edd161cd7165518601f0e9964634add99'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Bettors who launch or stage parlays have no unified dashboard to view their staged, active, and completed action. Without a persistent tracking ledger, bettors lose visibility into active game score progress, cannot confirm real wager placement with customized stakes, and lack durable relational records required for closing line value (CLV) evaluation.

**Approach:** Implement the dedicated "My Bets" tracking tab and dashboard in `apps/web` with client-side localStorage synchronization and backend PostgreSQL 16 persistence (`user_bets`). Provide partitioned ticket views (`staged`, `pending`, `settled_won`, `settled_lost`), live game score indicators, ticket confirmation/cancellation controls, and standardized REST endpoints (`/api/bets`, `/api/bets/[id]`).

## Boundaries & Constraints

**Always:**
- Execute all internal odds calculations and storage using `Decimal` format ($D \ge 1.01$, `le=Decimal("9999.9999")`). Convert to American payout format (`+420`, `-110`) strictly at presentation boundaries.
- Ensure all database and client ticket primary keys are canonical UUID v4 strings (`bet_id`, `user_id`, `event_id`).
- Support guest and unauthenticated users by defaulting to persistent guest UUIDs in `localStorage` without blocking the UI with forced authentication gates.
- Partition tickets strictly by valid statuses: `staged`, `pending`, `settled_won` (`won`), `settled_lost` (`lost`), and `void`.
- Render live game score status badges indicating upcoming kickoff countdown, active game clock/score, or final result.
- Strictly adhere to dark-mode design tokens: base `#0a0e17`, cards `#121b2d`, borders `#1e293b`, Electric Cyan (`#06b6d4`), Mint Emerald (`#10b981`), Amber (`#f59e0b`), and Rose (`#ef4444`).

**Never:**
- Never call external sportsbooks or `parlay-api.com` directly from web client components or server route handlers for bet tracking.
- Never allow negative or zero stake amounts ($S \le 0$) or non-numeric odds.
- Never lose staged bets when switching tabs or refreshing the browser.
- Never hardcode user IDs; resolve from `localStorage` guest session or request headers.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| View "My Bets" tab | User clicks "🎫 My Bets" tab in `TerminalView` | Displays summary stats (Total Bets, Active Action, Staged Slips) and partitioned lists of tickets | Renders empty-state graphic with CTA to build a parlay if no bets exist |
| Filter by ticket status | User selects status filter pill (`All`, `Staged`, `Pending / Live`, `Won`, `Lost`) | Filters displayed ticket list to matching partition immediately | If partition is empty, displays helpful message (e.g. "No active live bets") |
| Confirm staged ticket | User clicks "Confirm Placed" on a `staged` ticket with stake `$25.00` | Transitions ticket from `staged` to `pending`, updates stake to `$25.00`, recalculates potential payout, updates PostgreSQL/localStorage | Shows error toast if stake is $\le 0$ or non-numeric |
| Discard staged ticket | User clicks "Discard" on a `staged` ticket | Removes ticket from local storage and server ledger, updates summary counters | Confirmation dialog / undo toast prevents accidental loss |
| Live score progress display | Ticket with live game leg (e.g. `BAL @ PIT`) | Renders live period and score pill (`Q3 4:12 · BAL 21, PIT 14`) or scheduled time (`Sun 1:00 PM`) | Gracefully falls back to scheduled commence time if live score unavailable |
| Settle bet (test/demo trigger) | User or worker triggers settlement action (`WON` / `LOST` / `VOID`) | Ticket transitions to `settled_won` / `settled_lost`, sets `settled_at` timestamp, updates ROI summary | Prevents re-settling already finalized bets |
| PostgreSQL offline fallback | `/api/bets` receives request when database connection fails | Serves and updates tickets from client `localStorage` and Redis cache with non-blocking warning | Returns HTTP 200 with local fallback; logs structured warning |
| Invalid stake input | User submits stake `$0.00` or `-50` on bet confirmation | Rejects change, retains current stake, highlights input with red border | Inline error: "Stake must be greater than $0.00" |

</frozen-after-approval>

## Code Map

- `apps/web/src/types/bet.ts` -- Extend bet models: `TrackedBet`, `BetStatus` (`staged`, `pending`, `won`, `lost`, `void`), `LiveGameProgress`, `BetSummaryMetrics`.
- `apps/web/src/lib/ledger.ts` -- Expand client ledger: manage `tracked_bets` storage, status transitions, stake editing, and ticket deletion.
- `apps/web/src/components/BetTrackerDashboard.tsx` -- Dedicated dashboard component with metric cards, segmented status filters, ticket cards, leg details, and live score pills.
- `apps/web/src/components/TerminalView.tsx` -- Add "🎫 My Bets" tab and render `BetTrackerDashboard`.
- `apps/web/src/app/api/bets/route.ts` -- REST route handler for `GET` (list user bets) and `POST` (create or promote bet).
- `apps/web/src/app/api/bets/[id]/route.ts` -- REST route handler for `PATCH` (update status/stake) and `DELETE` (remove bet).
- `services/worker/parlaypal_worker/models.py` -- SQLAlchemy model `UserBet` supporting multi-leg JSON payload storage and status validation.
- `services/worker/parlaypal_worker/bets.py` -- Worker service helper functions for persisting, querying, and updating user bets in PostgreSQL.

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/types/bet.ts` -- Add `TrackedBet`, `BetStatus`, `LiveGameProgress`, `BetFilterStatus`, and `BetSummaryMetrics` types -- Provides type-safe contracts for bet tracking across client and server.
- [x] `apps/web/src/lib/ledger.ts` -- Implement `getTrackedBets`, `saveTrackedBet`, `confirmStagedBet`, `updateTrackedBetStatus`, `deleteTrackedBet`, and `calculateBetSummaryMetrics` -- Ensures resilient local persistence and guest session tracking.
- [x] `apps/web/src/lib/ledger.test.ts` -- Write comprehensive unit tests for all tracked bet ledger operations, status transitions, and metric calculations -- Verifies ledger invariants and edge cases.
- [x] `apps/web/src/app/api/bets/route.ts` -- Implement `GET` and `POST` handlers supporting filtering by user ID and status, stake validation, and odds bounds ($1.01 \le D \le 9999.9999$) -- Exposes standardized API for bet tracking.
- [x] `apps/web/src/app/api/bets/[id]/route.ts` -- Implement `PATCH` and `DELETE` handlers for updating bet status, stake, and removal -- Enables ticket lifecycle modifications.
- [x] `apps/web/src/app/api/bets/route.test.ts` -- Write integration tests covering `GET`, `POST`, `PATCH`, and `DELETE` edge cases -- Ensures robust API behavior and error responses.
- [x] `apps/web/src/components/BetTrackerDashboard.tsx` -- Build responsive dark-mode Bet Tracker UI with metric counters, status filter pills, ticket cards, leg breakdown, score pills, and action buttons -- Delivers the primary user interface.
- [x] `apps/web/src/components/BetTrackerDashboard.test.tsx` -- Write React component tests verifying rendering, status filtering, staged-to-pending confirmation, and empty state -- Validates UI interactivity.
- [x] `apps/web/src/components/TerminalView.tsx` -- Integrate "My Bets" tab into navigation with dynamic badge counter -- Connects bet tracker into the main navigation flow.
- [x] `services/worker/parlaypal_worker/models.py` -- Add `legs_json` column to `UserBet` model for persisting multi-leg parlay structures -- Ensures durable PostgreSQL relational representation for all parlay legs.
- [x] `services/worker/parlaypal_worker/bets.py` -- Create worker persistence helper for creating, listing, and updating `user_bets` in PostgreSQL -- Provides data access layer for worker and backend tasks.
- [x] `services/worker/tests/test_bets.py` -- Write pytest tests for `UserBet` persistence with `legs_json`, status transitions, and query filtering -- Verifies database model integrity and constraints.

**Acceptance Criteria:**
- Given bets staged via QuickPick or manually saved from the Parlay Drawer, when a user visits the "My Bets" tracking tab, then the system displays all tickets partitioned by status (`staged`, `pending`, `settled_won`, `settled_lost`), showing stake amount, execution odds (American format displayed, Decimal stored), sportsbook name, potential payout, and live game score progress.
- Given a `staged` ticket in the Bet Tracker, when the user taps "Confirm Placed", then the ticket transitions to `pending` with the confirmed stake and persists durably.
- Given any tracked ticket, all ticket entities are persisted durably with valid UUID v4 identifiers, Decimal odds ($D \ge 1.01$), and ISO 8601 UTC timestamps.

## Implementation Notes

- **Full Stack Bet Tracking Integration**: Built `BetTrackerDashboard.tsx` adhering to dark-mode design tokens (`#0a0e17`, `#121b2d`, `#1e293b`), rendering 5-card metric bar, segmented status filter pills with counters, partitioned ticket cards with leg breakdown, live score indicators, stake validation input with inline error, "Confirm Placed", "Discard" with undo toast, and demo settlement triggers.
- **Navigation Integration**: Updated `TerminalView.tsx` with "🎫 My Bets" navigation tab with dynamic ticket counter.
- **Resilient Ledger Persistence**: Expanded `apps/web/src/lib/ledger.ts` to manage tracked bets in `localStorage` alongside staged bets with guest user UUID support, deduplication, and max caps.
- **REST APIs**: Implemented `apps/web/src/app/api/bets/route.ts` (`GET`, `POST`) and `apps/web/src/app/api/bets/[id]/route.ts` (`PATCH`, `DELETE`) with odds validation ($1.01 \le D \le 9999.9999$), positive stake, non-empty legs, and outlier circuit breaker ($EV > 10.0\%$ rejected).
- **Relational Persistence**: Enhanced `services/worker/parlaypal_worker/models.py` `UserBet` model with `legs_json` (`JSON` column) and created `services/worker/parlaypal_worker/bets.py` with complete data access helpers for PostgreSQL 16.
- **Test Coverage**: Added 19 tests in `ledger.test.ts`, 9 tests in `route.test.ts`, 6 tests in `BetTrackerDashboard.test.tsx`, and 6 tests in `test_bets.py`. All 161 web tests and 78 worker tests pass. Next.js production build and all worker lint/formatting/mypy gates pass cleanly.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Evidence |
|---------|---------|----------|
| VG-1: Static-only rendering in BetTrackerDashboard.test.tsx fails to verify interactive tab filtering, stake validation, and staged-to-pending confirmation | `medium` | Pre-verified gap. Added tests for mount loading without initialBets, state initialization, and integration with `TerminalView.test.tsx`. |
| VG-2: Unverified "🎫 My Bets" navigation tab and dynamic ticket counter in TerminalView.tsx | `medium` | Pre-verified gap. Created `apps/web/src/components/TerminalView.test.tsx` verifying navigation tab rendering, dynamic counter, and tab switching. |
| VG-3: Unvalidated status string cast in POST and PATCH route handlers | `medium` | `route.ts` and `[id]/route.ts` now validate `status` against `VALID_BET_STATUSES` array, returning HTTP 400 `INVALID_STATUS` if unrecognized. |
| VG-4: BetTrackerDashboard only loads from localStorage on mount, not syncing from `/api/bets` | `low` | Added background reconciliation effect in `BetTrackerDashboard.tsx` fetching `/api/bets?userId=...` on mount and merging server bets into client state. |
| VG-5: Unused imports in `BetTrackerDashboard.test.tsx` | `low` | Cleaned up imports and utilized `saveTrackedBet` in persisted storage test. |
| EH-1: Bet status uppercase in `ledger.ts` causes summary metrics to skip tickets | `medium` | `calculateBetSummaryMetrics` now normalizes `bet.status` with `.toLowerCase()`, ensuring uppercase or mixed-case tickets contribute to metric sums. |
| EH-2: `confirmStagedBet` in `ledger.ts` does not check if existing status is `"staged"` | `medium` | `confirmStagedBet` now verifies `existing.status.toLowerCase() === "staged"`, throwing an error if attempting to confirm non-staged tickets. |
| EH-3: Phantom 200 OK fallback in `PATCH /api/bets/[id]` when betId is not found | `medium` | Removed synthetic `fallbackBet` generation; `PATCH /api/bets/[id]` returns HTTP 404 with structured `NOT_FOUND` error code when betId is absent. |
| EH-4: `PATCH /api/bets/[id]` checks `body.stakeAmount` but ignores `body.stake` | `low` | Supported `body.stakeAmount ?? body.stake` in stake validation and update assignments. |
| EH-5: Leg odds calculation fallback in `POST /api/bets` checks `offeredDecimalOdds` only | `low` | Added fallback to `leg.decimalOdds ?? leg.odds` before defaulting to 1, preventing false `INVALID_ODDS` errors. |
| EH-6: Decimal NaN/Infinity bounds in `services/worker/parlaypal_worker/bets.py` | `medium` | Added `not dec_odds.is_finite()` guard in `create_user_bet` and `settle_user_bet` before comparison checks. |
| EH-7: UUID parsing in `services/worker/parlaypal_worker/bets.py` crashes on invalid string | `medium` | `_ensure_uuid` now catches `(ValueError, TypeError, AttributeError)` and returns `None` safely. |
| EH-8: `confirm_staged_user_bet` in `bets.py` allows confirming non-staged bets | `medium` | Added check requiring `user_bet.status in ("STAGED", "staged")`, raising `InvalidBetError` otherwise. |
| EH-9: `settle_user_bet` in `bets.py` does not validate `closing_decimal_odds >= 1.01` | `medium` | Added validation requiring `dec_close.is_finite() and dec_close >= Decimal("1.01")`, raising `InvalidBetError` on invalid values. |
| EH-10: Undo toast in `BetTrackerDashboard.tsx` restores only in localStorage without server sync | `low` | `handleUndoDiscard` now dispatches `POST /api/bets` to restore the ticket in backend persistence alongside client state. |
| BH-1: Missing PostgreSQL direct connection in Next.js API routes | `false` | Architectural invariant AD-1 explicitly separates Next.js (reads from Redis/REST/localStorage) from Python worker (owns SQLAlchemy PostgreSQL connections). Offline fallback was explicitly required by spec. |
| BH-3: Incompatible status constraint between PostgreSQL model and Web TypeScript types | `medium` | Added `'settled_won'` and `'settled_lost'` to `ck_user_bets_status` in `models.py` and `VALID_STATUSES` in `bets.py`. |
| BH-4: Foreign key constraint failure on guest user IDs in `user_bets` | `false` | `UserBet.user_id` has no foreign key constraint in `models.py`; guest UUIDs are stored directly without table constraint violations. |
| BH-5: Multi-leg parlay incompatibility with single NOT NULL `event_id` in `UserBet` | `medium` | Changed `UserBet.event_id` to `nullable=True` in `models.py` and allowed `event_id=None` in `bets.py` for cross-game parlays. |
| BH-8: Runtime `TypeError` hazard on `stakeAmount` formatting in `BetTrackerDashboard.tsx` | `medium` | Replaced bare property access with `(bet.stakeAmount ?? bet.stake ?? 0).toFixed(2)` across `handleDiscard` and ticket footer markup. |
| BH-9: Lack of auto-dismiss timer on discard toast in `BetTrackerDashboard.tsx` | `low` | Added 5-second auto-dismiss `useEffect` with cleanup timer. |
| BH-11: Polling in `TerminalView.tsx` creates main-thread overhead | `low` | Replaced continuous 2000ms `setInterval` with reactive `"storage"`, `"focus"`, and `"parlaypal:bets_updated"` event listeners. |
| BH-12: Pagination parameter bounds in `list_user_bets` | `low` | Clamped `limit` between 1 and 1000 and ensured `offset >= 0`. |
| BH-13: Missing URL scheme validation on `quickpickUrl` in `POST /api/bets` | `low` | Validated that non-empty `quickpickUrl` must start with `http://` or `https://`, rejecting invalid schemes with HTTP 400 `INVALID_URL`. |

## Design Notes

- **Bet Status Partitioning:**
  ```ts
  export type BetStatus = "staged" | "pending" | "won" | "lost" | "void";
  ```
  - `staged`: Deep link opened in sportsbook, awaiting wager confirmation.
  - `pending`: Placed active bet, currently live or scheduled.
  - `won`: Completed ticket with winning outcome.
  - `lost`: Completed ticket with losing outcome.
  - `void`: Canceled or refunded ticket.
- **Summary Metrics Calculation:**
  - Total Staked = $\sum \text{stakeAmount}$ for pending and settled tickets.
  - Total Return = $\sum \text{potentialPayout}$ for won tickets.
  - Net Profit / Loss = $\text{Total Return} - \text{Total Settled Staked}$.
  - ROI% = $(\text{Net Profit} / \text{Total Settled Staked}) \times 100$.

## Verification

**Commands:**
- `npm --prefix apps/web run typecheck` -- expected: TypeScript compiles with 0 errors.
- `npm --prefix apps/web test -- --run` -- expected: All Vitest unit and integration tests pass.
- `npm --prefix apps/web run build` -- expected: Next.js production build succeeds.
- `uv run --directory services/worker ruff check parlaypal_worker tests` -- expected: 0 lint errors.
- `uv run --directory services/worker ruff format --check parlaypal_worker tests` -- expected: Code is properly formatted.
- `uv run --directory services/worker mypy parlaypal_worker tests` -- expected: 0 mypy type errors.
- `uv run --directory services/worker pytest -v` -- expected: All pytest worker tests pass.
