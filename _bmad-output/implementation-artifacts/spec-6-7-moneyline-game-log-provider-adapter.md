---
title: 'Story 6.7: MoneyLine Game-Log Provider Adapter (NBA & NFL)'
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

**Problem:** Story 6.5 added game-log plumbing (cache, budget, deadline, breaker) but no real source; parlay-api is odds-only, so live props still show "Limited history". MoneyLine (mlapi.bet) is the chosen source (renegotiated from api-sports on 2026-11-16, see Spec Change Log). It does not fit the 6.5 generic fetcher: players are keyed by MoneyLine `playerId`, there is no name-search endpoint, and NBA stats are flat while NFL stats are nested per category.

**Approach:** Add a MoneyLine provider adapter behind the 6.5 `resolve_game_logs` contract (`(player_name, market_key)` -> most-recent-first `Decimal` stats), selected by config, with the generic fetcher kept as the default. Task 1 (coverage gate) is already mostly satisfied by the probe recorded in Implementation Notes; only its remaining open checks gate the build.

## Boundaries & Constraints

**Always:**
- Auth header `x-api-key`, key from `MONEYLINE_API_KEY` env only, never logged or committed. Base URL from `MONEYLINE_API_BASE_URL` (default `https://mlapi.bet/v1`).
- Reuse 6.5 budget, deadline, breaker and negative cache; add a configurable requests-per-minute limiter (Free 10, Starter 60) and honour HTTP 429 `Retry-After` by deferring remaining targets to a later cycle. Budget counts credits (1 per game-log or roster-page call), not just requests.
- Game logs: `GET /players/{playerId}/stats?type=game&season=<season>` returns newest-first rows. Season string is `YYYY-YY` for NBA and NFL (e.g. `2026-27`; the bare `2026` form returned no rows for NFL). Derive the current season from the date with a config override; do not trust `/leagues` `season`, which was stale.
- Stat mapping (league and market -> field): NBA `points` -> `stats.points`, `rebounds` -> `stats.total_rebounds`, `threes` -> `stats.threepoint_goals_made`; NFL `player_rush_yds` -> `stats.rushing.yards`, `player_pass_yds` -> `stats.passing.yards` (key unverified, see Task 1). A row missing the mapped field is skipped, not counted as 0.
- Name matching: roster sync via `GET /players?league=<id>&limit=100&page=<n>` (about 10 credits per league), cached as a name -> `playerId` map with a 7-day TTL. Match on the normalized full name (case, accents, punctuation, hyphens, Jr/Sr/II/III suffixes) with a small alias table for nicknames; require a unique match. Ignore stale placeholder roster rows with abbreviated first names (e.g. `A. Funk`). Ambiguous or unmatched names, or under 5 games, stay NULL and are logged by count (not by player) for coverage tracking.
- Positive TTL for logs is 20 hours (vendor refreshes stats daily); finished-game rows need no per-game cache because one call returns the whole season.
- Rates still come only from `compute_rolling_hit_rate`; seed path never calls the provider.

**Never:** season totals (`type=season`) as game logs; fabricated or defaulted stats; calls from `apps/web`; `player_anytime_td` support (deferred; touchdown fields are now confirmed present, revisit in a later story); new DB columns; changes to preset/market-browser rendering; leaving auto-upgrade on for the MoneyLine account (it charges the card at the plan limit).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected |
|---|---|---|
| NBA happy path | matched player, 20 games | newest-first points/rebounds/threes logs; rates populated |
| NFL happy path | matched player, nested stats | newest-first passing/rushing yards from `stats.passing/rushing.yards` |
| Unmatched / ambiguous name | zero or two candidates | NULL, negative-cached, no crash |
| Placeholder roster row | `A. Funk` style abbreviated name | ignored by matcher |
| Empty game log | `data: []` (e.g. fringe player) | NULL, negative-cached |
| Field missing on a row | no `stats.rushing` on a game | row skipped, not counted as 0 |
| Rate limit (HTTP 429) | per-minute cap or credit exhaustion | remaining targets deferred to later cycle; breaker not tripped by 429 alone |
| Season boundary | new season has no rows yet | NULL (or prior-season fallback only if explicitly configured) |
| Provider unset | `game_log_provider` generic/unset | 6.5 behaviour unchanged |

</frozen-after-approval>

## Code Map

- `services/worker/parlaypal_worker/game_logs.py` -- 6.5 `resolve_game_logs`, cache, budget, deadline, breaker; add provider selection and reuse.
- `services/worker/parlaypal_worker/config.py` -- add `game_log_provider`, `moneyline_api_key`, `moneyline_api_base_url`, requests-per-minute limit, roster TTL, log TTL.
- `services/worker/parlaypal_worker/ingestion.py` -- `_attach_upstream_game_logs` consumes the result unchanged.
- New `services/worker/parlaypal_worker/moneyline.py` -- adapter: auth, roster sync, name normalization and aliases, NBA flat and NFL nested stat extraction, limiter.
- `.env.example` -- add `MONEYLINE_API_KEY` and `MONEYLINE_API_BASE_URL` placeholders (worker `.env` already has them locally and is gitignored).
- Tests: mirror `tests/test_game_logs.py` (`httpx.MockTransport`, `FakeRedisClient`); do not hit the network.

## Tasks & Acceptance

**Execution (TDD per `AGENTS.md`):**
- [ ] Task 1 (gate, remaining checks only): with the existing key, verify the `stats.passing.yards` field name on an NFL quarterback, check NBA `minutes` handling for DNP rows, and re-measure the name-match rate using `parlay-api.com` prop names rather than MoneyLine's own (target >= 90%). Record in Implementation Notes. If match rate is below 90% after the alias table, stop and keep the 6.5 fetcher disabled.
- [ ] Tests (red): one per matrix row for the adapter, name matching and limiter.
- [ ] `config.py`, `moneyline.py`, `game_logs.py`, `.env.example` -- adapter, limiter, provider selection.
- [ ] Matrix audit and verification commands.

**Acceptance Criteria:**
- Given a matched NBA or NFL player with at least 5 games, then logs are newest-first and hit rates populate through the existing 6.5 path.
- Given an unmatched player or an empty or rate-limited response, then fields stay NULL and the beat cycle completes.
- Given the credit budget for a cycle is exhausted, then remaining players are deferred and no extra provider calls occur.

## Implementation Notes

**Task 1 probe, 2026-11-16 (MoneyLine Free tier, about 60 credits spent):**
- Auth and base URL work (`x-api-key`, `https://mlapi.bet/v1`). Terms (moneylineapp.com/terms) allow commercial in-app display, storage and model training; reselling or exposing the data via our own API or feed is prohibited. Auto-upgrade is on by default and was turned off by the owner.
- Coverage current: NBA 2026-27 and 2025-26 and NFL 2026-27 game logs populated through November 2026; live props current. `/leagues` reports `season: 2025-26` for NBA/NFL with a March 2026 `updatedAt`, which is stale metadata, not missing data.
- Ordering: `type=game` rows are newest-first.
- NBA fields (flat): `stats.points`, `total_rebounds`, `assists`, `threepoint_goals_made`, `minutes`, plus `gameDate`, `result`, `homeAway`, `opponent`, `gameType` (regular/postseason).
- NFL fields (nested): `stats.rushing.{yards,total_rushes,rushing_touch_downs}`, `stats.receiving.{yards,total_receptions,targets,receiving_touch_downs}`. Passing field names not yet observed (open in Task 1).
- NFL season string: `2026` returned no rows; `2026-27` returned rows.
- Name match, NBA live slate (118 props players, MoneyLine's own full names vs its roster `normalizedName`): 117 unique matches (99%), 0 ambiguous, 1 miss (nickname `Herb Jones` vs `Herbert Jones`). Roster contains stale abbreviated placeholder rows (`A. Funk`) that must be ignored. This used MoneyLine's names, not parlay-api's; Task 1 re-measures.
- Costs: game log 1 credit, `/players` page 1 credit (100 players), `/player-props` 8 credits, `/events/{id}/player-props` 4 credits. Credits are account-wide. Limits: Free 10 requests/min and 1,000 credits/month; Starter $29 for 150K credits and 60 requests/min.
- Rough sizing (estimate): a 120-player NBA slate refreshed daily is about 120 credits/day plus about 10 per roster sync, so Free is enough to build and test, Starter for production. NFL roster is larger (366 props players this week) but logs change weekly.
- No-name-search constraint: `/players` has only `league`, `team`, `limit`, `page`; there is no name filter, hence the cached roster map.
- Not tested: MLB, NHL, soccer.

## Spec Change Log

- 2026-11-16: Provider renegotiated by the human from api-sports.io to MoneyLine (mlapi.bet) after a free-tier probe showed current NBA/NFL coverage, 1-credit game logs and a 99% NBA name match without needing a paid plan to verify. Frozen intent, approach, constraints and matrix rewritten for MoneyLine; the paid-plan gate and the NFL game-centric ingest (per-game statistics, 90-day game cache) were dropped because MoneyLine returns whole-season per-game logs in one call. Task 1 reduced to the three open checks. Spec file renamed from `spec-6-7-api-sports-game-log-provider-adapter.md`.

## Review Triage Log

## Verification

**Commands:**
- `uv run --directory services/worker ruff check parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker ruff format --check parlaypal_worker tests` -- expected: formatted
- `uv run --directory services/worker mypy parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker pytest -v` -- expected: all pass
