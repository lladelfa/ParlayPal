# Epic 1 Context: Curated Preset Parlays & Value Feed

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Establish the foundational polyglot infrastructure (Next.js 15 web application, Python 3.13 / Celery worker service, PostgreSQL 16, and Redis 7.2) and deliver the primary landing experience: a curated feed of high-conviction preset parlay cards for upcoming NFL and NBA games. This epic builds the quantitative ingestion and math pipeline—devigging sharp lines, enforcing outlier circuit breakers, calculating rolling player prop hit rates, and ingesting stadium weather forecasts—so bettors immediately discover statistically grounded, positive-EV parlay opportunities without manual research.

## Stories

- Story 1.1: Project Ingestion & Data Substrate Setup
- Story 1.2: Quantitative Devigging & Outlier Guard Engine
- Story 1.3: Rolling Consistency Hit-Rate & Weather Ingestion Engine
- Story 1.4: Curated Preset Parlay Feed with Conviction Micro-Copy

## Requirements & Constraints

- **Supported Sports & Markets:** Cover pre-match props for NFL (Anytime Touchdown, Passing Yards O/U, Rushing Yards O/U) and NBA (Player Points O/U, Rebounds O/U, Made Threes O/U).
- **Curated Preset Parlay Feed:** Display an ordered home feed of 3–5 active, themed preset parlay cards (capped at 2–4 high-conviction legs per card to prevent compounded bookmaker vig) for games scheduled within the next 24 hours. Automatically remove or mark cards `COMMENCED` once any constituent game begins.
- **Leg Telemetry & Rationale Display:** Every leg within a preset card must display the player name, team matchup, prop market, current line, rolling consistency hit rate, applicable environmental context badges, sharp price, and a 1-sentence plain-English conviction rationale. Each card must display combined decimal odds, American payout, and composite Hybrid Value Score (blending hit rate with devigged +EV).
- **Rolling Consistency Hit Rates:** Compute empirical player prop hit rates across three rolling windows: Last 5 games (L5), Last 10 games (L10), and Full Current Season (formatted as `8/10 (80.0%)`).
- **Devigging & Outlier Circuit Breaker:** Strip bookmaker margin from two-way sharp lines using both the Power method (Brent's root solver where $\sum P_i^k = 1.0$) and the Multiplicative method, setting guarded expected value to $\text{EV}_{\text{guarded}} = \min(\text{EV}_{\text{mult}}, \text{EV}_{\text{power}})$ where $\text{EV} = (P_{\text{fair}} \times D_{\text{offered}}) - 1$. Stamp any market with $\text{EV} > 10.0\%$ as `SUSPECT_STALE_LINE` and exclude it from public feeds and presets to protect against book-voided errors. Require $\text{EV} \ge 1.5\%$ for positive value highlights, and badge props with $\text{EV} \ge 3.5\%$ and hit rate $\ge 70\%$ as high value.
- **Environmental Weather Context:** Ingest forecasts for outdoor NFL venues within 24 hours of kickoff, tagging wind speed, temperature, and precipitation. Apply a warning badge when wind speed $\ge 15\text{ mph}$ (specifically flagging passing and kicking props) or precipitation probability $\ge 50\%$ (rain/snow), and display a neutral dome badge for indoor stadiums.
- **Frictionless Access & Responsiveness:** Support unauthenticated guest browsing of the preset feed across responsive mobile and desktop web viewports, with sub-second live odds propagation over HTTP/2 Server-Sent Events (SSE).

## Technical Decisions

- **Polyglot Service Isolation:** The Python 3.13 / Celery worker service (`parlay-api>=0.2.0`, `scipy>=1.13.0`, `pydantic`) owns all external `parlay-api.com` communication, schedule/box-score/weather ingestion, and numerical root-solving; it never serves end-user HTTP requests. The Next.js 15 App Router application (Node.js 22 LTS, TypeScript, React Server Components, Tailwind CSS 4.x) owns UI rendering and the SSE stream gateway (`/api/stream/odds`), reading exclusively from Redis and PostgreSQL.
- **Storage Partitioning & Ephemeral Cache:** Store live odds and +EV signals in Redis 7.2 with a strict 45-second TTL and broadcast deltas via Redis Pub/Sub (`odds:feed:<sport_key>`). Persist durable relational metadata (`events`, `teams`, `player_props`, `user_bets`, `clv_logs`, `users`) in PostgreSQL 16 without storing raw sub-second odds tick history.
- **Data & Protocol Conventions:**
  - **Identifiers:** Use UUID v4 for internal primary keys (`event_id`, `bet_id`, `user_id`) and store upstream provider identifiers in `external_provider_id` / `external_id` with explicit prefixes (e.g., `papi_nfl_12345`).
  - **Odds Representation:** Execute all internal math using Decimal odds ($D \ge 1.01$), converting to American odds ($+150, -110$) strictly at ingestion and display boundaries.
  - **Timestamps:** Enforce ISO 8601 UTC (`TIMESTAMPTZ` in PostgreSQL, `YYYY-MM-DDTHH:mm:ssZ` in JSON payloads).
  - **Redis Key Namespacing:** Use colon-delimited keys (`odds:latest:{sport_key}:{event_id}`, `ev:feed:{sport_key}`, `sgp:audit:{event_id}`).
  - **Error Format:** Return standardized JSON Problem Details (`{ error: { code, message, retry_after } }`).
- **Independent Parlay Pricing:** Calculate combined fair probability for cross-game preset parlays as the joint product of individual fair probabilities ($P_{\text{parlay\_fair}} = \prod P_{\text{fair}, i}$).

## UX & Interaction Patterns

- **High-Contrast Dark Surface Hierarchy:** Build on a deep slate canvas (`#0a0e17`), default module surface (`#0f131c`), elevated card surface (`#121b2d`), and 1px structural hairline borders (`#1e293b`), pairing high-contrast primary text (`#f8fafc`) with muted metadata (`#94a3b8`).
- **Semantic Neon Accents:** Use Electric Cyan (`#06b6d4`) for primary interactive triggers and active card glow borders, Violet (`#6366f1`) for parlay multipliers, Mint Emerald (`#10b981`) for `+EV` badges and winning form dots, Warning Amber (`#f59e0b`) for weather/situational alerts, and Rose Danger (`#f43f5e`) for `SUSPECT_STALE_LINE` alerts and losing form dots.
- **Typography & Fixed-Width Telemetry:** Pair `Space Grotesk` (28px/36px bold display headers; 20px/26px semibold section titles) and `Outfit` (14px/20px regular body copy; 11px/14px semibold uppercase category pills) with tabular `JetBrains Mono` (18px/22px bold odds/EV readouts; 11px/14px medium hit-rate badges) so live odds ticks never cause layout shift.
- **Tactile Preset Card Anatomy:** Render preset cards above the fold featuring a header with sport icon, themed title, glowing cyan American payout badge (`+485`), and mint `+EV` badge. Each leg row contains a 48x48px rounded (8px) player headshot with team code badge, player name + matchup + prop market pill, 1-line conviction micro-copy, a 5-dot Sofascore rolling form indicator (3px radius green/red squares followed by `8/10 L10` label), environmental context badge, and sharp price pill. Card footers provide secondary `Customize Legs` and primary `Open in Sportsbook via QuickPick` actions.
- **Responsive Breakpoints:** Render a 3-column command layout on desktop ($\ge 1280\text{px}$), a 2-column layout with top horizontal filter chips on tablet ($768\text{px}\text{–}1279\text{px}$), and a full-width 1-column vertical card stream on mobile ($< 768\text{px}$).

## Cross-Story Dependencies

- **Story 1.1 → Stories 1.2, 1.3, 1.4 (and Epics 2–4):** Story 1.1 initializes the Next.js 15 frontend, Python 3.13 / Celery worker, PostgreSQL 16 relational schema, and Redis 7.2 cache/pub-sub connections required by all downstream engines and UI views.
- **Stories 1.2 & 1.3 → Story 1.4:** Story 1.4 relies on the devigged fair probabilities, guarded EV scores, and `SUSPECT_STALE_LINE` exclusion filter from Story 1.2, plus the L5/L10/Season hit rates and outdoor weather context badges from Story 1.3, to rank, assemble, and display curated preset parlay cards.
- **Story 1.4 → Epics 2 & 3:** The `Customize Legs` and `Open in Sportsbook via QuickPick` triggers on preset cards in Story 1.4 act as the primary handoff entry points into the interactive Parlay Drawer (Epic 2) and QuickPick deep-link serialization flow (Epic 3).
