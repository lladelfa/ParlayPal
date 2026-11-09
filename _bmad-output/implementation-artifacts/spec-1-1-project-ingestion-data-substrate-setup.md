---
title: 'Story 1.1: Project Ingestion & Data Substrate Setup'
type: 'feature'
created: '2026-11-08'
status: 'done'
route: 'dispatch'
baseline_commit: 'NO_VCS'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** ParlayPal is currently a greenfield repository lacking the decoupled polyglot runtime, relational database schema, and real-time event bus required to ingest sportsbook odds, run quantitative devigging models, and stream live pricing to bettors.

**Approach:** Initialize a monorepo containing a Python 3.13 / Celery worker service (`services/worker`) managed by `uv` and a Next.js 15 App Router web application (`apps/web`) styled with Tailwind CSS 4 dark-mode design tokens, wired to PostgreSQL 16 (initializing `teams`, `events`, `player_props`, and `user_bets` tables) and Redis 7.2 (45s TTL cache and `odds:feed:<sport_key>` Pub/Sub streaming over `/api/stream/odds`).

## Boundaries & Constraints

**Always:**
- Enforce polyglot service isolation (AD-1): `services/worker` owns `parlay-api.com` ingestion and quantitative processing and never serves browser HTTP requests; `apps/web` owns UI rendering and `/api/stream/odds` SSE streaming and never calls `parlay-api.com` directly for live feeds.
- Use UUID v4 primary keys (`team_id`, `event_id`, `prop_id`, `bet_id`, `user_id`), explicit provider prefixes in `external_provider_id` (e.g., `papi_nfl_12345`), Decimal odds (`NUMERIC(8,4)`, $D \ge 1.01$) internally, and ISO 8601 UTC timestamps (`TIMESTAMPTZ` in PostgreSQL, `YYYY-MM-DDTHH:mm:ssZ` in JSON).
- Namespace Redis keys with colons (`odds:latest:{sport_key}:{event_id}`, `ev:feed:{sport_key}`, `sgp:audit:{event_id}`) with a strict 45-second TTL on hot odds/EV keys, and publish/subscribe deltas on `odds:feed:{sport_key}`.
- Format API error responses as standardized JSON Problem Details: `{ "error": { "code": "...", "message": "...", "retry_after": 60 } }`.
- Configure `apps/web` with the UX dark surface hierarchy (`#0a0e17` canvas, `#0f131c` module, `#121b2d` card, `#1e293b` hairline border) and semantic neon accents (`#06b6d4` cyan, `#6366f1` violet, `#10b981` emerald, `#f59e0b` amber, `#f43f5e` rose) plus `Space Grotesk`, `Outfit`, and tabular `JetBrains Mono` fonts.

**Never:**
- Never store raw sub-second odds tick history in PostgreSQL during Phase 1 or introduce TimescaleDB hypertables.
- Never implement devigging math (Story 1.2), rolling hit-rate/weather logic (Story 1.3), or preset parlay card assembly (Story 1.4) in this story beyond the foundational schema and service substrate.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Schema initialization | Worker startup or schema init invocation against PostgreSQL 16 | Idempotently creates `teams`, `events`, `player_props`, and `user_bets` tables and indexes (`idx_events_sport_commence`, `idx_player_props_event_market`, `idx_user_bets_user_placed`, `idx_user_bets_event_pending`) | Raises structured connection error and logs failure without partial uncommitted DDL |
| Hot odds cache & Pub/Sub | Worker publishes odds delta for `sport_key` and `event_id` | Sets `odds:latest:{sport_key}:{event_id}` in Redis with `EX=45` and publishes JSON frame (`YYYY-MM-DDTHH:mm:ssZ`) to `odds:feed:{sport_key}` | Rejects decimal odds $< 1.01$ via Pydantic validation before writing to Redis |
| SSE stream subscription | `GET /api/stream/odds?sport_key=americanfootball_nfl` | Returns `200 OK` with `Content-Type: text/event-stream`, emits initial connection frame, and forwards messages from Redis channel `odds:feed:americanfootball_nfl` | Cleans up Redis subscriber connection on client `AbortSignal` disconnect |
| Invalid SSE `sport_key` or Redis down | `GET /api/stream/odds` with unsupported `sport_key` or unreachable Redis | Rejects invalid request or fails gracefully | Returns HTTP `400` or `503` with `{ "error": { "code": " INVALID_SPORT_KEY" | "STREAM_UNAVAILABLE", "message": "...", "retry_after": 60 } }` |

</frozen-after-approval>

## Code Map

- `.gitignore` -- Existing ignore file; expand to ignore Node (`node_modules/`, `.next/`), Python (`.venv/`, `__pycache__/`, `.pytest_cache/`), and `.env*` secrets while preserving `.bmad-loop/` and `_bmad/render/` rules.
- `docker-compose.yml` -- New local infrastructure definition providing `postgres:16-alpine` and `redis:7.2-alpine` with healthchecks.
- `.env.example` -- New environment template defining `DATABASE_URL`, `REDIS_URL`, `PARLAY_API_KEY`, and `PARLAY_API_BASE_URL`.
- `services/worker/pyproject.toml` -- New `uv`-managed Python 3.13 project configuration declaring `celery`, `redis`, `sqlalchemy>=2.0`, `psycopg[binary]>=3.1`, `pydantic>=2.7`, `pydantic-settings`, `scipy>=1.13.0`, `httpx`, and `pytest`.
- `services/worker/parlaypal_worker/config.py` -- Worker settings loaded via `pydantic-settings` with defaults for local PostgreSQL 16 and Redis 7.2.
- `services/worker/parlaypal_worker/db.py` -- SQLAlchemy 2.0 engine, session factory, and `init_db()` helper.
- `services/worker/parlaypal_worker/models.py` -- Declarative models and constraints for `teams`, `events`, `player_props`, and `user_bets`.
- `services/worker/parlaypal_worker/redis_client.py` -- Redis 7.2 helper enforcing 45-second TTL on `odds:latest:{sport_key}:{event_id}` / `ev:feed:{sport_key}` and publishing ISO 8601 UTC frames to `odds:feed:{sport_key}`.
- `services/worker/parlaypal_worker/celery_app.py` -- Celery application wired to Redis broker/backend with foundational health/ingestion task hooks.
- `services/worker/tests/test_substrate.py` -- Pytest unit and integration suite covering schema initialization, constraint validation, and Redis 45s TTL + Pub/Sub behavior.
- `apps/web/package.json` -- Next.js 15 App Router package manifest with React 19, TypeScript, Tailwind CSS 4, `ioredis`, and Vitest.
- `apps/web/src/app/globals.css` -- Tailwind CSS 4 theme configuration defining dark surface tokens (`#0a0e17`, `#0f131c`, `#121b2d`, `#1e293b`), neon accents, and font variables.
- `apps/web/src/app/layout.tsx` & `apps/web/src/app/page.tsx` -- Root layout loading `Space Grotesk`, `Outfit`, and `JetBrains Mono` fonts and foundational ParlayPal shell page.
- `apps/web/src/lib/redis.ts` & `apps/web/src/lib/errors.ts` -- Redis client factory and standardized JSON Problem Details helper.
- `apps/web/src/app/api/stream/odds/route.ts` -- Next.js App Router SSE endpoint subscribing to `odds:feed:{sport_key}`.
- `apps/web/src/app/api/stream/odds/route.test.ts` -- Unit tests verifying SSE headers, frame streaming, and Problem Details error responses.

## Tasks & Acceptance

**Execution:**
- [x] `.gitignore`, `.env.example`, `docker-compose.yml` -- Update `.gitignore` for Python/Node/env artifacts and create `.env.example` and `docker-compose.yml` for PostgreSQL 16 and Redis 7.2 -- Provides reproducible local backing services and prevents committing build/secret artifacts.
- [x] `services/worker/pyproject.toml`, `services/worker/parlaypal_worker/__init__.py`, `services/worker/parlaypal_worker/config.py` -- Initialize the `uv` Python 3.13 package and typed configuration settings -- Establishes the isolated Python worker environment mandated by AD-1.
- [x] `services/worker/parlaypal_worker/models.py`, `services/worker/parlaypal_worker/db.py` -- Implement SQLAlchemy 2.0 ORM models (`Team`, `Event`, `PlayerProp`, `UserBet`) with UUID v4 PKs, `external_provider_id` uniqueness, status check constraints, `TIMESTAMPTZ` columns, and `init_db()` schema initializer -- Satisfies PostgreSQL 16 relational table initialization requirements.
- [x] `services/worker/parlaypal_worker/redis_client.py`, `services/worker/parlaypal_worker/celery_app.py` -- Implement Pydantic payload models (enforcing Decimal odds $\ge 1.01$ and ISO 8601 UTC timestamps), 45-second TTL Redis cache writer, `odds:feed:{sport_key}` Pub/Sub publisher, and Celery worker app -- Connects the worker service to Redis 7.2 for hot caching and task execution.
- [x] `services/worker/tests/test_substrate.py` -- Write pytest tests covering `teams`, `events`, `player_props`, and `user_bets` DDL creation, decimal odds validation, 45s TTL cache writes, and Pub/Sub publishing -- Verifies all worker I/O and edge-case matrix rows.
- [x] `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`, `apps/web/postcss.config.mjs`, `apps/web/src/app/globals.css`, `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx` -- Scaffold Next.js 15 App Router with TypeScript and Tailwind CSS 4 dark-mode design tokens and typography -- Establishes the web presentation substrate.
- [x] `apps/web/src/lib/errors.ts`, `apps/web/src/lib/redis.ts`, `apps/web/src/app/api/stream/odds/route.ts`, `apps/web/src/app/api/stream/odds/route.test.ts` -- Implement Redis subscriber helper, standardized Problem Details builder, `/api/stream/odds` SSE route handler, and route unit tests -- Enables unidirectional HTTP/2 SSE streaming from Redis Pub/Sub (AD-3).

**Acceptance Criteria:**
- Given a greenfield workspace, when `apps/web` is built and tested, then Next.js 15 App Router compiles cleanly with Tailwind CSS 4 tokens and `/api/stream/odds` streams SSE frames from `odds:feed:<sport_key>` or returns standardized Problem Details on error.
- Given the Python 3.13 worker service in `services/worker`, when `init_db()` runs, then `teams`, `events`, `player_props`, and `user_bets` tables and indexes are created with UUID v4 keys, `external_provider_id` constraints, `NUMERIC(8,4)` decimal odds columns, and `TIMESTAMPTZ` timestamps.
- Given a market odds payload in `services/worker`, when cached and broadcast via `redis_client`, then `odds:latest:{sport_key}:{event_id}` is stored with a 45-second TTL and published to `odds:feed:{sport_key}`.

## Implementation Notes

- Added platform environment marker on `psycopg[binary]>=3.1.0` alongside `psycopg>=3.1.0` in `services/worker/pyproject.toml` so `uv` resolves cleanly on Windows ARM64 (`win_arm64`) as well as x86_64/Linux/macOS platforms.
- Used ANSI SQL `ESCAPE '\'` in `external_provider_id LIKE '%\_%' ESCAPE '\'` check constraints so literal underscores are enforced in both PostgreSQL 16 and SQLite test databases.
- Added `apps/web/vitest.config.ts` to map `@/*` to `./src/*` during Vitest execution.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Evidence |
|---------|---------|----------|
| ECH-1: `services/worker/parlaypal_worker/db.py:64-65` — `create_db_engine(database_url)` called outside `try` block in `init_db` | `medium` | Verified at `db.py:64`: calling `create_db_engine` before `try:` allows `ArgumentError` (a `SQLAlchemyError` subclass) on malformed URLs to escape `init_db` instead of raising `DatabaseInitializationError`. Routed to `patch`. |
| ECH-2: `services/worker/parlaypal_worker/models.py:36-39` — `external_provider_id LIKE '%\_%'` allows leading/trailing underscores | `low` | Verified at `models.py:36,81,161,263`: SQL `%` matches zero characters, so `'_ab'`, `'ab_'`, and `'___'` satisfy the check constraint unlike `_validate_provider_prefix`. Routed to `patch`. |
| ECH-3: `services/worker/parlaypal_worker/redis_client.py:78-96` — `decimal_odds` and `line_value` allow `NaN`/`Infinity` or overflow | `medium` | Verified at `redis_client.py:79,106`: `Field(..., ge=MIN_DECIMAL_ODDS)` without `allow_inf_nan=False` and `le=Decimal("9999.9999")` lets `Decimal("Infinity")` pass validation and fail in `.quantize()`. Routed to `patch`. |
| ECH-4: `services/worker/parlaypal_worker/redis_client.py:161-194` — `cache_ev_feed` and `cache_sgp_audit` call `json.dumps` without `default=str` | `medium` | Verified at `redis_client.py:175,192`: passing `Decimal`, `UUID`, or `datetime` values inside `feed_items` or `audit_data` raises `TypeError` in `json.dumps(envelope)`. Routed to `patch`. |
| ECH-5: `services/worker/parlaypal_worker/celery_app.py:46-49` — `ingest_odds_delta` does not close the Redis client after publishing | `medium` | Verified at `celery_app.py:48-49`: `get_redis_client()` creates a client instance that is never closed in a `finally` block. Routed to `patch`. |
| ECH-6: `apps/web/src/app/api/stream/odds/route.ts:30-32` — SSE route does not close stream on Redis `end` or `close` events | `medium` | Verified at `route.ts:30-32,93-122`: if the Redis connection drops mid-stream, `cleanup(controller)` is not triggered, leaving the HTTP stream hanging open. Routed to `patch`. |
| ECH-7: `apps/web/src/app/api/stream/odds/route.ts:72-75` — `subscriber.removeAllListeners()` called before `await subscriber.quit()` | `medium` | Verified at `route.ts:73-74`: removing the `"error"` listener before `await subscriber.quit()` settles can cause an unhandled EventEmitter error if the socket errors during quit. Routed to `patch`. |
| ECH-8: `apps/web/src/app/api/stream/odds/route.ts:58-90` — `cleanup` awaits Redis teardown before closing `ReadableStream` controller | `low` | Verified at `route.ts:66-89`: `controller.close()` runs only after `unsubscribe()` and `quit()` finish instead of closing the HTTP stream immediately. Routed to `patch`. |
| ECH-9: `apps/web/src/app/api/stream/odds/route.ts:104-109` — `controller.enqueue` not wrapped in `try/catch` and newlines in message not sanitized | `low` | Verified at `route.ts:104-109`: multi-line messages or concurrent stream closure during `controller.enqueue` can corrupt SSE framing or throw. Routed to `patch`. |
| BH-1: `services/worker/parlaypal_worker/models.py` — Weak `external_provider_id` SQL `CheckConstraint` | `low` | Verified at `models.py:36,81,161,263`: same root cause as ECH-2 (`LIKE '%\_%'` vs `LIKE '_%\_%_'`). Routed to `patch`. |
| BH-2: `services/worker/parlaypal_worker/redis_client.py` — `sport_key` not validated against `SUPPORTED_SPORT_KEYS` | `low` | Verified at `redis_client.py:115-121,161`: `OddsDeltaFrame.check_sport_key` and `cache_ev_feed` allow arbitrary strings not in `SUPPORTED_SPORT_KEYS`. Routed to `patch`. |
| BH-3: `services/worker/parlaypal_worker/redis_client.py:104` — `OddsDeltaFrame.external_provider_id` defaults to `"papi_evt_default"` | `low` | Verified at `redis_client.py:104`: omitting `external_provider_id` silently substitutes `"papi_evt_default"` instead of raising `ValidationError`. Routed to `patch`. |
| BH-4: `services/worker/parlaypal_worker/redis_client.py` — Unbounded/non-finite `Decimal` odds in Pydantic models | `medium` | Verified at `redis_client.py:79,106`: same root cause as ECH-3 (`allow_inf_nan=False, le=Decimal("9999.9999")`). Routed to `patch`. |
| BH-5: `services/worker/parlaypal_worker/redis_client.py` — Non-JSON-serializable types in `cache_ev_feed` and `cache_sgp_audit` | `medium` | Verified at `redis_client.py:175,192`: same root cause as ECH-4 (`json.dumps(..., default=str)`). Routed to `patch`. |
| BH-6: `services/worker/parlaypal_worker/celery_app.py` — Redis client leak per task call and missing `ingest_odds_delta` test | `medium` | Verified at `celery_app.py:46-49`: same root cause as ECH-5 and VG-1. Routed to `patch`. |
| BH-7: `services/worker/parlaypal_worker/models.py` — Missing `home_team_id != away_team_id` check on `Event` and CLV columns on `UserBet` | `low` | Verified at `models.py:72,245`: adding `ck_events_distinct_teams` on `Event` and `closing_fair_prob` / `clv_percentage` on `UserBet` aligns the ORM with `ARCHITECTURE-SPINE.md`. Routed to `patch`. |
| BH-8: `services/worker/parlaypal_worker/db.py` — Engine leak and unhandled `ArgumentError` in `init_db()` | `medium` | Verified at `db.py:64-69`: same root cause as ECH-1; moving `create_db_engine` inside `try:` and disposing created engine on failure fixes both. Routed to `patch`. |
| BH-9: `services/worker/tests/test_substrate.py` — SQLite `PRAGMA foreign_keys=ON` not enabled in in-memory test | `low` | Verified at `test_substrate.py:114`: SQLite disables FK enforcement by default, while PostgreSQL 16 DDL compilation is already tested; rejected per low-finding rule as adding SQLite connection hooks adds test-only complexity for a non-production dialect. |
| BH-10: `apps/web/src/app/layout.tsx` — Google Fonts referenced via CSS variables rather than `next/font/google` network fetch | `false` | Refuted: `next/font/google` fetches font manifests over HTTPS from `fonts.googleapis.com` during `next build`, which fails in network-isolated sandboxed builds; CSS font variables are required for offline-reproducible builds. |
| BH-11: `apps/web/src/app/api/stream/odds/route.ts` — SSE stream zombie state on mid-stream Redis disconnect and unguarded `controller.enqueue` | `medium` | Verified at `route.ts:30-32,104-109`: same root cause as ECH-6 and ECH-9. Routed to `patch`. |
| BH-12: `apps/web/src/lib/redis.ts` — Missing non-subscriber Redis KV reader client in `apps/web` | `false` | Refuted: Story 1.1 scopes `apps/web` Redis usage to `/api/stream/odds` Pub/Sub SSE streaming and key helpers; preset feed KV reads belong to Story 1.4. |
| BH-13: `services/worker/pyproject.toml` and `apps/web/package.json` — `pytest` in project dependencies and `"test": "vitest"` script | `false` | Refuted: `pytest` in dependencies ensures `uv run --directory services/worker pytest` works out of the box, and `npm --prefix apps/web test -- --run` matches the spec's verification command. |
| VG-1: `services/worker/parlaypal_worker/celery_app.py:45-49` — Unverified `ingest_odds_delta` Celery task and `get_redis_client` wiring | `medium` | Pre-verified by verification-gap layer: no test in `test_substrate.py` imports or calls `ingest_odds_delta`. Routed to `patch`. |
| VG-2: `services/worker/parlaypal_worker/redis_client.py:59-121` — Unverified `external_provider_id` prefix and `sport_key` validation in Pydantic models | `medium` | Pre-verified by verification-gap layer: `test_substrate.py` only tests `decimal_odds < 1.01` on `publish_odds_delta`, not invalid `external_provider_id` or `sport_key`. Routed to `patch`. |
| VG-3: `services/worker/parlaypal_worker/db.py:46-65` — Unverified `create_db_engine` and `engine=None` branch in `init_db` and `create_session_factory` | `medium` | Pre-verified by verification-gap layer: all DB tests pass an explicit `engine=engine`, leaving `engine=None` and `create_db_engine(database_url)` unexercised. Routed to `patch`. |

## Verification

**Commands:**
- `uv run --directory services/worker pytest` -- expected: All Python worker schema, validation, and Redis substrate tests pass with exit code 0.
- `npm --prefix apps/web test -- --run` -- expected: All Next.js SSE route and utility unit tests pass with exit code 0.
- `npm --prefix apps/web run build` -- expected: Next.js 15 production build and TypeScript check succeed with exit code 0.
