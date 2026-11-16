# Epic 6 Context: Preset Data Integrity & Truthful Conviction Copy

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

A 2026-11-15 UI review showed every preset leg with the same hit-rate badge, form dots and templated rationale, even where price contradicted it. This epic makes consistency data and conviction copy truthful: missing history is shown as missing, hit rates and form respect bet direction, rationale cites real evidence, and upstream players get real game logs. Stories are ordered by dependency; 6.1 (shipped) was the urgent trust fix.

## Stories

- Story 6.1: Remove fabricated hit-rate fallback and honest consistency badge (done)
- Story 6.2: Selection-aware hit rate for Under legs
- Story 6.3: Real recent-form dots from game logs
- Story 6.4: Evidence-based conviction rationale
- Story 6.5: Game-log ingestion for upstream players
- Story 6.6: Preset candidate quality gate and de-duplication

## Requirements & Constraints

- Never substitute a numeric default for a missing hit rate; decide missing-ness with `is None`, never truthiness (a real 0 is valid).
- A hit rate must support the pick shown: Over hits are strictly above the line, Under hits strictly below; pushes are excluded from the denominator.
- Rationale copy must make no claim the data does not support and must read in the pick's direction.
- Worker owns provider communication and computation; web reads only Redis/PostgreSQL and tolerates null fields in both camelCase and snake_case payloads.

## Technical Decisions

- Odds math stays in `Decimal`; devigging, the 10% `SUSPECT_STALE_LINE` guard and 45s Redis TTL are untouched by this epic.
- Hit-rate logic lives in the worker (`hit_rate.py`, ingestion, `presets.py`, `market_browser.py`); preset and market feeds are serialized to Redis and consumed by `apps/web/src/lib/presets.ts` and `markets.ts`.
- Missing hit rate renders as a neutral "Limited history" badge with empty form fields; presets with no history on any leg are skipped.

## Cross-Story Dependencies

- 6.3 uses the side-aware rule from 6.2; 6.4 depends on 6.1 and 6.2; 6.5 supplies the game logs that 6.2-6.4 rely on for non-seed players.
