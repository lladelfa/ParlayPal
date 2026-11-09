# Deferred Work

This file tracks technical debt, edge cases, and architectural watch-items identified during development, reviews, and walkthroughs.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-project-ingestion-data-substrate-setup.md`
  summary: Validate relational FK cascading constraints and archive behavior when events or teams are canceled or settled.
  evidence: In `services/worker/parlaypal_worker/models.py`, `events` has `RESTRICT` on teams, while `player_props` cascades on events and sets null on teams. Need to ensure settlement workers in Story 4.1 handle canceled/voided events cleanly without violating referential integrity.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-project-ingestion-data-substrate-setup.md`
  summary: Implement periodic SSE heartbeat comments and client-side reconnect backoff for live odds streaming.
  evidence: In `apps/web/src/app/api/stream/odds/route.ts`, long-running SSE connections behind corporate proxies or cloud load balancers may time out without `: keep-alive\n\n` heartbeat comments. Needs validation and client test in Story 1.4.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-project-ingestion-data-substrate-setup.md`
  summary: Define fallback behavior for 45-second TTL cache misses when assembling curated preset parlay cards.
  evidence: In `services/worker/parlaypal_worker/redis_client.py`, hot odds expire strictly at 45 seconds (`EX=45`). Downstream consumer in Story 1.4 needs to handle expired or cold keys gracefully without crashing feed rendering.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-project-ingestion-data-substrate-setup.md`
  summary: Migrate Celery tasks to a shared Redis connection pool for high-throughput ingestion.
  evidence: In `services/worker/parlaypal_worker/celery_app.py`, tasks instantiate and close Redis connections per invocation. While clean, high-frequency ingestion loops in Story 1.2 and 1.3 should leverage a connection pool to minimize socket churn.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-project-ingestion-data-substrate-setup.md`
  summary: Audit database connection pool disposal and pool pre-ping under multi-worker concurrency.
  evidence: In `services/worker/parlaypal_worker/db.py`, `init_db()` constructs an engine and disposes it on error. Multi-process worker deployments running Celery prefork pools will need verification of engine session lifecycles across process forks.
