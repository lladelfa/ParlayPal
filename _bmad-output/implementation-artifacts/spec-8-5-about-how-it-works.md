---
title: 'Story 8.5: About & How It Works'
type: 'feature'
created: '2026-11-22'
status: 'done'
baseline_commit: 'c8bc345276eb6e5796ab1898eda96e8ebda22223'
route: 'oneshot'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** New bettors see a "Score", EV, hit rates and "Limited history" with no explanation of what they mean or how far to trust them.

**Approach:** Add a static `/about` page, linked from the home header, that walks through the site (what ParlayPal is, preset feed, market browser and game pages, parlay drawer and lineshopping, QuickPick, bet tracking and CLV) and explains, from the code, the Hybrid Value Score, L5/L10/season hit rates (Over vs Under), the "Limited history" badge, EV and the 10% suspect-line guard, plus a not-betting-advice notice. Add a "What is this score?" link on preset cards and on the market browser that points to `/about#score`.

</frozen-after-approval>

## Implementation Notes

- Copy is written from `presets.py::calculate_hybrid_value_score` (Score = clamp(round(0.60 × L10 hit rate % + 0.40 × EV component)), EV component = clamp(EV% × 10 + 50), 0–100; no hit-rate history → EV component only), `devig.py` (`OUTLIER_EV_THRESHOLD` 10%, suspect lines stamped `SUSPECT_STALE_LINE` and excluded from public feeds), `hit_rate.py` (L5/L10/season windows, Under hits when the stat is below the line, pushes skipped) and `redis_client.py` (high-value: EV ≥ 3.5% and L10 ≥ 70%).
- New `apps/web/src/app/about/page.tsx` (server component, section ids incl. `score`), tested first in `about/page.test.tsx` (sections, formula numbers, disclaimer present). `PresetCard.tsx` and `MarketBrowser.tsx` get a `next/link` to `/about#score`; home hero gets an About link. No worker or data changes.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Route / evidence |
|---|---|---|
| Blind-hunter subagent review skipped (no subagent authorization this run); inline copy-vs-code check only | n/a | weights, EV mapping, 10% guard, 10% min fair probability and Under direction re-verified against `presets.py`, `devig.py`, `hit_rate.py` |
| Page needed `import React` for vitest SSR | low | patched; typecheck, 278 tests and build pass |

## Verification

**Commands:**
- `npm --prefix apps/web run typecheck` -- expected: no errors
- `npm --prefix apps/web test -- --run` -- expected: all pass
- `npm --prefix apps/web run build` -- expected: succeeds
