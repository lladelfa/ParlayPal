---
title: 'Story 2.3: Real-Time Odds, SGP Correlation Boost & Hybrid Score Engine'
type: 'feature'
created: '2026-11-09'
status: 'done'
route: 'dispatch'
baseline_commit: 'efa559f131d795f45e5e8118dea86ff1fe61733e'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Bettors lack real-time visibility into whether combining player props from the same game introduces positive synergy or negative cannibalization, and need dynamic parlay payout, EV, and composite Hybrid Value Score recalculations as individual leg odds shift over live streams without UI freezing.

**Approach:** Implement a dual-path parlay valuation engine across `services/worker` and `apps/web`. The Python worker provides SGP pricing and correlation auditing against ParlayAPI (`POST /v1/sgp/price`), caching audit metadata in Redis (`sgp:audit:{event_id}`). Next.js evaluates active slip legs: independent cross-game legs compute fair probability as $\prod P_{\text{fair}, i}$, while same-game legs trigger SGP correlation resolution via `/api/sgp/price`. Positive synergy triggers a glowing Violet `⚡ Correlated Boost` badge with correlation pair telemetry in the Parlay Drawer, and incoming Server-Sent Events (SSE) odds updates dynamically reprice the slip without UI stutter.

## Boundaries & Constraints

**Always:**
- Follow strict Test-Driven Development (TDD) (Red $\rightarrow$ Green $\rightarrow$ Refactor) in Python worker and TypeScript web app.
- Enforce Polyglot Service Isolation (AD-1 & AD-5): worker service owns external `parlay-api.com` calls and Redis caching; web app reads from Redis (`sgp:audit:{event_id}`) and internal endpoints, never calling external bookmakers or `parlay-api.com` directly from the browser.
- Dual-Path Valuation:
  - **Cross-Game Independent Parlays:** $D_{\text{combined}} = \prod D_i$, $P_{\text{fair}} = \prod P_{\text{fair}, i}$, $\text{EV}_{\text{combined}} = (P_{\text{fair}} \times D_{\text{combined}}) - 1$.
  - **Same-Game Parlays (SGPs):** When $\ge 2$ legs share the same `event_id`, compute correlation-adjusted fair probability $P_{\text{sgp\_fair}}$, combining with any remaining independent legs: $P_{\text{total\_fair}} = P_{\text{sgp\_fair}} \times \prod_{j \notin \text{sgp}} P_{\text{fair}, j}$.
- Dynamic Hybrid Value Score formula:
  $$\text{Score} = \text{clamp}\left(0, 100, \text{round}\left(0.60 \times \bar{H}_{\text{L10}} + 0.40 \times \text{clamp}\left(0, 100, \text{EV}_{\text{combined}}\% \times 10 + 50\right)\right)\right)$$
- Display `⚡ Correlated Boost` badge strictly when positive synergy is verified ($P_{\text{sgp\_fair}} > \prod P_{\text{fair}, i}$ or positive correlation coefficients in audit); render neutral indicator if synergy is negative or neutral.
- Zero layout shift during live SSE updates: all odds, payouts, and hit rates render in fixed-width tabular numbers (`JetBrains Mono`).

**Never:**
- Never call external `parlay-api.com` from Next.js client or API routes.
- Never freeze user interface or trigger full page reload during live SSE odds recalculation or SGP audit fetches.
- Never award `⚡ Correlated Boost` badge when correlation is negative or unverified.
- Never exceed 8 legs per ticket or compute combined parlay payout for fewer than 2 legs.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Cross-Game Independent | 2 legs from different games: Leg A ($D=1.9091, P=0.50$), Leg B ($D=1.9091, P=0.50$) | $D=3.6447$ (`+264`), $P_{\text{fair}}=0.25000$, $\text{EV}=-0.0888$, `isSameGameParlay=false`, no SGP badge | N/A |
| SGP Positive Synergy | 2 legs same event: Mahomes Over Pass Yds ($P=0.50$), Kelce Over Rec ($P=0.50$), correlation $= +0.48$, $P_{\text{sgp\_fair}}=0.3200$ | $P_{\text{total\_fair}}=0.32000 > 0.25000$, `isSameGameParlay=true`, `hasPositiveSynergy=true`, displays `⚡ Correlated Boost` badge + correlation audit breakdown | Fallback to unadjusted product if audit fails |
| SGP Negative Cannibalization | 2 legs same event with negative correlation (e.g. opposing running backs) | $P_{\text{sgp\_fair}} \le \prod P_{\text{fair}, i}$, `isSameGameParlay=true`, `hasPositiveSynergy=false`, neutral SGP tag without "Boost" | Graceful neutral state |
| Hybrid Parlay | 2 legs Game 1 (SGP $P_{\text{sgp\_fair}}=0.30$) + 1 leg Game 2 ($P=0.52$) | $P_{\text{total\_fair}} = 0.30 \times 0.52 = 0.15600$, $D_{\text{combined}} = D_1 D_2 D_3$, EV and score updated dynamically | Handled uniformly |
| Live SSE Odds Delta | Active slip contains prop `prop-123`; SSE emits odds tick $1.90 \rightarrow 2.05$ | Slip updates `prop-123` odds, recalculates $D_{\text{combined}}$, payout, and score instantly without layout shift | Invalid payload ignored |
| Redis Offline / SGP Error | Worker or Web attempts SGP pricing while Redis / ParlayAPI unreachable | Returns calculated correlation estimate from heuristic matrix, logs warning, keeps drawer functional | Heuristic fallback |

</frozen-after-approval>

## Code Map

- `services/worker/parlaypal_worker/sgp.py` -- SGP pricing models (`SgpLegSelection`, `SgpAuditItem`, `SgpPriceResponse`), correlation calculation, external `POST /v1/sgp/price` client, and heuristic fallback.
- `services/worker/parlaypal_worker/celery_app.py` -- Register `parlaypal_worker.price_sgp_event` Celery task caching audit to `sgp:audit:{event_id}`.
- `services/worker/tests/test_sgp.py` -- Pytest tests for SGP models, correlation calculation, synergy detection, and Redis caching.
- `apps/web/src/types/parlay.ts` -- Extend `ParlaySlip` with `hasPositiveSynergy`, `sgpFairProbability`, and structured `SgpCorrelationAuditItem[]`.
- `apps/web/src/lib/parlay.ts` -- Extend `calculateParlaySlip` with SGP correlation integration, intra-game and cross-game combination, and synergy evaluation.
- `apps/web/src/lib/parlay.test.ts` -- Vitest tests for SGP positive synergy boost, negative correlation, hybrid cross-game legs, and edge cases.
- `apps/web/src/app/api/sgp/price/route.ts` -- API route serving cached or calculated SGP correlation and adjusted pricing from Redis (`sgp:audit:{event_id}`).
- `apps/web/src/app/api/sgp/price/route.test.ts` -- Vitest tests for `/api/sgp/price` endpoint (cached hits, positive synergy, negative correlation, Redis fallback).
- `apps/web/src/context/ParlayDrawerContext.tsx` -- Asynchronous SGP pricing resolution when `isSameGameParlay` changes, and live SSE odds recalculation.
- `apps/web/src/components/ParlayDrawer.tsx` -- Update drawer UI to display `⚡ Correlated Boost` with correlation audit details, neutral SGP tags, and dynamic Hybrid Value Score.

## Tasks & Acceptance

**Execution:**
- [x] `services/worker/parlaypal_worker/sgp.py` & `services/worker/tests/test_sgp.py` -- Write Red-phase Pytest tests and implement SGP pricing models, correlation calculation, synergy detection, and Redis caching (`sgp:audit:{event_id}`) -- Delivers worker SGP substrate.
- [x] `services/worker/parlaypal_worker/celery_app.py` -- Register Celery task `parlaypal_worker.price_sgp_event` and verify with tests -- Enables asynchronous worker execution.
- [x] `apps/web/src/types/parlay.ts` & `apps/web/src/lib/parlay.ts` -- Extend parlay slip types and pure calculation functions to handle SGP correlation adjustments, synergy detection, and hybrid SGP + cross-game math -- Provides verified domain math.
- [x] `apps/web/src/lib/parlay.test.ts` -- Add unit tests for SGP positive synergy boost, negative correlation, hybrid cross-game legs, and edge cases -- Enforces TDD coverage.
- [x] `apps/web/src/app/api/sgp/price/route.ts` & `apps/web/src/app/api/sgp/price/route.test.ts` -- Implement and test `/api/sgp/price` endpoint reading from Redis `sgp:audit:{event_id}` with heuristic fallback -- Connects web layer to correlation data.
- [x] `apps/web/src/context/ParlayDrawerContext.tsx` & `apps/web/src/components/ParlayDrawer.tsx` -- Wire SGP correlation fetching into drawer state, render `⚡ Correlated Boost` badge with correlation pair telemetry, and verify real-time SSE updates without layout shift -- Completes user-facing feature.

**Acceptance Criteria:**
- Given multiple selections in the Parlay Drawer, when independent cross-game legs are combined, then the system calculates fair parlay probability as $\prod P_{\text{fair}, i}$ and displays American payout (e.g. `+485`).
- Given two or more selections sharing the same `event_id`, when the slip is evaluated, then the system tags the slip as a Same-Game Parlay (SGP), requests SGP correlation resolution, and displays the `⚡ Correlated Boost` badge with correlation audit details when positive synergy is detected.
- Given an active slip with one or more legs, when real-time odds deltas arrive via `/api/stream/odds`, then all odds, payout values, and Hybrid Value Scores recompute dynamically without freezing the browser or shifting UI layout.

## Implementation Notes

- Implemented SGP pricing models and pairwise empirical correlation heuristics across NFL (passing + receiving synergy vs rushing competition) and NBA (assist + points synergy vs scoring/rebounding competition) in Python worker `parlaypal_worker/sgp.py` and TypeScript `apps/web/src/lib/parlay.ts`.
- Registered `price_sgp_event` Celery task with 45-second Redis TTL caching at `sgp:audit:{event_id}`.
- Extended Next.js web application with dual-path parlay calculations, `/api/sgp/price` endpoint with Redis hot cache and heuristic fallback, live SSE odds repricing, and glowing Violet `⚡ Correlated Boost` badge with pair telemetry in `ParlayDrawer.tsx`.
- All verification gates passed across Python (`ruff`, `mypy`, `pytest` - 72 tests) and Next.js (`tsc --noEmit`, `vitest` - 51 tests, `next build`).

## Spec Change Log

## Review Triage Log

- In `services/worker/parlaypal_worker/sgp.py` & `apps/web/src/lib/parlay.ts`: `hasPositiveSynergy` evaluates to true when any pair has correlation > 0.10, even if the net cluster fair probability is lower than unadjusted product (net cannibalization). Verdict: `high`. Route: `patch`.
- In `apps/web/src/context/ParlayDrawerContext.tsx`: Stale SGP overrides are retained when leg removals drop an event below 2 legs. Verdict: `high`. Route: `patch`.
- In `apps/web/src/app/api/sgp/price/route.ts`: Cached SGP audit check lacks leg selection matching, allowing different leg combinations in the same event to collide on cache hits. Verdict: `medium`. Route: `patch`.
- In `apps/web/src/app/api/sgp/price/route.ts`: `GET /api/sgp/price` endpoint lacks automated unit tests and does not normalize snake_case Redis audit envelope to camelCase `SgpPriceResponse`. Verdict: `medium`. Route: `patch`.
- In `apps/web/src/app/api/sgp/price/route.ts`: Missing same-event validation when legs array contains mismatched event IDs. Verdict: `medium`. Route: `patch`.
- In `apps/web/src/lib/parlay.ts`: `estimateHeuristicPairCorrelation` omits the `UNDER` passing + `UNDER` receiving positive synergy branch (+0.40) implemented in worker service. Verdict: `medium`. Route: `patch`.
- In `apps/web/src/lib/parlay.test.ts`: Missing test coverage verifying that calling `updateSlipLegOdds` with `sgpOverrides` preserves SGP boost fair probability during live SSE updates. Verdict: `medium`. Route: `patch`.
- In `apps/web/src/context/ParlayDrawerContext.tsx`: `setSlip` called inside `setSgpOverrides` state updater (React anti-pattern). Verdict: `medium`. Route: `patch`.
- In `apps/web/src/components/ParlayDrawer.tsx`: Correlation audit list items use unstable array index keys (`key={idx}`). Verdict: `low`. Route: `patch`.
- In `apps/web/src/app/api/sgp/price/route.ts`: Cache-Control header on HTTP POST route. Verdict: `low`. Route: `patch`.
- Celery pricing task not directly dispatched from web route: Deferred / intentional Phase 1 architectural boundary (AD-1 & AD-5); worker tasks run asynchronously via Celery worker. Verdict: `false`. Route: `defer`.

## Design Notes

- **SGP Synergy Rule:** Positive synergy is defined as $P_{\text{sgp\_fair}} > \prod_{i=1}^k P_{\text{fair}, i}$, or the presence of a correlation coefficient $> 0.10$ between teammates (e.g. QB passing yards Over + WR receiving yards Over). When positive synergy is detected, the odds boost and edge are highlighted with Secondary Violet (`#6366f1`) and Mint Emerald (`#10b981`).
- **Hybrid Parlay Probability Formulation:**
  $$P_{\text{total\_fair}} = P_{\text{fair}}(S) \times \prod_{j \in I} P_{\text{fair}, j}$$
  $$\text{EV}_{\text{combined}} = (P_{\text{total\_fair}} \times D_{\text{combined}}) - 1$$
