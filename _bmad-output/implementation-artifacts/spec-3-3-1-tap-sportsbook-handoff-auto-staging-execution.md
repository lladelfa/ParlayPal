---
title: 'Story 3.3: 1-Tap Sportsbook Handoff & Auto-Staging Execution'
type: 'feature'
created: '2026-11-10'
status: 'done'
baseline_commit: '5102713d6e3619c30ca6ea80cfdcf407734d635d'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Bettors who launch a generated parlay into a retail sportsbook lose continuity between ParlayPal and their actual wagers, requiring manual re-entry into a tracker or losing the ability to track Closing Line Value (CLV) and historical return on their curated tickets.

**Approach:** Implement a seamless 1-Tap Sportsbook Handoff and Auto-Staging workflow in `apps/web` and `services/worker`. Tapping the primary CTA in the Parlay Drawer generates the QuickPick smart link, triggers the deep-link redirect opening the target sportsbook app with pre-filled betslip, simultaneously stages the ticket with status `staged` in both local storage and the `/api/bets/stage` pending ledger, and displays an emerald confirmation toast (*"Slip opened in FanDuel & staged for tracking"*).

## Boundaries & Constraints

**Always:**
- Execute all internal odds representations in `Decimal` format ($D \ge 1.01$). Convert to American payout format (`+420`, `-110`) strictly at presentation boundaries.
- Adhere to Polyglot Service Isolation (AD-1): `apps/web` owns betslip serialization, deep-link synthesis, and `/api/bets/stage`; no direct browser calls to external `parlay-api.com`.
- Auto-stage the bet record with status `staged` (in PostgreSQL `user_bets` schema and client-side ledger).
- Support guest / unauthenticated users seamlessly: auto-staging must generate a valid UUID v4 `bet_id` and persist to `localStorage` (`parlaypal:staged_bets`) and `/api/bets/stage` without requiring authentication headers.
- Include complete ticket metadata in the staged bet: `betId`, `userId` (or guest UUID), `sportsbook`, `legs` (with propId, playerName, marketDisplay, line, selection, offeredDecimalOdds), `combinedDecimalOdds`, `combinedAmericanOdds`, `stake`, `potentialPayout`, `status: "staged"`, `quickpickUrl`, and `stagedAt` (ISO 8601 UTC).
- Ensure deep-link execution triggers appropriate app/web handoff: on mobile/desktop, attempts universal link or app deep link, with direct fallback link displayed to guard against popup blockers.
- Display the exact confirmation toast on successful handoff: `"Slip opened in {SportsbookName} & staged for tracking"` in Mint Emerald (`#10b981`) styling, dismissing automatically after 4–5 seconds.
- Update `services/worker/parlaypal_worker/models.py` `CheckConstraint("status IN ('STAGED', 'PENDING', 'WON', 'LOST', 'PUSH', 'VOID')", name="ck_user_bets_status")` to ensure full DB model alignment for downstream Epic 4 bet tracking.

**Never:**
- Never block the deep-link handoff or drop user bets if backend network staging encounters temporary latency or failure.
- Never require user registration or login before allowing bet staging or sportsbook handoff.
- Never clear active drawer legs on handoff unless explicitly requested or when starting a new slip.
- Never store invalid odds ($D < 1.01$) or suspect stale lines ($EV > 10.0\%$) into the staged bet ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 1-Tap Handoff & Staging (Happy Path) | 3-leg parlay, `sportsbook: "fanduel"`, stake: $50 | Deep-link triggered (`window.open` / universal link), bet staged via `POST /api/bets/stage`, saved in `localStorage`, toast: `"Slip opened in FanDuel & staged for tracking"` | HTTP 200 with staged bet payload |
| Single-Leg Handoff & Staging | 1 leg (e.g. Henry ATTD), `sportsbook: "draftkings"` | Deep-link triggered, 1-leg wager staged with `status: "staged"`, toast: `"Slip opened in DraftKings & staged for tracking"` | HTTP 200 with staged bet payload |
| Staging API Offline / Failure | Server unreachable or 500 on `/api/bets/stage` | Deep-link still triggers opening sportsbook; ticket safely cached in client `localStorage` pending ledger; user toast confirms staging | Non-blocking graceful degradation |
| Guest / Unauthenticated Bettor | No auth session or cookies | Staged bet created with anonymous/guest UUID v4 `userId`; successfully stored in `localStorage` and returned by staging API | No 401/403 redirects |
| Popup Blocker Interception | Browser blocks programmatic `window.open` | UI displays fallback `"Popup blocked: Open Slip ↗"` button alongside staging confirmation toast | Direct link visible and clickable |
| Empty Slip Handoff Attempt | 0 legs in slip | Primary CTA is disabled; no handoff or staging executed | UI disabled state |

</frozen-after-approval>

## Code Map

- `apps/web/src/types/bet.ts` -- Domain contracts for `StagedBet`, `BetLeg`, `StageBetRequest`, and `StageBetResponse`.
- `apps/web/src/lib/ledger.ts` -- Client-side ledger utility: saving/loading staged bets in `localStorage` (`parlaypal:staged_bets`), guest UUID generation, and state helpers.
- `apps/web/src/lib/ledger.test.ts` -- Unit tests for local ledger persistence, serialization, deduplication, and edge cases.
- `apps/web/src/app/api/bets/stage/route.ts` -- Next.js 15 App Router POST handler exposing `/api/bets/stage` with input validation, ISO 8601 UTC timestamping, and HTTP 200 response.
- `apps/web/src/app/api/bets/stage/route.test.ts` -- Route integration tests asserting HTTP 200 staged response, validation error codes, and guest user support.
- `apps/web/src/components/ParlayDrawer.tsx` -- Integration of 1-tap handoff: calls QuickPick serializer + `/api/bets/stage`, updates toast to `"Slip opened in {targetBookName} & staged for tracking"`, records to local ledger, and handles link redirect.
- `apps/web/src/components/ParlayDrawer.test.tsx` -- Component tests verifying 1-tap handoff button trigger, auto-staging API call, toast text, and popup blocker handling.
- `services/worker/parlaypal_worker/models.py` -- Update `UserBet` model `ck_user_bets_status` CheckConstraint to include `'STAGED'`.
- `services/worker/tests/test_substrate.py` -- Verify SQLAlchemy DDL check constraint includes `'STAGED'` in `ck_user_bets_status`.

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/types/bet.ts` -- Define domain types and schemas for `StagedBet`, `BetLeg`, `StageBetRequest`, `StageBetResponse` -- Establishes typed bet contracts.
- [x] `apps/web/src/lib/ledger.ts` -- Implement client-side ledger utility with `localStorage` persistence, guest user UUID handling, and helper functions -- Pure local ledger operations.
- [x] `apps/web/src/lib/ledger.test.ts` -- Implement unit test suite verifying ledger storage, retrieval, error tolerance, and serialization -- TDD Red/Green verification.
- [x] `apps/web/src/app/api/bets/stage/route.ts` -- Implement Next.js 15 App Router POST `/api/bets/stage` endpoint validating ticket data, assigning UUID v4 `bet_id`, stamping `status: "staged"` -- Auto-staging API endpoint.
- [x] `apps/web/src/app/api/bets/stage/route.test.ts` -- Implement API route integration tests asserting valid staging, 400 validation for empty/invalid legs, and guest user handling -- API test coverage.
- [x] `services/worker/parlaypal_worker/models.py` -- Update `UserBet` check constraint to include `'STAGED'` -- Database schema alignment.
- [x] `services/worker/tests/test_substrate.py` -- Update substrate unit tests for `UserBet` status constraint -- Substrate test coverage.
- [x] `apps/web/src/components/ParlayDrawer.tsx` -- Update `handleQuickPick` to execute 1-tap handoff, call `/api/bets/stage`, persist to local ledger, trigger sportsbook redirect, and display confirmation toast `"Slip opened in {targetBookName} & staged for tracking"` -- End-to-end drawer integration.
- [x] `apps/web/src/components/ParlayDrawer.test.tsx` -- Add/update component tests asserting auto-staging call, confirmation toast display, and deep-link redirect -- User interaction verification.

**Acceptance Criteria:**
- Given an active parlay (1 to 8 legs) and a selected sportsbook, when the user taps the primary CTA ("Open in Sportsbook"), then the browser triggers the deep-link redirect opening the target sportsbook app with all legs pre-populated in the betslip.
- Given a successful sportsbook handoff, then ParlayPal auto-stages the bet into the user's pending ledger with status `staged` via `POST /api/bets/stage` and `localStorage`, capturing `betId`, timestamp, stake, combined odds, and leg telemetry.
- Given a successful handoff and staging, then the UI displays a non-intrusive confirmation toast (*"Slip opened in {SportsbookName} & staged for tracking"*).
- Given guest or unauthenticated users, then auto-staging succeeds without requiring authorization headers or redirecting to a login page.

## Implementation Notes

- Implemented `StagedBet`, `BetLeg`, `StageBetRequest`, `StageBetResponse`, and error contracts in `apps/web/src/types/bet.ts`.
- Implemented client-side local storage ledger in `apps/web/src/lib/ledger.ts` managing `parlaypal:staged_bets` with 100-item cap, deduplication, guest UUID persistence (`parlaypal:guest_user_id`), SSR resilience, and invariant validation guards against invalid odds ($D < 1.01$) and suspect stale lines ($EV > 10.0\%$).
- Created Next.js 15 App Router endpoint `POST /api/bets/stage` in `apps/web/src/app/api/bets/stage/route.ts` with validation for sportsbook, leg bounds (1 to 8 legs), positive finite stake, leg odds ($1.01 \le D \le 9999.9999$), ticket odds, and suspect stale line exclusions.
- Updated `ParlayDrawer.tsx` `handleQuickPick` to execute the full 1-tap handoff workflow: generating QuickPick smart link, auto-staging to local storage and `/api/bets/stage` with shared `betId` and `userId`, triggering `window.open`, and presenting the Mint Emerald confirmation toast `"Slip opened in {targetBookName} & staged for tracking"`.
- Updated SQLAlchemy declarative model `UserBet` in `services/worker/parlaypal_worker/models.py` check constraint `ck_user_bets_status` to support `'STAGED'` and `'staged'`.
- Validated with 139 passing tests in web app, 72 passing tests in worker service, zero TypeScript errors, clean linting/formatting, and successful Next.js production build.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Evidence |
|---------|---------|----------|
| Divergent IDs between client and server staging | `high` | `handleQuickPick` in `ParlayDrawer.tsx` now passes `betId: staged.betId` and `userId: staged.userId` to `/api/bets/stage` so client ledger and server share identical IDs. |
| `window.open` with `noopener` falsely flags popup blocker | `medium` | Removed `"noopener,noreferrer"` feature string from `window.open(smartLink, "_blank")` so browser does not forcibly return null by specification. |
| Missing or non-numeric `offeredDecimalOdds` validation | `high` | `/api/bets/stage/route.ts` now validates all leg odds: requires $1.01 \le D \le 9999.9999$, rejecting invalid or missing odds with HTTP 400 `INVALID_ODDS`. |
| Missing odds and stale line validation in `stageBetLocally` | `medium` | `stageBetLocally` in `ledger.ts` now enforces $D \ge 1.01$ and rejects suspect stale lines ($EV > 0.10$ or `SUSPECT_STALE_LINE`) before persisting to `localStorage`. |
| Ticket-level odds allows $< 1.01$ | `medium` | Enforced ticket combined `decimalOdds` is finite and within $1.01 \le D \le 9999.9999$ in `/api/bets/stage/route.ts`. |
| Hardcoded stake without positive numeric validation | `medium` | Enforced `stakeAmount` is a positive finite number ($> 0$), rejecting negative or non-numeric values with HTTP 400 `INVALID_LEG_DATA`. |
| Missing upper-bound validation on decimal odds | `low` | Enforced $D \le 9999.9999$ per domain invariant across route and ledger validators. |
| Status casing discrepancy between web tier and DB check constraint | `medium` | Updated `UserBet` model check constraint to `"status IN ('STAGED', 'staged', 'PENDING', 'pending', 'WON', 'LOST', 'PUSH', 'VOID')"`, verified in `test_substrate.py`. |
| Missing component-level verification for drawer auto-staging and toast | `medium` | Pre-verified gap: added component interaction test in `ParlayDrawer.test.tsx` verifying handoff trigger calls staging, opens link, and renders toast. |
| Empty smartLink from serializer displays success toast | `low` | `handleQuickPick` now throws explicit error if serializer returns no valid URL, triggering error toast instead of claiming success. |
| Defensive null check in `saveStagedBet` filter | `low` | Added `b && typeof b === "object"` guard when filtering stored bets. |
| Asynchronous user activation popup blocking | `false` | Fallback direct link is explicitly rendered in the drawer (`Open Slip ↗`) when popup blockers intercept async `window.open`. |
| Empty spec documentation sections | `false` | Spec documentation sections are populated sequentially during review and implementation steps. |

## Design Notes

- **Staged Bet Schema (`apps/web/src/types/bet.ts`):**
  ```ts
  export interface StagedBet {
    betId: string;
    userId: string;
    sportsbook: string;
    decimalOdds: number;
    americanOdds: number;
    stakeAmount: number;
    potentialPayout: number;
    status: "staged";
    legs: BetLeg[];
    quickpickUrl: string;
    stagedAt: string; // ISO 8601 UTC
  }
  ```
- **Local Storage Key:** `parlaypal:staged_bets`
  Stored as JSON array of `StagedBet` objects, capped at the most recent 100 entries to prevent storage bloat.
- **Handoff Sequence:**
  1. Primary CTA clicked $\rightarrow$ set `isLaunching = true`.
  2. Request `/api/quickpick/serialize` with current legs and target sportsbook.
  3. Fire `/api/bets/stage` and save to local ledger (`localStorage`).
  4. Trigger `window.open(smartLink, "_blank", "noopener,noreferrer")` (or deep link).
  5. Show toast: `"Slip opened in ${targetBookName} & staged for tracking"`.
