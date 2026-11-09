---
title: 'Story 1.3: Rolling Consistency Hit-Rate & Weather Ingestion Engine'
type: 'feature'
created: '2026-11-09'
status: 'done'
route: 'dispatch'
baseline_commit: '09849ad6d52ad78173d9ad4f1832c3ff6650116f'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Bettors building player prop parlays lack empirical consistency hit rates (L5, L10, season) and stadium weather context (wind, precipitation, dome status), forcing them to do manual research or bet blindly into adverse environmental conditions that crush passing and kicking props.

**Approach:** Implement a rolling consistency hit-rate and stadium weather ingestion engine in `services/worker` that processes historical player game logs across L5, L10, and season sample windows to compute empirical hit rates (formatted as `8/10 (80.0%)`) and Sofascore-style form indicators, and ingests weather forecast telemetry for outdoor NFL stadiums scheduled within 24 hours of kickoff to apply warning Context Badges (wind $\ge 15\text{ mph}$, precipitation $\ge 50\%$) and neutral dome indicators in PostgreSQL and Redis.

## Boundaries & Constraints

**Always:**
- Enforce strict TDD (Red Phase $\rightarrow$ Green Phase $\rightarrow$ Refactor) and polyglot service isolation (AD-1): all rolling hit-rate calculations, weather ingestion models, and Celery tasks reside inside `services/worker`.
- Compute rolling hit rates across three explicit windows: Last 5 games (L5), Last 10 games (L10), and Full Current Season:
  - For `selection == "OVER"`: hit when game stat $> \text{line\_value}$.
  - For `selection == "UNDER"`: hit when game stat $< \text{line\_value}$.
  - Pushes (game stat $== \text{line\_value}$) are excluded from hits (hit count not incremented, push is counted in total games or handled deterministically: $\text{hit\_rate} = \text{hits} / \text{total\_games}$).
  - Quantize calculated hit rates to `Numeric(5, 4)` (`0.0001`, e.g. `0.8000`) and provide standard formatted strings (e.g., `8/10 (80.0%)`).
  - Provide a 5-item Sofascore form tracker indicator (boolean list and emoji string `🟢🟢🟢🔴🟢`) representing the last 5 games ordered from oldest to newest (or newest to oldest with explicit metadata).
- Enforce Stadium Weather & Dome rules for NFL games scheduled within 24 hours of kickoff:
  - If the home team stadium is indoor/dome (`is_dome == True`), tag the event as `is_dome = True` with a neutral `DOME` context badge (`Indoor / Climate Controlled`).
  - If the stadium is outdoor (`is_dome == False`):
    - Tag with `WIND_WARNING` if `wind_speed_mph >= 15.0` (specifically flagging passing props `player_pass_yds` and kicking).
    - Tag with `PRECIP_WARNING` if `precip_prob >= 50.0` (flagging wet / snowy conditions).
    - Tag with `FREEZING_WARNING` if `temp_f <= 32.0`.
    - If no warning threshold is reached, tag with neutral `CLEAR` badge.
  - Persist weather metrics to `Event` table columns (`weather_wind_mph`, `weather_temp_f`, `weather_precip_prob`, `is_dome`) using `Numeric(5, 2)`.
- When updating `PlayerProp` records in PostgreSQL, synchronize `hit_rate_l5`, `hit_rate_l10`, and `hit_rate_season` and re-evaluate `HIGH_VALUE` eligibility in concert with `evaluate_two_way_prop` (where $\text{EV}_{\text{guarded}} \ge 3.5\%$ and `hit_rate_l10 >= 0.7000`).

**Never:**
- Never generate weather warning badges for indoor/dome stadiums.
- Never calculate hit rates from empty game logs without returning handled `None` / `0.0000` defaults and structured error handling.
- Never write end-user Next.js UI preset parlay cards (Story 1.4) or interactive leg customizers (Epic 2) in this story.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Standard L10 & L5 Over Hit Rate | Derrick Henry Rushing Yards (Line: 75.5, OVER); 10 games: `[82, 95, 60, 110, 88, 70, 102, 54, 85, 91]` | L5: 4/5 (`0.8000`), L10: 7/10 (`0.7000`), Form: `[True, False, True, True, True]` (`🟢🔴🟢🟢🟢`), formatted: `7/10 (70.0%)` | N/A |
| Anytime Touchdown Hit Rate | CeeDee Lamb Anytime TD (Line: 0.5, OVER); 8 games played: `[1, 0, 2, 1, 0, 1, 1, 0]` | L5: 3/5 (`0.6000`), L10/Season: 5/8 (`0.6250`), formatted: `5/8 (62.5%)` | N/A |
| Under Prop with Push | Under 25.0 Points; games: `[22, 28, 25, 20, 24]` | Hits on 22, 20, 24 (3 hits); 28 is miss, 25 is push. Hit rate = 3/5 (`0.6000`) | Push is not counted as a hit for Under |
| Sample size smaller than rolling window | Rookie with 3 career games: `[15, 22, 18]` on line 16.5 OVER | L5: 2/3 (`0.6667`), L10: 2/3 (`0.6667`), Season: 2/3 (`0.6667`), formatted: `2/3 (66.7%)` | Does not fail or divide by zero; reports exact sample denominator |
| Outdoor NFL stadium with high wind ($\ge 15\text{ mph}$) | Highmark Stadium (Outdoor); wind: 18.5 mph, temp: 28.0°F, precip: 20% | `is_dome = False`, badges include `WIND_WARNING` (`18.5 mph winds`) and `FREEZING_WARNING` (`28°F`), passes flagged | N/A |
| Indoor Dome Venue | Ford Field (Detroit, Dome); outside weather: 10°F, snow 80% | `is_dome = True`, `weather_wind_mph = 0.0`, weather badge: `DOME` (`Indoor / Climate Controlled`), no wind/precip warnings | Bypasses outdoor weather threat flags |
| Outdoor NFL stadium with rain/snow ($\ge 50\%$) | Lambeau Field; wind: 10 mph, precip: 65% (snow), temp: 31°F | `is_dome = False`, badges include `PRECIP_WARNING` (`65% precip`) and `FREEZING_WARNING` | N/A |
| Empty or invalid player game log | Player with 0 games or invalid negative stats | Returns `None` for hit rates or raises `HitRateError` if invalid data types | Validates finite numbers, avoids ZeroDivisionError |

</frozen-after-approval>

## Code Map

- `services/worker/parlaypal_worker/hit_rate.py` -- New module implementing `PlayerGameLog`, `PropHitRateResult`, `compute_rolling_hit_rate`, Sofascore form dot sequence generator, and batch prop hit-rate processor (`update_props_hit_rates`).
- `services/worker/parlaypal_worker/weather.py` -- New module implementing `StadiumWeatherForecast`, `WeatherContextBadge`, `evaluate_stadium_weather`, and batch event weather ingestor (`ingest_events_weather`).
- `services/worker/parlaypal_worker/models.py` -- Existing SQLAlchemy models (`Event`, `PlayerProp`, `Team`); leverage existing `weather_wind_mph`, `weather_temp_f`, `weather_precip_prob`, `is_dome`, `hit_rate_l5`, `hit_rate_l10`, `hit_rate_season`.
- `services/worker/parlaypal_worker/celery_app.py` -- Register `parlaypal_worker.sync_weather_and_hit_rates` Celery task.
- `services/worker/parlaypal_worker/__init__.py` -- Export public hit-rate and weather utilities.
- `services/worker/tests/test_hit_rate.py` -- New unit test suite covering TDD scenarios for L5/L10/Season hit rates, Over/Under/Push handling, small samples, and `PlayerProp` updates.
- `services/worker/tests/test_weather.py` -- New unit test suite covering TDD scenarios for outdoor wind/precip warnings, dome overrides, freezing alerts, and `Event` updates.

## Tasks & Acceptance

**Execution:**
- [x] `services/worker/tests/test_hit_rate.py`, `services/worker/tests/test_weather.py` -- **TDD Red Phase**: Scaffold failing unit tests for all I/O & Edge-Case Matrix scenarios (rolling hit rates, push handling, small sample sizes, outdoor wind/precip warnings, dome neutral badges, and database persistence) before writing production code -- Establishes verified test assertions.
- [x] `services/worker/parlaypal_worker/hit_rate.py` -- **TDD Green Phase**: Implement `PlayerGameLog`, `compute_rolling_hit_rate`, form tracker, and `update_props_hit_rates` helper -- Satisfies FR-7 rolling hit rate requirements.
- [x] `services/worker/parlaypal_worker/weather.py` -- **TDD Green Phase**: Implement `StadiumWeatherForecast`, `WeatherContextBadge`, threshold evaluation (wind $\ge 15\text{ mph}$, precip $\ge 50\%$, dome override), and `ingest_events_weather` helper -- Satisfies FR-9 weather context requirements.
- [x] `services/worker/parlaypal_worker/celery_app.py`, `services/worker/parlaypal_worker/__init__.py` -- Register Celery background tasks for weather and hit-rate processing and export public interfaces -- Integrates engines with worker substrate.
- [x] Quality Audit: Run `ruff check`, `ruff format --check`, `mypy`, and `pytest` across `services/worker` -- Verifies full pass against SDLC quality gates.

**Acceptance Criteria:**
- Given scheduled NFL and NBA games, when the worker computes player prop hit rates, then it returns L5, L10, and Season hit rates formatted as `hits/total (percentage%)` with accurate form dot strings (`🟢🟢🟢🔴🟢`).
- Given an outdoor NFL venue with wind speed $\ge 15\text{ mph}$ or precipitation $\ge 50\%$, when weather is evaluated, then warning badges (`WIND_WARNING`, `PRECIP_WARNING`) are attached, whereas indoor dome stadiums display a neutral `DOME` badge regardless of external weather.
- Given updated hit rates and weather, when persisted in PostgreSQL, then `PlayerProp.hit_rate_l5/l10/season` and `Event.weather_*` columns are correctly populated with quantized numeric values.

## Implementation Notes

- Implemented `services/worker/parlaypal_worker/hit_rate.py` with `compute_rolling_hit_rate` calculating L5, L10, and Season hit rates with push exclusions, formatted strings (`8/10 (80.0%)`), and Sofascore form tracker sequence (`🔴🟢🔴🟢🟢`).
- Implemented `services/worker/parlaypal_worker/weather.py` evaluating `StadiumWeatherForecast` against 15 mph wind, 50% precipitation, and 32°F freezing thresholds with dome bypass and neutral badges.
- Implemented `update_props_hit_rates` and `ingest_events_weather` batch database persistence helpers and wired Celery tasks `sync_player_hit_rates` and `sync_event_weather`.
- Verified all 27 pytest tests, ruff lint/format, mypy type checks, and web vitest/typechecks pass with 0 errors.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Evidence |
|---------|---------|----------|
| VG-1: `celery_app.py:114-129` — Missing unit test coverage for `sync_player_hit_rates` Celery task | `medium` | Pre-verified by verification-gap layer: `sync_player_hit_rates` was never invoked in tests. Routed to `patch`. |
| VG-2: `celery_app.py:131-146` — Missing unit test coverage for `sync_event_weather` Celery task | `medium` | Pre-verified by verification-gap layer: `sync_event_weather` was never invoked in tests. Routed to `patch`. |
| VG-3: `tests/test_hit_rate.py:212-214` — Weak assertion on `hit_rate_l10` and `hit_rate_season` in DB persistence test | `low` | Pre-verified by verification-gap layer: only checked `is not None` instead of exact Decimal values (`0.6250`). Routed to `patch`. |
| VG-4: `tests/test_weather.py:110-167` — Missing test coverage for home team dome status resolution in `ingest_events_weather` | `low` | Pre-verified by verification-gap layer: all test fixtures had `is_dome=False`. Routed to `patch`. |
| BH-1: `hit_rate.py:366` — `_to_decimal_stat` rejects negative stats (`dec < 0`), crashing valid negative rushing yard stats | `medium` | Verified at `hit_rate.py:97`: negative yardage (tackles for loss) is valid in NFL/NBA and should not raise `HitRateError`. Routed to `patch`. |
| BH-2: `hit_rate.py:214-253` — `update_props_hit_rates` does not disambiguate between different prop markets for the same player | `high` | Verified at `hit_rate.py:226-245`: applying a single stat log across multiple markets (e.g. passing yards vs TDs) corrupts hit rates; support `(player_name, market_key)` compound keys. Routed to `patch`. |
| BH-3: `weather.py:168-211` — `ingest_events_weather` does not invoke `evaluate_stadium_weather`, cache badges in Redis, or zero dome wind metrics | `medium` | Verified at `weather.py:189-205`: dome events wrote raw outdoor wind speeds, and context badges were not cached to Redis `weather:event:{event_id}`. Routed to `patch`. |
| BH-4: `weather.py:192` — `bool(item.get("is_dome") or ...)` erroneously treats explicit `{"is_dome": False}` as True if home team is dome | `medium` | Verified at `weather.py:192`: `item.get("is_dome")` being `False` caused fallback to `home_team.is_dome`. Routed to `patch`. |
| ECH-1: `hit_rate.py:145-146` — Empty `game_stats` returns uninitialized formatted strings `""` instead of `"0/0 (0.0%)"` | `low` | Verified at `hit_rate.py:145`: returning `"0/0 (0.0%)"` ensures consistent UI telemetry formatting. Routed to `patch`. |
| ECH-2: `weather.py:181-185` — Malformed non-UUID `event_id` in weather data payload crashes database query | `low` | Verified at `weather.py:182`: `select(Event).where(Event.event_id == event_id)` raises unhandled ValueError on malformed UUID strings. Routed to `patch`. |
| BH-5: `celery_app.py` — Missing `parlaypal_worker.sync_weather_and_hit_rates` coordinator task specified in Code Map | `low` | Verified at `celery_app.py:110`: Code Map listed `sync_weather_and_hit_rates`; adding the coordinator task connects both pipelines. Routed to `patch`. |
| BH-6: `hit_rate.py:44` — `PlayerGameStat` instances not accepted by `compute_rolling_hit_rate` | `low` | Verified at `hit_rate.py:86`: extracting `.stat_value` if `isinstance(val, PlayerGameStat)` allows clean object ingestion. Routed to `patch`. |

## Verification

**Commands:**
- `uv run --directory services/worker ruff check parlaypal_worker tests` -- expected: Clean linting check with exit code 0.
- `uv run --directory services/worker ruff format --check parlaypal_worker tests` -- expected: Clean format check with exit code 0.
- `uv run --directory services/worker mypy parlaypal_worker tests` -- expected: Clean static type check with exit code 0.
- `uv run --directory services/worker pytest -v` -- expected: All existing tests and new hit rate / weather tests pass with exit code 0.
- `npm --prefix apps/web run typecheck` -- expected: TypeScript compiles with exit code 0.
- `npm --prefix apps/web test -- --run` -- expected: Web tests pass with exit code 0.
