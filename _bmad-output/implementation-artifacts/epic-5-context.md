# Epic 5 Context: Live Schedule & Prop Ingestion Pipeline

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Ensure bettors and local developers always see continuously updated, current NFL and NBA game slates and player prop markets rather than static UI fallback fixtures. This epic closes the missing upstream ingestion loop by polling live NFL/NBA schedules, teams, and two-way player prop markets (with a deterministic local seed fallback when offline or unconfigured), upserting them into PostgreSQL 16, transitioning commenced games out of pre-match feeds, and orchestrating a 30-second Celery Beat refresh cycle so the 45-second Redis hot caches (`markets:browser:*`, `presets:feed:*`, `ev:feed:*`) and SSE stream remain continuously warm.

## Stories

- Story 5.1: Automated Upstream Schedule, Prop Ingestion & Beat Orchestration

## Requirements & Constraints

- **Upstream Schedule & Prop Polling:** Periodically query upcoming NFL (`americanfootball_nfl`) and NBA (`basketball_nba`) events, team metadata, and two-way player prop quotes from the configured provider (`PARLAY_API_BASE_URL` / `PARLAY_API_KEY`) using `httpx` inside `services/worker`.
- **Deterministic Local Seed Fallback:** When `PARLAY_API_KEY` is missing/placeholder or the upstream provider is unreachable or returns an empty local slate, populate and refresh a realistic multi-sport local slate with `commence_time` anchored dynamically to `datetime.now(UTC)` (covering `today`, `tomorrow`, and `weekend` windows) so local verification works end-to-end without reverting to `apps/web` hardcoded fallback arrays.
- **PostgreSQL Upsert & Commenced Transition:** Idempotently upsert `teams`, `events` (by `external_provider_id` with explicit provider prefix), and `player_props` in PostgreSQL 16; automatically transition any pre-match event whose `commence_time <= now_utc` from `SCHEDULED` to `COMMENCED` so stale games drop out of pre-match feeds.
- **30-Second Celery Beat Orchestration:** Register periodic Beat tasks in `celery_app.conf.beat_schedule` running every 30 seconds (strictly under the 45-second Redis TTL invariant) to execute ingestion → devigging → `sync_preset_parlay_feed` → `sync_market_browser_feed`, and broadcast live odds deltas over `odds:feed:{sport_key}`.

## Technical Decisions

- **Polyglot Service Isolation (AD-1):** All external `parlay-api.com` HTTP requests, schedule/odds polling, and quantitative devigging remain strictly isolated in `services/worker`. `apps/web` continues reading exclusively from Redis 7.2 and PostgreSQL 16 without calling upstream providers directly.
- **Storage Partitioning & Ephemeral Cache (AD-2):** PostgreSQL 16 remains the durable store for `teams`, `events`, and `player_props`; Redis 7.2 caches `markets:browser:{sport}`, `presets:feed:{sport}`, `ev:feed:{sport_key}`, and `odds:latest:{sport_key}:{event_id}` with strict `EX=45`, kept continuously warm by the 30-second Celery Beat cadence.
- **Devigging & Outlier Guard Invariants (AD-4):** Every ingested two-way prop market routes through `process_and_publish_ev_props` (Multiplicative + Brent Power root solver) and enforces the $\text{EV}_{\text{guarded}} > 10.0\%$ (`SUSPECT_STALE_LINE`) circuit breaker before any feed sync runs.
- **Consistent Identifiers & Timestamps:** Preserve UUID v4 primary keys, explicit provider prefixes (`papi_...` or `seed_...`) in `external_provider_id`, `Decimal` odds ($D \ge 1.01$), and ISO 8601 UTC timestamps (`TIMESTAMPTZ` / `YYYY-MM-DDTHH:mm:ssZ`).

## UX & Interaction Patterns

- **Seamless Live Terminal Updates:** Keep the `apps/web` Curated Presets (`PresetFeed`) and Schedule & Market Browser (`MarketBrowser`) populated from Redis rather than `FALLBACK_PRESET_FEED` or `FALLBACK_MARKET_BROWSER_FEED`, ensuring the header game counts, matchup pills, and prop rows reflect real database/API schedules and live SSE ticks (`odds:feed:{sport_key}`).

## Cross-Story Dependencies

- **Story 1.1 → Story 5.1:** Consumes the PostgreSQL 16 ORM models (`Team`, `Event`, `PlayerProp`), `redis_client` 45s TTL / Pub/Sub helpers, and `celery_app` configuration.
- **Stories 1.2 & 1.3 → Story 5.1:** Feeds ingested two-way prop odds, rolling box-score hit rates, and stadium weather telemetry through `process_and_publish_ev_props`, `update_props_hit_rates`, and `ingest_events_weather`.
- **Stories 1.4 & 2.1 → Story 5.1:** Invokes `sync_preset_parlay_feed` and `sync_market_browser_feed` on the 30-second Beat loop so both UI surfaces render synchronized, non-expired games and props.
