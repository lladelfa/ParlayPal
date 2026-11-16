---
title: 'Story 6.5: Game-Log Ingestion for Upstream (Non-Seed) Players'
type: 'feature'
created: '2026-11-16'
status: 'done'
baseline_commit: 'cc4c53b3c4e5fa6af6a9a0f3572efc45c3c9cdfd'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Hit rates and recent outcomes exist only for seeded demo players, whose logs are hardcoded in `build_local_seed_slate`. Props for real upstream players have `hit_rate_*` and `recent_outcomes` NULL, so every live preset leg shows "Limited history" (Story 6.1).

**Approach:** In the upstream branch of the live sync, fetch each prop's player recent game logs through a worker-only provider function, cache them in Redis across 30s cycles under a per-cycle fetch budget, and feed them into the existing `IngestedGameLog` / `compute_rolling_hit_rate` / `update_props_hit_rates` path so rates and outcomes are written exactly as Stories 6.2-6.3 define.

## Boundaries & Constraints

**Always:**
- Logs are keyed `(player_name, market_key)`, most recent first, as `Decimal` stats. Rates and `recent_outcomes` come only from `compute_rolling_hit_rate` (no second comparison rule).
- Fewer than 5 games, a failed or malformed lookup, or an exhausted budget leaves rates and outcomes NULL (never `[]`, never defaults) and never raises into the beat loop.
- Provider-supplied rates still win; only NULL fields are filled.
- The seed path stays offline and deterministic and never calls the provider. `apps/web` never calls the provider.
- Calls are cached (Redis, `gamelog:{sport}:{player}:{market}`, positive TTL 6h, negative TTL 15min), capped per cycle (default 20, a named setting), and use the existing 10s HTTP timeout. Feed TTL stays `EX=45`; beat stays 30s.

**Decisions (confirmed by human):**
- Source: parlay-api has no player game-log/box-score endpoint (checked its docs/homepage; it is odds-only). Build a provider-agnostic fetcher interface whose base URL, path template and response mapping come from config. It is disabled when unconfigured, so rates stay NULL and nothing is fetched. Choosing and wiring a real stats source is deferred (`deferred-work.md`).
- `player_anytime_td` props are skipped (no fetch, stay "Limited history") until a better approach exists.

**Never:** new DB columns; changes to preset/market-browser rendering, rationale wording (6.4) or dedup (6.6); inventing a provider endpoint path.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected |
|---|---|---|
| Happy path | upstream prop, provider returns 12 games | l5/l10/season and outcomes set; leg shows `N/M` label and dots |
| Short history | 4 games | rates and outcomes stay NULL; "Limited history" |
| Lookup failure | timeout / 5xx / bad JSON | NULL, negative-cached 15min, cycle completes |
| Cache hit | log cached | no provider call |
| Budget exhausted | more uncached players than the cap | the rest NULL this cycle, fetched on later cycles |
| Under prop | selection UNDER | outcomes use the Under rule (6.2) |
| Seed slate | seed path | provider never called |
| Source unconfigured | no game-log source settings | no calls, all NULL, no errors |
| Anytime-TD | `player_anytime_td` prop | skipped, NULL |
| Provider rates present | upstream already sends rates | not overwritten |

</frozen-after-approval>

## Code Map

- `services/worker/parlaypal_worker/ingestion.py` -- `IngestedGameLog` (:301), `to_player_game_logs` (:324), `fetch_upstream_slate` (:1209, only provider code, sync `httpx.Client`, Bearer auth), `upsert_slate_to_db` (:1855; rates at :2054-2075, NULL backfill :2165-2218), `run_live_slate_sync` (:2279, upstream branch ~:2318 is the hook). Add the game-log fetcher + cache + budget here or in a new `game_logs.py`.
- `services/worker/parlaypal_worker/hit_rate.py` -- `compute_rolling_hit_rate` (:149), `update_props_hit_rates` (:240): reuse unchanged.
- `services/worker/parlaypal_worker/config.py:17-32` -- `WorkerSettings`: add budget/TTL/path settings.
- `services/worker/parlaypal_worker/redis_client.py` -- `RedisLike` only has `set(ex)`, `get`, `publish`; no `nx`/`incr`.
- `services/worker/tests/test_ingestion.py` -- `FakeRedisClient` (:51), `db_session` (:79), `httpx.MockTransport` helpers (:93, :585-645), 6.3 outcome tests (:2225-2450).
- Do not touch: `build_local_seed_slate` logs (:1761), `presets.py`, `market_browser.py`, `apps/web`.

## Tasks & Acceptance

**Execution (TDD per `AGENTS.md`):**
- [x] `tests/test_game_logs.py` (+ `test_ingestion.py`) -- red tests, one per matrix row.
- [x] `config.py` -- budget, TTL and endpoint settings.
- [x] fetcher/cache module -- fetch, parse to `Decimal`, positive/negative cache, per-cycle budget, never raises.
- [x] `ingestion.py` -- wire into the upstream branch before upsert; seed branch untouched.
- [x] Matrix audit and all verification commands.

**Acceptance Criteria:**
- Given an upstream prop with at least 5 fetched games, when the live sync runs, then `hit_rate_l5/l10/season` and `recent_outcomes` are populated via `compute_rolling_hit_rate`.
- Given a failed lookup or fewer than 5 games, then fields stay NULL and the beat cycle still completes.
- Given a warm cache, then no second provider call occurs within the TTL.

## Implementation Notes

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Route | Evidence |
|---|---|---|---|
| Per-request timeout can overrun the 12s cycle deadline / 25s beat expiry; injected client may have a longer timeout | medium | patch | Fixed: `timeout=min(10, remaining)` passed per request; asserted in `test_request_url_is_percent_encoded_and_bearer_header_sent`. |
| Failures all alike; dead provider burns budget and wall-clock every cycle; starvation of later players | medium | patch | Fixed: stop provider calls after 3 consecutive failures per cycle (`test_consecutive_failures_stop_provider_calls_for_the_cycle`). |
| TTL of 0 or less makes Redis reject `SET` and caching silently never works | low | patch | Fixed: `ex=max(1, ttl)` (`test_non_positive_ttl_still_caches_with_valid_expiry`). |
| Template `{player.x}` raises AttributeError/TypeError, surfacing as an "unexpected" error | low | patch | Fixed: caught in the template guard; `test_invalid_path_template_is_negative_cached_not_raised`. |
| Empty/whitespace player name wastes budget | low | patch | Fixed: skipped; `test_duplicate_targets_cost_one_call_and_empty_names_are_skipped`. |
| No cycle summary log; budget-deferred targets invisible | low | patch | Fixed: one info line with fetched/failed/deferred/resolved counts. |
| Untested: URL encoding, Bearer header, invalid template, duplicate targets, existing-log precedence, `line_value is None`, corrupt cache | medium | patch | Fixed: tests added for each in `tests/test_game_logs.py`. |
| Results keyed without `sport_key` (cross-sport same-name collision) | false | rejected | Key is `(player, market)` per spec; canonical markets are sport-specific (`player_pass_yds`/`player_points`), so the same market never appears in two sports. |
| Cache key uses raw player name / `:` ambiguity / no config fingerprint (stale for up to 6h after stat-field or ordering change) | low | rejected | Key format fixed by spec; effect is an extra call or stale data until TTL after an operator config change; fix adds complexity. |
| One null/non-numeric stat (e.g. DNP) discards the whole log | low | rejected | Matches spec ("malformed lookups remain NULL"); how to treat DNPs depends on the real source, which is deferred. |
| No list-length cap, date/season filtering, response-path indices, non-Bearer auth, `1_0` strings accepted by `Decimal` | low | rejected | Depend on the provider's actual schema, which is not chosen yet (deferred source item); no real source can hit them today. |
| Provider name spelling differs from prop name (suffixes, accents) | false | rejected | No provider exists; matching rules belong to the deferred source wiring. |
| Corrupt non-list cache entry "silently refetched every cycle" | false | rejected | `_read_cache` returns a miss, the lookup refetches, and the fresh write overwrites the entry; verified by `test_corrupt_cache_entry_is_refetched`. |
| `configured_source` fixture patches the shared settings singleton | false | rejected | Tests assert populated rates, so an unconfigured run fails loudly rather than passing vacuously. |
| Claim "provider rates still win" unverified in diff | false | rejected | Unchanged upsert path; covered by existing `test_recent_outcomes_stored_when_provider_supplies_all_rates`. |
| New env vars and `gamelog:*` keys undocumented | low | rejected | Disabled-by-default settings with inline comments in `config.py`; no env docs exist for sibling settings in the diff scope. |

## Verification

**Commands:**
- `uv run --directory services/worker ruff check parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker ruff format --check parlaypal_worker tests` -- expected: formatted
- `uv run --directory services/worker mypy parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker pytest -v` -- expected: all pass
