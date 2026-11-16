---
title: 'Story 6.7: API-Sports Game-Log Provider Adapter (NBA & NFL)'
type: 'feature'
created: '2026-11-16'
status: 'draft'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-6-5-game-log-ingestion-for-upstream-players.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 6.5 added game-log plumbing (cache, budget, deadline, breaker) but no real source; parlay-api is odds-only, so live props still show "Limited history". api-sports.io (API-NBA, API-NFL) is the chosen source, but it does not fit the 6.5 generic fetcher: players are keyed by ID, NBA rows carry a game id but no date, and NFL `players/statistics` returns season totals, so NFL per-game data must come from per-game player statistics.

**Approach:** Add an api-sports provider adapter behind the 6.5 `resolve_game_logs` contract (`(player_name, market_key)` -> most-recent-first `Decimal` stats), selected by config, with the generic fetcher kept as the default. A first, human-gated task verifies paid-plan coverage before any adapter code is written.

## Boundaries & Constraints

**Always:**
- Task 1 (gate) is done first and recorded in Implementation Notes: with a paid plan, verify 2025/2026 coverage, name-match rate on current-slate players (target >= 90%), the paid per-minute limit, NBA ordering, and NFL rush/receiving touchdown fields. If coverage fails, stop; the 6.5 fetcher stays disabled.
- Auth header `x-apisports-key`, key from env only, never logged or committed. Hosts: `v2.nba.api-sports.io`, `v1.american-football.api-sports.io` (configurable).
- Reuse 6.5 budget, deadline, breaker and negative cache; add a configurable requests-per-minute limiter from the verified plan limit.
- NBA: one `players/statistics?id&season` call per player returns the season; map `points`, `totReb`, `tpm`. Order by game date from `games` (or verified game-id order) so newest is first; skip rows with a non-null DNP `comment`.
- NFL: `games?team&season` for dates, then `games/statistics/players?id=<game>` once per finished game; extract per-player `Passing yards` and `Rushing yards`. Cache finished games' extracted stats with a long TTL (90 days); never use season totals.
- Name matching: normalize (case, accents, punctuation, Jr/Sr/II suffixes), require a unique match, cache the player-id map with a long TTL (30 days). Ambiguous or unmatched names, or under 5 games, stay NULL.
- Rates still come only from `compute_rolling_hit_rate`; seed path never calls the provider.

**Never:** season totals as game logs; fabricated or defaulted stats; calls from `apps/web`; `player_anytime_td` support (deferred; revisit after Task 1 confirms touchdown fields); new DB columns; changes to preset/market-browser rendering.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected |
|---|---|---|
| NBA happy path | matched player, 20 games | newest-first points/rebounds/threes logs; rates populated |
| NFL happy path | team games finished, per-game stats cached | newest-first passing/rushing yards from per-game stats |
| Unmatched / ambiguous name | zero or two candidates | NULL, negative-cached, no crash |
| DNP game | row with `comment` set | skipped, not counted as 0 |
| Season restricted (HTTP 200 with `errors.plan`) | plan lacks season | treated as failure: NULL, negative-cached |
| Rate limit | per-minute cap reached | remaining targets deferred to later cycle |
| Finished game cached | game already stored | no provider call |
| Provider unset | `game_log_provider` generic/unset | 6.5 behaviour unchanged |

</frozen-after-approval>

## Code Map

- `services/worker/parlaypal_worker/game_logs.py` -- 6.5 `resolve_game_logs`, cache, budget, deadline, breaker; add provider selection and reuse.
- `services/worker/parlaypal_worker/config.py` -- add `game_log_provider`, api-sports hosts, requests-per-minute limit, TTLs.
- `services/worker/parlaypal_worker/ingestion.py` -- `_attach_upstream_game_logs` consumes the result unchanged.
- New `services/worker/parlaypal_worker/api_sports.py` -- adapter: auth, ID lookup, NBA parser, NFL game-centric ingest, name normalization.
- Tests: mirror `tests/test_game_logs.py` (`httpx.MockTransport`, `FakeRedisClient`); do not hit the network.
- Note: api-sports returns HTTP 200 with an `errors` object for plan/quota failures; check it.

## Tasks & Acceptance

**Execution (TDD per `AGENTS.md`):**
- [ ] Task 1 (gate, human-assisted): paid-plan verification; record results in Implementation Notes.
- [ ] Tests (red): one per matrix row for the adapter and name matching.
- [ ] `config.py`, `api_sports.py`, `game_logs.py` -- adapter, limiter, provider selection.
- [ ] Matrix audit and verification commands.

**Acceptance Criteria:**
- Given a matched NBA or NFL player with at least 5 games, then logs are newest-first and hit rates populate through the existing 6.5 path.
- Given an unmatched player or a plan-restricted response, then fields stay NULL and the beat cycle completes.
- Given a finished NFL game already cached, then no repeat provider call occurs.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Verification

**Commands:**
- `uv run --directory services/worker ruff check parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker ruff format --check parlaypal_worker tests` -- expected: formatted
- `uv run --directory services/worker mypy parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker pytest -v` -- expected: all pass
