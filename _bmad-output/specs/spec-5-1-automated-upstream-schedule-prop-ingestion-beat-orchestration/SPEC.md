---
id: SPEC-5-1-automated-upstream-schedule-prop-ingestion-beat-orchestration
companions:
  - io-matrix.md
  - ../../implementation-artifacts/epic-5-context.md
  - ../../../AGENTS.md
sources:
  - ../../planning-artifacts/epics.md
  - ../../planning-artifacts/prds/prd-parlaypal-2026-11-08/prd.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Story 5.1: Automated Upstream Schedule, Prop Ingestion & Beat Orchestration

## Why

**A pain to solve:** When running ParlayPal locally, PostgreSQL (`teams`, `events`, `player_props`) starts empty, Celery Beat only schedules post-game CLV stamping (`stamp_closing_line_value`), and Redis hot caches (`markets:browser:*`, `presets:feed:*`, `ev:feed:*`) remain unpopulated or expire after 45 seconds. As a result, `apps/web` falls back to mismatched hardcoded module-level fixtures instead of displaying live, synchronized NFL and NBA games. Because all downstream quantitative and feed-assembly engines already exist, closing the upstream ingestion and 30-second Beat loop unlocks real end-to-end behavior locally and in production.

## Capabilities

- **CAP-1: Upstream Schedule & Two-Way Prop Polling**
  - **intent:** The Python worker fetches upcoming NFL and NBA schedules, team metadata, and two-way player prop markets from the configured upstream odds provider.
  - **success:** Given valid `PARLAY_API_BASE_URL` and `PARLAY_API_KEY` settings and reachable upstream HTTP endpoints, a sync cycle retrieves and normalizes current NFL (`americanfootball_nfl`) and NBA (`basketball_nba`) events, teams, and two-way prop quotes via `httpx`.
- **CAP-2: Deterministic Local Seed Slate Fallback**
  - **intent:** The worker supplies a realistic multi-sport NFL and NBA slate anchored dynamically to the current UTC timestamp whenever the upstream provider is unconfigured, offline, failing, or empty.
  - **success:** When `PARLAY_API_KEY` is missing/placeholder or an upstream request fails or returns zero upcoming events, the worker produces a deterministic slate containing upcoming NFL and NBA games across `today`, `tomorrow`, and `weekend` windows with canonical markets, weather telemetry, and game logs for hit rates.
- **CAP-3: Idempotent PostgreSQL Upsert & Commenced Transition**
  - **intent:** The worker persists ingested teams, events, and devigged player props idempotently in PostgreSQL 16 and retires past-commence pre-match events.
  - **success:** Repeated ingestion runs update existing `Team`, `Event`, and `PlayerProp` rows in place by `external_provider_id` without creating duplicates, transition any `SCHEDULED` event with `commence_time <= now_utc` to `COMMENCED`, and enforce the `> 10.0%` EV `SUSPECT_STALE_LINE` outlier guard.
- **CAP-4: End-to-End Feed Sync & 30-Second Celery Beat Orchestration**
  - **intent:** A periodic Celery Beat task coordinates ingestion, quantitative processing, Redis cache warming, and live SSE delta broadcasting on a cadence shorter than the 45-second Redis TTL.
  - **success:** `parlaypal_worker.sync_live_slate` is scheduled every 30 seconds in `celery_app.conf.beat_schedule`, populating `presets:feed:{all,nfl,nba}`, `markets:browser:{all,nfl,nba}`, `ev:feed:{sport_key}`, and `odds:latest:{sport_key}:{event_id}` with `ex=45` and publishing `OddsDeltaFrame` payloads to `odds:feed:{sport_key}`.

## Constraints

- **AD-1 Service Isolation:** `services/worker` owns all upstream `parlay-api.com` HTTP communication, seed fallback, and devigging math; `apps/web` must not be modified to call external APIs.
- **AD-2 Storage Partitioning & 45s TTL:** Durable entities (`teams`, `events`, `player_props`) persist in PostgreSQL 16; ephemeral Redis feeds expire strictly at `45` seconds (`EX=45`) and are refreshed every `30` seconds by Celery Beat.
- **AD-4 Quantitative & Outlier Invariants:** Every ingested two-way prop must pass through `process_and_publish_ev_props` (Power + Multiplicative devigging), with any prop where `guarded_ev > 10.0%` stamped `SUSPECT_STALE_LINE` and excluded from public feeds.
- **Data Integrity Conventions:** Execute odds math in `Decimal` ($D \ge 1.01$, `<= 9999.9999`), use UUID v4 primary keys, require explicit provider prefixes (`papi_...` / `seed_...`) on `external_provider_id`, and enforce ISO 8601 UTC timestamps.

## Non-goals

- Modifying `apps/web` UI components, API route handlers, or hardcoded fallback fixtures (covered separately if needed; `apps/web` already reads live Redis keys).
- Implementing Story 4.3 (`CLV Analytics & Long-Term Edge Reporting`) UI charts or historical line-movement endpoints.
- Introducing WebSocket ingestion daemons or changing `docker-compose.yml` service topologies.

## Success signal

Running `services/worker` with Celery worker + Beat locally (even without live external network access) populates PostgreSQL 16 with upcoming NFL and NBA events (`commence_time > now_utc`) and refreshes `presets:feed:*` and `markets:browser:*` in Redis every 30 seconds before the 45-second TTL expires, verified by automated `pytest` matrix tests and `ruff`/`mypy` checks.
