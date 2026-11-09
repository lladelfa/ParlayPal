---
status: complete
stepsCompleted:
  - step-01-validate-prerequisites
  - step-02-design-epics
  - step-03-create-stories
  - step-04-final-validation
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-parlaypal-2026-11-08/prd.md
  - _bmad-output/planning-artifacts/architecture/architecture-spine-2026-11-08/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/ux-designs/ux-parlaypal-2026-11-08/DESIGN.md
  - _bmad-output/planning-artifacts/ux-designs/ux-parlaypal-2026-11-08/EXPERIENCE.md
---

# ParlayPal - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for ParlayPal, decomposing the requirements from the PRD and Architecture Spine into implementable stories.

## Requirements Inventory

### Functional Requirements

- **FR-1: Preset Parlay Feed Display** — System must display an ordered feed of active, curated Preset Parlay cards on the home screen based on upcoming scheduled games for the current day/weekend.
- **FR-2: Leg Consistency & Context Display** — Each leg within a Preset Parlay card must display player name, matchup, prop market, current line, rolling consistency hit rate (L5, L10, season), applicable Context Badges (weather/dome), and a 1-sentence plain-English conviction rationale (e.g., "Scored in 7 of last 8; defense allows 1.4 rushing TDs/game").
- **FR-3: 1-Tap QuickPick Launch** — Each Preset Parlay card must feature a primary CTA button ("Open in Sportsbook") calling the QuickPick deep-link generator to open the sportsbook with preloaded slip in $\le 1.5$s, automatically staging the ticket for bet tracking.
- **FR-4: Leg Swapping and Removal** — Users can remove any leg from a preset parlay or tap "Swap Leg" to view top-ranked alternative props from the same sport and time window.
- **FR-5: Multi-Sport Schedule & Market Browser** — Users can filter games by sport (NFL, NBA) and date (Today, Tomorrow, Weekend), browsing available prop markets (NFL ATTD, Pass Yds, Rush Yds; NBA Points, Rebounds, Threes).
- **FR-6: Real-Time Odds & Hybrid Score Recalculation** — System must recalculate combined parlay decimal odds, American payout, and composite Hybrid Value Score whenever legs are added, modified, or removed, highlighting positive intra-game correlation synergies (e.g., "⚡ Correlated Boost: QB Over + WR TD") for Same-Game Parlays.
- **FR-7: Rolling Consistency Hit Rate Calculation** — System must calculate rolling consistency hit rates for each player prop over L5, L10, and Full Season.
- **FR-8: Devigging & Outlier Guard** — System must devig consensus sharp book odds using Power method (and Multiplicative minimum) for $P_{\text{fair}}$ and EV%. Bets with $\text{EV} > 10.0\%$ tagged `SUSPECT_STALE_LINE`; bets with $\text{EV} < 1.5\%$ excluded from value highlights.
- **FR-9: Environmental Weather Context Ingestion** — Ingest weather forecast data for all outdoor NFL stadiums within 24 hours of kickoff, applying warning badges for wind speed $\ge 15\text{ mph}$ or precipitation $\ge 50\%$.
- **FR-10: QuickPick Payload Serialization** — Serialize selections in the active Parlay Drawer into the QuickPick API schema and return a valid smart link URL with HTTP 200.
- **FR-11: Best Book Price Comparison** — Compare payout odds across integrated sportsbooks (DraftKings, FanDuel, BetMGM, Caesars) for selected legs and highlight the book offering the highest payout.
- **FR-12: Seamless Bet Logging & Auto-Staging** — Users can save any parlay in their Parlay Drawer with 1 tap, and triggering a QuickPick handoff automatically stages the bet into the user's pending ledger with non-intrusive confirmation.
- **FR-13: Asynchronous CLV Stamping** — Query closing sharp odds 10 minutes post-commence time for every leg in a tracked bet, calculate CLV% against execution odds, and stamp the result onto the bet record.

### NonFunctional Requirements

- **NFR-1 (Performance):** QuickPick deep-link generation 95th percentile latency $< 1500\text{ ms}$.
- **NFR-2 (Performance / Streaming):** Live odds updates stream over HTTP/2 Server-Sent Events (SSE) from Redis pub/sub with sub-second propagation to client.
- **NFR-3 (Reliability / Cache TTL):** Ephemeral hot odds stored in Redis 7.2 with a 45-second TTL to avoid stale pricing.
- **NFR-4 (Usability / Form Factor):** Responsive web application supporting both mobile web viewports and desktop displays.
- **NFR-5 (Data Integrity / Outlier Circuit Breaker):** Automatic exclusion of lines with calculated $\text{EV} > 10.0\%$ to safeguard against book-voided errors.

### Additional Requirements

- **Architecture Stack Greenfield Setup:** Polyglot decoupled architecture consisting of Python 3.13 / Celery worker service for quantitative math/ingestion and Next.js 15 App Router (TypeScript / React Server Components / Tailwind CSS) for client web application and SSE stream gateway.
- **AD-1 (Service Isolation):** Python daemon owns external interaction with `parlay-api.com` and all devigging root-solving (SciPy); Next.js owns UI, auth, bet logging, and SSE stream gateway.
- **AD-2 (Storage Partitioning):** PostgreSQL 16 stores durable relational data (`events`, `teams`, `user_bets`, `clv_logs`, `users`); Redis 7.2 acts as pub/sub bus and ephemeral KV cache (45s TTL).
- **AD-3 (Unidirectional SSE):** Client subscribes to `/api/stream/odds` consuming Redis pub/sub channel `odds:feed:<sport_key>`.
- **AD-4 (Multi-Method Devigging):** Power method via Brent's root solver ($\sum P_i^k = 1.0$) combined with Multiplicative minimum for EV guarding.
- **AD-5 (SGP & Correlation Invariant):** Same-Game Parlay combinations query `POST /v1/sgp/price` and surface correlation audit factors; independent cross-game parlays use joint product $\prod P_{\text{fair}, i}$.
- **AD-6 (Scheduled CLV Engine):** Celery scheduled task triggered 10 minutes post-commence time querying `/v1/historical/sports/{sport_key}/closing-odds`.

### UX Design Requirements

- **UX-DR1 (Color Tokens & Surfaces):** High-contrast dark mode design system built on a deep slate base (`#0a0e17`), elevated card containers (`#121b2d`), and 1px structural hairline borders (`#1e293b`).
- **UX-DR2 (Spectral Neon Accents):** High-luminosity conduits: Electric Cyan (`#06b6d4`) for primary triggers/selected states, Violet (`#6366f1`) for parlay multipliers, Mint Emerald (`#10b981`) for +EV and winning streaks, and Warning Amber (`#f59e0b`) for weather alerts.
- **UX-DR3 (Sofascore Rolling Form Tracker):** Compact 5-dot rolling form indicators (`🟢🟢🟢🔴🟢`) with sample hit-rate labels (`8/10 L10`) on all player prop legs.
- **UX-DR4 (Tactile Preset Cards):** Sleeper-style tactile preset parlay cards with glowing odds badges, player avatars, team badges, conviction micro-copy rationales, and outdoor weather threat warnings.
- **UX-DR5 (Persistent Parlay Drawer & Lineshopper):** 360px sticky right sidebar on desktop / swipe-up bottom dock on mobile, featuring live payout math, multi-sportsbook lineshopper comparison, and a 1-tap QuickPick checkout CTA.

### FR Coverage Map

- **FR-1:** Epic 1 — Preset Parlay Feed Display
- **FR-2:** Epic 1 — Leg Consistency & Context Display
- **FR-3:** Epic 3 — 1-Tap QuickPick Launch
- **FR-4:** Epic 2 — Leg Swapping and Removal
- **FR-5:** Epic 2 — Multi-Sport Schedule & Market Browser
- **FR-6:** Epic 2 — Real-Time Odds & Hybrid Score Recalculation
- **FR-7:** Epic 1 — Rolling Consistency Hit Rate Calculation
- **FR-8:** Epic 1 — Devigging & Outlier Guard
- **FR-9:** Epic 1 — Environmental Weather Context Ingestion
- **FR-10:** Epic 3 — QuickPick Payload Serialization
- **FR-11:** Epic 3 — Best Book Price Comparison
- **FR-12:** Epic 4 — 1-Tap Bet Logging
- **FR-13:** Epic 4 — Asynchronous CLV Stamping

## Epic List

### Epic 1: Curated Preset Parlays & Value Feed
Bettors landing on the app immediately discover high-conviction, automated preset parlay cards for upcoming NFL and NBA games, complete with rolling consistency hit rates, conviction micro-copy rationales, outdoor stadium weather badges, and devigged fair odds. Includes core greenfield project setup and data ingestion pipelines.
**FRs covered:** FR-1, FR-2, FR-7, FR-8, FR-9

### Epic 2: Interactive Parlay Builder & Market Browser
Bettors can customize presets by swapping or removing legs, browse the full NFL and NBA game slate across multiple prop categories (TDs, Points, Rebounds, Threes), and see combined odds, SGP correlation boosts, and hybrid scores recalculate in real-time.
**FRs covered:** FR-4, FR-5, FR-6

### Epic 3: QuickPick Universal Betslip Handoff & Lineshopping
Bettors can compare payout prices across major sportsbooks to identify the best odds, automatically stage their bets for tracking, and instantly transfer their customized parlay into DraftKings, FanDuel, BetMGM, or Caesars via 1-tap QuickPick deep-links.
**FRs covered:** FR-3, FR-10, FR-11

### Epic 4: Bet Tracking & Closing Line Value (CLV) Ledger
Bettors have their placed wagers seamlessly tracked upon sportsbook handoff and receive automated Closing Line Value calculations against post-commence sharp closing prices to measure their long-term edge.
**FRs covered:** FR-12, FR-13


## Epic 1: Curated Preset Parlays & Value Feed

Bettors landing on the app immediately discover high-conviction, automated preset parlay cards for upcoming NFL and NBA games, complete with rolling consistency hit rates, conviction micro-copy rationales, outdoor stadium weather badges, and devigged fair odds. Includes core greenfield project setup and data ingestion pipelines.

### Story 1.1: Project Ingestion & Data Substrate Setup

As a developer,
I want the foundational Next.js 15 web app and Python 3.13 / Celery worker scaffold initialized with PostgreSQL 16 and Redis 7.2 connections,
So that live ingestion, quantitative mathematical processing, and web rendering have a clean, decoupled infrastructure substrate.

**Acceptance Criteria:**

**Given** a greenfield workspace,
**When** the project is initialized,
**Then** the Next.js 15 App Router frontend compiles with Tailwind CSS and connects to Redis for event streaming,
**And** the Python worker service connects to Redis and PostgreSQL 16, initializing relational tables (`events`, `teams`, `player_props`).

### Story 1.2: Quantitative Devigging & Outlier Guard Engine

As a bettor,
I want raw sportsbook odds devigged via the Power and Multiplicative methods and capped by an Outlier Guard,
So that I only see mathematically sound fair odds without bookmaker errors or stale lines.

**Acceptance Criteria:**

**Given** a two-way player prop market with sharp sportsbook lines,
**When** the devigging engine executes,
**Then** it calculates fair probability $P_{\text{fair}}$ using the Power method (Brent root solver) and Multiplicative method, setting $\text{EV}_{\text{guarded}} = \min(\text{EV}_{\text{mult}}, \text{EV}_{\text{power}})$,
**And** any market with $\text{EV} > 10.0\%$ is stamped `SUSPECT_STALE_LINE` and excluded from the public feed,
**And** markets with $\text{EV} \ge 1.5\%$ are flagged as positive value.

### Story 1.3: Rolling Consistency Hit-Rate & Weather Ingestion Engine

As a bettor,
I want each player prop to show empirical consistency hit rates (L5, L10, season) and stadium weather context badges,
So that I have instant situational and statistical evidence before betting.

**Acceptance Criteria:**

**Given** scheduled NFL and NBA games within the next 24 hours,
**When** the worker processes rolling historical box scores,
**Then** it computes consistency hit rates for Last 5 games (L5), Last 10 games (L10), and Full Season (e.g. `8/10 (80%)`),
**And** for NFL games at outdoor venues, it ingests weather forecasts and applies a yellow warning Context Badge if wind speed $\ge 15\text{ mph}$ or precipitation probability $\ge 50\%$.

### Story 1.4: Curated Preset Parlay Feed with Conviction Micro-Copy

As a bettor,
I want to see 3–5 themed preset parlay cards on the home screen with consistency badges, combined payouts, and plain-English rationales,
So that I can discover top-ranked parlays within seconds of opening the app.

**Acceptance Criteria:**

**Given** active NFL or NBA games scheduled today,
**When** a user visits the ParlayPal home screen,
**Then** 3 to 5 curated preset cards (e.g. *"The Red Zone Express"*, *"The Floor Generals"*) are displayed,
**And** each leg shows player name, matchup, prop line, consistency badge (e.g., `TD in 7 of last 8`), weather badge (if applicable), and a 1-sentence conviction rationale (e.g., *"Titans allow 1.4 rushing TDs/game; Henry averaging 18 red zone touches"*),
**And** the card displays combined decimal odds, American payout (+420), and composite Hybrid Value Score.


## Epic 2: Interactive Parlay Builder & Market Browser

Bettors can customize presets by swapping or removing legs, browse the full NFL and NBA game slate across multiple prop categories (TDs, Points, Rebounds, Threes), and see combined odds, SGP correlation boosts, and hybrid scores recalculate in real-time.

### Story 2.1: Multi-Sport Schedule & Market Browser

As a bettor,
I want to browse all upcoming NFL and NBA games filtered by date and prop category,
So that I can easily find individual player props ranked by hit rate and fair market value.

**Acceptance Criteria:**

**Given** active NFL or NBA game schedules,
**When** a user navigates to the schedule browser,
**Then** they can filter by Sport (`NFL`, `NBA`) and Date (`Today`, `Tomorrow`, `Weekend`),
**And** filter by prop market (NFL: `Anytime TD`, `Passing Yards`, `Rushing Yards`; NBA: `Points`, `Rebounds`, `Threes`),
**And** each prop row displays the player, matchup, sportsbook line, rolling hit rate, and EV%.

### Story 2.2: Interactive Parlay Drawer & Leg Swapper

As a bettor,
I want a persistent Parlay Drawer where I can remove legs or tap "Swap Leg" to review alternative candidates,
So that I can tailor any preset parlay or build my own ticket without losing my place.

**Acceptance Criteria:**

**Given** a preset parlay or active selections in the Parlay Drawer,
**When** a user clicks the "Remove" icon on a leg,
**Then** the leg is removed and the slip recalculates instantly without a full page reload,
**And** when a user clicks "Swap Leg", a modal displays top alternative props matching that time window and sport, ranked by Hybrid Value Score, allowing 1-click replacement.

### Story 2.3: Real-Time Odds, SGP Correlation Boost & Hybrid Score Engine

As a bettor,
I want combined payout odds, Same-Game Parlay correlation boosts, and the total Hybrid Score to update dynamically as legs change,
So that I know the exact fair return and understand if my parlay has positive intra-game synergy.

**Acceptance Criteria:**

**Given** multiple selections in the Parlay Drawer,
**When** independent cross-game legs are combined,
**Then** the system calculates fair parlay probability as $\prod P_{\text{fair}, i}$ and displays American payout (e.g. `+485`),
**And** when two or more selections share the same `event_id`, the system tags the slip as a Same-Game Parlay (SGP), calls the SGP correlation engine, and displays the `⚡ Correlated Boost` badge when positive synergy is detected,
**And** updates stream live over SSE without freezing the browser interface.


## Epic 3: QuickPick Universal Betslip Handoff & Lineshopping

Bettors can compare payout prices across major sportsbooks to identify the best odds, automatically stage their bets for tracking, and instantly transfer their customized parlay into DraftKings, FanDuel, BetMGM, or Caesars via 1-tap QuickPick deep-links.

### Story 3.1: Multi-Sportsbook Lineshopper Comparison

As a bettor,
I want to see combined parlay payout prices compared across major sportsbooks (DraftKings, FanDuel, BetMGM, Caesars),
So that I always place my wager at the book offering the highest payout for my exact legs.

**Acceptance Criteria:**

**Given** an assembled parlay in the Parlay Drawer,
**When** lineshopping pricing is loaded,
**Then** the UI displays comparative payouts across DraftKings, FanDuel, BetMGM, and Caesars,
**And** explicitly highlights the "Best Value Book" (e.g. `FanDuel paying +420 vs DraftKings +370`).

### Story 3.2: QuickPick Payload Serialization & Smart-Link Generator

As a bettor,
I want ParlayPal to serialize my parlay legs into a universal QuickPick smart-link,
So that I don't have to manually build the betslip inside my sportsbook app.

**Acceptance Criteria:**

**Given** a parlay in the Parlay Drawer and a selected target sportsbook,
**When** the user initiates the handoff,
**Then** the backend serializes the selections into the QuickPick API schema (mapping external event IDs, player IDs, and prop market lines),
**And** returns a valid QuickPick deep link URL in $\le 1500\text{ ms}$ (p95) with HTTP 200.

### Story 3.3: 1-Tap Sportsbook Handoff & Auto-Staging Execution

As a bettor,
I want tapping "Open in Sportsbook" to launch my sportsbook with my slip pre-filled and simultaneously stage my bet in ParlayPal,
So that my fulfillment is frictionless and my bet is pre-queued for tracking without extra steps.

**Acceptance Criteria:**

**Given** an active parlay and a generated QuickPick link,
**When** the user taps the primary CTA ("Open in Sportsbook"),
**Then** the browser triggers the deep-link redirect opening the target sportsbook app with all legs pre-populated in the betslip,
**And** ParlayPal auto-stages the bet into the user's pending ledger with status `staged`, displaying a non-intrusive confirmation toast (*"Slip opened in FanDuel & staged for tracking"*).


## Epic 4: Bet Tracking & Closing Line Value (CLV) Ledger

Bettors have their placed wagers seamlessly tracked upon sportsbook handoff and receive automated Closing Line Value calculations against post-commence sharp closing prices to measure their long-term edge.

### Story 4.1: User Bet Tracker Dashboard & Persistence

As a bettor,
I want a dedicated dashboard displaying all my staged, pending, and settled parlays,
So that I can track my active action and historical performance in one place.

**Acceptance Criteria:**

**Given** bets staged via QuickPick or manually saved from the Parlay Drawer,
**When** a user visits the "My Bets" tracking tab,
**Then** the system displays all tickets partitioned by status (`pending`, `settled_won`, `settled_lost`),
**And** shows stake amount, execution odds, bookmaker placed at, and live game score progress,
**And** persists all ticket entities durably in PostgreSQL 16 (`user_bets`).

### Story 4.2: Asynchronous Closing Line Value (CLV) Worker

As a bettor,
I want an automated background worker to evaluate the sharp closing price 10 minutes after kickoff/tip-off and stamp my CLV%,
So that I know objectively whether I beat the closing market price.

**Acceptance Criteria:**

**Given** a tracked bet with status `pending`,
**When** 10 minutes have elapsed following the game's `commence_time`,
**Then** a scheduled Celery worker queries `GET /v1/historical/sports/{sport_key}/closing-odds`,
**And** devigs the closing sharp price via the Power method to extract $P_{\text{fair, close}}$,
**And** calculates $\text{CLV}\% = (P_{\text{fair, close}} \times D_{\text{exec}}) - 1$, stamping the result into `user_bets.clv_percentage`.

### Story 4.3: CLV Analytics & Long-Term Edge Reporting

As a bettor,
I want to see aggregated CLV performance metrics and beat-the-closing-line percentages,
So that I have empirical proof that my betting strategy is generating sustainable edge against bookmaker margins.

**Acceptance Criteria:**

**Given** settled bets in the user's history with stamped CLV records,
**When** viewing the Bet Tracker Analytics view,
**Then** the UI displays the user's overall "Closing Line Beat Rate" (e.g. `68% of bets beat closing line`),
**And** displays average CLV% gain alongside standard win/loss ROI.
