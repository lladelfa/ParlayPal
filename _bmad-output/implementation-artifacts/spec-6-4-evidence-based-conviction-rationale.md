---
title: 'Story 6.4: Evidence-Based Conviction Rationale'
type: 'feature'
created: '2026-11-16'
status: 'in-progress'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `generate_conviction_rationale` appends invented context to every sentence ("red-zone focal point in high-leverage matchup", "heavy touch volume established", "averaging high-volume attempts", "consistently cleaning the glass"), never cites the line or the price, and gives a +3604 long shot the same consistency copy as a favourite. Cards read as one template.

**Approach:** Build the sentence only from data on the leg: hit rate with side and line when known, and the offered price versus the devigged fair price (plus EV% when present) otherwise. Drop every unsupported claim. Long shots get no consistency claim.

## Boundaries & Constraints

**Always:**
- Facts allowed: player, market/line/side, hit-rate label (from 6.3's `build_recent_form_display`), offered American odds, fair American odds derived from `fair_probability`, `guarded_ev` as a signed percent (only the raw prop value, never the `0.0200` leg default), matchup, and the weather badge text verbatim as data (no causal claim).
- Add trailing keyword-only args to `generate_conviction_rationale` (`fair_probability`, `offered_decimal_odds`, `guarded_ev`, all default `None`); with all `None` the sentence states only player, market and matchup, no claims. Existing callers keep working.
- Hit-rate sentence: Over `"{player} cleared {line} {unit} in {hit}"`, Under `"{player} stayed under {line} {unit} in {hit}"`, anytime TD `"{player} scored in {hit}"` (TD stays Over-style for any selection). Then `; {offered} offered vs {fair} fair` and ` ({ev} EV)` when EV is known, then the wind/precip badge in parentheses. Unmapped markets omit the unit (never the raw key).
- No-hit-rate sentence: `"{player}: {market} at {offered} offered vs {fair} fair ({ev} EV) in {matchup}"` using whichever price facts exist.
- Long shot rule: when `fair_probability < 0.10`, never include the hit-rate label or any consistency wording; cite only price versus fair (and EV) with the implied probability.
- Anytime TD is detected by the market key containing both `anytime` and `td`, so Under on `player_pass_tds` reads in the under direction.
- Share one exact market-to-unit map with the Under copy (replace `_UNDER_UNITS`).

**Never:**
- No phrase asserting usage, role, volume, scheme, matchup leverage, game script, or weather-to-performance causality. Remove all of them from every template, including wind variants.
- Do not change hit-rate computation, scoring, fixtures in `apps/web`, or the persisted leg `guarded_ev` default (log it as deferred, do not fix here).
- Never print `None`, a raw `market_key`, or a fabricated price/EV.

## I/O & Edge-Case Matrix

| Scenario | Input | Expected |
|---|---|---|
| Over with history | Over, line 274.5 pass yds, `7/10 (70.0%) L10`, +105 offered, fair +110, EV +3.2% | `... cleared 274.5 pass yds in 7/10 (70.0%) L10; +105 offered vs +110 fair (+3.2% EV)` |
| Under with history | Under, line 28.5 rush yds, `6/10 (60.0%) L10` | `... stayed under 28.5 rush yds in 6/10 (60.0%) L10; ...` |
| Anytime TD | TD, any selection, `7/10 (70.0%) L10` | `... scored in 7/10 (70.0%) L10; ...` |
| No hit rate | `hit_rate_formatted=None`, price+fair known | price vs fair (and EV) sentence, no "/10" |
| Long shot | fair 0.03, hit rate 7/10, +3604 offered | price vs fair and implied probability only; no hit-rate text, no "cleared"/"scored" |
| Wind | badge `⚠️ 19mph Wind` | badge text appears verbatim; no "elevates", "strong ground-game" etc. |
| No price data | all new args `None` | player, market, matchup only; no claims |
| EV unknown | `guarded_ev=None` | no EV text; never `+2.0%` |
| Distinct legs | seed slate props with different player/line/price | no two rationales equal unless inputs are identical |
| Banned phrases | every template output | none of: red-zone, high-leverage, touch volume, high-volume, cleaning the glass, usage, catch-and-shoot, trajectory, ground-game |

</frozen-after-approval>

## Code Map

- `services/worker/parlaypal_worker/presets.py:76-197` -- rewrite `_generate_history_free_rationale` and `generate_conviction_rationale`; replace `_UNDER_UNITS` (107-113) with a shared unit map; add small price/EV formatters (reuse `decimal_to_american` at :23).
- `presets.py:461-469` -- the only production call site; pass `fair_probability`, `offered_decimal_odds`, `prop.guarded_ev` (raw, may be `None`). Do not change the `0.0200` leg default at ~:489.
- `services/worker/tests/test_presets.py:84-158, 606-726, 767-792` -- tests that pin old copy; update to the new sentences (keep 6.2 under-direction and 6.1 no-history assertions; `test_over_rationale_defaults_identical` no longer pins "surpassed"). Add matrix-row tests, a banned-phrase parametrized test over all markets, and a distinctness test over seed-like props (the 12 seed props in `ingestion.py:1602-1759`, built via `upsert_slate_to_db` on the in-memory DB or equivalent direct props).
- `apps/web` -- no change; fixtures and parsers just pass the string through.

## Tasks & Acceptance

**Execution (TDD per `AGENTS.md`):**
- [ ] `services/worker/tests/test_presets.py` -- Red: failing tests for every matrix row, banned phrases, seed-slate distinctness.
- [ ] `presets.py` -- new signature, price/EV helpers, shared unit map, rewritten templates, long-shot rule, updated call site.
- [ ] Matrix audit; run all verification commands.

**Acceptance Criteria:**
- Given a leg with a hit rate, then the sentence cites hit rate with side and line plus price versus fair, and nothing else.
- Given a leg without a hit rate, then it cites offered price versus fair price or EV%.
- Given fair probability below 10%, then no consistency claim appears.
- Given the seed slate, then no two legs with different inputs share identical rationale text.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Verification

**Commands:**
- `uv run --directory services/worker ruff check parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker ruff format --check parlaypal_worker tests` -- expected: formatted
- `uv run --directory services/worker mypy parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker pytest -v` -- expected: all pass
- `npm --prefix apps/web run typecheck` and `npm --prefix apps/web test -- --run` -- expected: pass (no web changes expected)
