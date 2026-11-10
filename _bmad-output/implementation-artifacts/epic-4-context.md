# Epic 4 Context: Bet Tracking & Closing Line Value (CLV) Ledger

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Provide sports bettors with automated bet tracking and empirical edge verification by persisting staged, pending, and settled tickets in a high-contrast dashboard and calculating asynchronous Closing Line Value (CLV) against post-commence sharp closing prices to measure long-term beating of bookmaker margins.

## Stories

- Story 4.1: User Bet Tracker Dashboard & Persistence
- Story 4.2: Asynchronous Closing Line Value (CLV) Worker
- Story 4.3: CLV Analytics & Long-Term Edge Reporting

## Requirements & Constraints

- **User Bet Tracker Dashboard & Persistence (Story 4.1):**
  - Dedicated "My Bets" tracking tab/view displaying all staged, pending, and settled tickets partitioned by status (`pending`, `settled_won`, `settled_lost`, `staged`).
  - Render stake amount, execution odds (Decimal standard, displayed in American), bookmaker placed at, potential payout, timestamp, and live game score progress.
  - Durable persistence in PostgreSQL 16 (`user_bets`) and seamless client synchronization with local state / `localStorage` (`parlaypal:staged_bets`).
  - Provide transition controls: allow moving a ticket from `staged` (opened in sportsbook) to `pending` (confirmed placed with stake amount) or canceling/removing.
- **Asynchronous Closing Line Value (CLV) Worker (Story 4.2):**
  - Celery background task triggered 10 minutes post-commence time for tracked bets with status `pending`.
  - Queries `GET /v1/historical/sports/{sport_key}/closing-odds?event_id={event_id}` via worker daemon.
  - Devigs sharp closing price via Power method (Brent's solver) to extract $P_{\text{fair, close}}$.
  - Calculates $\text{CLV}\% = (P_{\text{fair, close}} \times D_{\text{exec}}) - 1$ and stamps into `user_bets.closing_fair_prob` and `user_bets.clv_percentage`.
- **CLV Analytics & Long-Term Edge Reporting (Story 4.3):**
  - Bet Tracker Analytics view showing overall "Closing Line Beat Rate" (% of bets beating closing line) and average CLV% gain alongside standard win/loss ROI.
  - Visual edge distribution reporting across sports and bookmakers.

## Technical Decisions

- **Polyglot Service Isolation (AD-1):**
  - Python 3.13 / Celery worker (`services/worker`) owns all external interaction with `parlay-api.com` historical endpoints and numerical devigging root-solving. Never handles user browser HTTP traffic.
  - Next.js 15 App Router (`apps/web`) owns user bet dashboard UI, bet-tracking APIs (`/api/bets/*`), local storage syncing, and Server Actions.
- **Data Architecture & Schema (AD-2, AD-6):**
  - PostgreSQL 16 durable schema: `user_bets` table with UUID v4 primary keys (`bet_id`, `user_id`, `event_id`), `sportsbook`, `decimal_odds`, `closing_fair_prob`, `clv_percentage`, `stake_amount`, `status` (`'staged'`, `'pending'`, `'won'`, `'lost'`, `'push'`, `'void'`), and timestamps (`placed_at`, `settled_at`).
  - Ephemeral Redis 7.2 layer caches live scores and pending tracking lists if needed.
- **Odds & Value Representation Invariants:**
  - Execute all internal odds math in `Decimal` format ($D \ge 1.01$, `le=Decimal("9999.9999")`).
  - American odds display format (`+150`, `-110`) strictly at presentation boundaries.
  - Outlier Circuit Breaker: exclude or guard any lines with $\text{EV} > 10.0\%$ (`SUSPECT_STALE_LINE`).

## UX & Interaction Patterns

- **Color Tokens & Visual Surfaces:**
  - Deep slate base (`#0a0e17`), elevated card containers (`#121b2d`), structural hairline borders (`#1e293b`).
  - Electric Cyan (`#06b6d4`) for active tabs, status badges, and interactive controls.
  - Mint Emerald (`#10b981`) for positive CLV badges (`+4.2% CLV`), winning settlements, and won tickets.
  - Rose/Red (`#ef4444`) for lost tickets and negative CLV.
  - Amber (`#f59e0b`) for pending/staged tickets awaiting game completion or settlement.
- **Layout & Structure:**
  - Dedicated "My Bets" tab or route accessible from top navigation.
  - Segmented status filters: All, Staged, Pending / Live, Settled.
  - Expandable bet cards showing individual legs, prop descriptions, rolling hit rate tags, live game progress, execution odds, and CLV stats.

## Cross-Story Dependencies

- **Story 3.3 → Story 4.1:** The 1-Tap QuickPick handoff in Story 3.3 auto-stages tickets into local storage and `/api/bets/stage`. Story 4.1 consumes these staged tickets, renders them in the Bet Tracker, and allows upgrading them to confirmed `pending` bets with user-specified stakes.
- **Story 4.1 → Story 4.2:** Story 4.1 persists confirmed `pending` wagers in `user_bets`. Story 4.2's Celery task queries pending wagers 10 minutes post-commence time to stamp CLV.
- **Story 4.2 → Story 4.3:** Story 4.3 aggregates the stamped `clv_percentage` and settlement records from Story 4.2 into user-level edge analytics.
