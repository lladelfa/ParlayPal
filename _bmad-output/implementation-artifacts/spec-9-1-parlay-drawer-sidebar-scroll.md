---
title: 'Parlay drawer sidebar scroll fix'
type: 'bugfix'
created: '2026-11-25'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** When the parlay slip grows taller than the viewport, its lower part (totals, lineshopper, QuickPick button) can't be reached. On desktop the rail (`sticky top-6`) has no height cap or overflow, so it stays pinned while its bottom sits off-screen. On mobile the bottom sheet's scroll body (`flex-1 overflow-y-auto`) has no `min-h-0`, so it never shrinks, and the `max-h-[85vh] overflow-hidden` parent clips the content instead of scrolling it.

**Approach:** Cap the desktop rail at the viewport height minus its sticky offset and let it scroll internally (`max-h-[calc(100vh-3rem)] overflow-y-auto`), and give the mobile sheet's scroll body `min-h-0` so it scrolls inside the sheet. Whole-panel scrolling is used on both. No sticky footer, because the mobile sheet already scrolls as one unit.

</frozen-after-approval>

## Implementation Notes

- `apps/web/src/components/ParlayDrawer.tsx`: desktop `<aside>` gets `max-h-[calc(100vh-3rem)] overflow-y-auto` (3rem = top-6 offset + a matching bottom gap). The mobile sheet's scroll body gets `min-h-0`.
- jsdom does no layout, so the regression tests assert the scroll-container classes on the rail and the sheet body. Real scroll behavior still needs a manual check in a browser with a slip of 4+ legs.
- Review patch: mobile sheet cap changed `85vh` → `85dvh` so the QuickPick CTA isn't hidden under mobile browser toolbars; `overscroll-contain` added to both scroll containers so slip scrolling doesn't chain to the page behind. Test now scopes the sheet-body match to the sheet markup and renders per test.

## Review Triage Log

- `vh` on mobile sheet hides bottom under toolbar — medium, patched (`85dvh`).
- No overscroll containment, swipes chain to page behind modal sheet — low, patched (one class each).
- Spec doesn't justify no sticky footer on desktop — false as a defect: whole-panel scroll is the frozen intent decision; a pinned CTA is a separate UX change.
- Tests assert class tokens, not behavior — low, rejected: vitest runs in `node` env with no layout and the repo has no browser-test framework; adding one exceeds a simple fix.
- Sheet-body assertion not scoped to sheet — low, patched (slice markup from sheet match).
- Render at module load — low, patched (`renderDrawer()` per test).
- Missing edge cases (8 legs, empty rail, header shrink) — false: classes are static across leg counts; header's `min-height:auto` keeps it from shrinking under the `min-h-0` body.
- Spec frontmatter lacks `baseline_commit`; 9-1 not in sprint-status — frontmatter: false (template has no such field); sprint tracking: deferred.
