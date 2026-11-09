# Digest: Streaming, Latency & Credit Consumption

- **Topic:** ParlayAPI Streaming & Credit Economics
- **Date:** 2026-11-07
- **Source:** ParlayAPI Pricing & Rate Limiting Documentation (`parlay-api.com/pricing`, `/docs`)
- **Confidence:** High

## Key Claims & Evidence

1. **Pricing Tiers & Quotas:**
   - **Free ($0/mo):** 1,000 credits/mo, 2-day historical data access, no credit card required.
   - **Starter ($5/mo):** 20,000 credits/mo, 7-day historical window.
   - **Pro ($20/mo):** 100,000 credits/mo, 30-day historical window, line-movement API.
   - **Business ($40/mo):** 1,000,000 credits/mo, 90-day historical window, unlocks WebSockets + SSE.
   - Overage policy: No unexpected billing; paid endpoints return `HTTP 403 OUT_OF_USAGE_CREDITS` on exhaustion until reset.

2. **Credit Consumption Mechanics:**
   - **Live Game Odds:** `billable_markets × regions` (e.g., `?markets=h2h,spreads&regions=us` costs 2 credits).
   - **Bookmaker Filtering:** Specifying `bookmakers=` counts 1 region-equivalent per 10 books (rounded up).
   - **Historical Odds:** 10× standard formula.
   - **Historical Closing Odds:** Flat 10 credits per call (`/v1/historical/sports/{sport_key}/closing-odds`).

3. **Streaming & Rate Limits:**
   - **Per-Second Throttling:** No hard per-second rate limits on paid plans. Safe ceiling at 10,000 requests/sec.
   - **WebSocket Push Feeds (Business tier):**
     - Endpoint: `wss://parlay-api.com/v1/ws/odds/{sport_key}`
     - Sends initial snapshot, then broadcasts low-latency `odds_update` frames as lines shift.
     - 5 concurrent WebSocket connections allowed per API key on standard tier.
