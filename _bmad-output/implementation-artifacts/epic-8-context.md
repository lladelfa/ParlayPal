# Epic 8 Context: Game-Centric Browsing & Explainability

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Bettors browse a sportsbook-style slate where each game shows its main lines (spread, moneyline, total), click a game to filter props or open a game page (main lines, props by market tab, player history), sort the market browser, and read an About page explaining the site and its score. Scope is slate plus game page; per-period lines (halves, quarters) and multi-rung player ladders are out of scope. Today only player props are stored; game lines are not ingested, so Story 8.1 is a data story that gates 8.2 and 8.3.

## Stories

- Story 8.1: Game lines ingestion (spread, moneyline, total)
- Story 8.2: Slate of games with main lines and click-to-filter
- Story 8.3: Game detail page
- Story 8.4: Sortable market browser
- Story 8.5: About and how it works

## Requirements & Constraints

- Missing data stays missing: an event without lines is stored without them, never with defaults; the UI shows "—".
- Odds math in `Decimal`; American odds only at ingestion/display boundaries.
- Live odds cache uses the 45-second TTL; timestamps are ISO 8601 UTC (`TIMESTAMPTZ`).
- Mobile-width layouts required.
- Web reads only Redis/PostgreSQL; the worker owns all provider calls.

## Technical Decisions

- Worker ingests lines in the schedule/odds sync; web renders from Redis/PostgreSQL.
- Provider markets: `h2h`, `spreads`, `totals`. Store consensus line plus per-book prices where available.
- Story 8.1 Task 1 is a gate: confirm from a live response that the provider returns these markets for NFL and NBA and at what credit cost per event; if not, stop and re-plan 8.2/8.3 around prop-only data.
- Selected game is reflected in the URL (`?game=<event_id>`); game page at `/games/<event_id>`.
- About copy must be written from the code (score formula in `presets.py`), not memory.

## Cross-Story Dependencies

- 8.1 gates 8.2 and 8.3; 8.3 builds on 8.2's slate.
- 8.4 and 8.5 are independent of game lines.
- Follows Epic 7 (canonical market keys, honest empty states).
