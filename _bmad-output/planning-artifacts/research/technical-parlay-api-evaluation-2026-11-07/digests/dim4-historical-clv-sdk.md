# Digest: Historical Closing Lines, CLV, & SDK Integration

- **Topic:** ParlayAPI Closing Odds & Developer Ecosystem
- **Date:** 2026-11-07
- **Source:** PyPI (`parlay-api`), OpenAPI documentation, GitHub / PublicAPIs
- **Confidence:** High

## Key Claims & Evidence

1. **Closing Lines & CLV (Story 4.1):**
   - Dedicated endpoint: `GET /v1/historical/sports/{sport_key}/closing-odds`.
   - Returns final market state immediately prior to event commence time.
   - Cost: Flat 10 credits per event call.
   - Enables asynchronous post-game settlement workers to fetch exact sharp devigged closing prices without requiring ParlayPal to run 24/7 scrapers on game start.

2. **Official Python SDK:**
   - Package: `parlay-api` (`pip install parlay-api`).
   - Standard initialization:
     `client = ParlayAPI(api_key=os.environ.get("PARLAY_API_KEY"))`
   - Native methods:
     - `client.sports()`
     - `client.events(sport_key)`
     - `client.odds(sport_key, regions="us", markets="h2h,spreads")`
     - `client.props(sport_key, event_id=...)`
   - Exception handling conforms to standard Python requests/HTTP status code wrappers.

3. **Database & Caching Recommendation:**
   - Dual-tier: Ingest via Python daemon / Node.js worker -> cache latest snapshot in Redis (TTL: 30–60s) -> write ticks to TimescaleDB hypertable (`odds_ticks`) only when prices shift.
   - For CLV calculation: Scheduled cron job fires 10 minutes post-game to query `/v1/historical/.../closing-odds` and update `user_bets.closing_fair_prob` and `clv_percentage`.
