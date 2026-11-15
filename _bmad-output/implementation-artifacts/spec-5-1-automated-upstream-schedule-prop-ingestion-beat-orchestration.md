---
title: 'Story 5.1: Automated Upstream Schedule, Prop Ingestion & Beat Orchestration'
type: 'feature'
created: '2026-11-14'
status: 'done'
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
- [x] `services/worker/tests/test_ingestion.py` -- Write failing tests for every I/O & Edge-Case Matrix row (red phase) -- TDD per `AGENTS.md`.
- [x] `services/worker/parlaypal_worker/ingestion.py` -- Implement upstream schedule/prop poller (`httpx`), deterministic local seed fallback (`build_local_seed_slate`), idempotent PostgreSQL upsert + commenced transition (`upsert_slate_to_db`), and pipeline orchestration (`run_live_slate_sync`) -- core ingestion engine.
- [x] `services/worker/parlaypal_worker/celery_app.py` -- Register `parlaypal_worker.sync_live_slate` task and configure 30-second Celery Beat schedule (`beat_schedule`) -- continuous Redis cache warming.
- [x] Verify end-to-end local sync execution against PostgreSQL 16 and Redis 7.2 (confirming populated `teams`, `events`, `player_props`, `presets:feed:*`, and `markets:browser:*` with 45s TTL).

**Acceptance Criteria:**
- Given valid upstream API settings and mocked/live HTTP responses, when `run_live_slate_sync` executes, then NFL and NBA teams, events, and devigged player props are persisted idempotently in PostgreSQL and synced to Redis (`presets:feed:*`, `markets:browser:*`, `ev:feed:*`) with `ex=45` and `odds:feed:{sport_key}` deltas published.
- Given missing/placeholder `PARLAY_API_KEY` or an unreachable/empty upstream endpoint, when `run_live_slate_sync` executes, then a deterministic multi-sport NFL/NBA slate anchored to `datetime.now(UTC)` (`today`, `tomorrow`, `weekend`) populates PostgreSQL and Redis cleanly without crashing.
- Given a `SCHEDULED` event whose `commence_time <= now_utc`, when `run_live_slate_sync` executes, then the event is transitioned to `COMMENCED` and excluded from pre-match preset and market browser Redis feeds.
- Given `celery_app.conf.beat_schedule`, then `parlaypal_worker.sync_live_slate` is registered on a `30.0`-second interval alongside `parlaypal_worker.stamp_closing_line_value`.

## Implementation Notes

- Added [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py) (`fetch_upstream_slate`, `build_local_seed_slate`, `upsert_slate_to_db`, `run_live_slate_sync`) supporting `PARLAY_API_BASE_URL` polling via `httpx`, automatic deterministic NFL/NBA local seed fallback across `today`, `tomorrow`, and `weekend` windows, idempotent `Team`/`Event`/`PlayerProp` upserts, automatic `SCHEDULED -> COMMENCED` transitions, weather/hit-rate updates, Brent devigging + `> 10.0%` outlier guard via `process_and_publish_ev_props`, and 45s Redis feed/delta publishing.
- Registered `parlaypal_worker.sync_live_slate` on a `30.0`-second Beat interval (`sync-live-slate-every-30s`) in [celery_app.py](../../services/worker/parlaypal_worker/celery_app.py).
- Added 35 tests covering all 7 matrix rows and Step 4 review triage fixes in [test_ingestion.py](../../services/worker/tests/test_ingestion.py); all 174 worker pytest cases, `ruff check`, `ruff format --check`, `mypy`, and live PostgreSQL 16 / Redis 7.2 sync checks (`teams=12`, `events=6`, `player_props=12`, Redis TTL `45`s) passed.

## Spec Change Log

## Review Triage Log

| Finding | Layer | Location | Verdict | Route | Evidence |
|---------|-------|----------|---------|-------|----------|
| `VG-1` | `verification-gap` | [celery_app.py](../../services/worker/parlaypal_worker/celery_app.py#L399-L438), [test_ingestion.py](../../services/worker/tests/test_ingestion.py#L891-L934) | `medium` | `patch` | Pre-verified gap: `test_celery_sync_live_slate_task_execution_and_resource_cleanup` populates `created_sessions` but never asserts `.close()` on owned sessions or exception cleanup. |
| `VG-2` | `verification-gap` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1548-L1615), [test_ingestion.py](../../services/worker/tests/test_ingestion.py#L450-L505) | `medium` | `patch` | Pre-verified gap: seed fallback test checks Redis keys and `ttl == 45` without asserting DB `PlayerProp.hit_rate_l5`/`l10`/`season`, `markets:browser:all` `hitRateL10`, or `HIGH_VALUE` tiering in `ev:feed:americanfootball_nfl`. |
| `VG-3` | `verification-gap` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L809-L843), [test_ingestion.py](../../services/worker/tests/test_ingestion.py#L540-L625) | `medium` | `patch` | Pre-verified gap: mock transport returns identical errors/empty responses across all sports and removes all events in `past_events_only`, leaving single-sport partial HTTP failure and empty-props schedule fallback unverified. |
| `VG-4` | `verification-gap` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L626-L649), [test_ingestion.py](../../services/worker/tests/test_ingestion.py) | `medium` | `patch` | Pre-verified gap: every two-way fixture selects `"OVER"`, leaving the `under_ratio > over_ratio` and `"UNDER"`-only retail branches and sharp odds pairing unexecuted. |
| `VG-O1` | `verification-gap` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L980), [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1717-L1761) | `high` | `patch` | Verified: transient fallback persists `seed_*` events out to `+56h`, and subsequent `"upstream"` recovery loads all `ACTIVE` `PlayerProp` and future `SCHEDULED` `Event` rows globally without retiring `seed_*` records or scoping props to `events_map`. |
| `VG-O2` | `verification-gap` | [PresetFeed.tsx](../../apps/web/src/components/PresetFeed.tsx#L45-L59), [route.ts](../../apps/web/src/app/api/stream/odds/route.ts#L126) | `medium` | `defer` | Verified pre-existing (`97adb43`/`9a5a054`): `PresetFeed.tsx` listens only for named `"odds_delta"` events and camelCase `propId`/`decimalOdds`, whereas `/api/stream/odds` emits unnamed `data:` frames with snake_case `quotes`; spec prohibits modifying `apps/web`. |
| `VG-O3` | `verification-gap` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L373), [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L893) | `medium` | `patch` | Verified: `raw_team.get("is_dome", default_is_dome)` and `raw_event.get("is_dome", home_team.is_dome)` evaluate explicit JSON `"is_dome": null` via `bool(None)` to `False`, overriding arena/dome metadata and `weather.py` checks. |
| `VG-O4` | `verification-gap` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1542-L1546) | `medium` | `patch` | Verified: `upsert_slate_to_db` resolves `prop_in.team_external_id` only from in-memory `teams_by_ext_id` without a DB `select(Team)` fallback, leaving `PlayerProp.team_id = None` for incremental slates. |
| `EC-1` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1693-L1696) | `medium` | `patch` | Verified: `active_session = create_session_factory()()` opens before `get_redis_client()` and outside `try:`, so a Redis init error leaks an unclosed SQLAlchemy `Session`. |
| `EC-2` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L699-L700) | `high` | `patch` | Verified: `_extract_direct_props` maps `raw_sel == "UNDER"` and silently coerces `"NO"` or unrecognized strings like `"INVALID"` to `"OVER"`. |
| `EC-3` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L457-L463) | `medium` | `patch` | Verified: `_parse_optional_decimal` strips string inputs without returning `None` on empty `""`, raising `decimal.InvalidOperation` and dropping the parent event/prop. |
| `EC-4` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L419-L454) | `high` | `patch` | Verified: `_parse_odds_to_decimal` converts `int >= 100` as American odds while treating string `"150"` and float `150.0` as Decimal `150.0000`, and fails to catch `InvalidOperation` on non-numeric strings. |
| `EC-5` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L373), [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L893) | `medium` | `patch` | Verified (shared root cause with `VG-O3`): explicit `"is_dome": null` overrides `default_is_dome` and `home_team.is_dome` to `False`. |
| `EC-6` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L931-L932), [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1600-L1609) | `high` | `patch` | Verified: empty `supported_sports` raises an empty `UpstreamIngestionError("")`, and single-sport failure skips raising and causes `markets_by_sport` to overwrite `ev:feed:{failed_sport}` with `[]`. |
| `EC-7` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L339-L354), [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L626-L672) | `high` | `patch` | Verified (shared root cause with `VG-O1`): deterministic ID includes `selection|line_value` with no reconciliation step marking moved, side-flipped, or removed event props `SUSPENDED`. |
| `EC-8` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L910-L922), [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1600-L1611) | `medium` | `patch` | Verified: duplicate event objects across sport responses and overlapping `book_props`/`direct_props` are appended without deduplication by `external_provider_id`, double-counting upsert metrics and duplicating `ev:feed` items. |
| `EC-9` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L902), [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1460-L1479) | `medium` | `patch` | Verified: `fetch_upstream_slate` hardcodes `status="SCHEDULED"` and `upsert_slate_to_db` unconditionally overwrites `existing_event.status = effective_status`, reverting `LIVE`/`FINAL`/`POSTPONED`/`CANCELLED` events. |
| `EC-10` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1542-L1546) | `medium` | `patch` | Verified (shared root cause with `VG-O4`): prop `team_external_id` resolution lacks DB fallback lookup when `slate.teams` omits an existing DB team. |
| `EC-11` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1551-L1561) | `medium` | `patch` | Verified: `compute_rolling_hit_rate` executes before the per-prop `try/except`, so `HitRateError` from bad `IngestedGameLog.stats` aborts the whole slate sync. |
| `EC-12` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1551-L1615) | `medium` | `patch` | Verified: `update_props_hit_rates` executes after `process_and_publish_ev_props` and overwrites preset `hit_rate_*` on matching `(player_name, market_key)` rows, letting `ev:feed` diverge from DB and browser/preset feeds. |
| `EC-13` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1600-L1609) | `low` | `patch` | Verified: `upsert_slate_to_db(..., redis_client=None)` forwards `None` into `process_and_publish_ev_props`, which falls back to `get_redis_client()` and attempts a localhost Redis connection. |
| `EC-14` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1759-L1760) | `low` | `rejected` | Verified low, rejected: reassigning naive SQLite `event.commence_time = commence_utc` only normalizes test-dialect naive datetimes before feed assembly; production PostgreSQL `TIMESTAMPTZ` is already tz-aware. |
| `EC-15` | `edge-case-hunter` | [celery_app.py](../../services/worker/parlaypal_worker/celery_app.py#L45-L48), [celery_app.py](../../services/worker/parlaypal_worker/celery_app.py#L400-L429) | `low` | `patch` | Verified: `"sync-live-slate-every-30s"` lacks task expiration (`options={"expires": 25.0}`), allowing delayed queued Beat ticks to pile up past the next 30s interval. |
| `EC-16` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L944-L960) | `low` | `patch` | Verified: `_same_utc_day_commence` sets `end_of_day` with `microsecond=0`, which is `<= ref_now` during `23:59:59.000001Z..23:59:59.999999Z` and returns tomorrow's `candidate`. |
| `EC-17` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L325-L336) | `medium` | `patch` | Verified: `_ensure_provider_prefix` uses non-deterministic `uuid.uuid4().hex[:12]` on empty-after-sanitize `raw_id` and truncates `[:128]` without collapsing underscores or appending a short hash to prevent ID collisions. |
| `EC-18` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L180-L182), [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1496-L1518) | `medium` | `patch` | Verified: `IngestedEvent` weather fields lack finite `Numeric(5, 2)` and domain bounds (`[-999.99, 999.99]`, `wind >= 0`, `0 <= precip_prob <= 100`), letting one out-of-range value fail `ingest_events_weather`. |
| `EC-19` | `edge-case-hunter` | [celery_app.py](../../services/worker/parlaypal_worker/celery_app.py#L420) | `false` | `rejected` | Refuted: `sync_live_slate` types `now: datetime \| str \| None = None`, matching `stamp_closing_line_value`; failing loudly on an unsupported numeric type is expected behavior. |
| `EC-20` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L830) | `medium` | `patch` | Verified: `raw_payload.get("events") or raw_payload.get("data") or []` falls through to `"data"` when `"events": []` is an empty list. |
| `EC-21` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L855-L856) | `low` | `patch` | Verified: `if not raw_ev_id:` rejects valid integer `id: 0` as missing instead of checking `None` / blank string. |
| `EC-22` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L701) | `medium` | `patch` | Verified: `item.get("line_value", item.get("line"))` returns `None` when `"line_value": null` is explicit instead of falling back to `"line"`. |
| `EC-23` | `edge-case-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1374-L1375) | `low` | `patch` | Verified: `_ensure_schema_initialized` checks `has_table("teams")` and `has_table("events")` without checking `has_table("player_props")`. |
| `BH-1` | `blind-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L339-L354), [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1742-L1761) | `high` | `patch` | Verified (shared root cause with `VG-O1`/`EC-7`): no retirement for moved/flipped/dropped props or `seed_*` rows on recovery, and `active_props` is not scoped to `events_map.keys()`. |
| `BH-2` | `blind-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L659-L749), [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1542-L1546) | `medium` | `patch` | Verified (shared root cause with `VG-O4`/`EC-10`): upstream prop extractors leave `team_external_id=None` and `upsert_slate_to_db` skips DB `Team` lookup, leaving `PlayerProp.team_id = None`. |
| `BH-3` | `blind-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L466-L580), [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1649-L1671) | `low` | `patch` | Mixed: `PlayerProp` (`models.py`) has no `sportsbook` column and 30s delta publishing is needed to keep the 45s `odds:latest:*` TTL warm (`false` for `sportsbook="consensus"` / 30s frequency); verified `low` that `_split_outcome_player_and_side` ignores name/description mismatch and `_extract_props_from_bookmakers` silently overwrites duplicate `(player, line, side)` outcomes in one book. |
| `BH-4` | `blind-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L419-L454) | `high` | `patch` | Verified (shared root cause with `EC-4`): `_parse_odds_to_decimal` disagrees on `>= 100` across types, leaks `InvalidOperation`, and duplicates bounds checks. |
| `BH-5` | `blind-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L699-L749) | `high` | `patch` | Verified (shared root cause with `EC-2`): `_extract_direct_props` coerces `"NO"`/invalid selections to `"OVER"` and omits optional `hit_rate_*` fields on direct props (synthetic game logs in `/odds` polling is `false`). |
| `BH-6` | `blind-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1600-L1609), [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1724) | `high` | `patch` | Mixed: `if not slate.events or not slate.props:` fallback is intentional per Matrix Row 3 and `VG-3` so prop-less responses do not starve Redis feeds (`false`), while verified `high` (`EC-6`) that single-sport failure wipes `ev:feed:{sport}` via `markets_by_sport`. |
| `BH-7` | `blind-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1460-L1615) | `medium` | `patch` | Verified (shared root cause with `EC-9`/`EC-11`/`EC-12`): `compute_rolling_hit_rate` outside `try:`, `update_props_hit_rates` ordering after `process_and_publish_ev_props`, non-scheduled props unfiltered before `ev:feed`, and `existing_event.status` overwrite. |
| `BH-8` | `blind-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1693-L1696), [celery_app.py](../../services/worker/parlaypal_worker/celery_app.py#L45-L48) | `medium` | `patch` | Verified (shared root cause with `EC-1`/`EC-15`): DB `Session` leaks on `get_redis_client()` error and Beat schedule entry lacks `expires`. |
| `BH-9` | `blind-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L325-L373), [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L893) | `medium` | `patch` | Verified (shared root cause with `VG-O3`/`EC-5`/`EC-17`): non-deterministic `uuid.uuid4()` fallback ID and `"is_dome": null` evaluated to `False`. |
| `BH-10` | `blind-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L180-L182), [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L1496-L1518) | `medium` | `patch` | Verified (shared root cause with `EC-18`): outdoor upstream events without explicit weather metrics skip `weather_payload` so `weather:event:{id}` is not cached, and weather metrics lack `Numeric(5, 2)` / range bounds. |
| `BH-11` | `blind-hunter` | [ingestion.py](../../services/worker/parlaypal_worker/ingestion.py#L944-L980) | `low` | `patch` | Mixed: anchoring `build_local_seed_slate` dynamically to `now_utc` is explicitly required by frozen spec (`false`), while verified `low` (`EC-16`) that `_same_utc_day_commence` `microsecond=0` spills into tomorrow at `23:59:59.xxxxxx`. |
| `BH-12` | `blind-hunter` | [test_ingestion.py](../../services/worker/tests/test_ingestion.py#L365-L443) | `medium` | `patch` | Verified (shared root cause with `VG-1..4`): missing unit/edge tests and loose `>= 6`/`>= 1` assertions in `test_upstream_happy_path_persists_db_caches_redis_and_skips_malformed_props` mask double-counting malformed props. |

## Verification

**Commands:**
- `uv run --directory services/worker ruff check parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker ruff format --check parlaypal_worker tests` -- expected: formatted
- `uv run --directory services/worker mypy parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker pytest -v` -- expected: all pass
