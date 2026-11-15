---
title: 'Story 5.1: Automated Upstream Schedule, Prop Ingestion & Beat Orchestration'
type: 'feature'
created: '2026-11-14'
status: 'ready-for-dev'
baseline_commit: '9e57c0f'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** When running ParlayPal locally, PostgreSQL (`teams`, `events`, `player_props`) is empty, Celery Beat only schedules post-game CLV stamping (`stamp_closing_line_value`), and Redis hot caches (`markets:browser:*`, `presets:feed:*`, `ev:feed:*`) are never populated or expire after 45 seconds. Consequently, `apps/web` falls back to mismatched hardcoded static fixtures (`FALLBACK_MARKET_BROWSER_FEED` and `FALLBACK_PRESET_FEED`) instead of showing current games.

**Approach:** Add an ingestion and orchestration module (`services/worker/parlaypal_worker/ingestion.py`) that fetches upcoming NFL and NBA schedules, teams, and two-way player prop markets from `PARLAY_API_BASE_URL` (with a deterministic local seed slate anchored to `datetime.now(UTC)` when unconfigured, offline, or empty), idempotently upserts `Team`, `Event`, and devigged `PlayerProp` rows into PostgreSQL 16, transitions past-commence events to `COMMENCED`, updates hit rates and stadium weather, refreshes `presets:feed:*` and `markets:browser:*` in Redis (`ex=45`), publishes `OddsDeltaFrame` messages to `odds:feed:{sport_key}`, and runs on a 30-second Celery Beat schedule via `parlaypal_worker.sync_live_slate`.

## Boundaries & Constraints

**Always:**
- Enforce AD-1 service isolation: all external `parlay-api.com` HTTP requests, schedule ingestion, seed generation, and devigging stay exclusively inside `services/worker`.
- Execute all odds math in `Decimal` (`1.01 <= D <= 9999.9999`, `allow_inf_nan=False`), converting American odds strictly at ingestion/display boundaries.
- Use UUID v4 primary keys, explicit provider prefixes (`papi_...` or `seed_...`) on every `external_provider_id`, and ISO 8601 UTC timestamps (`TIMESTAMPTZ` / `YYYY-MM-DDTHH:mm:ssZ`).
- Route all two-way player prop quotes through `process_and_publish_ev_props` so Multiplicative + Brent Power devigging and the `> 10.0%` (`SUSPECT_STALE_LINE`) outlier circuit breaker are enforced before caching.
- Keep Redis hot cache TTL strictly at `45` seconds (`EX=45`) and schedule `parlaypal_worker.sync_live_slate` in `celery_app.conf.beat_schedule` every `30.0` seconds.

**Decisions (human-approved):**
- **Automatic Local Seed Fallback:** When `PARLAY_API_KEY` is blank or `"replace_with_parlay_api_key"`, when `httpx` raises transport/timeout/HTTP errors, or when the upstream response contains zero upcoming events, fall back automatically to a deterministic multi-sport NFL + NBA slate anchored to `datetime.now(UTC)` across `today`, `tomorrow`, and `weekend` (`48h-72h` / Sat-Sun) windows so local development works immediately with or without live API access.
- **Database Schema Initialization Safety:** Call `init_db()` or ensure schema tables exist on startup/sync if needed without dropping existing data, and perform idempotent upserts keyed by `external_provider_id`.
- **Commenced Event Lifecycle:** Automatically transition any `Event` with `status == "SCHEDULED"` and `commence_time <= now_utc` to `status = "COMMENCED"` on every sync pass before building preset and market browser feeds.

**Never:**
- Never call `parlay-api.com` from `apps/web` or modify `apps/web` UI fallback fixtures as a substitute for real worker → PostgreSQL → Redis flow.
- Never publish props with `guarded_ev > 0.10000` (`SUSPECT_STALE_LINE`) to `ev:feed:*`, `presets:feed:*`, or `markets:browser:*`.
- Never allow upstream network failures, timeouts, or malformed single-prop entries to crash the Celery Beat schedule loop.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Upstream happy path | Valid `PARLAY_API_KEY` & `PARLAY_API_BASE_URL`; upstream returns NFL & NBA events with teams and two-way prop odds | Upserts `Team`, `Event` (`SCHEDULED`), and devigged `PlayerProp` rows in PostgreSQL 16; updates hit rates & weather; refreshes `presets:feed:*`, `markets:browser:*`, `ev:feed:*` (`EX=45`); publishes `OddsDeltaFrame` to `odds:feed:{sport_key}` | Malformed individual prop records skipped/logged without aborting remaining batch |
| Missing/placeholder API key fallback | `PARLAY_API_KEY` empty or `"replace_with_parlay_api_key"` | Falls back automatically to deterministic local NFL/NBA seed slate anchored to `datetime.now(UTC)` (`today`, `tomorrow`, `weekend` windows) | Logs fallback activation (`INFO`); returns populated sync summary |
| Upstream HTTP error / timeout / empty slate | Upstream returns HTTP 4xx/5xx, times out, raises transport error, or returns `0` upcoming events | Falls back cleanly to deterministic local seed slate so Redis feeds never starve into `apps/web` static fallback fixtures | Logs upstream error warning; never crashes Beat cycle |
| Commenced game transition | Existing `SCHEDULED` event in PostgreSQL with `commence_time <= now_utc` | Updates `Event.status = "COMMENCED"` before assembling preset and market browser feeds | Excluded automatically from `presets:feed:*` and `markets:browser:*` |
| Outlier prop circuit breaker | Upstream or seed batch includes prop with calculated `guarded_ev > 0.10000` (10.0%) | `process_and_publish_ev_props` stamps `status = "SUSPECT_STALE_LINE"` in PostgreSQL and excludes prop from `ev:feed:*`, `presets:feed:*`, and `markets:browser:*` | Logged via existing outlier guard warning |
| Idempotent re-run / upsert | `sync_live_slate` runs twice consecutively with identical `external_provider_id` records | Updates existing `Team`, `Event`, and `PlayerProp` rows in place without creating duplicate rows or violating unique constraints | Reuses resolved UUID primary keys across cycles |
| 30s Beat schedule & 45s Redis TTL | Celery Beat configuration in `celery_app.py` | `beat_schedule` schedules `parlaypal_worker.sync_live_slate` every `30.0` seconds; all written Redis feed/cache keys carry `ex=45` | Keeps Redis hot cache continuously warm ahead of 45s TTL expiration |

</frozen-after-approval>

## Code Map

- `services/worker/parlaypal_worker/ingestion.py` -- NEW: Upstream HTTP schedule/prop poller (`fetch_upstream_slate`), deterministic local seed slate builder (`build_local_seed_slate`), idempotent PostgreSQL upsert + commenced-event transition (`upsert_slate_to_db`), and end-to-end pipeline orchestrator (`run_live_slate_sync`).
- `services/worker/parlaypal_worker/celery_app.py` -- Register `parlaypal_worker.sync_live_slate` task and add `sync-live-slate-every-30s` (`schedule: 30.0`) to `celery_app.conf.beat_schedule` alongside `stamp-closing-line-value-every-minute`.
- `services/worker/parlaypal_worker/devig.py` -- Reuse `TwoWayPropMarketInput`, `process_and_publish_ev_props`, `american_to_decimal`; do not modify.
- `services/worker/parlaypal_worker/hit_rate.py` -- Reuse `update_props_hit_rates`; do not modify.
- `services/worker/parlaypal_worker/weather.py` -- Reuse `ingest_events_weather`; do not modify.
- `services/worker/parlaypal_worker/presets.py` -- Reuse `generate_curated_presets`, `sync_preset_feed_to_redis`; do not modify.
- `services/worker/parlaypal_worker/market_browser.py` -- Reuse `build_market_browser_feed`, `sync_market_browser_to_redis`, `CANONICAL_MARKETS_BY_SPORT`; do not modify.
- `services/worker/parlaypal_worker/redis_client.py` -- Reuse `HOT_CACHE_TTL_SECONDS`, `OddsDeltaFrame`, `PropOddsQuote`, `publish_odds_delta`, `get_redis_client`; do not modify.
- `services/worker/tests/test_ingestion.py` -- NEW: TDD unit & integration suite covering every matrix row, HTTP mocking, SQLite/PostgreSQL persistence, Redis TTL/Pub/Sub verification, and Celery Beat schedule checks.

## Tasks & Acceptance

**Execution:**
- [ ] `services/worker/tests/test_ingestion.py` -- Write failing tests for every I/O & Edge-Case Matrix row (red phase) -- TDD per `AGENTS.md`.
- [ ] `services/worker/parlaypal_worker/ingestion.py` -- Implement upstream schedule/prop poller (`httpx`), deterministic local seed fallback (`build_local_seed_slate`), idempotent PostgreSQL upsert + commenced transition (`upsert_slate_to_db`), and pipeline orchestration (`run_live_slate_sync`) -- core ingestion engine.
- [ ] `services/worker/parlaypal_worker/celery_app.py` -- Register `parlaypal_worker.sync_live_slate` task and configure 30-second Celery Beat schedule (`beat_schedule`) -- continuous Redis cache warming.
- [ ] Verify end-to-end local sync execution against PostgreSQL 16 and Redis 7.2 (confirming populated `teams`, `events`, `player_props`, `presets:feed:*`, and `markets:browser:*` with 45s TTL).

**Acceptance Criteria:**
- Given valid upstream API settings and mocked/live HTTP responses, when `run_live_slate_sync` executes, then NFL and NBA teams, events, and devigged player props are persisted idempotently in PostgreSQL and synced to Redis (`presets:feed:*`, `markets:browser:*`, `ev:feed:*`) with `ex=45` and `odds:feed:{sport_key}` deltas published.
- Given missing/placeholder `PARLAY_API_KEY` or an unreachable/empty upstream endpoint, when `run_live_slate_sync` executes, then a deterministic multi-sport NFL/NBA slate anchored to `datetime.now(UTC)` (`today`, `tomorrow`, `weekend`) populates PostgreSQL and Redis cleanly without crashing.
- Given a `SCHEDULED` event whose `commence_time <= now_utc`, when `run_live_slate_sync` executes, then the event is transitioned to `COMMENCED` and excluded from pre-match preset and market browser Redis feeds.
- Given `celery_app.conf.beat_schedule`, then `parlaypal_worker.sync_live_slate` is registered on a `30.0`-second interval alongside `parlaypal_worker.stamp_closing_line_value`.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Verification

**Commands:**
- `uv run --directory services/worker ruff check parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker ruff format --check parlaypal_worker tests` -- expected: formatted
- `uv run --directory services/worker mypy parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker pytest -v` -- expected: all pass
