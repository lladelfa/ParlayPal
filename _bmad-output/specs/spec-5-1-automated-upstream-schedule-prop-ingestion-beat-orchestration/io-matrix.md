# Story 5.1 — I/O & Edge-Case Matrix and Code Map

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

## Code Map

- `services/worker/parlaypal_worker/ingestion.py` -- NEW: Upstream HTTP schedule/prop poller (`fetch_upstream_slate`), deterministic local seed slate builder (`build_local_seed_slate`), idempotent PostgreSQL upsert + commenced-event transition (`upsert_slate_to_db`), and end-to-end orchestration helper (`run_live_slate_sync`).
- `services/worker/parlaypal_worker/celery_app.py` -- Register `parlaypal_worker.sync_live_slate` task and add 30-second periodic schedule entry in `celery_app.conf.beat_schedule` alongside `stamp-closing-line-value-every-minute`.
- `services/worker/parlaypal_worker/config.py` -- Existing settings (`parlay_api_key`, `parlay_api_base_url`, `hot_cache_ttl_seconds`, `supported_sports`); reuse without breaking existing consumers.
- `services/worker/tests/test_ingestion.py` -- NEW: TDD unit & integration suite covering every matrix row, HTTP mocking, PostgreSQL/SQLite persistence, Beat schedule verification, and Redis TTL/Pub/Sub verification.
