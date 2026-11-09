# Digest: API Endpoints, Sharp & Retail Coverage, & Payload Schema

- **Topic:** ParlayAPI Core Coverage & Payload Architecture
- **Date:** 2026-11-07
- **Source:** ParlayAPI Official Documentation (`parlay-api.com`), OpenAPI (`/openapi.json`), PublicAPIs
- **Confidence:** High

## Key Claims & Evidence

1. **The-Odds-API v4 Drop-In Compatibility:**
   - Base URL: `https://parlay-api.com`
   - Authentication: Header `X-API-Key: <key>` or query parameter `apiKey=<key>`.
   - Core endpoint paths match v4 standard:
     - `GET /v1/sports`
     - `GET /v1/sports/{sport_key}/events`
     - `GET /v1/sports/{sport_key}/odds`
     - `GET /v1/sports/{sport_key}/props`
   - Payload structure:
     `[ { id, sport_key, commence_time, home_team, away_team, bookmakers: [ { key, title, last_update, markets: [ { key, outcomes: [ { name, price, point } ] } ] } ] } ]`
   - Outcome prices can be requested in decimal or american formats (`oddsFormat=decimal` or `oddsFormat=american`).

2. **Sharp & Retail Sportsbook Availability:**
   - Over 30–45+ integrated bookmakers and market makers across 38+ sports.
   - **Sharp Benchmarks:** Pinnacle (`pinnacle`) and Novig (`novig`) are present.
   - **Retail Books:** DraftKings, FanDuel, BetMGM, Caesars, bet365, BetRivers, Bovada.
   - **Prediction Markets:** Direct inclusion of Kalshi and Polymarket as bookmaker sources, allowing devigging against prediction contract probabilities.
   - **DFS Pick'em Books:** PrizePicks, Underdog, Sleeper, Betr, ParlayPlay, Pick6, and Fliff.

3. **Analytics & Comparison Shims:**
   - `GET /v1/sports/{sport_key}/compare` (Side-by-side best line analysis).
   - `GET /v1/sports/{sport_key}/ev` (Pre-calculated positive EV against consensus).
   - `GET /v1/sports/{sport_key}/arbitrage` (Cross-book arbs).
   - `GET /v1/sports/{sport_key}/line-movement` (Time-series odds changes).
