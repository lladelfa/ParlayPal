# Epic 2 Context: Interactive Parlay Builder & Market Browser

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Enable bettors to customize preset parlays or build multi-leg slips from scratch by browsing the full NFL and NBA game slates across supported prop categories, swapping or removing individual legs in a persistent Parlay Drawer, and viewing live recalculations of combined decimal/American payout odds, composite Hybrid Value Scores, and Same-Game Parlay (SGP) intra-game correlation boosts.

## Stories

- Story 2.1: Multi-Sport Schedule & Market Browser
- Story 2.2: Interactive Parlay Drawer & Leg Swapper
- Story 2.3: Real-Time Odds, SGP Correlation Boost & Hybrid Score Engine

## Requirements & Constraints

- **Multi-Sport Schedule & Market Browser:** Allow users to filter active pre-match games by sport (`NFL`, `NBA`), date window (`Today`, `Tomorrow`, `Weekend`), and prop category:
  - **NFL:** Anytime Touchdown (`ATTD`), Passing Yards Over/Under, Rushing Yards Over/Under.
  - **NBA:** Player Points Over/Under, Rebounds Over/Under, Made Threes Over/Under.
- **Prop Screener Row Telemetry:** Every prop row in the browser and leg swapper must display the player name, team matchup, sportsbook line, rolling consistency hit rate (L5, L10, Season), applicable environmental weather/dome Context Badges, and devigged EV%, ranked by consistency hit rate and fair market value (Hybrid Value Score). Exclude markets stamped `SUSPECT_STALE_LINE` ($\text{EV} > 10.0\%$) from public value rankings.
- **Interactive Leg Swapping & Removal:** Allow users to remove any leg from an active slip with immediate recalculation (no full page reload) or tap `Swap Leg` to view top-ranked alternative candidates matching the same sport and time window/market type, sorted by Hybrid Value Score, for 1-click replacement.
- **Dual-Path Parlay Valuation & Real-Time Recalculation:** Whenever legs are added, swapped, or removed, dynamically recalculate combined decimal odds (2 decimal places), standard American payout (`+420`), and composite Hybrid Value Score:
  - **Cross-Game Independent Parlays:** Compute combined fair probability as the joint product $P_{\text{parlay\_fair}} = \prod_{i=1}^n P_{\text{fair}, i}$.
  - **Same-Game Parlays (SGPs):** When two or more legs share the same `event_id`, tag the slip as an SGP, evaluate intra-game correlation via `/v1/sgp/price`, store/surface `correlation_audit[]` factors, and display a `⚡ Correlated Boost` badge when positive synergy is detected.
- **Live Streaming & Guest Access:** Stream live odds updates over HTTP/2 Server-Sent Events (`/api/stream/odds`) without freezing the UI, and allow unauthenticated guests to browse markets and customize slips.

## Technical Decisions

- **Polyglot Service Isolation:** The Python 3.13 / Celery worker owns external `parlay-api.com` calls (including `POST /v1/sgp/price` correlation auditing and devigging math) and publishes verified +EV signals, SGP audit metadata (`sgp:audit:{event_id}`), and odds deltas (`odds:feed:<sport_key>`) to Redis 7.2 (45s TTL) and durable schedule/prop metadata to PostgreSQL 16. The Next.js 15 App Router web app reads exclusively from Redis and PostgreSQL and streams live updates via `/api/stream/odds`.
- **Data & Protocol Conventions:**
  - **Identifiers:** UUID v4 primary keys (`event_id`, `prop_id`, `team_id`); upstream provider IDs prefixed in `external_provider_id` (e.g., `papi_nfl_12345`).
  - **Odds Math:** Execute all internal probability and payout math in `Decimal` odds ($D \ge 1.01$), converting to American odds strictly at display boundaries.
  - **Timestamps:** ISO 8601 UTC (`TIMESTAMPTZ` in PostgreSQL, `YYYY-MM-DDTHH:mm:ssZ` in JSON/Redis).

## UX & Interaction Patterns

- **Navigation & Browser Hierarchy:** Top navigation provides the Sport Switcher (`NFL` / `NBA`), Date Pills (`Today`, `Tomorrow`, `Weekend`), and search (`⌘K`), routing between the Home Preset Feed and the Schedule & Market Browser.
- **Dark Mode Surface & Neon Tokens:** Use deep slate canvas (`#0a0e17`), container surface (`#0f131c`), elevated card/row surface (`#121b2d`), and 1px hairline borders (`#1e293b`). Highlight primary interactive states and active odds pills in Electric Cyan (`#06b6d4`), parlay multipliers and `⚡ Correlated Boost` SGP badges in Secondary Violet (`#6366f1`), `+EV` badges and leg-swap confirmation flashes in Mint Emerald (`#10b981`), and weather threats in Warning Amber (`#f59e0b`).
- **Fixed-Width Telemetry Typography:** Render all odds, EV%, and hit-rate badges (`8/10 L10`) in tabular `JetBrains Mono` alongside `Space Grotesk` headers and `Outfit` body/category pills so live SSE ticks and leg edits never cause layout shift.
- **Persistent Parlay Drawer & Customization Micro-Behaviors:**
  - **Desktop ($\ge 1280\text{px}$):** 3-column command layout with left filter/navigation rail, center browser/feed canvas, and fixed 360px right-hand Parlay Drawer.
  - **Tablet ($768\text{px}\text{–}1279\text{px}$) & Mobile ($< 768\text{px}$):** Horizontal filter chips at the top; Parlay Drawer docks as a compact sticky bottom bar showing active leg count and combined odds, expanding via swipe-up/tap into a bottom sheet.
  - **Leg Editing Transitions:** Clicking `Customize Legs` on a preset card loads its legs into the Parlay Drawer; removing a leg fades it out and slides remaining legs up; tapping `Swap Leg` opens a ranked candidate modal where selecting a replacement triggers an emerald flash (`#10b981`) and immediate payout/SGP recalculation.

## Cross-Story Dependencies

- **Epic 1 → Story 2.1:** Relies on the PostgreSQL/Redis schema (`events`, `teams`, `player_props`), devigged fair probabilities, guarded EV% (`SUSPECT_STALE_LINE` filtering), rolling L5/L10/Season hit rates, Hybrid Value Scores, and weather context badges built in Stories 1.1–1.4.
- **Story 2.1 → Story 2.2:** The Schedule & Market Browser's prop query, filtering, and ranking substrate feeds both standalone market browsing (allowing users to add legs to the drawer) and the `Swap Leg` alternative candidate modal in Story 2.2.
- **Story 2.2 → Story 2.3:** The interactive Parlay Drawer state and leg mutation actions in Story 2.2 trigger the real-time cross-game product pricing, SGP correlation boost auditing (`POST /v1/sgp/price`), and live SSE odds recalculation in Story 2.3.
- **Epic 2 → Epic 3:** The active selections in the Parlay Drawer feed directly into the multi-sportsbook lineshopper and QuickPick deep-link serializer in Epic 3.
