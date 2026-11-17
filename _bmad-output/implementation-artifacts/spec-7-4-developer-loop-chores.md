---
title: 'Story 7.4: Developer-Loop Chores'
type: 'chore'
created: '2026-11-17'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 6 retro items 3, 5 and 7 are open: MoneyLine credit balance and request count are invisible between beat cycles, planning docs are stale (no 6.7 in `epic-6-context.md`, Carson Beck open question in `epics.md`, 6.5 game-log ledger entry unresolved), `git_flow.py` has no commit-only command, and `AGENTS.md` omits the `ml:*` Redis key families.

**Approach:** Log `x-credits-remaining` and the per-cycle request count at INFO each game-log cycle; reconcile the three planning docs; add a `commit` subcommand (commit only, never push, blocks main/master) and document when to use it; list `ml:roster:*`, `ml:gamelog:*`, `ml:rl:*` and their TTLs in `AGENTS.md`.

</frozen-after-approval>

## Implementation Notes

- Decision: `MoneyLineClient` stores the last parsed `credits_remaining` (None when the header is absent or not an integer); `summary()` includes it and the existing cycle INFO log in `game_logs.py` already emits `summary()`, so the credit balance and call count appear every cycle.
- Decision: `commit` reuses `cmd_ship(..., no_push=True)` so staging and main-protection behaviour stay identical; `ship --no-push` remains.
- Decision: sprint-status 7-3 moved to `done` (accepted, PR #34 merged); retro action items 3, 5, 7 marked `done` on completion.
- Redis TTLs: `ml:roster:*` 7d (`moneyline_roster_ttl_seconds`), `ml:gamelog:*` 20h (`moneyline_log_ttl_seconds`), `ml:rl:*` 70s.
- Files: `moneyline.py`, `tests/test_moneyline.py`, `_bmad/scripts/git_flow.py`, `tests/test_git_flow.py`, `AGENTS.md`, `epic-6-context.md`, `epics.md`, `deferred-work.md`, `sprint-status.yaml`.

## Review Triage Log

Self-review (no subagent reviewers authorised): no findings. Gates: ruff, format, mypy, pytest pass; web untouched.
