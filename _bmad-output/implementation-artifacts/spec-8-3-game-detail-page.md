---
title: 'Story 8.3: Game Detail Page'
type: 'feature'
created: '2026-11-20'
status: 'done'
baseline_commit: '52536a758b8d1512e8dd62730959c44302cacebc'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The slate (8.2) shows each game's main lines, but a bettor cannot open one game to see its lines, its props by market, and each player's recent history together.

**Approach:** Add a server-rendered `/games/<event_id>` page built from the existing `markets:browser` Redis feed (game header, Main Lines, props with market tabs) plus the worker's cached player game logs (`gamelog:*` keys) for an expandable per-player history. Each slate card gets an "Open game" link.

## Boundaries & Constraints

**Always:** Web reads only Redis (feed and `gamelog:*`); no provider calls, no worker changes, no new Redis key. Missing data stays missing: absent line is "—", absent or short game log is "Limited history", never a default. Reuse `SlateGameCard` line formatting (`formatSpread`/`formatMoney`/`formatTotal`), `MarketPropRowItem`-style row, `ParlayDrawerProvider` + `ParlayDrawer` for add-to-slip, and `CANONICAL_MARKETS_BY_SPORT` for tab labels. Game logs are stat values newest first, no dates or opponents (that is all the cache holds). A game-log read failure degrades to "Limited history", never a 500. Works at mobile width (no page overflow). Tests first (TDD).

**Never:** Per-period lines, multi-rung ladders, live scores, head-to-head (out of scope); sorting (8.4); changing scoring, the worker, the slate's selection behavior or `?game=` filtering; Alembic or legacy-DB hardening (solo developer).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Open game | `/games/<id>` in the feed | Header (teams, start time), Main Lines grid, props with market tabs (only markets that have props, "All" first) | N/A |
| Unknown / past id | id not in feed (started games are dropped by the feed) | Not-found page | `notFound()` |
| Partial lines | Game has only totals | Spread and Money show "—" | N/A |
| No props | Game in feed with zero props | Main Lines shown, props section says no props | N/A |
| Expand player | Cached log has >=5 stats | Values newest first, each marked over/under the prop line (pushes neutral) | N/A |
| No history | Key missing, `null`, or fewer than 5 stats | "Limited history" | N/A |
| Redis down | Feed unreachable | Not-found (feed empty, same as unknown id) | log warning only |
| Add to slip | Click "+ Add to Slip" | Prop enters the drawer; button shows "In Slip" | N/A |

</frozen-after-approval>

## Code Map

- `apps/web/src/lib/markets.ts` -- `getMarketBrowserFeed` (reuse, pass no sport so all games load), `normalizeMarketBrowserFeed`; add `getGameDetail(eventId)` returning `{game, props, logs}` or `null`.
- `apps/web/src/lib/game-logs.ts` (new) -- `gameLogKey(sportKey, player, market)` mirroring worker `game_log_cache_key` (`gamelog:{upstream_sport}:{player}:{market}`; upstream sport is `americanfootball_nfl` / `basketball_nba`, map from web `nfl`/`nba`; `SUPPORTED_SPORT_KEYS` in `lib/redis.ts`), `parseGameLog(raw)` (JSON list of decimal strings or `null`; <5 entries or bad JSON -> `null`), `readGameLogs(redis, props)`.
- `apps/web/src/app/games/[eventId]/page.tsx` (new) -- async server page, `force-dynamic`, calls `getGameDetail`, `notFound()` when null. Next 15: `params` is a Promise.
- `apps/web/src/app/games/[eventId]/not-found.tsx` (new) -- not-found state with link back to `/`.
- `apps/web/src/components/GameDetail.tsx` (new, client) -- wraps `ParlayDrawerProvider`/`ParlayDrawer`; header, Main Lines block, market tabs, prop rows with expandable history. Extract `MarketPropRowItem` from `MarketBrowser.tsx` (export it) rather than duplicating.
- `apps/web/src/components/MarketBrowser.tsx` -- add an "Open game" `Link` to `/games/<eventId>` next to each slate card (sibling of the card button, not nested in it). Do not change selection logic.
- `apps/web/src/lib/market-filters.ts` -- reuse line formatters; add `marketTabs(props)` helper.
- Do not change: SSE handler, scoring, `TerminalView`, worker.

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/lib/game-logs.test.ts`, `markets.test.ts`, `market-filters.test.ts`, `GameDetail.test.tsx` -- failing tests: key format, `parseGameLog` (valid, null, short, bad JSON), `getGameDetail` (found, unknown id, Redis error, log read error), `marketTabs`, render of header/lines/tabs/"Limited history"/over-under marks -- TDD red
- [x] `apps/web/src/lib/game-logs.ts`, `lib/markets.ts`, `lib/market-filters.ts` -- log key/parse/read, `getGameDetail`, `marketTabs` -- data layer
- [x] `apps/web/src/components/MarketBrowser.tsx`, `GameDetail.tsx`, `app/games/[eventId]/page.tsx`, `not-found.tsx` -- export row item, "Open game" link, game page and not-found -- UI

**Acceptance Criteria:**
- Given a game in the feed, when `/games/<id>` loads, then it shows teams, start time, the Spread / Money / Total grid, and a market tab per market that has props, each row with line, odds, hit rate, form dots and an Add to Slip action.
- Given a cached game log of 5+ stats, when a player is expanded, then values show newest first with over/under marks against the line; otherwise "Limited history".
- Given an unknown or started game id or an unreachable feed, when the page loads, then a not-found state shows.
- Given the web gates in AGENTS.md section 4, then typecheck, vitest and build all pass.

## Implementation Notes

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Route / evidence |
|---|---|---|
| Blank/whitespace log entries coerce to 0 via `Number("")` | low | patch: `parseGameLog` rejects non-numeric strings; test added |
| Started game stays openable while the cached feed is stale | medium | patch: `getGameDetail` returns null when `commenceTime` has passed; test added |
| Redis-down test depends on `PARLAYPAL_SAMPLE_DATA` env | low | patch: test stubs the env |
| No `getGameDetail` test for log-read failure | low | patch: test added |
| "Open game" link untested | medium | patch: slate render test asserts `href="/games/<id>"` |
| Tab filter and history toggle not exercised | medium | patch: `filterByTab` extracted and unit tested; render test with a cached log; click toggle itself stays untested (no jsdom in repo, same as 8.2) |
| `MainLinesGrid` over-indented after extraction | low | patch: reindented |
| Web `gameLogKey` not tied to the worker key by a shared test | medium | defer: key format verified by hand against worker config (`americanfootball_nfl`, `basketball_nba`); cross-language contract test is a separate chore |
| Redis outage shows 404; sample data shown if the dev flag is on | low | reject: matches the spec matrix; sample mode is a labelled dev flag |
| NaN line; encodeURIComponent; dangling "NBA ·" separator; tab missing after props change; runtime sportKey outside nfl/nba | low | reject: feed is normalized upstream, ids are UUIDs, props are constant; fixes add guards |
| Duplicate/wrong-sport tab labels | false | NFL and NBA canonical market keys are disjoint |
| Redis connect hang; N parallel GETs; timezone and duplicated `formatStart`; drawer pool limited to one game; tab not in URL; `aria-controls` | low | reject: matches existing patterns, negligible or out of intent |
| Mapping not derived from `SUPPORTED_SPORT_KEYS` | low | reject: two fixed sports, comment-level concern |

## Design Notes

The cache stores only stat values (no dates, opponents or minutes), so the history is a newest-first value strip, not a table. The slate's `?game=` filter and the new page are independent: the card selects, the link opens.

## Verification

**Commands:**
- `npm --prefix apps/web run typecheck` -- expected: no errors
- `npm --prefix apps/web test -- --run` -- expected: all pass
- `npm --prefix apps/web run build` -- expected: succeeds and lists `/games/[eventId]`
