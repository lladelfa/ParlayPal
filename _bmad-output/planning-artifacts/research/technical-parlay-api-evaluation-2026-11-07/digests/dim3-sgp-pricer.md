# Digest: Same-Game Parlay (SGP) Pricer & Correlation Modeling

- **Topic:** ParlayAPI SGP Capabilities & Correlation Mechanics
- **Date:** 2026-11-07
- **Source:** ParlayAPI Documentation (`/v1/sgp/price`, `/v1/try/sgp`), Sports Tech Reviews
- **Confidence:** High

## Key Claims & Evidence

1. **Dedicated SGP Pricing Endpoint:**
   - URL: `https://parlay-api.com/v1/sgp/price`
   - Purpose: Generates correlation-adjusted pricing for multi-leg same-game parlays rather than using naive unadjusted multiplication (\(\prod P_i\)).
   - Supports passing selections across game mainlines and player props in a single game context.

2. **Correlation Audit Output:**
   - Response includes a `correlation_audit[]` array that details statistical dependency/correlation coefficients between each leg pair (e.g., QB Passing Yards Over paired with WR Receiving Yards Over vs. Opposing Running Back Yards Over).
   - Enables auditing why an SGP pays what it does and identifying whether the retail book's offered payout underpenalizes positive correlation.

3. **Architectural Value for ParlayPal:**
   - Eliminates the immediate need for ParlayPal to develop and maintain an internal proprietary Copula simulation engine for NFL/NBA correlations during Phase 1.
   - Can query `/v1/sgp/price` to get the fair correlation-adjusted price, compare it against retail SGP quotes, and flag mispricings.
