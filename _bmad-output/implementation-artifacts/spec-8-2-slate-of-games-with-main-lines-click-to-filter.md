---
title: 'Story 8.2: Slate of Games With Main Lines & Click-to-Filter'
type: 'feature'
created: '2026-11-18'
status: 'done'
route: 'dispatch'
baseline_commit: '30385037217e4be01bcd2338bc1dbab5e18197b5'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 8.1 stores each game's spread, moneyline and total in `event_lines`, but the Schedule & Market Browser only shows a small "Upcoming Slate" badge row with no lines, and a game cannot be used to filter the prop list.

**Approach:** The worker attaches the consensus main lines to each game in the existing `markets:browser:*` feed (read from PostgreSQL, not the 45s `odds:lines` key). The web renders a Spread / Money / Total grid per game and a URL-backed (`?game=<event_id>`) click-to-filter on the prop list.

## Boundaries & Constraints

**Always:** Odds stay Decimal strings in the feed with American only at the display boundary (`decimal_to_american`); a missing line is `null` in the feed and "—" in the UI, never 0 or a default (a real 0 point, pick'em, is shown as `PK`/`0`, use `is None` / `=== null` checks); web reads only Redis; existing sport and date filters still apply on top of the game filter; mobile width works (horizontal scroll or stacked cards, no page overflow); tests first (TDD).

**Never:** Game detail page (8.3), sorting (8.4), per-period or alternate lines, a new Redis key, direct provider calls, changing prop scoring, Alembic or legacy-DB hardening (solo developer).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Full lines | Game has spreads, h2h, totals rows | Grid: away row `+3.5 -110 / +140 / O 45.5 -110`, home row `-3.5 -110 / -165 / U 45.5 -110` | N/A |
| Partial lines | Game has only totals | Spread and Money cells show "—" | N/A |
| No lines | Game has no `event_lines` rows | `lines` all null, grid is all "—", game still listed | N/A |
| Pick'em | Spread point 0 | Shown as `PK`, not "—" | N/A |
| Select game | Click a game card | Card highlighted, props filtered to that event, URL gets `?game=<id>` | N/A |
| Deselect | Click it again or "Clear" | Filter and URL param removed | N/A |
| Shared link | Load with `?game=<id>` | Game preselected and props filtered | Unknown id: no filter, no highlight |
| No props | Selected game has no visible props | Empty state naming the game, not the previous list | N/A |
| Refresh tick | 30s data refresh or SSE delta | Selection and highlight unchanged, no flicker | N/A |
| Started game | `commence_time` passed | Not in feed (already dropped by date window) | N/A |

</frozen-after-approval>

## Code Map

- `services/worker/parlaypal_worker/market_browser.py` -- `ScheduledGameSummary` (add `lines`), `build_market_browser_feed` (add optional `lines` arg, group by event), `sync_market_browser_to_redis` (slices already reuse game objects). Reuse `decimal_to_american` (imported from presets).
- `services/worker/parlaypal_worker/models.py` -- `EventLine` (`market_key` h2h|spreads|totals, `side` home|away|over|under, `point`, `decimal_odds`).
- `services/worker/parlaypal_worker/ingestion.py` (~L2395-2440) and `celery_app.py` `sync_market_browser_feed` (L284) -- the two builder callers; each loads `EventLine` rows for `events_map` and passes them.
- `services/worker/tests/test_market_browser.py` -- fixtures and serialization tests to extend.
- `apps/web/src/types/market.ts` -- `ScheduledEventSummary` (add optional `lines`).
- `apps/web/src/lib/markets.ts` -- `normalizeGameSummary` (parse `lines`, snake and camel), `FALLBACK_MARKET_BROWSER_FEED` games (add sample lines).
- `apps/web/src/lib/market-filters.ts` -- `filterMarketProps` (add `eventId`), new `formatSpread`/`formatTotal`/`formatMoney` helpers.
- `apps/web/src/app/api/markets/route.ts` -- pass `game` query param through to the filter.
- `apps/web/src/components/MarketBrowser.tsx` -- replace the "Upcoming Slate" badge row (L~265) with a game card grid; selection state synced to `?game=` via `window.history.replaceState` (no Next navigation, so no refetch or flicker); props filtered by selected game. Games list must come from `initialFeed.games` filtered by sport/date only, not by the game filter.
- Do not change: SSE handler, scoring, parlay drawer, `TerminalView` tab state.

## Tasks & Acceptance

**Execution:**
- [x] `services/worker/tests/test_market_browser.py` -- failing tests for lines on game summaries (full, partial, none, pick'em zero, odds as decimal + american) -- TDD red
- [x] `services/worker/parlaypal_worker/market_browser.py` -- `GameLines` models, group `EventLine` rows, `lines` on `ScheduledGameSummary` -- worker feed
- [x] `ingestion.py`, `celery_app.py` -- load `EventLine` rows for events and pass to the builder -- both feed paths
- [x] `apps/web/src/lib/market-filters.test.ts`, `markets.test.ts`, `route.test.ts` -- failing tests: line formatting (PK, "—", negative/positive), `eventId` filter, `lines` normalization, `?game=` API param -- TDD red
- [x] `apps/web/src/types/market.ts`, `lib/markets.ts`, `lib/market-filters.ts`, `api/markets/route.ts` -- types, normalization, helpers, filter -- web data layer
- [x] `apps/web/src/components/MarketBrowser.tsx` (+ component test) -- game card grid, select/clear, URL sync, empty state -- UI
- [x] `AGENTS.md` -- one line noting the browser feed `games[].lines` field if the Redis list documents the feed shape

**Acceptance Criteria:**
- Given games with lines in `event_lines`, when the browser feed is built, then each `games[]` entry has `lines` with spread/moneyline/total per side (decimal string, American int, point) and `null` for anything missing.
- Given the Schedule & Market Browser, when it loads, then every game card shows teams, start time and the Spread / Money / Total grid, with "—" for missing cells.
- Given a game card, when clicked, then it is highlighted, the prop list shows only that event's props under the active sport/date/market/search filters, and `?game=<id>` is set; clicking again or "Clear" removes both.
- Given the worker and web gates in AGENTS.md section 4, then ruff, ruff format, mypy, pytest, typecheck, vitest and build all pass.

## Implementation Notes

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Route / evidence |
|---|---|---|
| Celery `sync_market_browser_feed` loads every `EventLine` row (3 layers) | medium | patch: filtered by `events_map` ids |
| `run_live_slate_sync` has no test that lines reach the browser feed | medium | patch: test added in `test_ingestion.py` |
| Click, toggle, `?game=` preselect untested in a DOM | medium | defer: repo has no jsdom or Testing Library, adding them is a new dependency |
| Games list and lines never refresh after load (no 30s refresh in component) | medium | defer: pre-existing (games come from `initialFeed`); spec premise of a 30s refresh does not match the code |
| `decimal_to_american` raises on odds < 1.01 and aborts the feed | low | reject: DB CHECK `decimal_odds >= 1.01` makes it unreachable |
| Duplicate rows in `build_game_lines` | false | unique constraint on event/market/side |
| `useEffect` resets selection when `initialFeed.games` changes | false | prop is constant and the effect re-reads the URL, which is synced |
| Missing `EventLine` / `select` imports | false | both imported (`ingestion.py` L19, L40) |
| AGENTS.md note not added | false | AGENTS.md documents no `markets:browser` shape; also agent-context file |
| Stale `?game=` when the game is hidden by sport/date chips | low | reject: matches spec (filters still apply); fix adds guards |
| First paint is unfiltered on a shared link | low | reject: SSR-safe pattern, lazy init would cause a hydration mismatch |
| API `?game=` unknown id returns empty props | low | reject: API only, UI ignores unknown ids; fix adds a branch |
| Null point with a price shows a bare dash; partial bad side; raw float text; timezone label; focus style | low | reject: improbable (worker always stores a point) or cosmetic |

## Design Notes

Slate scope: the games list remains derived from games that have at least one active prop (existing behavior); games with lines but no props are not added here (deferred). The "no props" empty state covers a selected game whose props are all removed by the sport/date/market/search filters.

Lines come from PostgreSQL via the worker (the `odds:lines` key expires after 45s while polling is 30 min, see 8.1), so the browser feed carries them and the web needs no new data path.

## Verification

**Commands:**
- `uv run --directory services/worker ruff check parlaypal_worker tests` -- expected: no errors
- `uv run --directory services/worker ruff format --check parlaypal_worker tests` -- expected: clean
- `uv run --directory services/worker mypy parlaypal_worker tests` -- expected: no errors
- `uv run --directory services/worker pytest -v` -- expected: all pass
- `npm --prefix apps/web run typecheck` -- expected: no errors
- `npm --prefix apps/web test -- --run` -- expected: all pass
- `npm --prefix apps/web run build` -- expected: succeeds
