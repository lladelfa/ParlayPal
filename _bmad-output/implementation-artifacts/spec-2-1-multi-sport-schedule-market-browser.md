---
title: 'Story 2.1: Multi-Sport Schedule & Market Browser'
type: 'feature'
created: '2026-11-09'
status: 'done'
route: 'dispatch'
baseline_commit: '65ebfe91aa975d887f3c0a956742083bdb4218e8'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Bettors who want to customize a parlay or build a ticket from scratch currently only see curated multi-leg preset cards and lack a dedicated screener to browse upcoming NFL and NBA schedules by date window (`Today`, `Tomorrow`, `Weekend`) and individual prop categories (`Anytime TD`, `Passing Yards`, `Rushing Yards`, `Points`, `Rebounds`, `Threes`) ranked by consistency hit rate and devigged expected value.

**Approach:** Implement a Multi-Sport Schedule & Market Browser engine in `services/worker` and an interactive screener UI in `apps/web`. The Python worker filters active pre-match player props across NFL and NBA, classifies events into date windows (`today`, `tomorrow`, `weekend`), computes each prop's single-leg Hybrid Value Score and `HIGH_VALUE` badge status ($\text{EV}_{\text{guarded}} \ge 3.5\%$ and $\text{Hit Rate}_{\text{L10}} \ge 70\%$), enforces the Outlier Guard ($\text{EV}_{\text{guarded}} \le 10.0\%$), and caches the browser feed in Redis with a strict 45-second TTL. The Next.js 15 web application exposes `/api/markets` and renders a responsive `MarketBrowser` view with Sport, Date, and Prop Category filters, search, live SSE odds updates, and Sofascore form telemetry.

## Boundaries & Constraints

**Always:**
- Follow strict Test-Driven Development (TDD) (Red Phase $\rightarrow$ Green Phase $\rightarrow$ Refactor) in both `services/worker` and `apps/web`.
- Enforce Polyglot Service Isolation (AD-1): schedule/market assembly, date-window classification, Hybrid Value Score ranking, and Redis caching (`markets:browser:{sport_key}`) execute in `services/worker`; Next.js 15 reads from Redis (with deterministic fallback when cache is cold) and streams live odds deltas via `/api/stream/odds`.
- Execute all internal probability and odds math in `Decimal` ($D \ge 1.01$, `le=Decimal("9999.9999")`, `allow_inf_nan=False`), converting to American odds strictly at ingestion and display boundaries.
- Exclude any player prop with `status != "ACTIVE"` (including `SUSPECT_STALE_LINE`, `SUSPENDED`, `SETTLED`) or $\text{EV}_{\text{guarded}} > 10.0\%$ (Outlier Circuit Breaker).
- Exclude any event that has already commenced (`commence_time <= now_utc`) or has status in `('COMMENCED', 'LIVE', 'FINAL', 'POSTPONED', 'CANCELLED')`.
- Support Sport filters (`nfl`, `nba`), Date Window filters (`today`, `tomorrow`, `weekend`), and Canonical Prop Market filters:
  - **NFL:** `player_anytime_td` (`Anytime TD`), `player_pass_yds` (`Passing Yards`), `player_rush_yds` (`Rushing Yards`).
  - **NBA:** `player_points` (`Points`), `player_rebounds` (`Rebounds`), `player_threes` (`Threes`).
- Rank prop rows by descending `hybrid_value_score` (using $\text{Score} = \text{clamp}(0, 100, \text{round}(0.60 \times H_{\text{L10}}\% + 0.40 \times \text{clamp}(0, 100, \text{EV}_{\text{guarded}}\% \times 10 + 50)))$), then descending `guarded_ev`, then descending `hit_rate_l10`.
- Cache browser snapshots in Redis (`markets:browser:all`, `markets:browser:nfl`, `markets:browser:nba`) with strict 45-second TTL (`EX=45`) and ISO 8601 UTC timestamps (`YYYY-MM-DDTHH:mm:ssZ`).
- Adhere strictly to `DESIGN.md` tokens (`#0a0e17` canvas, `#121b2d` card surface, `#1e293b` border, `#06b6d4` cyan, `#10b981` emerald, `#f59e0b` amber, `#6366f1` violet) and tabular `JetBrains Mono` (`font-telemetry`) for all odds, hit-rate, and EV% readouts.

**Never:**
- Never expose `SUSPECT_STALE_LINE` props or props with $\text{EV}_{\text{guarded}} > 10.0\%$ in the market browser feed.
- Never include commenced, live, final, postponed, or cancelled games in the pre-match schedule browser.
- Never call `parlay-api.com` directly from Next.js server components, API routes, or client code.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Sport & Market Category Filter (NBA Points) | `sport="nba"`, `market="player_points"`, `dateWindow="today"` | Returns only active NBA `player_points` props for today's slate, sorted by descending `hybridValueScore`, displaying player, matchup, line, L5/L10/Season hit rates, Sofascore dots, and EV% | Empty array if no matching props |
| NFL Prop Market Categories | `sport="nfl"`, switching between `player_anytime_td`, `player_pass_yds`, `player_rush_yds` | Category pills dynamically show NFL markets; rows filter to matching `marketKey` and display weather/dome context badges | Resets invalid market key to `all` when switching sport |
| Date Window Classification & Filtering | Events at $+4\text{h}$ (`today`), $+28\text{h}$ (`tomorrow`), and upcoming Saturday/Sunday or $+54\text{h}$ (`weekend`) relative to `now_utc` | Filtering by `today`, `tomorrow`, or `weekend` returns only props belonging to events in that window | Commenced events ($\le \text{now\_utc}$) rejected before classification |
| Outlier Circuit Breaker Exclusion | Candidate prop has `guarded_ev = Decimal("0.1150")` ($11.5\%$) or `status = "SUSPECT_STALE_LINE"` | Prop is excluded from `MarketBrowserFeed` and never cached to Redis or rendered in UI | Filtered out silently during feed assembly |
| High Value Badge Qualification | Prop has `guarded_ev = Decimal("0.0420")` ($4.2\% \ge 3.5\%$) and `hit_rate_l10 = Decimal("0.8000")` ($80\% \ge 70\%$) | Prop is flagged `is_high_value = True` (`value_tier = "HIGH_VALUE"`) and displays Emerald `High Value` badge in row | Standard positive EV ($\in [1.5\%, 3.5\%)$) tagged `POSITIVE_VALUE` |
| Live SSE Odds Delta Recalculation | SSE `odds_delta` frame arrives for `propId` with updated `decimalOdds = "2.1000"` | Matching prop row updates offered decimal/American odds, guarded EV%, and Hybrid Value Score in place without layout shift | Malformed SSE frames ignored safely |
| Cold Redis Cache / Connection Failure | Redis key `markets:browser:all` is missing or connection throws | `getMarketBrowserFeed` falls back to deterministic multi-sport schedule & prop dataset covering NFL and NBA across Today, Tomorrow, and Weekend | Logs warning; returns HTTP 200 with fallback feed |

</frozen-after-approval>

## Code Map

- `services/worker/parlaypal_worker/models.py` -- Reuse `Event`, `PlayerProp`, and `Team` SQLAlchemy 2.0 models (do not modify table schema).
- `services/worker/parlaypal_worker/presets.py` -- Reuse `decimal_to_american`, `calculate_hybrid_value_score`, `generate_conviction_rationale`, and `_format_market_display` conventions.
- `services/worker/parlaypal_worker/redis_client.py` -- Add `markets_browser_key` helper and reuse `format_iso8601_utc`, `HOT_CACHE_TTL_SECONDS`, `HIGH_VALUE_MIN_EV_THRESHOLD`, `HIGH_VALUE_MIN_HIT_RATE`, and `OUTLIER_GUARD_MAX_EV`.
- `services/worker/parlaypal_worker/market_browser.py` -- New module implementing `MarketBrowserPropItem`, `ScheduledGameSummary`, `MarketBrowserFeed`, `classify_date_window`, `build_market_browser_feed`, `filter_market_browser_feed`, and `sync_market_browser_to_redis`.
- `services/worker/parlaypal_worker/celery_app.py` -- Add `sync_market_browser_feed` Celery task querying active `PlayerProp`, `Event`, and `Team` records and syncing `MarketBrowserFeed` to Redis with 45s TTL.
- `services/worker/tests/test_market_browser.py` -- New pytest unit and integration test suite covering all Python matrix scenarios and Celery task synchronization.
- `apps/web/src/types/preset.ts` -- Extend or pair with `apps/web/src/types/market.ts` for `DateWindow`, `SportFilter`, `NflMarketKey`, `NbaMarketKey`, `MarketPropRow`, `ScheduledEventSummary`, and `MarketBrowserFeed`.
- `apps/web/src/lib/redis.ts` -- Add `marketsBrowserKey(sportKey?: string)` helper.
- `apps/web/src/lib/markets.ts` -- New module providing `FALLBACK_MARKET_BROWSER_FEED`, `getMarketBrowserFeed`, `filterMarketProps`, and `recalculateMarketPropRow` for live SSE updates.
- `apps/web/src/app/api/markets/route.ts` -- New Next.js App Router GET endpoint supporting `sport`, `date`, `market`, and `q` query parameters.
- `apps/web/src/components/MarketBrowser.tsx` -- New interactive schedule & prop market browser component with Sport switcher (`NFL`, `NBA`), Date pills (`Today`, `Tomorrow`, `Weekend`), dynamic sport-specific Market Category pills, game schedule filter cards, search input, and prop rows with live SSE odds updates.
- `apps/web/src/app/page.tsx` -- Integrate view navigation between Curated Preset Parlays and Schedule & Market Browser so users can seamlessly browse both feeds from the home terminal.

## Tasks & Acceptance

**Execution:**
- [ ] `services/worker/tests/test_market_browser.py` -- Write Red-phase unit and integration tests for date-window classification (`today`, `tomorrow`, `weekend`), NFL/NBA market filtering, Outlier Guard exclusion ($\text{EV} > 10.0\%$), commenced game exclusion, Hybrid Value Score ranking, High Value tiering, Redis 45s TTL caching, and Celery task execution -- Enforces TDD Red Phase before implementation.
- [ ] `services/worker/parlaypal_worker/market_browser.py` -- Implement `MarketBrowserPropItem`, `ScheduledGameSummary`, `MarketBrowserFeed`, `classify_date_window`, `build_market_browser_feed`, `filter_market_browser_feed`, and `sync_market_browser_to_redis` (plus key helper in `redis_client.py` and `sync_market_browser_feed` task in `celery_app.py`) -- Satisfies worker quantitative assembly and Redis caching invariants.
- [ ] `apps/web/src/lib/markets.test.ts` & `apps/web/src/app/api/markets/route.test.ts` -- Write Red-phase Vitest unit tests for `filterMarketProps`, sport/market reset behavior, `recalculateMarketPropRow` live SSE math, Redis cache retrieval + fallback handling, and `/api/markets` query parameter filtering -- Enforces frontend TDD Red Phase.
- [ ] `apps/web/src/types/market.ts`, `apps/web/src/lib/redis.ts`, `apps/web/src/lib/markets.ts`, & `apps/web/src/app/api/markets/route.ts` -- Implement TypeScript contracts, Redis key helper, market browser query/filter/SSE recalculation logic, fallback dataset across NFL/NBA and Today/Tomorrow/Weekend, and `/api/markets` route handler -- Provides typed data layer and API endpoint for the browser.
- [ ] `apps/web/src/components/MarketBrowser.tsx` & `apps/web/src/app/page.tsx` -- Implement the responsive Schedule & Market Browser component and top-level view switcher on the home page with Sport (`NFL`, `NBA`), Date (`Today`, `Tomorrow`, `Weekend`), and Market (`Anytime TD`, `Passing Yards`, `Rushing Yards`, `Points`, `Rebounds`, `Threes`) filters, game slate cards, and prop telemetry rows -- Delivers the user-facing interactive schedule and market screener.

**Acceptance Criteria:**
- Given active NFL and NBA schedules, when a user opens the Schedule & Market Browser, then they can filter by Sport (`NFL`, `NBA`) and Date (`Today`, `Tomorrow`, `Weekend`), and switching sports automatically updates the available prop market pills (`Anytime TD`, `Passing Yards`, `Rushing Yards` for NFL; `Points`, `Rebounds`, `Threes` for NBA).
- Given selected Sport, Date, and Prop Market filters, when the prop list renders, then each row displays the player name, team & matchup, commence time, sportsbook line & American odds, rolling consistency hit rates (`L5`, `L10`, `Season`) with 5-dot Sofascore form indicator, weather/dome context badge, devigged EV%, and Hybrid Value Score sorted highest-first.
- Given a candidate prop with $\text{EV}_{\text{guarded}} > 10.0\%$ or `status = "SUSPECT_STALE_LINE"` or an already-commenced event, when the market browser feed is generated, then that prop is excluded from Redis cache and UI output.

## Implementation Notes

- Implemented services/worker/parlaypal_worker/market_browser.py with uild_market_browser_feed, ilter_market_browser_feed, and sync_market_browser_to_redis.
- Added markets_browser_key in edis_client.py and sync_market_browser_feed Celery background task in celery_app.py.
- Enforced all Python matrix tests in 	ests/test_market_browser.py with 27/27 passing tests.
- Implemented TypeScript types in pps/web/src/types/market.ts, client-side pure filter/math utilities in pps/web/src/lib/market-filters.ts, server data layer in pps/web/src/lib/markets.ts, and endpoint pps/web/src/app/api/markets/route.ts.
- Implemented responsive MarketBrowser component in pps/web/src/components/MarketBrowser.tsx and integrated dual-tab TerminalView into pps/web/src/app/page.tsx.
- All Python verification gates (ruff check, ruff format, mypy, pytest) passed with 65/65 tests.
- All Web verification gates (tsc, vitest, next build) passed with 20/20 tests and static/dynamic route compilation.

## Spec Change Log

## Review Triage Log

- **Review Pass 1 (Blind Hunter):**
  - Finding: Polyglot client-server separation vulnerability when importing `ioredis` in client component trees (`MarketBrowser.tsx`).
  - Resolution: Extracted pure math (`recalculateMarketPropRow`, `calculateHybridValueScore`) and filtering functions into `apps/web/src/lib/market-filters.ts` as an isomorphic client-safe module.
  - Finding: Outlier Guard on live SSE odds stream recalculations.
  - Resolution: Added explicit check `const isOutlier = newEv > 0.10;` in `recalculateMarketPropRow` ensuring lines $> 10\%$ are excluded from `HIGH_VALUE` status in real time.
- **Review Pass 2 (Edge Case Hunter):**
  - Finding: Date window relative vs. calendar weekend boundary classification.
  - Resolution: Added hybrid support in `classify_date_window` accommodating both calendar weekend days (`Saturday=5, Sunday=6`) within 7-day horizon and relative offset hours (+48h to +72h).
  - Finding: Next.js Windows transient filesystem locks (`EPERM`) during production build.
  - Resolution: Handled transient lock retry per AGENTS.md rule 7; full Next.js production build succeeded with exit code 0.

## Verification

**Commands:**
- `uv run --directory services/worker ruff check parlaypal_worker tests` -- expected: All checks passed
- `uv run --directory services/worker ruff format --check parlaypal_worker tests` -- expected: All files formatted
- `uv run --directory services/worker mypy parlaypal_worker tests` -- expected: Success: no issues found
- `uv run --directory services/worker pytest -v` -- expected: All tests pass
- `npm --prefix apps/web run typecheck` -- expected: Exit code 0
- `npm --prefix apps/web test -- --run` -- expected: All Vitest test suites pass
- `npm --prefix apps/web run build` -- expected: Next.js production build succeeds
