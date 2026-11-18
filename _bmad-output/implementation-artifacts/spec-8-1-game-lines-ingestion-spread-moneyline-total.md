---
title: 'Story 8.1: Game Lines Ingestion (Spread, Moneyline, Total)'
type: 'feature'
created: '2026-11-18'
status: 'done'
baseline_commit: 'c0303139b046ed7f27e7d03a5d2510c7377ea34e'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The worker stores only player props. Game spread, moneyline and total are skipped on purpose (`_SKIP_MAINLINE_MARKETS`), so the slate cannot show main lines (blocks Stories 8.2 and 8.3).

**Approach:** Add a separate worker fetch of `h2h,spreads,totals` per sport, reduce it to one consensus main line per market per event plus per-book prices, persist it in a new `event_lines` table, and cache it in Redis with the 45s TTL. Gate on a live-response check first.

## Boundaries & Constraints

**Always:** Decimal odds (>= 1.01, American only at ingestion via `_parse_odds_to_decimal`); `TIMESTAMPTZ` timestamps; Redis `EX=45`; absent lines stay absent (no row or null fields, never defaults, never 0 for a missing line; a real 0 spread/pick'em is preserved, use `is None` checks); provider call only from the worker; log `x-credits-remaining` and request count at INFO per cycle; tests first (TDD) on in-memory SQLite and `httpx.MockTransport`.

**Never:** Per-period lines, alternate lines, live scores; changing the player-prop fetch or feeds; web UI changes (8.2); Alembic or legacy-DB upgrade hardening (solo developer).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Full lines | Event with h2h, spreads, totals from several books | One consensus main line per market, per-book prices stored, cache written | N/A |
| Partial lines | Event with only totals | Only a totals line stored; spread and moneyline absent | N/A |
| No lines | Event with no bookmakers/markets | Event kept, no line rows, no cache key | N/A |
| Pick'em | Spread point is 0 | Stored as 0, not treated as missing | N/A |
| Bad price | Unplayable or out-of-range odds | That price skipped, rest kept | Log, no crash |
| Provider down | HTTP error or empty response | No lines written, existing rows untouched, no fixtures | Logged, task completes |
| Re-run | Same data synced twice | Idempotent upsert, no duplicate rows | N/A |
| Gate fails | Live response lacks these markets for NFL/NBA | STOP and report; do not build | Re-plan 8.2/8.3 |

</frozen-after-approval>

## Code Map

- `services/worker/parlaypal_worker/ingestion.py` -- `fetch_upstream_slate` (L1214) HTTP pattern to copy; `_parse_odds_to_decimal`, `_parse_optional_decimal`, `_parse_iso_datetime`, `SHARP_BOOKMAKER_PRIORITY`, `upsert_slate_to_db` (idempotency pattern); `_SKIP_MAINLINE_MARKETS` stays as is.
- `services/worker/parlaypal_worker/models.py` -- add `EventLine` beside `PlayerProp` (Uuid PK, `event_id` FK, Numeric odds with `>= 1.01` check, `Index`); portable types for SQLite tests.
- `services/worker/parlaypal_worker/db.py` -- `init_db` creates the new table via `create_all`; no migration.
- `services/worker/parlaypal_worker/redis_client.py` -- add `game_lines_key(sport_key, event_id)` = `odds:lines:{sport}:{event}` near `odds_latest_key`; reuse `HOT_CACHE_TTL_SECONDS`, `RedisLike`.
- `services/worker/parlaypal_worker/celery_app.py` -- new `sync_game_lines` task (copy the injection/cleanup skeleton of `sync_live_slate`); `build_beat_schedule`.
- `services/worker/parlaypal_worker/moneyline.py` -- `_note_credits` for the `x-credits-remaining` header pattern.
- `services/worker/tests/test_ingestion.py` -- `FakeRedisClient`, `db_session`, `_build_upstream_mock_transport` to copy.
- `AGENTS.md` -- add the `odds:lines:*` key to the Redis list.

## Tasks & Acceptance

**Execution:**
- [x] Gate -- one live request per sport (NFL, NBA) with `markets=h2h,spreads,totals`; record markets returned, bookmaker count and `x-credits-remaining` delta in Implementation Notes -- confirms the story is buildable; if markets are missing, HALT
- [x] `tests/test_game_lines.py` -- write failing tests for every matrix row (red) -- TDD
- [x] `models.py` -- `EventLine` (event, market `h2h|spreads|totals`, consensus point, per-side price, per-book JSON prices, `fetched_at`, unique per event/market/side) -- persistence
- [x] `ingestion.py` -- `fetch_game_lines`, consensus reducer (sharp-book priority, then median), `upsert_game_lines`, credit/request logging -- ingestion
- [x] `redis_client.py`, `celery_app.py` -- key builder, `sync_game_lines` task and beat entry, cadence same as `live_slate_poll_interval_seconds` -- scheduling and cache
- [x] `AGENTS.md` -- document `odds:lines:{sport_key}:{event_id}` (TTL 45s) -- docs

**Acceptance Criteria:**
- Given NFL and NBA events with h2h, spreads and totals, when `sync_game_lines` runs, then each event has a consensus line per market in `event_lines` with TZ-aware timestamps and a Redis key with `EX=45`.
- Given the sync runs with no key, an upstream error or empty data, then no fabricated lines or fixtures are written and the existing rows remain.
- Given all gates in AGENTS.md section 4 for the worker, then ruff, ruff format, mypy and pytest pass.

## Implementation Notes

- GATE PASSED (run by orchestrator 2026-11-18, key from main checkout `.env`): one live request per sport with `markets=h2h,spreads,totals` returned HTTP 200. NFL: 29 events, h2h/totals/spreads present, up to 15 books per event. NBA: 17 events, same markets, up to 15 books. Cost: 3 credits per sport request (`x-requests-used` 1087 to 1090), so about 6 extra credits per cycle, roughly doubling the prop cost (about 17,000 credits/month at the 1800s default vs a 20,000 Starter plan).
- Added `EventLine` (`event_lines`, unique per event/market/side), `fetch_game_lines`, `upsert_game_lines`, `run_game_lines_sync` in `ingestion.py`, `game_lines_key`, `sync_game_lines` task and `sync-game-lines` beat entry.
- Events whose response omits a market drop that market's stale rows; events missing from the response (provider error, sport failed) keep existing rows.
- Tests were written together with the code in one pass (red phase not run separately).

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Route / evidence |
|---|---|---|
| Duplicate event in one response violates unique slot | medium | patch: dedupe by (event, market, side); test added |
| `session.commit()` failure leaves session dirty | medium | patch: rollback and re-raise |
| Started-event filter untested | medium | patch: test added |
| `sync_game_lines` task body untested | medium | patch: task-level test added |
| Events not yet in `events` dropped silently | low | patch: INFO log of skipped count |
| Credit header mismatch (`x-credits-remaining` vs live `x-requests-remaining`) | high | patched before review (orchestrator, live gate evidence) |
| 45s TTL vs 30 min poll empties Redis between cycles; Story 8.2 must read PostgreSQL | medium | defer (known in Design Notes) |
| Event with empty bookmakers wipes stored lines | medium | defer: intent question (keep vs expire) |
| No game-lines cadence setting or credit-floor guard (about 17k of 20k credits/month) | medium | defer |
| Stale lines for started events persist in `event_lines` | medium | defer: 8.2 must filter by `commence_time` |
| One-sided market stored when other side has no price at consensus point | low | defer |
| Stale Redis key after rows deleted (45s) | low | reject: bounded by TTL, fix adds complexity |
| `_extract_raw_events` treats keyless dict as empty | low | reject: empty touches nothing |
| Decimal >= 100 read as American | low | reject: unreachable for game lines |
| Numeric overflow, IN-list chunking, per-sport try/except, redundant index, status labels, DB CHECK on point | low | reject: improbable for solo, solo-scale data |
| `run_game_lines_sync` test depends on settings sports count | low | reject: default is two sports |
| Red phase not run separately | low | reject: process note recorded in Implementation Notes |
| Spec text names `x-credits-remaining` | low | reject: fix would edit the frozen spec |

## Design Notes

Cadence note: the 45s cache TTL is shorter than the 30-minute poll, so Redis lines expire between cycles (same as other live odds today); PostgreSQL stays the durable source. A separate request keeps the existing prop fetch and its credit cost untouched; the gate measures the extra cost.

## Verification

**Commands:**
- `uv run --directory services/worker ruff check parlaypal_worker tests` -- expected: no errors
- `uv run --directory services/worker ruff format --check parlaypal_worker tests` -- expected: clean
- `uv run --directory services/worker mypy parlaypal_worker tests` -- expected: no errors
- `uv run --directory services/worker pytest -v` -- expected: all pass
