# Sprint Change Proposal: Live Schedule & Prop Ingestion Pipeline (Epic 5 / Story 5.1)

**Date:** 2026-11-14  
**Project:** ParlayPal  
**Prepared By:** John (Product Manager)  
**Scope Classification:** Moderate (New Epic 5 + Story 5.1 added to backlog; existing Epic 1–4 implementations remain intact)

---

## Section 1: Issue Summary

When running ParlayPal locally, the web application (`apps/web`) does not display live or updated NFL and NBA games and instead renders static, mismatched hardcoded fallback fixtures (`FALLBACK_MARKET_BROWSER_FEED` in `apps/web/src/lib/markets.ts` and `FALLBACK_PRESET_FEED` in `apps/web/src/lib/presets.ts`).

**Discovery Context & Evidence:**
- Inspection of the running local PostgreSQL 16 database shows `0` rows in `teams`, `events`, `player_props`, and `user_bets`.
- Inspection of Redis 7.2 shows only `celery-task-meta-*` keys and zero `markets:browser:*`, `presets:feed:*`, or `ev:feed:*` keys.
- In `services/worker/parlaypal_worker/celery_app.py`, `beat_schedule` only registers `stamp-closing-line-value-every-minute` (`stamp_closing_line_value`). Neither `sync_preset_parlay_feed` nor `sync_market_browser_feed` is scheduled, causing any cached feed keys (with strict 45-second TTL) to expire immediately.
- No upstream schedule/prop ingestion poller exists in `services/worker` (`clv.py` is currently the only module issuing HTTP requests via `httpx`). All Epic 1 and Story 2.1 worker tasks expect payloads to already exist in PostgreSQL or be passed as arguments.

---

## Section 2: Impact Analysis

- **Epic Impact:**
  - **Epics 1–3 (`done`) & Epic 4 (`in-progress`):** Existing completed stories (1.1–3.3) and active Epic 4 stories (4.1–4.3) remain valid and do not require rollback. Their transform/sync functions (`process_and_publish_ev_props`, `update_props_hit_rates`, `ingest_events_weather`, `sync_preset_parlay_feed`, `sync_market_browser_feed`) already exist and will be orchestrated directly.
  - **New Epic 5 (`backlog`):** Added **Epic 5: Live Schedule & Prop Ingestion Pipeline** with **Story 5.1: Automated Upstream Schedule, Prop Ingestion & Beat Orchestration** (`5-1-automated-upstream-schedule-prop-ingestion-beat-orchestration`).
- **Story Impact:**
  - Story `4-3-clv-analytics-long-term-edge-reporting` remains in `backlog` under Epic 4.
  - New Story `5-1-automated-upstream-schedule-prop-ingestion-beat-orchestration` added to `backlog` under Epic 5.
- **Artifact Updates:**
  - `_bmad-output/planning-artifacts/prds/prd-parlaypal-2026-11-08/prd.md`: Added `FR-14: Automated Upstream Schedule, Prop Ingestion & Beat Orchestration`.
  - `_bmad-output/planning-artifacts/epics.md`: Added `FR-14`, updated the FR Coverage Map and Epic List, and appended Epic 5 / Story 5.1 with Acceptance Criteria.
  - `_bmad-output/implementation-artifacts/epic-5-context.md`: Created epic implementation context capturing requirements, AD-1/AD-2/AD-4 constraints, and cross-story dependencies.
  - `_bmad-output/implementation-artifacts/sprint-status.yaml`: Registered `epic-5`, `5-1-automated-upstream-schedule-prop-ingestion-beat-orchestration`, and `epic-5-retrospective`.
- **Technical Impact:**
  - Requires an upstream HTTP schedule/odds ingestion module (plus deterministic local seed fallback for offline/dev mode) in `services/worker`, idempotent PostgreSQL upserts (`teams`, `events`, `player_props`), transitioning `commence_time <= now_utc` events to `COMMENCED`, and scheduling a 30-second Celery Beat cycle so the 45-second Redis TTL stays continuously warm.

---

## Section 3: Recommended Approach

**Selected Path:** **Option 1 — Direct Adjustment (Add Epic 5 / Story 5.1)**

**Rationale:**
- All downstream quantitative engines (devigging, outlier guard, hit rates, weather badges, preset generation, market browser feed builder, and SSE streaming) are already built and tested.
- Rolling back prior stories is unnecessary; adding Epic 5 / Story 5.1 cleanly closes the missing ingestion + Beat orchestration loop without destabilizing Epics 1–4.
- **Effort Estimate:** Medium (single worker-focused story with TDD unit/integration coverage).
- **Risk Level:** Low (isolated to `services/worker`, preserving AD-1 service isolation and existing web contracts).

---

## Section 4: Detailed Change Proposals

1. **PRD (`_bmad-output/planning-artifacts/prds/prd-parlaypal-2026-11-08/prd.md`):**
   - Added **FR-14: Automated Upstream Schedule, Prop Ingestion & Beat Orchestration** under Section 4.3 detailing upstream polling (`PARLAY_API_BASE_URL` / `PARLAY_API_KEY`), deterministic local seed fallback, PostgreSQL persistence, and 30-second Celery Beat refresh cadence.
2. **Epics (`_bmad-output/planning-artifacts/epics.md`):**
   - Added **FR-14** to the Requirements Inventory and FR Coverage Map.
   - Added **Epic 5: Live Schedule & Prop Ingestion Pipeline** and **Story 5.1** with explicit Given/When/Then Acceptance Criteria.
3. **Epic Context (`_bmad-output/implementation-artifacts/epic-5-context.md`):**
   - Documented Story 5.1 boundaries, AD-1/AD-2/AD-4 compliance, and dependencies on Stories 1.1–1.4 and 2.1.
4. **Sprint Status (`_bmad-output/implementation-artifacts/sprint-status.yaml`):**
   - Added `epic-5: backlog`, `5-1-automated-upstream-schedule-prop-ingestion-beat-orchestration: backlog`, and `epic-5-retrospective: optional`.

---

## Section 5: Implementation Handoff

- **Scope Classification:** Moderate
- **Handoff Recipients & Responsibilities:**
  - **Product Manager / Spec Author (`bmad-spec`):** Draft the detailed technical specification `spec-5-1-automated-upstream-schedule-prop-ingestion-beat-orchestration.md` (I/O & Edge-Case Matrix, Code Map, API payload contract, Beat schedule) if a formal spec is desired prior to build.
  - **Developer (`bmad-build` / Amelia):** Implement Story 5.1 on a dedicated feature branch (`feat/5-1-...`) following strict TDD, ensuring `ruff`, `mypy`, and `pytest` gates pass in `services/worker` and verifying live Redis cache warming + UI updates locally.
- **Success Criteria:**
  - Running Celery worker + Beat locally populates `teams`, `events`, and `player_props` in PostgreSQL 16 and refreshes `markets:browser:*`, `presets:feed:*`, and `ev:feed:*` in Redis every 30 seconds before the 45-second TTL expires, eliminating stale fallback fixtures in the UI.
