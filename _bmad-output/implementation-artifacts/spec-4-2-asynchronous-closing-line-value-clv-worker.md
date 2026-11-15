---
title: 'Story 4.2: Asynchronous Closing Line Value (CLV) Worker'
type: 'feature'
created: '2026-11-10'
status: 'done'
baseline_commit: '206a263681fc646f91ee5dd1ecff57ae53328ec5'
route: 'dispatch'
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Pending bets persisted by Story 4.1 never receive a closing-line benchmark, so bettors cannot tell whether they beat the closing market.

**Approach:** Add a Celery task in `services/worker` that, 10 minutes after an event's `commence_time`, fetches sharp closing odds from `GET /v1/historical/sports/{sport_key}/closing-odds?event_id={event_id}`, devigs them with the Power method (`devig_power`), computes `CLV% = (P_fair_close × D_exec) − 1`, and stamps `closing_decimal_odds`, `closing_fair_prob`, `clv_percentage` onto the `user_bets` row.

## Boundaries & Constraints

**Always:** All odds math in `Decimal` (1.01 ≤ D ≤ 9999.9999); quantize `closing_fair_prob` to 5 dp, `clv_percentage` to 3 dp (Numeric(6,3)); timestamps ISO 8601 UTC; only `PENDING`/`pending` bets are processed; stamping is idempotent (skip bets whose `clv_percentage` is already set); provider IDs keep the `papi_` prefix; the worker owns all `parlay-api.com` calls.

**Decisions (human-approved):** (1) Multi-leg tickets: `P_fair_close` = product of per-leg devigged fair closing probabilities, compared against the ticket's combined `D_exec`; a ticket is stamped only if every leg resolves (SGP independence is an accepted approximation). (2) Trigger: Celery beat 1-minute sweep selecting due pending bets. (3) Closing-odds payload assumed as `{event_id, bookmakers:[{key, markets:[{outcomes:[{name, price}]}]}]}`, Pinnacle-first sharp book, with all parsing isolated in a single function. (4) Outlier guard: skip (log `SUSPECT_STALE_LINE`, leave unstamped) only when CLV is positive and above +10%; all negative CLV values, however large, are stamped. (5) `clv_percentage` is stored in percent points (+5% → `5.000`, i.e. `((P×D)−1)×100`, 3 dp; `Numeric(6,3)` bound ±999.999); `closing_fair_prob` stays a 0–1 probability.

**Never:** Change bet status or settle bets (CLV stamping only); touch `apps/web`; call the provider from Next.js; stamp positive CLV above +10% (suspect closing line); swallow provider errors silently.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path | Pending bet, event commenced ≥10 min ago, valid two-way closing odds | Stamps closing odds, fair prob, CLV% | N/A |
| Too early | `now < commence_time + 10 min` | Bet skipped, left untouched | N/A |
| Already stamped | `clv_percentage` not null | Skipped, no provider call | N/A |
| Non-pending | Status staged/settled | Skipped | N/A |
| Provider failure | HTTP 5xx / timeout / 429 | No stamp; Celery retry with backoff (max 3) | Log + raise after retries |
| Malformed odds | Missing side, odds < 1.01, NaN | No stamp for that bet | Log `INVALID_MARKET_ODDS`, continue batch |
| Negative CLV | P_fair_close × D_exec < 1 (including below −10%) | Stamps negative CLV (percent points) | N/A |
| Suspect positive | CLV > +10% | Not stamped, `SUSPECT_STALE_LINE` logged | Skip, continue batch |

</frozen-after-approval>

## Code Map

- `services/worker/parlaypal_worker/devig.py` -- reuse `devig_power(odds1, odds2)`, `_validate_decimal_odds`, `DeviggingError`; do not modify.
- `services/worker/parlaypal_worker/bets.py` -- `list_user_bets`, `settle_user_bet` (stamping fields), `InvalidBetError`; add a `stamp_bet_clv` helper that does not change status.
- `services/worker/parlaypal_worker/models.py` -- `UserBet` already has `closing_decimal_odds`, `closing_fair_prob`, `clv_percentage`, `event_id` → `Event.commence_time`/`sport_key`/`external_provider_id`; no schema change expected.
- `services/worker/parlaypal_worker/celery_app.py` -- register new task `parlaypal_worker.stamp_closing_line_value` and beat schedule; follow existing task patterns.
- `services/worker/parlaypal_worker/config.py` -- `parlay_api_key`, `parlay_api_base_url` (httpx already a dependency).
- `services/worker/parlaypal_worker/clv.py` -- NEW: provider client, payload parsing, CLV math, batch orchestration.
- `services/worker/tests/test_clv.py` -- NEW: matrix tests (httpx mocked, SQLite in-memory fixture as in `test_bets.py`).

## Tasks & Acceptance

**Execution:**
- [x] `services/worker/tests/test_clv.py` -- write failing tests for every matrix row (red phase) -- TDD per AGENTS.md
- [x] `services/worker/parlaypal_worker/clv.py` -- implement `calculate_clv`, closing-odds fetch/parse, `stamp_due_bets(session, now)` -- core feature
- [x] `services/worker/parlaypal_worker/bets.py` -- add `stamp_bet_clv` (no status change, validates bounds) -- persistence
- [x] `services/worker/parlaypal_worker/celery_app.py` -- register task + 1-minute beat sweep with retry/backoff -- scheduling

**Acceptance Criteria:**
- Given a pending bet 10+ minutes past commence with valid closing odds, when the task runs, then `clv_percentage = (P_fair_close × D_exec) − 1` is stamped (3 dp) alongside `closing_fair_prob` and `closing_decimal_odds`.
- Given the task runs twice, then the second run makes no provider calls for already-stamped bets.

## Implementation Notes

## Spec Change Log

- **Iteration 1 (review loopback, intent_gap):** Triggered by IG-1/IG-2 (symmetric `abs(clv)` guard skipped large negative CLV; fraction vs percent storage). Frozen block amended by human: positive-only +10% guard; percent-point storage. Known-bad state avoided: bad bets (< −10% CLV) silently never stamped and re-fetched every minute; 4.3 reading fractions as percents.
  - **KEEP / apply on re-derivation** (reference implementation at `scratch/story42-backup` in the brain dir): `clv.py` structure (`calculate_clv`, `fetch_closing_odds`, `parse_closing_leg_prices`, `compute_bet_closing`, `stamp_due_bets`), `stamp_bet_clv` in `bets.py`, Celery task + 60s beat. Harden per review: catch `DeviggingError`, `ArithmeticError`, `AttributeError`, `TypeError`, `ValueError`, `InvalidBetError`, `BetNotFoundError` per bet (log, count, continue; rollback session on stamp failure); skip events with null `commence_time`/`external_provider_id`; fail fast without retry on missing API key and non-429 4xx; verify payload `event_id` matches when present; require leg `line` and outcome `point` both present or both absent, and require market `key` equality when leg has `marketKey`; cap sweep to events within 7 days of commence; add tests for multi-event partial failure, line/market-key mismatch, task body + `autoretry_for`, 10-minute boundary, null/naive commence time, large negative CLV stamped, +10% boundary.

## Review Triage Log

| Finding | Verdict | Evidence |
|---------|---------|----------|
| IG-1 (BH units, EH claim "Negative CLV"): `abs(clv) > 0.10` skips legitimately large negative CLV; matrix row says negative CLV is stamped, Never-clause says "\|closing-line EV\|" | `medium` → intent_gap | Frozen block supports two readings (skip only positive outliers vs both); user would notice missing CLV on bad bets. Implementation backup in scratch/story42-backup. |
| IG-2 (BH units): `clv_percentage` stored as fraction (0.050) though column name/existing `test_bets.py` use percent-scale values (14.0) | `medium` → intent_gap | Spec formula `CLV% = P×D−1` and `Numeric(6,3)` allow both; Story 4.3 consumes it. |
| BH/EH: suspect/invalid/orphan bets retried every minute, no age cap or attempt marker | `medium` (patch after loopback) | Verified in `stamp_due_bets`: skipped bets stay PENDING with NULL clv. |
| EH: non-Deviggingerror exceptions (null commence_time, bad legs_json, null odds, InvalidBetError from stamp) abort whole batch | `medium` (patch after loopback) | `except DeviggingError` only; contradicts "continue batch". |
| EH/BH: missing API key and non-429 4xx retried as provider failure; event_id mismatch in payload unchecked | `medium` (patch after loopback) | `fetch_closing_odds` wraps all `httpx.HTTPError`; no key/event_id check. |
| EH/BH: leg matching loose (line vs missing point, missing market key, Pinnacle silent fallback) | `medium` (patch after loopback) | `_outcome_matches_leg` returns True when point absent. |
| VG-1/VG-2/VG-3: task body/retry config, multi-event partial failure, matching behavior untested | `medium` (patch after loopback) | Pre-verified gap findings. |
| VG-4/BH: `stamp_bet_clv` validation branches untested; rollback on commit failure; quantize-after-bounds overflow | `low` (defer) | Sweep pre-validates; low harm. |
| BH/EH: no row lock / concurrent sweeps, per-bet commit expiring ORM objects, python-side cutoff filtering, serial fetches/429 Retry-After | `maybe-false` (defer, unverified medium) | Needs multi-worker load test to settle. |
| BH: SUSPECT_STALE_LINE status stamp on bets, no migration/beat service/CLV_ENABLED flag/metrics, private `_validate_decimal_odds` import, shared status helper | `false`/`low` (rejected) | AGENTS.md invariant targets player prop markets; columns already exist in `UserBet`; rest cosmetic with larger fixes. |
| EH: base_url without /v1 yields wrong path; caplog level in test | `low` (rejected) | Default base URL ends in /v1; unlikely in everyday use. |
| BH-1 / EH-4 (`clv.py:495-505`): Non-sharp retail books sorted at priority 100 instead of excluded | `medium` (patch) | `SHARP_BOOKMAKER_PRIORITY.get(..., 100)` allows retail books (`draftkings`, `fanduel`) to be used as closing benchmarks when sharp books are absent. |
| BH-2 / EH-3 (`clv.py:391-456, 519-540`): Pinnacle-first fallback aborts on incomplete or malformed outcomes in higher-priority book | `medium` (patch) | `_match_leg_in_market` raises `DeviggingError` on one-sided/invalid Pinnacle markets before `parse_closing_leg_prices` can try fallback sharp books (`circa`, `bookmaker`, etc.). |
| BH-3 / EH-1 / EH-12 (`clv.py:398-446`): Two-way matching fails on `player_anytime_td` `OVER` vs `Yes`/`No`, spread `-leg_line` opposite points, and mixed generic/player outcomes | `medium` (patch) | `models.py`/`parlay.ts` use `OVER`/`UNDER` for `player_anytime_td` while feeds may use `Yes`/`No`; spread opposite outcomes carry `-leg_line` (`research.md:76-80`); line 438 misses player-prefixed `name_lower` when target is generic. |
| EH-2 (`clv.py:224-233, 800-842`): Per-event HTTP 404/400/422 raises `ClosingOddsClientError` and aborts entire multi-event sweep | `medium` (patch) | Only auth/config errors (missing API key, HTTP 401/403) should fail fast with `ClosingOddsClientError`; event-level 400/404/422 should raise `DeviggingError(code="INVALID_MARKET_ODDS")` so the event is skipped and other events in the sweep still stamp. |
| BH-6 / EH-5 / EH-6 / EH-7 / VG-Other (`clv.py:618-733`): Cross-game leg `papi_` `eventId` rejected when `bet_event` is None/different; `POSTPONED`/`CANCELLED` events not excluded; `event_id IS NULL` query unbounded by 7-day window | `medium` (patch) | `_resolve_leg_event` only checks `_ensure_uuid` when `raw_str != bet_event`; `_is_event_due` and SQL query do not filter out `POSTPONED`/`CANCELLED` events or bound `event_id IS NULL` by `placed_at >= earliest_commence`. |
| VG-1 (`tests/test_clv.py`): Missing `db_session` tests for `UserBet(event_id=None)` with per-leg `eventId` and 2-leg cross-game parlay with staggered `commence_time`s | `medium` (patch) | Pre-verified gap: removing `UserBet.event_id.is_(None)` or per-leg `_resolve_leg_event`/`_is_event_due` checks leaves all existing tests passing. |
| VG-2 (`tests/test_clv.py`): Missing `db_session` test for single-prop `UserBet.prop_id` fallback (`legs_json=None`) in `_resolve_bet_legs` | `medium` (patch) | Pre-verified gap: deleting `clv.py:641-653` leaves all existing tests passing. |
| VG-3 (`tests/test_clv.py:861-881`): Null `commence_time`/`external_provider_id` test only asserts `stamped_bets == 0` on a `MagicMock` session | `medium` (patch) | Pre-verified gap: removing `commence_time is None` guard raises `TypeError` caught into `skipped_invalid=1` with `stamped_bets=0` still passing. |
| EH-15 / BH-7 / BH-10 (`bets.py:319-356`, `clv.py:584, 711-799`): `stamp_bet_clv` idempotency check runs after validation; `is_suspect` checks unquantized `raw_clv_pct`; `stamp_due_bets` creates `httpx.Client` per event when `http_client` is None | `low` (patch) | Trivial cleanups: check `clv_percentage is not None` right after pending-status check in `stamp_bet_clv`; use 3-dp `clv_pct > MAX_POSITIVE_CLV_PERCENT` for `is_suspect`; share one `httpx.Client` across a sweep when `http_client is None`. |
| EH-14 (`celery_app.py:367-392`): `create_session_factory()()` per 60s task allocates an undisposed `Engine` pool | `medium` (defer) | Pre-existing pattern across all tasks in `celery_app.py`; tracked in `deferred-work.md`. |
| BH-4 / EH-9 / BH-8 / EH-8 / BH-10 / EH-13: Missing row locks / concurrent sweep TOCTOU, `session.rollback()` expiring ORM objects, HTTP 429 `Retry-After` | `maybe-false` (defer, unverified medium) | `carried`: Needs multi-worker load test to settle. |
| BH-5 / EH-16: Suspect/invalid bets stay `PENDING` with `NULL` CLV and re-fetch within 7-day window | `medium` (patch after loopback) | `carried`: Verified in `stamp_due_bets`: 7-day cap applied per Iteration 1 Spec Change Log; no schema change in `UserBet`. |
| EH-11 (`bets.py:344-353`): `clv_percentage <= -1e25` quantize-after-bounds overflow | `low` (defer) | `carried`: Sweep pre-validates; low harm. |
| BH-10 (`docker-compose.yml` beat service, bare `base_url` without `/v1`, retry log level) | `low` (rejected) | `carried`: Default base URL ends in `/v1`; `docker-compose.yml` only defines backing stores. |
| BH-7 / EH-10 (`clv.py:573-584` longshot parlay `combined_closing_odds > 9999.9999` or `_quantize_fair_prob < 0.00001`), BH-9 (`placed_at <= commence_time` filter) | `low` (rejected) | `<frozen-after-approval>` mandates `1.01 <= D <= 9999.9999`, 5-dp `closing_fair_prob`, and `commence_time + 10 min` eligibility; filtering by `placed_at` would break staged bets confirmed after kickoff. |
| EH-17 (`clv.py:145,582` percent points vs fraction), EH-18 (`clv.py:34` 7-day sweep cap vs spec wording) | `false` | Disproved by `<frozen-after-approval>` Decision (5) (`((P×D)−1)×100`, 3 dp) and Iteration 1 `Spec Change Log` (`cap sweep to events within 7 days of commence`). |


## Design Notes

Worked example: `D_exec = 2.10`, closing sharp odds 1.95/1.95 → `P_fair_close = 0.5`, `CLV% = (0.5 × 2.10 − 1) × 100 = +5.000`.

## Verification

**Commands:**
- `uv run --directory services/worker ruff check parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker ruff format --check parlaypal_worker tests` -- expected: formatted
- `uv run --directory services/worker mypy parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker pytest -v` -- expected: all pass
