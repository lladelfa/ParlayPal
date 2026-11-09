# ParlayPal - Agent Engineering Instructions

## 1. Project Overview & Architecture Stack

ParlayPal is a high-conviction sports betting intelligence platform built on a polyglot, decoupled architecture:
- **`services/worker/`**: Python 3.13 / Celery worker service managed by `uv`.
  - Owns all external provider communication (`parlay-api.com`), schedule/box-score ingestion, quantitative devigging root-solving (Brent's solver via `scipy.optimize.brentq`), and Celery background tasks.
  - Never serves browser HTTP traffic directly.
- **`apps/web/`**: Next.js 15 App Router web application (TypeScript, React 19, Tailwind CSS 4).
  - Owns UI rendering, the Server-Sent Events (SSE) live odds stream gateway (`/api/stream/odds`), lineshopper comparison, and QuickPick betslip serialization.
  - Reads exclusively from Redis 7.2 and PostgreSQL 16; never calls `parlay-api.com` directly for live feeds.
- **Backing Services**:
  - **PostgreSQL 16**: Relational persistence for durable entities (`teams`, `events`, `player_props`, `user_bets`).
  - **Redis 7.2**: Ephemeral hot odds cache (`odds:latest:{sport_key}:{event_id}`) with strict 45-second TTL, devigged EV feed cache (`ev:feed:{sport_key}`), and Pub/Sub bus (`odds:feed:{sport_key}`).

---

## 2. SDLC & Git Branching Standards

### Feature Branching Workflow (Required by Default)
- **Never commit directly to `main` for feature work or bug fixes.**
- Before starting any story, bugfix, or spec work, create and switch to a dedicated feature branch from the latest `main`:
  ```bash
  git checkout main
  git pull origin main
  git checkout -b feat/<epic-num>-<story-num>-<short-slug>
  # Example: feat/1-3-rolling-hit-rate-weather-engine
  ```
- All implementation changes, reviews, patches, and local commits must occur on the feature branch.
- PRs or human merges integrate the feature branch into `main`.

---

## 3. Test-Driven Development (TDD) Standard

All new features and engines must follow a strict **Test-Driven Development (TDD)** lifecycle:
1. **Red Phase (Tests First):**
   - Translate the story's I/O & Edge-Case Matrix and acceptance criteria into concrete unit and integration test scaffolds (`tests/test_*.py` for Python, `*.test.ts` for TypeScript) before writing production logic.
   - Run the test suite to confirm the tests fail for the expected reasons.
2. **Green Phase (Implementation):**
   - Implement the minimal, clean production code required to satisfy the failing tests.
3. **Refactor & Matrix Audit:**
   - Audit that every matrix scenario (happy paths, boundary conditions, invalid inputs, circuit breakers) is covered by at least one passing test.
   - Verify that all static typing and linting checks pass.

---

## 4. Code Quality & Verification Gates

Before completing a story or merging a feature branch, run and pass all verification checks:

### Python Worker Service (`services/worker`)
```bash
# 1. Linting with ruff
uv run --directory services/worker ruff check parlaypal_worker tests

# 2. Formatting check with ruff
uv run --directory services/worker ruff format --check parlaypal_worker tests

# 3. Static type checking with mypy
uv run --directory services/worker mypy parlaypal_worker tests

# 4. Unit and integration tests with pytest
uv run --directory services/worker pytest -v
```

### Next.js Web Application (`apps/web`)
```bash
# 1. TypeScript compilation check
npm --prefix apps/web run typecheck

# 2. Vitest unit tests
npm --prefix apps/web test -- --run

# 3. Production build verification
npm --prefix apps/web run build
```

---

## 5. Domain & Engineering Invariants

- **Odds Representation:** Execute all internal math in `Decimal` odds ($D \ge 1.01$, `le=Decimal("9999.9999")`, `allow_inf_nan=False`). Convert American odds ($+150, -110$) strictly at ingestion and display boundaries.
- **Identifiers:** Primary keys are UUID v4 (`event_id`, `prop_id`, `team_id`, `bet_id`, `user_id`). Upstream IDs must include explicit provider prefixes in `external_provider_id` (e.g., `papi_nfl_12345`).
- **Timestamps:** Enforce ISO 8601 UTC timestamps (`TIMESTAMPTZ` in PostgreSQL, `YYYY-MM-DDTHH:mm:ssZ` in JSON / Redis).
- **Outlier Circuit Breaker:** Any player prop market with calculated $\text{EV}_{\text{guarded}} > 10.0\%$ must be stamped `status = "SUSPECT_STALE_LINE"` in PostgreSQL and excluded from public Redis `ev:feed:{sport_key}` feeds.
- **Cache TTL:** Live odds and EV snapshots must expire with a strict 45-second TTL (`EX=45`).
