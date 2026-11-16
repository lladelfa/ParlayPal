---
title: 'Story 6.3: Real Recent-Form Dots From Game Logs'
type: 'feature'
created: '2026-11-15'
status: 'done'
baseline_commit: '418fac4543be326ab8bca30a5133dfc778cae9b9'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Preset and market-browser legs show form dots from two hardcoded patterns (`[T,T,F,T,T]` / `[T,F,T,F,T]`, chosen only by L10 >= 0.60) and an `N/10` label rebuilt as `round(rate*10)`. Neither is real: dots can contradict the label, and `M` is always 10. Game logs exist only in memory during ingestion, so the builders only see rates.

**Approach:** Persist each prop's real recent per-game outcomes (computed with the Story 6.2 side-aware rule) when hit rates are written, and have the preset and market-browser builders derive dots and the `N/M` label from those stored outcomes.

## Boundaries & Constraints

**Always:**
- Outcome rule is exactly `compute_rolling_hit_rate`'s: Over strictly above, Under strictly below, push excluded. Expose its tri-state outcomes (most recent first, up to 10 games) rather than re-implementing the comparison.
- Dots = last 5 games, most recent last, pushes skipped (fewer than 5 dots allowed, none when no outcomes). Label = `{hits}/{decided} ({pct:.1f}%) L10` over the stored last-10 window, where `decided` excludes pushes; dots must be consistent with it.
- Outcomes are written wherever rates are written: ingestion upsert, the NULL backfill, and `update_props_hit_rates`.
- Delete both hardcoded dot patterns in `presets.py` and `market_browser.py`. Missing history keeps 6.1's behaviour (`None` display, `[]`, `""`).
- Rate columns, hybrid score, sort order and the 6.1 missing-history rules stay unchanged. Keep `Decimal` math and Redis `EX=45`.

**Decisions (confirmed by human):**
- Rollout: add a nullable JSON column `recent_outcomes` to `PlayerProp` plus an idempotent `ALTER TABLE player_props ADD COLUMN IF NOT EXISTS` run at schema init, so existing databases upgrade themselves (no manual step).
- A leg with a real rate but no stored outcomes (provider-supplied rates, rows not yet re-ingested) shows a percent-only label such as `70.0% L10` and no dots; never a derived `N/10`.

**Never:**
- Never fabricate outcomes, counts or a default window; never change provider calls or ingest new logs (Story 6.5).
- Never change rationale wording logic beyond consuming the new label string (Story 6.4).
- No web component changes expected (renderers already tolerate empty/short arrays).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected |
|---|---|---|
| Full history | 10 outcomes, 7 hits, none pushed | label `7/10 (70.0%) L10`; dots = last 5 outcomes, most recent last |
| Under side | stats under line in 6 of 10 | hits counted with the Under rule; dots green for under games |
| Fewer than 10 games | 6 outcomes, 4 hits | label `4/6 (66.7%) L10`; 5 dots |
| Fewer than 5 games | 3 outcomes | label `N/3 ...`; 3 dots |
| Pushes | 10 games, 2 pushes, 5 hits | label `5/8 (62.5%) L10`; pushes skipped in dots |
| No outcomes, no rate | `None` | `None` display, `[]`, `""` (6.1) |
| Rate but no outcomes | rate 0.7, outcomes `None` | label `70.0% L10`, no dots |
| Zero hits | 10 decided, 0 hits | `0/10 (0.0%) L10`; all red dots |
| Consistency | any leg with outcomes | green dot count in last 5 never exceeds L10 hits |

</frozen-after-approval>

## Code Map

- `services/worker/parlaypal_worker/hit_rate.py` -- `compute_rolling_hit_rate` already builds tri-state outcomes internally (most recent first); expose them on `PropHitRateResult`; `update_props_hit_rates` writes them.
- `services/worker/parlaypal_worker/models.py:148-254` -- `PlayerProp`: add the nullable outcomes column; `db.py:73-83` `init_db` for rollout.
- `services/worker/parlaypal_worker/ingestion.py:2054-2093, 2165-2210` -- upsert and NULL-backfill paths that compute rates; also write outcomes (backfill fills only when outcomes are NULL); thread through `TwoWayPropMarketInput` and the DB write.
- `services/worker/parlaypal_worker/presets.py:436-451` and `market_browser.py:305-318` -- replace `round(rate*10)` label and hardcoded patterns with a shared helper that builds label and dots from outcomes.
- Tests to rewrite: `tests/test_presets.py` `test_real_hit_rate_display_and_dots_unchanged` (:599), `test_zero_hit_rate_is_real` (:624), the `len(sofascore_form) == 5` check (~:474), `_slate` helper; `tests/test_market_browser.py` (:416-417, `_prop` helper :91-110); `tests/test_hit_rate.py` for the exposed outcomes.
- `apps/web` -- unchanged (parsers default to `[]`; renderers `.map` safely).

## Tasks & Acceptance

**Execution (TDD per `AGENTS.md`):**
- [ ] Tests (red): one per matrix row in `test_hit_rate.py`, `test_presets.py`, `test_market_browser.py`; update tests that pin the old patterns/`N/10` derivation.
- [ ] `hit_rate.py`, `models.py` (+ idempotent ALTER at init), `ingestion.py` -- compute, expose, persist outcomes at every rate write.
- [ ] `presets.py`, `market_browser.py` -- shared label/dots helper from outcomes; delete hardcoded patterns.
- [ ] Matrix audit and all verification commands.

**Acceptance Criteria:**
- Given a prop with at least 5 stored outcomes, when a leg is built, then dots equal its last 5 outcomes (most recent last) under the side-aware rule and the L10 label counts the same outcomes.
- Given fewer than 10 outcomes, then the label shows `N/M` with `M` the decided games available; fewer than 5 shows only available dots; none shows no dots.
- Given the hardcoded patterns, then neither exists in the codebase.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Verification

**Commands:**
- `uv run --directory services/worker ruff check parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker ruff format --check parlaypal_worker tests` -- expected: formatted
- `uv run --directory services/worker mypy parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker pytest -v` -- expected: all pass
- `npm --prefix apps/web run typecheck` and `npm --prefix apps/web test -- --run` -- expected: pass

| Finding | Verdict | Route | Evidence |
|---|---|---|---|
| Existing prop: rate overwritten but outcomes kept when market has none (stale outcomes vs rate/line/selection) | medium | patch | `devig.py:724` only writes outcomes when supplied; rates always written. |
| Upsert computes outcomes only when a rate is missing; provider-supplied rates leave outcomes NULL/stale | medium | patch | `ingestion.py:2057-2070`. |
| No test of existing-prop update, provider-rates-with-logs, or backfill selection (Under) | medium | patch | Removing the update branch leaves all tests green. |
| `test_green_dots_never_exceed_l10_hits` asserts `sum(form) <= 5` | low | patch | Trivially true. |
| Postgres `ALTER TABLE ... IF NOT EXISTS` path untested; SQLite upgrade path absent | medium | defer | Needs a Postgres fixture; production is Postgres, `create_all` covers fresh/test DBs. |
| Outcomes list unbounded/coerced on `TwoWayPropMarketInput` | low | rejected | Producers are internal; read path slices to 10. |
| Fewer than 5 dots when pushes fall in last 5; all-push window | low | rejected | Spec decision (pushes skipped); all-push yields no decided rate. |
| Backfill fills outcomes beside provider-supplied rate; backfill never refreshes; `[]` persisted; JSON null; unused imports | low/false | rejected | `update_props_hit_rates` refreshes both; ruff clean; Python reads None for JSON null. |
