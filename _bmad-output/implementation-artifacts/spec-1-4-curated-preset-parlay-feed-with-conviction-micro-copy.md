---
title: 'Story 1.4: Curated Preset Parlay Feed with Conviction Micro-Copy'
type: 'feature'
created: '2026-11-09'
status: 'in-progress'
route: 'dispatch'
baseline_commit: '5fa54db52f20436d421d00c3c548a4c1ea5bbd9c'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Bettors landing on sports betting platforms face cognitive overload with hundreds of disconnected prop lines, no indication of whether multi-leg parlays hold positive expected value or excessive bookmaker vig, and lack plain-English conviction rationales synthesizing statistical consistency and stadium conditions.

**Approach:** Implement a curated preset parlay feed in `services/worker` and `apps/web` that surfaces 3–5 high-conviction themed cards (2–4 legs each) across active NFL and NBA games. Each leg presents player matchup telemetry, rolling hit rate consistency (`8/10 L10`), Sofascore form indicators (`🟢🟢🟢🔴🟢`), environmental weather badges, and a 1-sentence plain-English conviction rationale. Each card displays combined decimal odds, American payout (+420), composite Hybrid Value Score, and glowing action triggers. The web app integrates Server-Sent Events (SSE) live telemetry from `/api/stream/odds` to reflect sub-second price adjustments without layout shift.

## Boundaries & Constraints

**Always:**
- Follow strict Test-Driven Development (TDD) (Red Phase $\rightarrow$ Green Phase $\rightarrow$ Refactor) in both Python worker service and TypeScript web app.
- Enforce Polyglot Service Isolation (AD-1): numerical parlay pricing, outlier circuit breaking, conviction rationale generation, and Celery tasks live in `services/worker`; Next.js 15 App Router owns UI rendering and client-side streaming.
- Filter out any player prop flagged with `status == "SUSPECT_STALE_LINE"` or $\text{EV}_{\text{guarded}} > 10.0\%$ (outlier circuit breaker) from being included in any curated preset card.
- Filter out any game that has already commenced (`commence_time <= now_utc`).
- Enforce card leg limits: each preset card must contain between 2 and 4 legs (inclusive) to prevent compounded bookmaker vig.
- Calculate cross-game independent combined odds and fair probability:
  $$D_{\text{combined}} = \prod_{i=1}^n D_i, \quad P_{\text{parlay\_fair}} = \prod_{i=1}^n P_{\text{fair}, i}$$
  $$\text{EV}_{\text{combined}} = (P_{\text{parlay\_fair}} \times D_{\text{combined}}) - 1$$
- Calculate composite **Hybrid Value Score** (0–100 index) blending empirical hit rate and guarded EV:
  $$\text{Score} = \text{clamp}\left(0, 100, \text{round}\left(0.60 \times \bar{H}_{\text{L10}} + 0.40 \times \text{clamp}\left(0, 100, \text{EV}_{\text{combined}}\% \times 10 + 50\right)\right)\right)$$
- Generate a 1-sentence plain-English conviction rationale for every leg summarizing consistency and matchup context.
- UI styling must adhere strictly to DESIGN.md tokens: Canvas `#0a0e17`, Card `#121b2d`, Hairline Border `#1e293b`, Electric Cyan `#06b6d4`, Mint Emerald `#10b981`, Amber `#f59e0b`, and Violet `#6366f1`.
- Live odds updates via SSE must update card payout odds and EV dynamically without full page reloads or layout shift.

**Never:**
- Never include more than 4 legs or fewer than 2 legs on a curated preset card.
- Never include suspect stale lines ($\text{EV} > 10.0\%$).
- Never execute external network calls to `parlay-api.com` from the browser or Next.js server components.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Curated 3-Leg NFL Preset | 3 NFL props: Henry TD, Lamb TD, St. Brown O6.5 Rec; all with $EV \in [1.5\%, 8\%]$ and hit rate $\ge 65\%$ | Card titled "The Red Zone Express", 3 legs, combined payout (e.g. +485), hybrid score $\ge 80$, 1-sentence rationale on each leg | Validated 2–4 legs |
| Outlier Guard Circuit Breaker | 1 prop has $\text{EV}_{\text{guarded}} = 12.5\%$ (stale line error) | Prop is strictly excluded from preset selection; preset is built from clean candidates or card rejected if legs $< 2$ | Stamped `SUSPECT_STALE_LINE` |
| Commenced Game Filter | 1 candidate prop belongs to a game that started 5 minutes ago | Prop excluded; active card displays only future games ($\text{commence\_time} > \text{now}$) | Commenced legs rejected |
| Weather Context Badge Integration | 1 leg is outdoor NFL with 19 mph wind | Leg displays Amber warning badge `⚠️ 19mph Wind` alongside conviction rationale | Dome games display neutral `DOME Indoor` |
| American Odds Conversion | Combined decimal odds $D = 5.8500$ | American payout $= +485$; $D = 1.7500 \rightarrow -133$ | Strict formula validation |
| Empty / Cold Cache Fallback | Redis has no cached preset cards | Next.js API / feed server component falls back to deterministic high-conviction curated presets | No blank screen or 500 error |
| Live Odds Telemetry Update | SSE frame updates 1 leg's offered odds from 1.75 to 1.85 | Card automatically updates combined payout and EV in place | Tabular JetBrains Mono prevents layout shift |

</frozen-after-approval>
