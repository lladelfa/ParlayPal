---
title: 'Story 7.1: Honest Empty State & Feed Diagnostics'
type: 'feature'
created: '2026-11-17'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** When Redis holds no preset cards (or is unreachable), `getCuratedPresetFeed` serves hard-coded `FALLBACK_PRESET_FEED` as if real ("Sample fixture leg shown while the live feed is unavailable"); the market browser does the same with `FALLBACK_MARKET_BROWSER_FEED`. The worker's `generate_curated_presets` drops candidates silently, so an empty feed cannot be diagnosed.

**Approach:** The web feed carries a `reason` (`live` | `no_qualifying_presets` | `feed_unavailable` | `sample`); fixtures are served only when `PARLAYPAL_SAMPLE_DATA=1`, labelled "Sample data". The UI renders an explicit empty state per reason. The worker logs per-cycle drop counts by cause.

## Boundaries & Constraints

**Always:**
- Redis unreachable, or no hot/snapshot key at all -> `feed_unavailable`. A parseable key with 0 cards -> `no_qualifying_presets`.
- Fixtures never merge with live data; market browser stops serving its fixture unless the flag is set.
- Existing "Limited history" copy and component behavior stay unchanged.

**Never:** new DB columns; worker/Redis schema changes beyond logging; deleting the fixtures (kept for tests and the dev flag); hiding the sport filter or breaking SSE.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error Handling |
|----------|--------------|----------|----------------|
| Live cards | Redis has cards | `reason: "live"`, cards | N/A |
| Empty feed | Key present, 0 cards | `no_qualifying_presets`, no cards | N/A |
| Missing/expired | No key | `feed_unavailable`, no cards | N/A |
| Redis down | connect/get throws | `feed_unavailable`, warn log | no throw |
| Dev flag | flag=1 and not live | `sample`, fixtures, "Sample data" badge | N/A |
| Worker drops | candidates filtered | INFO log with counts per cause | N/A |

</frozen-after-approval>

## Code Map

- `apps/web/src/lib/presets.ts` -- `getCuratedPresetFeed` fallback (~L532-575); `FALLBACK_PRESET_FEED` kept.
- `apps/web/src/lib/markets.ts` -- `getMarketBrowserFeed` fallback (~L463-510).
- `apps/web/src/types/preset.ts`, `types/market.ts` -- add `reason`.
- `apps/web/src/app/page.tsx`, `components/TerminalView.tsx`, `components/PresetFeed.tsx` -- pass reason, render empty/sample states.
- `services/worker/parlaypal_worker/presets.py` -- `generate_curated_presets` filter loop (~L440-470), theme loop skips.

## Tasks & Acceptance

**Execution:**
- [x] Tests first: `apps/web/src/lib/presets.test.ts`, `markets.test.ts`, `services/worker/tests/test_presets.py`
- [x] `types/*`, `lib/presets.ts`, `lib/markets.ts` -- reason + flag-gated fixtures
- [x] `page.tsx`, `TerminalView.tsx`, `PresetFeed.tsx` -- empty and sample states
- [x] `presets.py` -- per-cycle drop-reason INFO log
- [ ] Task 1 (verify with `GAME_LOG_PROVIDER=moneyline`) needs a live key and running stack; recorded as not performed here.

**Acceptance Criteria:**
- Given an empty/expired/unreachable feed, when the web app renders presets, then no fixture legs appear and the reason is explicit.
- Given the dev flag, when not live, then fixtures show labelled "Sample data".
- Given a generation cycle, when candidates are dropped, then the worker logs counts by cause.

## Implementation Notes

- Epic-7 context file not compiled; planning read directly from `epics.md`.
- Gates: worker ruff/format/mypy/pytest (400) and web typecheck/vitest (217)/build all pass. Existing route tests that asserted fixture fallback now set the flag or assert the empty feed.
- Not done: Task 1 live verification (needs MoneyLine key + stack); 24h snapshot key still serves any stored snapshot as live.
- Decision: sample flag is server env `PARLAYPAL_SAMPLE_DATA` (`1`/`true`).

## Verification

**Commands:**
- `uv run --directory services/worker ruff check parlaypal_worker tests` / `ruff format --check` / `mypy parlaypal_worker tests` / `pytest -v`
- `npm --prefix apps/web run typecheck` / `npm --prefix apps/web test -- --run` / `npm --prefix apps/web run build`
