---
title: 'Story 3.2: QuickPick Payload Serialization & Smart-Link Generator'
type: 'feature'
created: '2026-11-10'
status: 'done'
baseline_commit: '29f71d9d0bdb3eb75b6788b7c82f513b521e00ac'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Bettors who analyze and build high-conviction parlays in ParlayPal must manually search for each player, navigate market sub-menus, and re-enter every prop leg inside their retail sportsbook app, creating friction, latency, and frequent line drift before bets can be placed.

**Approach:** Implement a high-performance QuickPick betslip serialization engine and smart-link generator in `apps/web`. The Next.js 15 App Router endpoint `POST /api/quickpick/serialize` and client utility `serializeQuickPickPayload` transform active Parlay Drawer legs and the user's selected sportsbook into the universal Pikkit QuickPick schema (`quickpick.pikkit.com`), generating valid universal smart-links and bookmaker deep links in sub-50ms (well within the $\le 1500\text{ ms}$ p95 constraint) with guest/unauthenticated access.

## Boundaries & Constraints

**Always:**
- Execute all internal odds representations in `Decimal` format ($D \ge 1.01$). Convert to American payout format (`+420`, `-110`) strictly at presentation boundaries.
- Adhere to Polyglot Service Isolation (AD-1): `apps/web` owns betslip serialization, deep-link synthesis, and `/api/quickpick/serialize`; no browser calls to external `parlay-api.com`.
- Construe the universal QuickPick smart-link URL using the standard format: `https://quickpick.pikkit.com/v1/betslip?data={base64url_encoded_payload}`.
- Map sportsbooks to supported platform IDs: `fanduel`, `draftkings`, `betmgm`, `caesars`, `fanatics`, `sleeper`.
- Include full leg telemetry in the serialized payload: external event ID (prefixed `papi_` or provider ID), player name, market type, selection (`OVER` | `UNDER` | `YES`), line value, and offered odds.
- Guarantee response latency $\le 1500\text{ ms}$ at p95 (target $< 100\text{ ms}$ for in-memory serialization).
- Support guest and unauthenticated access for betslip serialization without requiring user login or session cookies.
- Return structured error payloads with HTTP 400 when parlay legs are empty, exceed maximum allowed leg count (8 legs), or target an unsupported sportsbook.

**Never:**
- Never call external `parlay-api.com` or third-party sportsbook scrapers from the client or Next.js server components.
- Never block drawer interactions or crash the UI when network serialization fails or is in-flight.
- Never generate QuickPick smart links for invalid parlays ($< 1$ leg or containing suspect stale lines).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Multi-Leg Parlay Serialization (Happy Path) | 2 legs (Henry ATTD, St. Brown O6.5 Rec), `sportsbook: "fanduel"`, stake: 50 | HTTP 200, valid `url` starting with `https://quickpick.pikkit.com/v1/betslip?data=...`, `universalLink`, `deepLink`, and full serialized payload | Valid JSON response |
| Single-Leg Bet Serialization | 1 leg (Luka Doncic O31.5 Pts), `sportsbook: "draftkings"` | HTTP 200, valid QuickPick URL with 1 selection | Valid JSON response |
| Empty Parlay Slip | `legs: []`, `sportsbook: "betmgm"` | HTTP 400 with `{ error: { code: "EMPTY_PARLAY_LEGS", message: "At least one leg is required." } }` | Clean client error |
| Unsupported Sportsbook | 2 valid legs, `sportsbook: "unsupported_book"` | HTTP 400 with `{ error: { code: "UNSUPPORTED_SPORTSBOOK", message: "Sportsbook 'unsupported_book' is not supported." } }` | Clean client error |
| Excessive Leg Count (> 8 Legs) | 9 valid legs, `sportsbook: "caesars"` | HTTP 400 with `{ error: { code: "MAX_LEGS_EXCEEDED", message: "Maximum 8 legs allowed per QuickPick slip." } }` | Clean client error |
| Malformed Leg Payload | 1 leg missing `propId` or `marketKey` | HTTP 400 with `{ error: { code: "INVALID_LEG_DATA", message: "..." } }` | Validated field errors |
| Drawer QuickPick CTA Integration | User clicks "⚡ Open in FanDuel via QuickPick" | Button enters loading state (`isLaunching=true`, spinner/pulse), calls `/api/quickpick/serialize`, receives link, triggers handoff callback, displays success toast | Graceful fallback toast on network failure |

</frozen-after-approval>

## Code Map

- `apps/web/src/types/quickpick.ts` -- QuickPick domain contracts: `QuickPickLeg`, `QuickPickPayload`, `QuickPickSerializeRequest`, `QuickPickSerializeResponse`.
- `apps/web/src/lib/quickpick.ts` -- Core serialization utility: `serializeQuickPickPayload`, `buildQuickPickUrl`, `generateSportsbookDeepLink`, URL-safe base64 encoding/decoding, input validation.
- `apps/web/src/lib/quickpick.test.ts` -- Unit tests validating serialization algorithms, schema compliance, base64 roundtrip, edge cases, and error conditions.
- `apps/web/src/app/api/quickpick/serialize/route.ts` -- Next.js 15 App Router POST API handler exposing `/api/quickpick/serialize` with latency tracking and validation.
- `apps/web/src/app/api/quickpick/serialize/route.test.ts` -- API route integration tests asserting HTTP 200, HTTP 400 error codes, and performance constraints.
- `apps/web/src/components/ParlayDrawer.tsx` -- Integration of QuickPick handoff: replacing mock timeout with real `/api/quickpick/serialize` call, loading animation, and handoff execution.
- `apps/web/src/components/ParlayDrawer.test.tsx` -- Component tests verifying QuickPick button trigger, loading state, and error handling.

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/types/quickpick.ts` -- Define domain types and schemas for QuickPick payload, serialized legs, request/response contracts -- Establishes typed contracts.
- [x] `apps/web/src/lib/quickpick.ts` -- Implement `serializeQuickPickPayload`, `buildQuickPickUrl`, `generateSportsbookDeepLink`, and validation helpers -- Pure serialization logic.
- [x] `apps/web/src/lib/quickpick.test.ts` -- Create comprehensive unit test suite covering payload generation, encoding, error cases, and edge cases -- TDD Red/Green verification.
- [x] `apps/web/src/app/api/quickpick/serialize/route.ts` -- Implement Next.js App Router POST route with input validation, latency stamping, and HTTP response handling -- Public API endpoint.
- [x] `apps/web/src/app/api/quickpick/serialize/route.test.ts` -- Implement integration tests for the API route verifying 200 responses, 400 validation, and p95 latency standards -- API test coverage.
- [x] `apps/web/src/components/ParlayDrawer.tsx` -- Update `handleQuickPick` in ParlayDrawer to call `/api/quickpick/serialize`, manage pending state, and execute link handoff -- End-to-end drawer integration.
- [x] `apps/web/src/components/ParlayDrawer.test.tsx` -- Add/update component tests asserting QuickPick button calls the serialization endpoint and responds to results -- User interaction verification.

**Acceptance Criteria:**
- Given a parlay in the Parlay Drawer with 1 to 8 legs and a selected target sportsbook, when the user initiates QuickPick handoff, then `POST /api/quickpick/serialize` returns HTTP 200 with a valid QuickPick smart-link URL within $\le 1500\text{ ms}$.
- Given an empty parlay slip or invalid legs submitted to `/api/quickpick/serialize`, then the API returns HTTP 400 with a descriptive error code and message.
- Given any supported sportsbook (`fanduel`, `draftkings`, `betmgm`, `caesars`, `fanatics`, `sleeper`), then the serializer maps the book identifier and generates corresponding universal and deep links.
- Given guest or unauthenticated users, then QuickPick payload serialization succeeds without requiring authorization headers or session state.

## Implementation Notes

- Implemented `QuickPickPayload`, `QuickPickLeg`, `QuickPickSerializeRequest`, and `QuickPickSerializeResponse` domain models in `apps/web/src/types/quickpick.ts`.
- Built pure utility `serializeQuickPickPayload` in `apps/web/src/lib/quickpick.ts` with RFC 4648 §5 base64url encoding, sportsbook deep-link generators, circuit breaker validation against suspect stale lines (>10.0% EV), and deterministic decimal odds formatting.
- Implemented `POST /api/quickpick/serialize` route handler in `apps/web/src/app/api/quickpick/serialize/route.ts` with input validation, latency tracking, `Server-Timing` headers, and guest unauthenticated access.
- Integrated `/api/quickpick/serialize` into `ParlayDrawer.tsx`, updating `handleQuickPick` to dispatch the serialized payload, manage loading animations, present error/success toasts, and trigger `window.open` handoff.
- Verified test coverage with 25 unit and integration tests across `quickpick.test.ts`, `route.test.ts`, and `ParlayDrawer.test.tsx`, achieving 100% test pass rate, clean TypeScript typechecking, and production build verification.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Evidence |
|---------|---------|----------|
| 1-leg QuickPick handoff disabled by `!slip.isValidParlay` check in `ParlayDrawer` | `high` | `ParlayDrawer.tsx` checks `!slip.isValidParlay` which requires 2+ legs, preventing single-leg bet handoff explicitly required by spec AC and I/O matrix. |
| Popup blocker suppression of `window.open` after async await fetch | `medium` | Modern browsers block unprompted async `window.open`; exposing `generatedLink` directly in toast/UI ensures user can access smart link if popup is blocked. |
| Missing validation for negative or non-finite `stake` | `medium` | `validateQuickPickRequest` allowed negative or non-finite stake values without throwing `INVALID_LEG_DATA`. |
| Missing decimal odds range enforcement ($D \ge 1.01$, $D \le 9999.9999$) | `medium` | Domain invariant requires $D \ge 1.01$ and upper bound guard; invalid/zero odds bypassed check. |
| Outlier flag `status === "SUSPECT_STALE_LINE"` unverified for nominal EV | `medium` | Pre-verified verification gap: existing test passed `guardedEv = 0.1500` which masked whether `status === "SUSPECT_STALE_LINE"` works independently. |
| ParlayDrawer QuickPick CTA trigger and async handoff untested at component level | `medium` | Pre-verified verification gap: tests only called fetch directly and rendered empty drawer. |
| Unreferenced `generatedLink` state in `ParlayDrawer` | `low` | `generatedLink` state was populated but never displayed in UI; rendering fallback link resolves popup block issue. |
| Deprecated `escape`/`unescape` in fallback base64url | `low` | Replaced with modern standard `TextEncoder`/`TextDecoder` for browser fallback. |
| Redundant sport prefixing in `formatExternalEventId` | `low` | Cleaned regex to prevent `papi_nfl_nfl-...` when event ID already contains sport slug. |
| Imprecise error for non-object JSON body | `low` | Non-object request body threw `EMPTY_PARLAY_LEGS` rather than `INVALID_LEG_DATA`. |
| Unmanaged timers on `ParlayDrawer` unmount | `low` | Added timer ref tracking to clear timeout handles on unmount. |
| Public unauthenticated endpoint payload size limit | `low` | Added 100kB request size guard to `/api/quickpick/serialize`. |
| Multiplicative parlay odds ignores correlation and SGP pricing | `false` | SGP pricing is executed by downstream retail sportsbook engine; QuickPick payload calculates baseline ticket decimal odds. |
| Selection validation excludes complementary prop outcomes | `false` | In-scope MVP markets (PRD §6.1) are ATTD (YES) and Over/Under prop markets. |
| Unchecked task checkboxes and empty spec logs | `false` | Task checkboxes and triage log are maintained in sequential step workflow and updated during verification/review. |

## Design Notes

- **QuickPick URL Format:**
  `https://quickpick.pikkit.com/v1/betslip?data={BASE64URL_ENCODED_JSON}`
- **Sportsbook Direct Deep Link Schemes:**
  - `fanduel`: `fanduel://sportsbook/betslip?quickpick={DATA}` (web fallback: `https://sportsbook.fanduel.com`)
  - `draftkings`: `draftkings://sportsbook/betslip?quickpick={DATA}` (web fallback: `https://sportsbook.draftkings.com`)
  - `betmgm`: `betmgm://sportsbook/betslip?quickpick={DATA}` (web fallback: `https://sports.betmgm.com`)
  - `caesars`: `williamhill://sportsbook/betslip?quickpick={DATA}` (web fallback: `https://www.caesars.com/sportsbook-and-casino`)
  - `fanatics`: `fanatics://sportsbook/betslip?quickpick={DATA}` (web fallback: `https://sportsbook.fanatics.com`)
  - `sleeper`: `sleeper://picks/betslip?quickpick={DATA}` (web fallback: `https://sleeper.com`)

## Verification

**Commands:**
- `npm --prefix apps/web test -- --run` -- expected: All Vitest unit tests pass including QuickPick tests.
- `npm --prefix apps/web run typecheck` -- expected: TypeScript compiles with 0 errors.
- `npm --prefix apps/web run build` -- expected: Production Next.js build succeeds.

**Manual checks (if no CLI):**
- Verify clicking QuickPick button in desktop and mobile drawer invokes `/api/quickpick/serialize`.
- Verify toast alert appears on completion and button exhibits loading spinner during request.
