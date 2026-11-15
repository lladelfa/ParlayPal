---
title: 'Story 6.1: Remove Fabricated Hit-Rate Fallback & Honest Consistency Badge'
type: 'bugfix'
created: '2026-11-15'
status: 'done'
baseline_commit: '5758f7d81293f981b7c701887bf2c56e40964a86'
route: 'dispatch'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A 2026-11-15 UI review showed every preset leg with an identical "7/10 (70.0%) L10", near-identical form dots and templated rationale, even where the price contradicts it (Carter Runyon anytime TD at +3604 implies about 3%). Verified causes:
1. `services/worker/parlaypal_worker/presets.py` (~line 370): `l10_rate = prop.hit_rate_l10 or Decimal("0.7000")` invents a 70% hit rate whenever `hit_rate_l10` is `NULL`. The `or` also turns a real `0` into 70%.
2. `PresetCard.create` (~line 243) falls back to `Decimal("0.6500")` average hit rate when no leg has one, inflating the Hybrid Value Score.
3. `generate_conviction_rationale` asserts past performance using the invented hit rate.
4. `apps/web/src/lib/presets.ts` fallback fixtures hardcode `"7/10 (70.0%) L10"` strings. They must stay clearly fixture-only (see Boundaries).

**Approach:** Treat a missing hit rate as missing. Carry `None` through `PresetLeg`, compute the score only from legs with real data, render a neutral "Limited history" badge, and make the rationale silent about history when none exists. Do not fix Under direction, real form dots, rationale quality or game-log ingestion here (Stories 6.2-6.5).

## Boundaries & Constraints

**Always:**
- Decide missing-ness with `is None`, never truthiness. `Decimal("0")` is real and renders `0/10 (0.0%) L10`.
- Keep odds math in `Decimal`; do not touch devigging, the `> 10.0%` `SUSPECT_STALE_LINE` guard, or Redis TTL (`EX=45`).
- Keep `apps/web` reading only Redis/PostgreSQL; accept both camelCase and snake_case keys as `lib/presets.ts` does today.
- Legs with a real `hit_rate_l10` must serialize and render byte-for-byte as before.

**Decisions (proposed, confirm in review):**
- `hit_rate_display` becomes `str | None` on `PresetLeg` (and `string | null` in `types/preset.ts`). UI shows "Limited history" when null.
- `sofascore_form` is `[]` and `sofascore_dots` is `""` when hit rate is missing. The hardcoded form patterns stay for legs with a real hit rate until Story 6.3 replaces them.
- A preset must have at least 2 legs and at least 1 leg with real history to be emitted. Otherwise it is skipped, and the existing all-legs rotation fallback cannot re-introduce it.
- `PresetCard.create` with zero legs having `hit_rate_l10`: score uses EV component only (hit-rate weight redistributed), never the `0.6500` default.

**Never:**
- Never substitute any numeric default for a missing hit rate anywhere in worker or web.
- Never modify `parlay-api.com` calls or ingestion (Story 6.5).
- Never present the web fallback fixtures as live data. If the web falls back to fixtures, they must not display consistency claims that look live (see matrix row 7).

</frozen-after-approval>

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Real hit rate | `hit_rate_l10 = 0.7` | `hit_rate_display = "7/10 (70.0%) L10"`, form dots as today, rationale cites "7/10 (70.0%) L10" | n/a |
| Missing hit rate | `hit_rate_l10 = None` | `hit_rate_l10 = None`, `hit_rate_display = None`, `sofascore_form = []`, `sofascore_dots = ""`; UI shows "Limited history" | No exception, leg still priced |
| Zero hit rate | `hit_rate_l10 = Decimal("0")` | `"0/10 (0.0%) L10"`; not treated as missing | n/a |
| Missing-history rationale | `hit_rate_l10 = None`, market `player_anytime_td` | Sentence makes no claim of past scoring/clearing; may cite price or matchup only (full evidence-based copy is Story 6.4) | n/a |
| Mixed-history preset | 3 legs, 2 with hit rates 0.6 and 0.8, 1 `None` | Score avg hit rate = 0.7 (two legs only) | n/a |
| No-history preset | All legs `hit_rate_l10 = None` | Preset not emitted; fewer-than-minimum presets handled by existing empty-feed path | Logged at `INFO`, no crash |
| Score without any hit rate (direct `PresetCard.create`) | No leg has hit rate | `avg_l10` not defaulted; EV-only score, clamped 0-100 | n/a |
| Web with null fields | Redis payload with `hit_rate_display: null` / `hitRateDisplay: null`, or key missing | Card renders "Limited history" badge, no dots, no crash; both key styles supported | Coercion yields `null`, never `""` or `"undefined"` |
| Web fallback fixtures | Redis feed unavailable | Fixture legs do not claim "7/10 (70.0%) L10" as if live; use null hit-rate display | n/a |

## Code Map

- `services/worker/parlaypal_worker/presets.py` — remove `or Decimal("0.7000")` (~370); make `hit_rate_display` optional on `PresetLeg` (~134-155); skip dots when missing (~376-381); fix `PresetCard.create` `0.6500` fallback (~243); add no-history preset skip (~467-480); adjust `generate_conviction_rationale` for missing hit rate (line 68; keep signature backward compatible with `hit_rate_formatted: str | None`).
- `services/worker/tests/test_presets.py` — add tests for every matrix row (red phase first).
- `apps/web/src/types/preset.ts` — `hitRateDisplay: string | null`.
- `apps/web/src/lib/presets.ts` — null-safe coercion (~113) and neutral fixtures (~231 onward).
- `apps/web/src/components/PresetCard.tsx` (and `ParlayDrawer.tsx`, `LegSwapperModal.tsx`, `MarketBrowser.tsx`, `lib/parlay.ts`, `lib/markets.ts`, `types/market.ts`, `types/parlay.ts` where `hitRateDisplay`/`sofascore*` appear) — render "Limited history" when null.
- `apps/web/src/lib/presets.test.ts`, `apps/web/src/app/api/presets/route.test.ts` — add null-field cases.

## Tasks & Acceptance

**Execution (TDD, per `AGENTS.md`):**
- [ ] Red: write failing worker tests for each matrix row in `services/worker/tests/test_presets.py`; write failing Vitest cases for null fields in `lib/presets.test.ts` and `api/presets/route.test.ts`.
- [ ] Green (worker): remove fabricated defaults, make display/dots optional, exclude no-history legs from the score, skip no-history presets, make the rationale history-free when data is missing.
- [ ] Green (web): update types, coercion, fixtures and the components that render the badge.
- [ ] Refactor and matrix audit: confirm every row above has a passing test.
- [ ] Branch `fix/6-1-remove-fabricated-hit-rate-fallback` via `python _bmad/scripts/git_flow.py start ...`; ship via `git_flow.py ship`.

**Acceptance Criteria:**
- Given a prop with `hit_rate_l10 = NULL`, when presets are built, then no leg shows "7/10 (70.0%) L10" or any invented value and the UI shows "Limited history".
- Given `hit_rate_l10 = 0`, then the leg shows `0/10 (0.0%) L10`.
- Given a preset whose legs all lack history, then it is not emitted.
- Given mixed legs, then the Hybrid Value Score uses only legs with real hit rates.
- Given legs with real hit rates, then output is unchanged from today.

## Verification

**Commands:**
- `uv run --directory services/worker ruff check parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker ruff format --check parlaypal_worker tests` -- expected: formatted
- `uv run --directory services/worker mypy parlaypal_worker tests` -- expected: 0 errors
- `uv run --directory services/worker pytest -v` -- expected: all pass
- `npm --prefix apps/web run typecheck` -- expected: 0 errors
- `npm --prefix apps/web test -- --run` -- expected: all pass
- `npm --prefix apps/web run build` -- expected: success

## Review Triage Log

| Finding | Verdict | Route | Evidence |
|---|---|---|---|
| No test for market_browser missing-L10 path (Verification Gap, Blind, Edge) | medium | patch | Reverting the fix there leaves all tests green. |
| Web callers (parlay/math/market-filters) and market normalizer untested with null rate | medium | patch | Reverting to 0.70 default or `coerceString` leaves tests green. |
| `caplog` unasserted; vacuous partial-history test | low | patch | Direct test corrections. |
| Sort key `hit_rate_l10 or 0` ranks missing equal to real 0 | low | patch | Truthiness against the `is None` rule; ordering only. |
| "Limited history" untested in LegSwapperModal/MarketBrowser/ParlayDrawer | low | defer | One-line fallbacks; no component render test infra. |
| Persisted 24h Redis snapshot may serve pre-fix fabricated legs | medium | defer | Deploy/ops concern, not caused by this diff. |
| Fixture feeds keep live-looking odds/EV/card scores | low | defer | Matrix row 7 only requires no consistency claims; sample banner is a separate feature. |
| Rotation window with all-missing legs is skipped; fewer than 3 cards possible | false | rejected | Spec Decisions explicitly require skipping; partial feeds were already possible. |
| Placeholder form dots / invented hit counts for real rates | false | rejected | Intent excludes it (Story 6.3). |
| Partial-coverage indicator, label wording, duplicated parsing, keyword rationale matching, whitespace/out-of-range rates, dots default for real legs, ParlayDrawer undefined | low/false | rejected | Spec decisions, negligible, or worker always supplies the field. |
