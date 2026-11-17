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
- **FR-14: Automated Upstream Schedule, Prop Ingestion & Beat Orchestration** — Periodically poll upstream NFL and NBA game schedules, teams, and two-way player prop odds (with a deterministic local seed fallback when offline/unconfigured), upsert into PostgreSQL 16, and execute a 30-second Celery Beat schedule so the 45-second Redis hot caches (`markets:browser:*`, `presets:feed:*`, `ev:feed:*`) and SSE stream stay continuously updated.
- **FR-15: Truthful Consistency & Conviction Data** — Consistency badges, form dots and rationale are computed from real game logs and the leg's actual side and price; missing evidence is labelled, never fabricated.
- **FR-16: Trustworthy Live Feed** — When live data is unavailable or yields no qualifying presets, the app says so explicitly instead of showing sample legs; no persisted or scored value is a fabricated default; prop market keys are canonical across providers.
- **FR-17: Game-Centric Browsing** — Users browse a slate of games showing main lines (spread, moneyline, total), select a game to filter props or open a game detail view (main lines, props by market, player history), sort the market browser by any displayed field, and read an in-app explanation of how the site and its score work.

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
- **FR-14:** Epic 5 — Automated Upstream Schedule, Prop Ingestion & Beat Orchestration
- **FR-15:** Epic 6 — Truthful Consistency & Conviction Data
- **FR-16:** Epic 7 — Trustworthy Live Feed
- **FR-17:** Epic 8 — Game-Centric Browsing

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

### Epic 5: Live Schedule & Prop Ingestion Pipeline
Bettors and local developers see continuously updated, current NFL and NBA game slates and player prop markets without relying on static UI fallbacks, powered by an automated upstream schedule/odds poller, deterministic local seed fallback, and a 30-second Celery Beat synchronization loop that keeps the 45-second Redis hot caches warm.
**FRs covered:** FR-14

### Epic 6: Preset Data Integrity & Truthful Conviction Copy
Bettors can trust every consistency badge, form indicator and rationale on a preset card because each is computed from real player game logs and the leg's actual side (Over/Under) and price. Cards never show fabricated defaults, and legs lacking evidence are labelled honestly or excluded.
**FRs covered:** FR-15

### Epic 7: Trustworthy Feed & Data Hygiene
Bettors and the developer can tell at a glance whether the feed is live. An empty or failed feed shows an honest "no live data" state with a logged reason rather than invented sample legs, no scored value is a fabricated default, prop markets use one canonical key per market, and the local-dev loop (credits visibility, planning docs, commit-only git flow) is tidy. Prerequisite for Epic 8.
**FRs covered:** FR-16

### Epic 8: Game-Centric Browsing & Explainability
Bettors browse a Fanatics-style slate of games with main lines (spread, moneyline, total), click a game to filter props or open a game page (main lines, props by market tab, player history), sort the market browser by score, player, team and more, and learn how the site and its score work from an About page.
**FRs covered:** FR-17


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


## Epic 5: Live Schedule & Prop Ingestion Pipeline

Bettors and local developers see continuously updated, current NFL and NBA game slates and player prop markets without relying on static UI fallbacks, powered by an automated upstream schedule/odds poller, deterministic local seed fallback, and a 30-second Celery Beat synchronization loop that keeps the 45-second Redis hot caches warm.

### Story 5.1: Automated Upstream Schedule, Prop Ingestion & Beat Orchestration

As a bettor (and developer running ParlayPal locally),
I want the Python worker to automatically fetch current NFL and NBA game schedules and player prop odds (or seed realistic upcoming games relative to current UTC time when offline) and refresh Redis feeds on a 30-second Celery Beat schedule,
So that all upcoming games, curated presets, and market browser slates stay continuously updated without expiring into static fallback data.

**Acceptance Criteria:**

**Given** the Python worker and Celery Beat service are running,
**When** the periodic schedule and prop ingestion cycle executes (every 30 seconds, within the 45-second Redis TTL),
**Then** the worker fetches upcoming NFL and NBA events, teams, and two-way player prop markets from the upstream provider (`PARLAY_API_BASE_URL` / `PARLAY_API_KEY`) or populates/refreshes a deterministic local slate anchored to `datetime.now(UTC)` when the upstream API is unreachable or unconfigured,
**And** upserts `teams`, `events` (transitioning past-commence games to `COMMENCED`), and devigged `player_props` in PostgreSQL 16,
**And** runs `sync_preset_parlay_feed` and `sync_market_browser_feed` to refresh `presets:feed:*` and `markets:browser:*` in Redis with a 45-second TTL and broadcast live odds deltas over `odds:feed:{sport_key}`.


## Epic 6: Preset Data Integrity & Truthful Conviction Copy

Triggered by a 2026-11-15 UI review: every preset leg showed an identical "7/10 (70.0%) L10", identical form dots and a templated rationale, even where the price contradicted it (e.g. Carter Runyon anytime TD at +3604). Root cause is in `services/worker/parlaypal_worker/presets.py`: a silent `Decimal("0.7000")` fallback when `hit_rate_l10` is null (line ~370), hardcoded form dots (~376), an Over-only rationale template (`generate_conviction_rationale`), and no game-log ingestion for non-seed upstream players. Stories 6.1-6.6 are ordered by dependency; 6.1 is the urgent trust fix and can ship alone.

### Story 6.1: Remove Fabricated Hit-Rate Fallback & Honest Consistency Badge

As a bettor,
I want preset legs without real history to say so instead of showing a made-up 70% hit rate,
So that I never rely on consistency data that does not exist.

**Acceptance Criteria:**

**Given** a candidate prop whose `hit_rate_l10` is `NULL`,
**When** `build_preset_parlays` assembles its `PresetLeg`,
**Then** no default (such as `0.7000`) is substituted, the hit rate and form fields are `None`, and the UI shows a neutral "Limited history" badge in place of `N/10 (X%) L10`,
**And** such legs are excluded from the Hybrid Value Score's average hit rate (score is computed only from legs with real data) and a preset made only of legs without history is not emitted,
**And** the rationale for such a leg makes no claim about past performance,
**And** legs with a real `hit_rate_l10` render exactly as before.

**Edge cases:** a hit rate of exactly `0` must display `0/10`, not be treated as missing (replace `or` with an explicit `is None` check); `apps/web` must tolerate null hit-rate fields from both fresh Redis feeds and the snake_case fallback normalization.

### Story 6.2: Selection-Aware Hit Rate for Under Legs

As a bettor,
I want the consistency badge on an Under leg to reflect how often the player stayed under the line,
So that the number supports the pick being shown.

**Acceptance Criteria:**

**Given** a prop with `selection = "UNDER"` and a line of 28.5 rush yards,
**When** hit rates are computed (`hit_rate.py`, `update_props_hit_rates`, and the ingestion paths that set `hit_rate_l5/l10/season`),
**Then** a game counts as a hit only when the stat is strictly below the line (Over: strictly above; a push counts as neither a hit nor a miss and is excluded from the denominator),
**And** the rationale copy for Unders reads in the under direction (e.g. "stayed under 28.5 rush yds in 6 of last 10"), never "surpassed",
**And** existing Over behaviour is unchanged and anytime-TD props remain Over-style.

### Story 6.3: Real Recent-Form Dots From Game Logs

As a bettor,
I want the five form dots to show the player's actual last five results for that prop,
So that I can see streaks and slumps accurately.

**Acceptance Criteria:**

**Given** a player with at least 5 game-log entries for the prop's market,
**When** a preset leg is built,
**Then** `sofascore_form` / dots reflect the last 5 outcomes, most recent last, evaluated with the same side-aware rule as Story 6.2,
**And** the green dots never contradict the L10 label, and when fewer than 10 games exist the label shows `N/M` where `M` is the games actually available,
**And** the hardcoded patterns `[T,T,F,T,T]` and `[T,F,T,F,T]` are deleted,
**And** with fewer than 5 logs only the available dots render; with none, no dots render.

**Dependency:** needs recent outcomes persisted or recomputable at preset-build time (store a `recent_form` array on `player_props`, or recompute from logs).

### Story 6.4: Evidence-Based Conviction Rationale

As a bettor,
I want the one-line rationale to cite facts specific to the leg,
So that cards read as distinct analysis rather than a template.

**Acceptance Criteria:**

**Given** a leg with a price, devigged fair probability and (when available) a hit rate,
**When** `generate_conviction_rationale` runs,
**Then** the sentence cites only data present on the leg: hit rate with side and line when known, and the offered price versus the devigged fair price or EV% when no hit rate exists,
**And** it never asserts unsupported context such as "red-zone focal point", "heavy touch volume established", or "high-leverage" matchup,
**And** a long shot (fair probability below 10%) is never described with a consistency claim that implies a high probability,
**And** two legs with different data produce different sentences; unit tests assert no two legs in the seed slate share identical rationale text unless their inputs are identical.

**Dependency:** Stories 6.1 and 6.2.

### Story 6.5: Game-Log Ingestion for Upstream (Non-Seed) Players

As a bettor,
I want real hit rates for the actual players on the live slate,
So that consistency data exists for upstream props and not only for seeded demo players.

**Acceptance Criteria:**

**Given** the sync loop ingests upstream props for players such as those in the 2026-11-15 screenshot,
**When** the worker runs `sync_player_hit_rates` / `sync_live_slate`,
**Then** the worker fetches per-player recent game logs or box scores from the configured provider (worker only, never `apps/web`), keyed by `(player_name, market_key)`, and populates `hit_rate_l5`, `hit_rate_l10` and `hit_rate_season`,
**And** players with fewer than 5 games of history, or whose lookups fail, remain `NULL` (feeding the Story 6.1 "Limited history" path) without crashing the beat loop,
**And** provider calls are rate-limited and cached so the 30-second cycle and 45-second TTL still hold,
**And** the seed-slate path keeps its deterministic logs for offline development.

**Open question for the build team:** confirm which `parlay-api.com` endpoint, or alternate source, exposes player game logs. If none does, this story needs a spike first and 6.1 remains the shipped mitigation.

### Story 6.6: Preset Candidate Quality Gate & De-duplication

As a bettor,
I want preset cards to contain distinct, sensible legs,
So that the feed does not repeat the same player across cards or show implausible picks.

**Acceptance Criteria:**

**Given** the candidate pool used by `build_preset_parlays`,
**When** presets are assembled,
**Then** a player appears in at most one preset per feed refresh (today Cody White and Rico Dowdle each appear twice),
**And** legs failing a plausibility check are dropped: a market and position mismatch, or a fair probability below a configurable floor for presets labelled high-conviction,
**And** the Outlier Circuit Breaker rule (`EV_guarded > 10%` is `SUSPECT_STALE_LINE` and never published) is unaffected,
**And** the quality-gate thresholds are named constants with unit tests covering the boundary values.

**Open question:** confirm whether Carson Beck "Under 11.5 Rush Yds" is a data/mapping error before tuning the plausibility rule.

### Story 6.7: MoneyLine Game-Log Provider Adapter (NBA & NFL)

As a bettor,
I want live NBA and NFL props to show real hit rates from actual game logs,
So that consistency data exists for the players on today's slate.

**Acceptance Criteria:**

**Given** a MoneyLine API key and the 6.5 game-log plumbing (budget, cache, deadline, breaker),
**When** the live sync runs for NBA `player_points/rebounds/threes` and NFL `player_pass_yds/rush_yds` props,
**Then** a provider adapter resolves player names to MoneyLine player IDs (roster map cached, 7-day TTL), fetches per-game stats, and returns most-recent-first `Decimal` logs keyed by `(player_name, market_key)`,
**And** logs come from the per-game stats endpoint (`type=game`), never from season totals,
**And** players that cannot be matched, or have fewer than 5 games, stay `NULL` ("Limited history").

**Task 1 (gate):** coverage, ordering and NBA/NFL fields were verified on the free tier (see spec Implementation Notes); remaining checks are the NFL passing-yards field, DNP handling, and name-match rate (target >= 90%) using parlay-api prop names. If the match rate fails, stop and keep the 6.5 fetcher disabled.

## Epic 7: Trustworthy Feed & Data Hygiene

Triggered by the Epic 6 retrospective (`_bmad-output/implementation-artifacts/epic-6-retro-2026-11-16.md`) and a 2026-11-17 review where the preset feed showed "Sample fixture leg shown while the live feed is unavailable" and "Limited history" for players expected to have history. Diagnosis: the live Redis feed held 0 cards (only 26 of 4,529 active props had a `hit_rate_l10`, and `GAME_LOG_PROVIDER` was unset in `services/worker/.env`), so `apps/web/src/lib/presets.ts` (~line 564-574) served the hard-coded `FALLBACK_PRESET_FEED`. Retro action item 1 (schema upgrade for old databases) is out of scope: ParlayPal has a single developer and no other databases.

### Story 7.1: Honest Empty State & Feed Diagnostics

As a bettor,
I want the app to say when there is no live preset data instead of showing sample legs,
So that I never mistake a fixture for a real recommendation.

**Acceptance Criteria:**

**Given** the live preset feed is empty, expired or Redis is unreachable,
**When** the web app renders presets,
**Then** `FALLBACK_PRESET_FEED` is no longer served as if real; the UI shows an explicit "No live presets right now" state that distinguishes "feed unavailable" from "no qualifying presets" (the response carries a reason),
**And** the sample fixtures remain available only behind an explicit dev flag and are visibly labelled "Sample data" when used,
**And** `generate_curated_presets` logs, per cycle, how many candidates were dropped and why (no hit rate, quality gate, dedup, below minimum legs) so an empty feed is diagnosable from the worker log.

**Task 1 (verify):** with `GAME_LOG_PROVIDER=moneyline` set, run the stack and record how many props gain real hit rates per beat cycle (the free plan allows 10 requests/min, so fill is gradual) and whether cards then appear; confirm the 24-hour `presets:feed:snapshot:*` does not serve pre-6.1 values. Findings go in the story's spec.

**Edge cases:** the market browser and drawer must also stop mixing fixture legs into live data; `LegSwapperModal`, `MarketBrowser`, `ParlayDrawer` and `PresetCard` share the "Limited history" copy and must keep working with the new state.

### Story 7.2: Remove Fabricated `guarded_ev` Default

As a bettor,
I want a missing edge estimate to stay missing,
So that no preset score or display includes an invented 2% EV.

**Acceptance Criteria:**

**Given** a prop whose `guarded_ev` is `NULL`,
**When** `presets.py` builds its `PresetLeg`,
**Then** no `Decimal("0.0200")` (or any default) is substituted, `guarded_ev` stays `None`, and the leg is either excluded from EV-dependent scoring or the score is computed only from legs with real EV (decision recorded in the spec),
**And** the web display renders a missing EV as absent, never as 0.00% or 2.00%,
**And** a real `guarded_ev` of exactly `0` is preserved (explicit `is None` check, not `or`).

### Story 7.3: Canonical Prop Market Keys

As a bettor,
I want one market to appear once,
So that filters, sorting and consistency data are not split across spelling variants.

**Acceptance Criteria:**

**Given** the database holds `player_threes` (1,049 rows) alongside `player_threes_made` (83), and `player_rush_yds` / `player_rushing_yards` / `player_rush_yards` and `player_pass_yds` / `player_passing_yards` variants,
**When** props are ingested,
**Then** every provider spelling is mapped to one canonical `market_key` at the ingestion boundary, with the mapping table in one place and unit-tested,
**And** hit-rate computation, the MoneyLine game-log stat mapping and the web market filters all use the canonical keys,
**And** an unknown market key is stored as received and logged once, not silently dropped.

**Edge cases:** existing rows are rewritten by a one-off local script (no migration framework needed); anytime-TD stays `player_anytime_td`.

### Story 7.4: Developer-Loop Chores

As the developer,
I want the remaining Epic 6 follow-ups closed,
So that the next epics start from accurate docs and visible provider limits.

**Acceptance Criteria:**

**Given** the Epic 6 retro action items 3, 5 and 7 and the open `deferred-work.md` entries,
**When** this story ships,
**Then** MoneyLine `x-credits-remaining` and the per-cycle request count are logged at INFO each beat cycle,
**And** `epic-6-context.md` lists story 6.7, the Carson Beck note in `epics.md` (Story 6.6) is replaced by the decision recorded in spec 6-6, and the `deferred-work.md` entry "Choose and wire a real player game-log source" is marked resolved by 6-7,
**And** `git_flow.py` gains a commit-only subcommand (no push) and `AGENTS.md` says when to use it,
**And** `AGENTS.md` lists the `ml:roster:*`, `ml:gamelog:*`, `ml:rl:*` Redis key families and their TTLs.

## Epic 8: Game-Centric Browsing & Explainability

Inspired by Fanatics Sportsbook (screenshots reviewed 2026-11-17): a slate where each game shows its main lines, a game page with main lines then props by market tab, and a deeper game-lines section. Scope here is the first two levels; per-period lines (halves, quarters) and multi-rung player ladders are out of scope. Today the worker stores only player props (`player_props`); spread, moneyline and total are not ingested, so Story 8.1 is a data story and gates 8.2 and 8.3. Story 8.4 (sorting) and Story 8.5 (About) do not depend on game lines and may run in parallel after Epic 7.

### Story 8.1: Game Lines Ingestion (Spread, Moneyline, Total)

As a bettor,
I want the app to know each game's spread, moneyline and total,
So that games can be shown with their main lines.

**Acceptance Criteria:**

**Given** the upstream provider returns `h2h`, `spreads` and `totals` markets for NFL and NBA events,
**When** the schedule/odds sync runs,
**Then** the main line for each is stored per event (consensus line plus per-book prices where available) in PostgreSQL with `TIMESTAMPTZ` timestamps and cached in Redis with the same 45-second TTL as other live odds,
**And** odds follow the Decimal invariant (stored as decimal, American only at display),
**And** an event without lines is stored without them, never with defaults.

**Task 1 (gate):** confirm from a live response that parlay-api returns these markets for NFL and NBA and at what credit cost per event; if it does not, stop and re-plan 8.2 and 8.3 around prop-only data.

### Story 8.2: Slate of Games With Main Lines & Click-to-Filter

As a bettor,
I want to see each upcoming game with its spread, moneyline and total and click one to see only its props,
So that I can browse the slate the way I do in my sportsbook.

**Acceptance Criteria:**

**Given** the Schedule & Market Browsing section,
**When** it loads,
**Then** each game shows away and home team, start time and a Spread / Money / Total grid (two rows, away over home) from Story 8.1, with missing lines shown as "—",
**And** clicking a game selects it (visibly highlighted) and filters the player-prop list below to that event; clicking it again, or a "Clear" control, removes the filter, and the existing sport and date filters still apply,
**And** the selection is reflected in the URL (for example `?game=<event_id>`) so a refresh or shared link keeps it, and the layout works at mobile width.

**Edge cases:** a game with no props shows an empty state, not the previous list; selection survives the 30-second data refresh without flicker.

### Story 8.3: Game Detail Page

As a bettor,
I want a page for one game with all its lines and its players' history,
So that I can judge a game's props in context.

**Acceptance Criteria:**

**Given** the slate from Story 8.2,
**When** I open a game,
**Then** `/games/<event_id>` shows the header (teams, start time), a Main Lines block, and a Player Props section with market tabs (for example Points, Threes, Rebounds for NBA; Pass Yds, Rush Yds, Anytime TD for NFL) listing each player's line, Over/Under prices, hit rate and form dots,
**And** expanding a player shows their recent game log (most recent first) from the existing game-log cache, or "Limited history" when none exists,
**And** the page offers the existing parlay-drawer add-to-slip action on each prop and works at mobile width,
**And** an unknown or past `event_id` shows a not-found state.

**Out of scope:** per-period lines, multi-rung player ladders, live scores, head-to-head history.

### Story 8.4: Sortable Market Browser

As a bettor,
I want to sort the prop list by score, player, team and other fields,
So that I can find the best or most relevant props quickly.

**Acceptance Criteria:**

**Given** the market browser list,
**When** I click a column header or choose a sort option,
**Then** rows sort ascending or descending by player, team, market, line, odds, EV, hit rate and score, with an indicator of the active sort and direction,
**And** missing values (for example no hit rate) always sort last regardless of direction,
**And** sorting composes with the sport, date, market and game filters, and the choice persists in the URL.

### Story 8.5: About & How It Works

As a new bettor,
I want a clear explanation of the site and its score,
So that I understand what the numbers mean before I act on them.

**Acceptance Criteria:**

**Given** the navigation,
**When** I open About,
**Then** `/about` walks through the site in sections: what ParlayPal is, the preset feed, the market browser and game pages, the parlay drawer and lineshopping, QuickPick handoff, bet tracking and CLV,
**And** it explains the Hybrid Value Score in plain language (inputs, direction, how missing data is handled, what a high score does and does not mean), matching the implemented formula in `presets.py`,
**And** it explains consistency hit rates (L5/L10/season, Over vs Under), the "Limited history" badge, EV and the 10% suspect-line guard, and states that it is not betting advice,
**And** a short "What is this score?" link on preset cards and the market browser points to the relevant section.

**Edge cases:** copy must be written from the code (score formula, thresholds) at implementation time, not from memory, so it cannot drift from behavior.
