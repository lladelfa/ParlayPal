---
title: 'Story 1.2: Quantitative Devigging & Outlier Guard Engine'
type: 'feature'
created: '2026-11-09'
status: 'done'
route: 'dispatch'
baseline_commit: '20bbcccb89dbaf3ee7d2bc984dacc792dee98c91'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Raw sportsbook player prop lines embed bookmaker vigorish (overround) and occasionally contain stale or broken pricing outliers that distort true win probabilities and expose bettors to book-voided wagers.

**Approach:** Implement a quantitative devigging and outlier-guard engine in `services/worker` that strips bookmaker margin from two-way sharp markets using both the Multiplicative method and the Power method (Brent's root-finding algorithm via `scipy.optimize.brentq`), computes guarded Expected Value ($\text{EV}_{\text{guarded}} = \min(\text{EV}_{\text{mult}}, \text{EV}_{\text{power}})$), stamps markets with $\text{EV}_{\text{guarded}} > 10.0\%$ as `SUSPECT_STALE_LINE` to exclude them from public feeds, and flags markets with $\text{EV}_{\text{guarded}} \ge 1.5\%$ as positive value in PostgreSQL and Redis.

## Boundaries & Constraints

**Always:**
- Keep all quantitative root-solving and devigging math strictly inside `services/worker` (`parlaypal_worker/devig.py`) in accordance with polyglot service isolation (AD-1 and AD-4).
- Execute all internal odds and EV calculations using `Decimal` odds ($D \ge 1.01$, `le=Decimal("9999.9999")`, `allow_inf_nan=False`), converting between American odds ($+150, -110$) and Decimal odds strictly at ingestion and display boundaries.
- Compute two-way fair probabilities using both Multiplicative ($P_{\text{fair, mult}, i} = P_i / (P_1 + P_2)$ where $P_i = 1 / D_{\text{sharp}, i}$) and Power ($\sum_{i=1}^2 P_i^k = 1.0$ solved via `scipy.optimize.brentq`, $P_{\text{fair, power}, i} = P_i^k$) methods, setting $\text{EV}_{\text{guarded}} = \min(\text{EV}_{\text{mult}}, \text{EV}_{\text{power}})$ and $P_{\text{fair}} = \min(P_{\text{fair, mult}}, P_{\text{fair, power}})$ where $\text{EV} = (P_{\text{fair}} \times D_{\text{offered}}) - 1$.
- Enforce the Outlier Circuit Breaker: any prop with $\text{EV}_{\text{guarded}} > 0.10$ ($10.0\%$) must be stamped with `status = "SUSPECT_STALE_LINE"` and excluded from public Redis `+EV` feeds (`ev:feed:{sport_key}`).
- Classify props with $0.015 \le \text{EV}_{\text{guarded}} \le 0.10$ ($1.5\% \text{ to } 10.0\%$) as positive value (`is_positive_ev = True`), and classify props with $0.035 \le \text{EV}_{\text{guarded}} \le 0.10$ ($3.5\% \text{ to } 10.0\%$) and rolling hit rate $\ge 0.70$ ($70\%$) as high value (`value_tier = "HIGH_VALUE"`).
- Quantize persisted `fair_probability` to `Numeric(6, 5)` (`0.00001`) and `guarded_ev` to `Numeric(7, 5)` (`0.00001`) to match `PlayerProp` columns in `services/worker/parlaypal_worker/models.py`.

**Never:**
- Never allow a market with $\text{EV}_{\text{guarded}} > 10.0\%$ or `status == "SUSPECT_STALE_LINE"` to be published into `ev:feed:{sport_key}`.
- Never accept two-way sharp odds with zero or negative overround ($P_1 + P_2 \le 1.0$ where no bookmaker vig exists or arbitrage input is malformed) without handled fallback or explicit validation when running the Power solver, nor accept decimal odds $< 1.01$ or non-finite values.
- Never implement rolling box-score hit-rate calculation or stadium weather ingestion (Story 1.3) or UI preset card rendering (Story 1.4) in this story.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Standard two-way sharp market with positive EV | Sharp Over/Under decimal odds `(1.9091, 1.9091)` ($-110/-110$), offered odds `2.1000` ($+110$) | $P_{\text{fair, mult}} = 0.50000$, $P_{\text{fair, power}} = 0.50000$, $\text{EV}_{\text{guarded}} = +0.05000$ ($+5.0\%$), `status = "ACTIVE"`, `is_positive_ev = True`, included in `ev:feed:{sport_key}` | N/A |
| Asymmetric two-way market (Power vs Multiplicative divergence) | Asymmetric sharp two-way odds `(1.2500, 3.6000)` with offered underdog odds `4.0000` | Solves $\sum P_i^k = 1.0$ via `brentq`; Power method penalizes longshot bias more heavily than Multiplicative, so $\text{EV}_{\text{guarded}} = \min(\text{EV}_{\text{mult}}, \text{EV}_{\text{power}}) = \text{EV}_{\text{power}}$ | N/A |
| Outlier stale line ($\text{EV}_{\text{guarded}} > 10.0\%$) | Sharp two-way odds `(1.8000, 2.0500)` with stale offered odds `2.4500` yielding $\text{EV}_{\text{guarded}} > 0.10000$ | Prop stamped `status = "SUSPECT_STALE_LINE"`, `is_positive_ev = False`, `value_tier = "SUSPECT_STALE_LINE"`, persisted to DB for audit, and excluded from `ev:feed:{sport_key}` | Logs outlier guard trigger without crashing batch processing |
| Sub-threshold value ($\text{EV}_{\text{guarded}} < 1.5\%$) | Sharp two-way odds `(1.9091, 1.9091)` with offered odds `2.0200` ($\text{EV}_{\text{guarded}} = +0.01000 = 1.0\%$) | Prop remains `status = "ACTIVE"`, `is_positive_ev = False`, `value_tier = "NEUTRAL"`, excluded from positive-value highlights in `ev:feed:{sport_key}` | N/A |
| High-value tier qualification | Active prop with $\text{EV}_{\text{guarded}} = +0.04200$ ($4.2\%$) and `hit_rate_l10 = 0.8000` ($80\% \ge 70\%$) | Flagged `is_positive_ev = True`, `is_high_value = True`, `value_tier = "HIGH_VALUE"` | Falls back to `POSITIVE_VALUE` if rolling hit rate is `None` or $< 0.7000$ |
| Invalid odds or zero/negative bookmaker overround | Decimal odds $< 1.01$, `NaN`/`Infinity`, American odds between `-99` and `+99`, or two-way sharp odds where $1/D_1 + 1/D_2 < 1.0$ | Rejects invalid odds (< 1.01 or invalid American); for sub-1.0 overround, raises `DeviggingError` with structured Problem Details (`code = "INVALID_MARKET_ODDS"`) | Raises `DeviggingError` or `ValidationError` before persisting or caching |

</frozen-after-approval>

## Code Map

- `services/worker/parlaypal_worker/devig.py` -- New module implementing American/Decimal conversion (`american_to_decimal`, `decimal_to_american`), Multiplicative and Power (`scipy.optimize.brentq`) two-way devigging, independent parlay joint fair probability (`combine_independent_fair_probabilities`), Outlier Circuit Breaker classification (`evaluate_two_way_prop`), and PostgreSQL + Redis batch evaluation (`process_and_publish_ev_props`).
- `services/worker/parlaypal_worker/models.py` -- Existing SQLAlchemy 2.0 ORM (`PlayerProp` lines 146–245); reuse `PlayerProp.fair_probability` (`Numeric(6, 5)`), `PlayerProp.guarded_ev` (`Numeric(7, 5)`), `PlayerProp.status` (`ACTIVE` / `SUSPECT_STALE_LINE`), and `PlayerProp.hit_rate_l10` without modifying existing table schemas.
- `services/worker/parlaypal_worker/redis_client.py` -- Existing Redis 7.2 cache/pub-sub client; extend with a shared `ConnectionPool` helper (`get_redis_pool`) and typed `EvaluatedPropFeedItem` model for `cache_ev_feed` while preserving existing `publish_odds_delta` and `OddsDeltaFrame` contracts.
- `services/worker/parlaypal_worker/celery_app.py` -- Existing Celery worker entry point; register `parlaypal_worker.evaluate_prop_markets` task to devig incoming two-way prop batches and publish non-outlier positive-EV items to `ev:feed:{sport_key}`.
- `services/worker/parlaypal_worker/__init__.py` -- Package root; export public devigging interfaces if needed.
- `services/worker/tests/test_devig.py` -- New pytest test suite verifying Multiplicative vs Power solver accuracy, longshot bias guarding, $\text{EV} > 10\%$ `SUSPECT_STALE_LINE` exclusion, $\text{EV} \ge 1.5\%$ positive value flagging, $\text{EV} \ge 3.5\%$ + $70\%$ hit-rate high-value badge tiering, American/Decimal conversions, DB persistence, and Celery/Redis feed caching.

## Tasks & Acceptance

**Execution:**
- [x] `services/worker/parlaypal_worker/devig.py` -- Implement `DeviggingError`, `american_to_decimal`, `decimal_to_american`, `devig_multiplicative`, `devig_power` (using `scipy.optimize.brentq` on $f(k) = P_1^k + P_2^k - 1 = 0$), `evaluate_two_way_prop`, `combine_independent_fair_probabilities`, and `process_and_publish_ev_props` -- Provides the core AD-4 multi-method devigging math, outlier circuit breaker ($\text{EV} > 10.0\%$), and value tier classification ($\text{EV} \ge 1.5\%$ and $\ge 3.5\%$).
- [x] `services/worker/parlaypal_worker/redis_client.py`, `services/worker/parlaypal_worker/celery_app.py` -- Add `EvaluatedPropFeedItem` Pydantic schema, reusable Redis connection pool support, and the `parlaypal_worker.evaluate_prop_markets` Celery task that runs `evaluate_two_way_prop` and caches active positive-EV props in `ev:feed:{sport_key}` (45s TTL) -- Connects the quantitative devigging engine to the worker task queue and Redis hot cache while filtering out `SUSPECT_STALE_LINE` props.
- [x] `services/worker/tests/test_devig.py` -- Write comprehensive unit and integration tests covering all I/O & Edge-Case Matrix scenarios, Brent root-solver convergence across symmetric and heavily skewed markets, `PlayerProp` database updates, and Redis `ev:feed:{sport_key}` exclusion of `SUSPECT_STALE_LINE` markets -- Verifies mathematical accuracy and circuit-breaker invariants.

**Acceptance Criteria:**
- Given a two-way player prop market with sharp sportsbook lines, when the devigging engine executes, then it calculates fair probability $P_{\text{fair}}$ using the Power method (Brent root solver) and Multiplicative method, setting $\text{EV}_{\text{guarded}} = \min(\text{EV}_{\text{mult}}, \text{EV}_{\text{power}})$.
- Given a market whose calculated $\text{EV}_{\text{guarded}} > 10.0\%$, when evaluated and processed by the worker, then its status is stamped `SUSPECT_STALE_LINE` in PostgreSQL and it is excluded from the public Redis `ev:feed:{sport_key}` cache.
- Given markets with $1.5\% \le \text{EV}_{\text{guarded}} \le 10.0\%$, when evaluated and processed by the worker, then they are flagged as positive value (`is_positive_ev = True`), upgraded to `HIGH_VALUE` when $\text{EV}_{\text{guarded}} \ge 3.5\%$ and rolling hit rate $\ge 70\%$, and published to `ev:feed:{sport_key}` with a 45-second TTL.

## Implementation Notes

- Implemented `parlaypal_worker/devig.py` with `DeviggingError` (structured Problem Details `INVALID_MARKET_ODDS`), boundary American/Decimal conversions (`american_to_decimal`, `decimal_to_american`), two-way Multiplicative (`devig_multiplicative`) and Brent Power root-solving (`devig_power` via `scipy.optimize.brentq`), independent cross-game parlay joint fair probability (`combine_independent_fair_probabilities`), `evaluate_two_way_prop`, and `process_and_publish_ev_props`.
- Extended `parlaypal_worker/redis_client.py` with `get_redis_pool`, `EvaluatedPropFeedItem` (enforcing `status == "ACTIVE"` and `guarded_ev <= 0.10000`), and outlier-guarded `cache_ev_feed`.
- Registered `parlaypal_worker.evaluate_prop_markets` in `parlaypal_worker/celery_app.py` and added unit and integration tests in `services/worker/tests/test_devig.py`.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Evidence |
|---------|---------|----------|
| VG-1: `services/worker/parlaypal_worker/devig.py:629-669` — Updating an existing `PlayerProp` row in `process_and_publish_ev_props` is never tested | `medium` | Pre-verified by verification-gap layer: `test_devig.py` only runs `process_and_publish_ev_props` against an empty `player_props` table, leaving the `existing_prop is not None` branch and `existing_prop.hit_rate_l10` fallback unexercised. Routed to `patch`. |
| ECH-1: `services/worker/parlaypal_worker/devig.py:140-146` — `american_to_decimal` raises uncaught `InvalidOperation` on extreme magnitudes (`>= 1e26`) | `low` | Verified at `devig.py:145`: `raw_decimal.quantize(ODDS_QUANTIZE)` raises `decimal.InvalidOperation` before `_validate_decimal_odds` runs when integer digits exceed Decimal context precision. Routed to `patch`. |
| ECH-2: `services/worker/parlaypal_worker/devig.py:377-384` — Extreme stale `offered_odds` produces `guarded_ev >= 100.00000`, overflowing `Numeric(7, 5)` | `medium` | Verified at `devig.py:377-384` and `models.py:214`: `offered_odds` up to `9999.9999` can produce `guarded_ev > 99.99999`, which overflows PostgreSQL `NUMERIC(7,5)`. Clamping quantized EV to `[-99.99999, 99.99999]` preserves outlier detection and column safety. Routed to `patch`. |
| ECH-3: `services/worker/parlaypal_worker/devig.py:468-485` — `TwoWayPropMarketInput` coerces `bool` to `Decimal` on hit-rate and odds fields | `low` | Verified at `devig.py:449-485`: Pydantic coerces `True`/`False` to `Decimal('1')`/`Decimal('0')` unless rejected by a pre-validator, unlike `_to_finite_decimal`. Routed to `patch`. |
| ECH-4: `services/worker/parlaypal_worker/devig.py:628-689` — Duplicate `external_provider_id` or `prop_id` in same batch with `autoflush=False` causes `IntegrityError` | `medium` | Verified at `db.py:56` and `devig.py:631-689`: because `create_session_factory` sets `autoflush=False`, a second occurrence of a newly added prop in the same batch is not visible to `session.scalar(select(PlayerProp)...)` without flushing. Routed to `patch`. |
| ECH-5: `services/worker/parlaypal_worker/devig.py:642-688` — Mid-batch exception in `process_and_publish_ev_props` does not roll back `session` | `medium` | Verified at `devig.py:628-766`: if a later item in `prop_markets` raises `DeviggingError`, earlier mutations on `session` remain uncommitted and unrolled-back. Routed to `patch`. |
| ECH-6: `services/worker/parlaypal_worker/redis_client.py:207-240` — `EvaluatedPropFeedItem` allows `guarded_ev < 0.01500` | `medium` | Verified at `redis_client.py:207-240`: `guarded_ev` enforces `le=OUTLIER_GUARD_MAX_EV` (`0.10000`) but lacks `ge=Decimal("0.01500")` and `HIGH_VALUE` tier consistency validation. Routed to `patch`. |
| ECH-7: `services/worker/parlaypal_worker/redis_client.py:341-363` — Dict branch in `cache_ev_feed` allows mismatched `sport_key`, non-`ACTIVE` status, or invalid `guarded_ev` | `medium` | Verified at `redis_client.py:341-363`: dict items can overwrite `sport_key` in `{"sport_key": validated_sport_key, **item}`, bypass `EvaluatedPropFeedItem` when missing keys, or raise `InvalidOperation` on non-numeric `guarded_ev`. Routed to `patch`. |
| ECH-8: `services/worker/parlaypal_worker/celery_app.py:63-98` — `evaluate_prop_markets` defaults `session=None` and skips PostgreSQL persistence when called by Celery | `high` | Verified at `celery_app.py:68-92`: when `session` is not passed, `evaluate_prop_markets` forwards `session=None` instead of opening a session via `create_session_factory()`. Routed to `patch`. |
| BH-1: `services/worker/parlaypal_worker/celery_app.py:63-98` — Celery task never opens a PostgreSQL `Session` when `session is None` | `high` | Verified at `celery_app.py:68-92`: same root cause as ECH-8. Routed to `patch`. |
| BH-2: `services/worker/parlaypal_worker/redis_client.py:207-240` — Missing lower-bound EV validation (`>= 0.01500`) and `HIGH_VALUE` invariant check on `EvaluatedPropFeedItem` | `medium` | Verified at `redis_client.py:207-240`: same root cause as ECH-6. Routed to `patch`. |
| BH-3: `services/worker/parlaypal_worker/redis_client.py:341-363` — Dict fallback in `cache_ev_feed` bypasses `EvaluatedPropFeedItem` validation | `medium` | Verified at `redis_client.py:341-363`: same root cause as ECH-7. Routed to `patch`. |
| BH-4: `services/worker/parlaypal_worker/devig.py:614-766` — Mid-batch exception leaves SQLAlchemy `Session` unrolled-back | `medium` | Verified at `devig.py:628-766`: same root cause as ECH-5 (note: raising `DeviggingError` on invalid market odds is mandated by the spec I/O Matrix, while rolling back the session on error prevents dirty session state). Routed to `patch`. |
| BH-5: `services/worker/parlaypal_worker/devig.py:249-267` — Extreme skews in `[1.01, 9999.9999]` can quantize fair probability to `0.00000` or `1.00000` | `low` | Verified at `devig.py:265-266,373-375`: clamping quantized fair probabilities to `[Decimal("0.00001"), Decimal("0.99999")]` preserves strict `(0, 1)` bounds across all valid odds. Routed to `patch`. |
| BH-6: `services/worker/parlaypal_worker/devig.py:373-384` — `ev_mult_q` and `ev_power_q` computed from unquantized `p_mult_raw` and `p_power_raw` | `false` | Refuted: keeping full Decimal precision during `(p_raw * d_offered) - 1` and quantizing at the output boundary prevents intermediate rounding drift and is verified by `test_asymmetric_two_way_market_power_vs_multiplicative_divergence`. |
| BH-7: `services/worker/parlaypal_worker/devig.py:655-669` — Updating `existing_prop` does not synchronize `player_name`, `market_key`, `selection`, `team_id`, or `updated_at` | `low` | Verified at `devig.py:655-669`: updating metadata fields and `updated_at = now_utc` on `existing_prop` keeps existing rows consistent with new rows. Routed to `patch`. |
| BH-8: `services/worker/parlaypal_worker/devig.py:495-539` — `offered_odds` / `sharp_odds` aliases accept positive numbers as Decimal odds | `false` | Refuted: `offered_odds` and `sharp_odds` are explicit Decimal odds aliases matching `evaluate_two_way_prop`, while American odds use explicit `*_american_odds` keys. |
| BH-9: `services/worker/parlaypal_worker/celery_app.py:72-83` — Dict payload missing `markets`/`props`/`items` key silently defaults to `[]` | `low` | Verified at `celery_app.py:74-79`: checking that a dict payload contains one of `markets`, `props`, or `items` prevents silent key-typo bugs while still allowing an explicit empty list `[]`. Routed to `patch`. |
| BH-10: `services/worker/tests/test_devig.py` — Missing test coverage for Celery DB persistence and `EvaluatedPropFeedItem` sub-threshold EV rejection | `medium` | Verified at `test_devig.py:442-515`: same root cause as VG-1, ECH-6, and ECH-8 (spec-edit portion rejected per step-04 rule). Routed to `patch`. |

## Verification

**Commands:**
- `uv run --directory services/worker pytest` -- expected: All existing substrate tests (`test_substrate.py`) and new devigging/outlier-guard tests (`test_devig.py`) pass with exit code 0.
- `npm --prefix apps/web test -- --run` -- expected: All Next.js unit tests continue to pass with exit code 0.
