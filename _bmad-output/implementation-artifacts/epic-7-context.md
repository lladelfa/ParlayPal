# Epic 7 Context: Trustworthy Feed & Data Hygiene

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

A 2026-11-17 review showed the preset feed serving hard-coded sample fixtures ("Sample fixture leg shown while the live feed is unavailable") and "Limited history" for players expected to have history. The live Redis feed held no cards because few props had hit rates and the game-log provider was not configured. This epic makes the feed honest about empty or unavailable data, removes remaining fabricated values, canonicalises market keys, and closes Epic 6 follow-ups. Single developer, no other databases: legacy-DB upgrade hardening is out of scope.

## Stories

- Story 7.1: Honest empty state and feed diagnostics (shipped)
- Story 7.2: Remove fabricated `guarded_ev` default
- Story 7.3: Canonical prop market keys
- Story 7.4: Developer-loop chores

## Requirements & Constraints

- Missing data stays missing: no invented hit rates, EV, or fixture legs presented as real.
- Fixtures only behind an explicit dev flag and labelled "Sample data".
- A real value of exactly 0 must be preserved (use `is None` checks, never truthiness/`or`).
- Missing EV renders as absent in the UI, never as 0.00% or a default.
- Provider market spellings map to one canonical `market_key` at ingestion; unknown keys are stored as received and logged once.

## Technical Decisions

- Worker (`services/worker`) builds presets in `presets.py`; web (`apps/web`) reads them from Redis (`presets.ts`, `markets.ts`, `MarketBrowser.tsx`).
- Outlier circuit breaker: `EV_guarded > 10%` is `SUSPECT_STALE_LINE` and excluded from public feeds.
- Odds math in `Decimal`; timestamps ISO 8601 UTC.

## Cross-Story Dependencies

- 7.3 affects hit-rate computation, MoneyLine game-log stat mapping and web market filters.
- 7.4 depends on Epic 6 retro action items 3, 5 and 7.
- Epic 8 (game-centric browsing) follows Epic 7.
