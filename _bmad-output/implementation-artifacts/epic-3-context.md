# Epic 3 Context: QuickPick Universal Betslip Handoff & Lineshopping

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Enable bettors to maximize their expected return by comparing multi-sportsbook parlay payout prices (DraftKings, FanDuel, BetMGM, Caesars), instantly serializing their customized Parlay Drawer tickets into Pikkit QuickPick smart-link schemas, and executing 1-tap deep-link handoffs into retail sportsbook apps with seamless auto-staging into their local tracking ledger.

## Stories

- Story 3.1: Multi-Sportsbook Lineshopper Comparison
- Story 3.2: QuickPick Payload Serialization & Smart-Link Generator
- Story 3.3: 1-Tap Sportsbook Handoff & Auto-Staging Execution

## Requirements & Constraints

- **Multi-Sportsbook Lineshopper Comparison (Story 3.1):**
  - Compare combined parlay payout prices across integrated tier-1 retail sportsbooks (FanDuel, DraftKings) and tier-2 books (BetMGM, Caesars) for the exact legs in the active Parlay Drawer.
  - Dynamically highlight the "Best Value Book" offering the highest payout, showing the calculated delta/edge (e.g. `FanDuel (+420) vs DraftKings (+370)` or `+$55 Edge on $50 bet`).
  - Allow users to select any available sportsbook in the widget to redirect the destination bookmaker for the handoff.
  - Gracefully handle missing lines at specific books (e.g., displaying `Line Unavailable` if a book does not offer a specific player prop without breaking the comparison for remaining books).
- **QuickPick Payload Serialization & Deep-Link Generation (Story 3.2):**
  - Serialize the selections in the active Parlay Drawer into the universal Pikkit QuickPick API schema (`quickpick.pikkit.com`).
  - Map ParlayPal entity IDs (`event_id`, player, prop market key, over/under line, and target sportsbook) to external provider specifications.
  - Return a valid QuickPick smart-link URL with HTTP 200 within strict latency constraints ($\le 1500\text{ ms}$ p95).
  - Support guest and unauthenticated access for betslip serialization to preserve frictionless top-of-funnel conversion.
- **1-Tap Sportsbook Handoff & Auto-Staging Execution (Story 3.3):**
  - Primary CTA ("Open in Sportsbook") launches the QuickPick deep link, opening the sportsbook native app via universal link on mobile or a new browser tab on desktop with legs pre-loaded.
  - Simultaneously auto-stage the ticket into the user's pending bet tracker ledger (`status = "staged"` in PostgreSQL / local state) with timestamp, stake, and execution odds.
  - Display an unobtrusive confirmation toast notification (*"Slip opened in FanDuel & staged for tracking"*).

## Technical Decisions

- **Polyglot Service Isolation (AD-1):**
  - The Python 3.13 / Celery worker service maintains bookmaker line ingestion and odds synchronization from `parlay-api.com` into Redis caches (`odds:latest:{sport_key}:{event_id}`) with strict 45-second TTL.
  - Next.js 15 App Router web app (`apps/web`) owns client-side lineshopper UI rendering, lineshopping price computation from cached odds snapshots, and QuickPick deep-link payload generation (`/api/quickpick/serialize` or client utility).
  - External network calls to `parlay-api.com` are strictly forbidden from browser components or Next.js server components; all odds reads pull from Redis or PostgreSQL.
- **Data & Odds Invariants:**
  - Execute all internal odds calculations in `Decimal` format ($D \ge 1.01$). Convert to American format (`+420`, `-133`) strictly at presentation boundaries.
  - Primary keys and entity IDs are UUID v4; external mapping maintains provider prefixes (e.g., `papi_nfl_12345`).
- **QuickPick Deep-Linking Architecture:**
  - Target URL format conforms to Pikkit QuickPick schema (`https://quickpick.pikkit.com/...` or API endpoint payload).
  - Fallback mechanisms for web desktop vs mobile app schemes (universal links vs web redirects).

## UX & Interaction Patterns

- **Color Palette & Visual Tokens:**
  - Canvas `#0a0e17`, Card/Surface `#121b2d`, Hairline Border `#1e293b`.
  - Electric Cyan (`#06b6d4`) for primary interactive CTAs and active odds pills.
  - Mint Emerald (`#10b981`) for the Best Value Book highlight, profit edge badges (`+$55 Edge`), and auto-stage confirmation toasts.
  - Secondary Violet (`#6366f1`) for parlay multipliers.
- **Lineshopper Widget Placement:**
  - Positioned inside the persistent Parlay Drawer directly beneath the leg list and above the primary CTA button.
  - Displays logos/names of DraftKings, FanDuel, BetMGM, and Caesars with payout multipliers in tabular `JetBrains Mono`.
  - The book with the top payout is highlighted with an emerald border and "Best Odds" pill. Clicking a sportsbook card selects it as the active target book for the QuickPick handoff.
- **Responsive Layout:**
  - **Desktop ($\ge 1280\text{px}$):** Embedded directly in the fixed 360px right-hand Parlay Drawer.
  - **Tablet & Mobile ($< 1280\text{px}$):** Accessible inside the expandable sticky bottom sheet / Parlay Drawer.
- **Handoff Interaction State:**
  - Tapping CTA triggers a loading state with spinning cyan glow ($\le 1.5\text{s}$) while validating/generating the link, opening the sportsbook and displaying the auto-stage confirmation toast.

## Cross-Story Dependencies

- **Epic 2 → Story 3.1:** The Lineshopper directly consumes the active legs selected in the Parlay Drawer (`parlay-drawer` state / context) and their associated market keys and bookmaker odds.
- **Story 3.1 → Story 3.2:** The user's chosen sportsbook in the Lineshopper widget dictates the target bookmaker parameter in the QuickPick payload serializer.
- **Story 3.2 → Story 3.3:** The generated QuickPick smart-link URL is executed by the 1-Tap handoff CTA in Story 3.3.
- **Story 3.3 → Epic 4:** Auto-staging on handoff generates the initial `user_bets` record with status `staged` that primes the Bet Tracker and CLV ledger.
