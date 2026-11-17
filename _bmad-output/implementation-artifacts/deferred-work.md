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


- source_spec: `_bmad-output/implementation-artifacts/spec-4-2-asynchronous-closing-line-value-clv-worker.md`
  summary: Share a module-level SQLAlchemy Engine/sessionmaker across Celery task invocations instead of calling `create_session_factory()` per task run.
  evidence: In `services/worker/parlaypal_worker/celery_app.py`, `create_session_factory()()` creates a new SQLAlchemy `Engine` connection pool when `session=None`, which for a 60-second Beat task (`stamp_closing_line_value`) can accumulate idle pooled connections unless a shared engine or `dispose()` is used.

- source_spec: `_bmad-output/implementation-artifacts/spec-4-3-clv-analytics-long-term-edge-reporting.md`
  summary: Preserve newer local bet settlement and simulated CLV fields during mount reconciliation in `BetTrackerDashboard` when the server ledger still holds stale `pending` data (pre-existing Story 4.1 reconciliation effect).
  evidence: In `apps/web/src/components/BetTrackerDashboard.tsx:185-203`, the mount `useEffect` merges server bets by `id` favoring the server record (`mergeById`), so if a local settlement `PATCH` failed or settled offline while `localStorage` recorded `won`/`lost` and simulated CLV, remounting overwrites the local state with the server's stale `pending` state.

- source_spec: `c:\Users\llade\Documents\GitHub\ParlayPal\_bmad-output\implementation-artifacts\spec-5-1-automated-upstream-schedule-prop-ingestion-beat-orchestration.md`
  summary: Update pre-existing `PresetFeed` SSE listener in `apps/web` to handle unnamed default `onmessage` `OddsDeltaFrame` payloads (`quotes` array) emitted by `/api/stream/odds`.
  evidence: `git log -n 2` (`97adb43`, `9a5a054`) confirms `apps/web/src/components/PresetFeed.tsx:45-59` is pre-existing and only subscribes to named `"odds_delta"` events expecting top-level camelCase `propId`/`decimalOdds`, whereas `/api/stream/odds/route.ts:126` emits unnamed `data:` frames carrying snake_case `quotes` (already handled in `MarketBrowser.tsx` and `ParlayDrawerContext.tsx`); `spec-5-1` prohibits modifying `apps/web`.

- source_spec: `_bmad-output/implementation-artifacts/spec-6-1-remove-fabricated-hit-rate-fallback-honest-consistency-badge.md`
  summary: Add render tests for the "Limited history" badge in LegSwapperModal, MarketBrowser and ParlayDrawer.
  evidence: Only PresetCard has a render test; reverting the `?? "Limited history"` fallback in the others passes all tests.
- source_spec: `_bmad-output/implementation-artifacts/spec-6-1-remove-fabricated-hit-rate-fallback-honest-consistency-badge.md`
  summary: Purge or version-gate the 24h presets Redis snapshot after deploying 6.1 so pre-fix fabricated hit rates are not served.
  evidence: `sync_preset_feed_to_redis` snapshot fallback persists feeds written before this fix.
- source_spec: `_bmad-output/implementation-artifacts/spec-6-1-remove-fabricated-hit-rate-fallback-honest-consistency-badge.md`
  summary: Mark web fallback fixture feeds as sample data in the UI and recompute fixture card-level scores.
  evidence: Fixtures keep real-looking odds/EV and card hybridValueScore values derived from the old 70-80% hit rates.

- source_spec: `_bmad-output/implementation-artifacts/spec-6-2-selection-aware-hit-rate-for-under-legs.md`
  summary: Recompute persisted hit rates written under the old push-as-miss logic (backfill only fills NULL columns).
  evidence: `ingestion.py` backfill skips non-None rates, so existing `player_props` rows keep stale values until their rates are cleared.
- source_spec: `_bmad-output/implementation-artifacts/spec-6-2-selection-aware-hit-rate-for-under-legs.md`
  summary: Carry real hits/total into the preset and market-browser display instead of deriving N/10 from the rate.
  evidence: `round(rate*10)` over a push-shrunk denominator can show an N/10 that was never an actual count.
- source_spec: `_bmad-output/implementation-artifacts/spec-6-2-selection-aware-hit-rate-for-under-legs.md`
  summary: Classify anytime-TD by exact market (not `"td"` substring) so pass-TD Unders get under-direction copy.
  evidence: `generate_conviction_rationale` uses `"td" in market_key`, so `player_pass_tds` UNDER gets "has scored a touchdown" copy.

- source_spec: `_bmad-output/implementation-artifacts/spec-6-3-real-recent-form-dots-from-game-logs.md`
  summary: Add a Postgres-backed (or mocked-connection) test for the `ALTER TABLE player_props ADD COLUMN IF NOT EXISTS recent_outcomes` upgrade in `init_db`.
  evidence: Tests run on SQLite where the ALTER is skipped; breaking the Postgres branch would fail every PlayerProp query on existing databases without any test noticing.

- source_spec: `_bmad-output/implementation-artifacts/spec-6-4-evidence-based-conviction-rationale.md`
  summary: Make Under anytime-TD (a "No TD" bet) read in the under direction instead of "scored in {hit}".
  evidence: Selection tokens `no` normalize to UNDER and the hit rate is computed with the Under rule, but frozen 6.4 copy keeps TD Over-style for any selection, so the sentence can contradict the label.
- source_spec: `_bmad-output/implementation-artifacts/spec-6-4-evidence-based-conviction-rationale.md`
  summary: Stop defaulting a missing `guarded_ev` to `Decimal("0.0200")` on the persisted `PresetLeg`.
  evidence: `presets.py` sets `guarded_ev=prop.guarded_ev or Decimal("0.0200")`, a fabricated EV that feeds the preset score and display (the rationale already avoids it).
- source_spec: `_bmad-output/implementation-artifacts/spec-6-5-game-log-ingestion-for-upstream-players.md`
  summary: RESOLVED by story 6-7 (MoneyLine adapter): Choose and wire a real player game-log source (parlay-api is odds-only), then enable the 6.5 fetcher; decide how to handle `player_anytime_td` history.
  evidence: parlay-api.com docs list no game-log, box-score or results endpoint; 6.5 ships a config-driven, disabled-by-default fetcher so live upstream props stay "Limited history" until a source is configured.
