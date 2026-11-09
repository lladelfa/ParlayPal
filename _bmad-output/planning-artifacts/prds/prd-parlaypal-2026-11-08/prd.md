---
title: "ParlayPal — Product Requirements Document"
status: final
created: "2026-11-08"
updated: "2026-11-08"
---

# PRD: ParlayPal

## 0. Document Purpose
This Product Requirements Document (PRD) defines the product scope, core capabilities, user journeys, functional requirements, and system boundaries for **ParlayPal v1 (MVP)**. It serves as the primary contract between Product Management, System Architecture, UX Design, and Development. Technical implementation details and mathematical solver derivations are anchored in the companion [ARCHITECTURE-SPINE.md](file:///c:/Users/llade/Documents/GitHub/ParlayPal/_bmad-output/planning-artifacts/architecture/architecture-spine-2026-11-08/ARCHITECTURE-SPINE.md) and technical research digests.

---

## 1. Vision
For sports fans and casual parlay bettors, crafting a multi-leg parlay is exciting but painfully tedious. Bettors are forced to spend hours hopping across ESPN box scores, player consistency logs, Twitter injury updates, and stadium weather forecasts—only to build gut-feel parlays with compounded sportsbook juice (vig) where the house maintains an insurmountable 20–30% edge.

**ParlayPal eliminates this friction entirely.** It delivers a high-conviction, automated research terminal that does all the heavy statistical lifting upfront. ParlayPal pairs **historical consistency** (e.g., players hitting props in 8 of the last 9 games) with **situational context alerts** (e.g., 25 mph freezing wind at outdoor stadiums) and **mathematical value (+EV)** to curate front-and-center preset parlays. With interactive leg customization and universal 1-tap betslip generation via **QuickPick (Pikkit)**, bettors can discover, customize, and place sharp, mathematically sound parlays into their preferred sportsbook in seconds.

---

## 2. Target User

### 2.1 Jobs To Be Done (JTBD)
- **Functional:** "When I want action on tonight's NBA slate or Sunday's NFL games, I want pre-vetted, high-probability parlay recommendations so I don't have to manually aggregate stats across multiple websites."
- **Contextual:** "When I'm betting on outdoor games, I want immediate visibility into environmental factors (like high wind or freezing rain) so I don't get blindsided by reduced passing or scoring volumes."
- **Economic / Value:** "When I place a parlay, I want to make sure I'm getting fair market odds (+EV) rather than paying exorbitant bookmaker margins."
- **Emotional:** "I want to feel confident and informed about my picks, not like a sucker throwing darts at a board."
- **Efficiency:** "When I find a parlay I like, I want to export it directly into my DraftKings or FanDuel betslip with one tap, without manually searching for each player leg."

### 2.2 Non-Users (v1)
- **High-Frequency Arbitrage Bots:** Bettors looking for automated sub-second execution across exchanges to capture risk-free arbitrage spreads.
- **Micro-Betting In-Play Bettors:** Bettors wanting second-by-second next-pitch or next-play micro-markets. (v1 focuses on pre-match props).

### 2.3 Key User Journeys

#### UJ-1: Marcus grabs the Sunday Touchdown Parlay in 60 seconds
- **Persona + Context:** Marcus, a 28-year-old software engineer and avid NFL fan, is sitting on his couch 45 minutes before Sunday 1:00 PM kickoff. He wants a fun, high-confidence 3-leg touchdown parlay.
- **Entry State:** Mobile web browser, unauthenticated / guest or authenticated user on the ParlayPal home screen.
- **Path:**
  1. Marcus lands on the home feed and immediately sees the featured preset card: **"The Red Zone Express"** (3-leg Anytime Touchdown parlay: Derrick Henry, CeeDee Lamb, Travis Kelce).
  2. Each leg clearly displays a **Consistency Badge** (e.g., *"TD in 7 of last 8 games"*), a **Value Score** (`+3.2% EV`), and the combined payout (`+485`).
  3. Marcus notices a yellow **Weather Alert Badge** on Travis Kelce (`⚠️ Buffalo Highmark Stadium: 24mph crosswinds & snow flurries`).
  4. He taps **"Customize Parlay"**, removes Kelce, browses the "NFL Anytime TD" consistency screener for the 1:00 PM window, and swaps in Jahmyr Gibbs (`TD in 6 of last 7`).
  5. The card instantly recalculates the new combined odds (`+420`) and total hybrid value score.
- **Climax:** Marcus taps **"Open in Sportsbook"**. ParlayPal calls the QuickPick deep-link generator and opens DraftKings on his phone with all three legs pre-populated in his betslip.
- **Resolution:** Marcus places the bet on DraftKings, toggles back to ParlayPal, taps **"Track Bet"**, and the ticket is logged to his personal CLV ledger.
- **Edge Case:** If a player in the preset is ruled out 10 minutes prior to kickoff, the card surfaces a red `INACTIVE` tag and prompts Marcus with a 1-tap "Swap with Next Best Trend" recommendation.

#### UJ-2: Elena builds a Friday Night NBA "Bucket Getters" Parlay
- **Persona + Context:** Elena follows NBA daily fantasy and player props. She wants to parlay 3 players to score Over 20.5 points on a 9-game Friday slate.
- **Entry State:** Desktop web browser on ParlayPal.
- **Path:**
  1. Elena selects the **NBA** sport tab and clicks the **"20+ Points Consistency"** category.
  2. The screener ranks all players playing tonight sorted by their 10-game hit rate and fair market value.
  3. She selects three players: Shai Gilgeous-Alexander (Over 28.5), Anthony Edwards (Over 24.5), and Jalen Brunson (Over 25.5).
  4. The **Parlay Drawer** computes the combined price, checks for Same-Game correlations (if any are teammates or opponents), and confirms all legs pass the Outlier Guard.
  5. She reviews the **QuickPick Lineshopper**, seeing that FanDuel offers `+380` while BetMGM only offers `+330`.
- **Climax:** She clicks **"Place on FanDuel via QuickPick"**, which routes directly to FanDuel with the slip loaded at the superior price.
- **Resolution:** Elena saves the bet to her ParlayPal profile to track closing line value against final pre-tip market prices.

---

## 3. Glossary
Downstream workflows and readers must use these terms exactly:

- **Anytime Touchdown (ATTD):** A proposition bet that a specific player scores a rushing, receiving, or defensive touchdown at any point during the game.
- **Consistency Hit Rate:** The historical percentage of games in which a player achieved or exceeded a specific statistical proposition line over a defined rolling sample (last 5, last 10, and full season).
- **Context Badge:** A visual indicator attached to a match or prop displaying environmental or situational factors (e.g., wind speed $\ge 15\text{ mph}$, freezing precipitation, dome/indoor stadium, key injury return).
- **Devigging:** The mathematical process of stripping the bookmaker's margin (overround/vig) to extract the true "fair" probability $P_{\text{fair}}$ using Multiplicative or Power methods.
- **Expected Value (+EV):** The percentage edge of a bet relative to the fair market probability: $\text{EV} = (P_{\text{fair}} \times D_{\text{offered}}) - 1$.
- **Hybrid Value Score:** ParlayPal's proprietary composite score blending the Consistency Hit Rate with Positive Expected Value to identify bets that are both statistically reliable and mathematically profitable.
- **Outlier Guard:** An automated circuit breaker that flags any prop with calculated $\text{EV} > 10.0\%$ as `SUSPECT_STALE_LINE` to protect users from betting into erroneous lines that sportsbooks will void.
- **Preset Parlay:** A curated, pre-packaged multi-leg parlay card featured on the home screen categorized by theme (e.g., Red Zone Express, Floor Generals, Weather Underdogs).
- **Leg Customizer:** An interactive component allowing users to add, remove, or swap individual legs within any Preset Parlay or custom parlay slip with real-time recalculation of odds.
- **QuickPick Deep-Link:** A universal smart-link URL generated via Pikkit's QuickPick integration (`quickpick.pikkit.com`) that transfers the full parlay slip into major retail sportsbook apps in one tap.
- **Closing Line Value (CLV):** The percentage difference between the odds locked in by the user at bet placement and the final sharp closing price right before game commencement.
- **Parlay Drawer:** The persistent floating slip on web/mobile where users assemble, inspect, and execute their custom or modified parlays.

---

## 4. Features

### 4.1 Curated Preset Parlays & Landing Feed
**Description:** The primary landing experience when opening ParlayPal. Surfaces 3–5 high-conviction, themed preset parlays for today's active games (NFL and NBA). Each preset card summarizes the theme, the legs, player consistency hit-rates, environmental context badges, combined sportsbooks odds, and the composite Hybrid Value Score. Realizes UJ-1.

**Functional Requirements:**

#### FR-1: Preset Parlay Feed Display
The system must display an ordered feed of active, curated Preset Parlay cards on the home screen based on upcoming scheduled games for the current day/weekend. Realizes UJ-1.
**Consequences (testable):**
- System displays at least 1 and up to 5 valid preset cards when games are scheduled within the next 24 hours.
- If a game has already commenced, preset cards containing legs from that game are automatically removed or marked `COMMENCED`.

#### FR-2: Leg Consistency & Context Display
Each leg within a Preset Parlay card must display the player name, team matchup, prop market, current line, rolling consistency hit rate (e.g., "7/8 (88%) L8G"), and any applicable Context Badges. Realizes UJ-1.
**Consequences (testable):**
- Given an NFL game scheduled at an outdoor stadium with forecasted winds $\ge 15\text{ mph}$, the system displays a yellow warning Context Badge showing wind speed and direction.
- Given an indoor/dome stadium, the system displays a dome icon badge indicating neutral weather conditions.

#### FR-3: 1-Tap QuickPick Launch
Each Preset Parlay card must feature a primary call-to-action button ("Open in Sportsbook") that calls the QuickPick deep-link generator and opens the user's sportsbook with the parlay preloaded. Realizes UJ-1.
**Consequences (testable):**
- Tapping the CTA initiates a request to the QuickPick API with the specific sport, event IDs, player IDs, and prop selections, returning a deep link within $\le 1.5$ seconds.

---

### 4.2 Interactive Parlay Builder & Leg Customization
**Description:** Bettors can customize any Preset Parlay or construct their own multi-leg slip from scratch. Users can remove a leg, swap a leg with an alternative candidate, or browse the complete schedule of games across NFL and NBA to add new legs. Realizes UJ-1, UJ-2.

**Functional Requirements:**

#### FR-4: Leg Swapping and Removal
Users can remove any leg from a preset parlay or tap "Swap Leg" to view top-ranked alternative props from the same sport and time window. Realizes UJ-1.
**Consequences (testable):**
- Removing a leg updates the Parlay Drawer immediately without reloading the page.
- Tapping "Swap Leg" displays a modal ranked by the Hybrid Value Score for props matching the same market type or time window.

#### FR-5: Multi-Sport Schedule & Market Browser
Users can filter games by sport (NFL, NBA) and date (Today, Tomorrow, Weekend), browsing available prop markets:
- **NFL:** Anytime Touchdown (ATTD), Passing Yards Over/Under, Rushing Yards Over/Under.
- **NBA:** Player Points Over/Under, Rebounds Over/Under, Made Threes Over/Under. Realizes UJ-2.
**Consequences (testable):**
- Filtering by "NBA" and "Points" lists all active player points markets with current sportsbook lines, consistency hit rates, and EV%.

#### FR-6: Real-Time Odds & Hybrid Score Recalculation
The system must recalculate combined parlay decimal odds, American payout, and composite Hybrid Value Score whenever legs are added, modified, or removed. Realizes UJ-1, UJ-2.
**Consequences (testable):**
- Combining 3 independent legs calculates fair parlay probability as $\prod P_{\text{fair}, i}$ and displays decimal odds to 2 decimal places alongside standard American format (+420).
- If two or more legs originate from the *same* game, the system tags the combination as a Same-Game Parlay (SGP) and queries the correlation engine.

---

### 4.3 Hybrid Value & Environmental Context Engine
**Description:** The quantitative brain of ParlayPal. It evaluates every player prop line against rolling box score statistics to compute hit rates, devigs the sharpest sportsbook odds to find fair probabilities, verifies outlier boundaries, and pulls stadium/weather conditions. Realizes UJ-1, UJ-2.

**Functional Requirements:**

#### FR-7: Rolling Consistency Hit Rate Calculation
The system must calculate rolling consistency hit rates for each player prop over three sample intervals: Last 5 games (L5), Last 10 games (L10), and Full Current Season. Realizes UJ-1, UJ-2.
**Consequences (testable):**
- Given a player who scored a touchdown in 8 of the last 10 games, the system returns `8/10 (80.0%)` for L10 hit rate.

#### FR-8: Devigging & Outlier Guard
The system must devig consensus sharp book odds using the Power method (and Multiplicative minimum) to compute $P_{\text{fair}}$ and Expected Value (EV%). Bets with $\text{EV} > 10.0\%$ must be flagged as `SUSPECT_STALE_LINE` and excluded from presets. Bets with $\text{EV} < 1.5\%$ are excluded from value highlights. Realizes UJ-1, UJ-2.
**Consequences (testable):**
- A prop calculated with $\text{EV} = 12.5\%$ is tagged `SUSPECT_STALE_LINE` and barred from appearing in automated preset feeds.
- A prop calculated with $\text{EV} = 3.5\%$ and $\text{Hit Rate} \ge 70\%$ receives the "High Value" badge.

#### FR-9: Environmental Weather Context Ingestion
The system must ingest weather forecast data for all outdoor NFL stadiums within 24 hours of kickoff, tagging games with wind speed, temperature, and precipitation type. Realizes UJ-1.
**Consequences (testable):**
- If wind speed $\ge 15\text{ mph}$, a weather badge is applied to passing and kicking props for that event.
- If precipitation probability $\ge 50\%$ (rain or snow), a wet conditions badge is attached.

---

### 4.4 QuickPick Betslip Handoff & Lineshopping
**Description:** Connects ParlayPal to the retail betting ecosystem via `quickpick.pikkit.com`. Translates the Parlay Drawer selections into a universal slip and deep-links the user into DraftKings, FanDuel, BetMGM, Caesars, or bet365. Realizes UJ-1, UJ-2.

**Functional Requirements:**

#### FR-10: QuickPick Payload Serialization
The system must serialize all selections in the active Parlay Drawer into the QuickPick API schema (specifying sportsbook, sport league, event external ID, market type, selection player ID, and line). Realizes UJ-1, UJ-2.
**Consequences (testable):**
- Successfully returns a valid QuickPick smart-link URL with HTTP 200 upon user checkout tap.

#### FR-11: Best Book Price Comparison
The system must compare payout odds across integrated sportsbooks (DraftKings, FanDuel, BetMGM, Caesars) for the selected parlay legs and highlight the book offering the highest payout. Realizes UJ-2.
**Consequences (testable):**
- The UI displays a "Best Odds at [Sportsbook Name]" indicator showing the payout difference (e.g., `FanDuel (+420) vs DraftKings (+370)`).

---

### 4.5 Bet Tracking & CLV Ledger
**Description:** Allows bettors to track their placed parlays, monitor real-time game progress, record final win/loss settlements, and evaluate closing line value (CLV) against sharp closing lines. Realizes UJ-1.

**Functional Requirements:**

#### FR-12: 1-Tap Bet Logging
Users can save any parlay in their Parlay Drawer to their local/account bet history with execution odds, stake amount, and timestamp. Realizes UJ-1.
**Consequences (testable):**
- Creates a `user_bets` record with status `pending` in the persistent database.

#### FR-13: Asynchronous CLV Stamping
The system must query the closing sharp odds 10 minutes post-commence time for every leg in a tracked bet, calculate CLV% against execution odds, and stamp the result onto the bet record. Realizes UJ-1.
**Consequences (testable):**
- Given an execution price of `+150` ($D = 2.50$) and a closing fair probability of $P_{\text{fair, close}} = 0.44$, the system stamps $\text{CLV}\% = (0.44 \times 2.50) - 1 = +10.0\%$.

---

## 5. Non-Goals (Explicit)
- **Direct Real-Money Wagering within ParlayPal:** ParlayPal is strictly a research, analytics, and betslip preparation tool. ParlayPal will **never** hold user funds, act as a bookmaker, or process gambling transactions directly. All wagering occurs on licensed retail sportsbooks via QuickPick.
- **In-Play / Live Betting Micro-Markets (v1):** Pre-match props only in MVP. Live in-game micro-props (e.g. "Will next drive result in a TD?") are out of scope for v1.
- **Social Feed / Bettor Chat Rooms (v1):** No user commenting, public user profiles, or social upvoting feeds in v1.
- **Automated Algorithmic Execution:** No automated bot betting on behalf of users without explicit human click-through.

---

## 6. MVP Scope

### 6.1 In Scope (v1)
- Sports: **NFL** and **NBA**.
- Markets:
  - NFL: Anytime Touchdown (ATTD), Passing Yards (O/U), Rushing Yards (O/U).
  - NBA: Player Points (O/U), Rebounds (O/U), Made Threes (O/U).
- Features:
  - Curated Preset Parlay Feed with 1-tap leg customization.
  - Hybrid Value Scoring (Hit Rate + Power-method Devigged +EV).
  - Outlier Guard ($\text{EV} \le 10\%$).
  - Outdoor Stadium Weather Context Badges (Wind, Precip, Dome).
  - QuickPick (`quickpick.pikkit.com`) universal deep-linking into DraftKings, FanDuel, BetMGM, Caesars.
  - Lineshopping comparison across supported books.
  - User Bet Tracker with Asynchronous Closing Line Value (CLV) calculation.
- Platform: Responsive Web Application (Next.js 15, optimized for mobile web and desktop).

### 6.2 Out of Scope for MVP (Deferred to v2/v3)
- **NHL and MLB Coverage:** Deferred to v2 upon NFL season conclusion.
- **Player Prop Alerts via Push Notifications:** Deferred to v2.
- **Native iOS/Android Apps:** Web-first responsive application in v1; native wrappers deferred to v2.
- **Automated Bankroll Management (Kelly Criterion auto-staking):** Basic flat staking / unit tracking in v1; dynamic fractional Kelly calculator deferred to v2.

---

## 7. Success Metrics

### Primary
- **SM-1: Betslip Handoff Rate:** $\ge 35\%$ of active daily sessions generate a QuickPick deep link click-through. Validates FR-1, FR-3, FR-10.
- **SM-2: Leg Customization Engagement:** $\ge 25\%$ of users who interact with a Preset Parlay use the Leg Customizer to swap or add legs before checking out. Validates FR-4, FR-6.

### Secondary
- **SM-3: Tracked Bet CLV Outperformance:** $\ge 60\%$ of tracked user bets achieve a positive Closing Line Value ($\text{CLV} > 0.0\%$). Validates FR-8, FR-13.
- **SM-4: QuickPick Deep-Link Latency:** 95th percentile latency for generating a QuickPick link is $< 1500\text{ ms}$. Validates FR-10.

### Counter-Metrics (Do Not Optimize)
- **SM-C1: Total Legs per Parlay (Do Not Maximize):** We explicitly do **not** optimize for maximizing the number of legs per parlay (e.g. pushing 10-leg lottos). Long-tail lottery parlays compound bookmaker vig and destroy user bankrolls. The system caps automated presets at 2 to 4 high-conviction legs. Counterbalances SM-1.

---

## 8. Open Questions
1. **QuickPick API Authentication & Rate Limits:** Does ParlayPal have an assigned partner API key with Pikkit/QuickPick, or will v1 use public URL schema formatting / web portal endpoints?
2. **Weather API Provider:** Will weather data be sourced via ParlayAPI stadium metadata if available, or do we connect an external weather API (e.g. Open-Meteo or WeatherAPI)?
3. **User Authentication Necessity for MVP:** Should guest/unauthenticated users be able to view presets, customize legs, and trigger QuickPick links, requiring an account only to save/track bets? `[ASSUMPTION: Yes, guest browsing enabled for frictionless top-of-funnel conversion]`.

---

## 9. Assumptions Index
- `[ASSUMPTION §2.3, §8.3]`: Guest browsing is enabled. Users can view presets, customize, and generate QuickPick links without an initial account; account sign-up is required only for persistent bet tracking.
- `[ASSUMPTION §4.1, §4.3]`: Presets are capped at 2 to 4 legs to prioritize win probability and positive EV over long-shot lottery tickets.
- `[ASSUMPTION §4.3]`: Weather impact thresholds use $\ge 15\text{ mph}$ for wind warnings based on NFL historical passing variance data.
- `[ASSUMPTION §4.4]`: QuickPick deep-linking supports DraftKings and FanDuel as tier-1 books, with BetMGM and Caesars as secondary.
- `[ASSUMPTION §6.1]`: Desktop and mobile-responsive web is the target platform for MVP; no native app stores required for initial launch.
