# Archive Report: studio-docs-honesty

**Date Archived**: 2026-11-25
**Branch**: `studio-docs-honesty` — `8dd57fc` (plan), `434a3e9` (WU1), `5bcedec` (WU2)
**Verdict**: PASS — 13/13 scenarios compliant (`verify-report.md`)

## Summary

Removed every fabrication left in the Studio docs view (`apps/studio/src/features/docs/`):
the banner's invented "cluster branches" capability, the Share Reference action (dead deep link +
`alert()`), the "live rows" metric (local record count posing as a live figure), the
placeholder-as-documentation column fallback, and Copy Schema's `alert()` — which already violated
a shipped `studio-ui-honesty` requirement whose scenarios only named the ERD pane.

## Spec Merge

| Capability | Before | After | Action |
|---|---|---|---|
| `studio-ui-honesty` | 11 req | 12 req | MODIFIED "Copy-to-clipboard actions give inline, non-blocking feedback" (title verbatim, +3 docs scenarios, `(Previously: …)` note kept per repo convention); ADDED "UI copy never claims a capability or data the product does not have" (6 scenarios) |

Checked by reading the merged file: 12 requirement titles, 0 duplicates, 36 scenarios. The MODIFIED
block replaced its predecessor in place (no surviving duplicate — the hazard named in the proposal).

## Deferred, Named

- `DocsNavSidebar.tsx` hardcoded schema grouping and its `key={t.name}` collision across schemas
  (Engram #1399).
- `useCopyFeedback` live region (`role="status"`) — must not break `App.test.tsx`'s single status.
- WU1 advisory `R3-undefined-clipboard-branch-unproved`.
- Real row counts, URL routing / deep links, `queryTable()` TODO, docs i18n.

## Lessons

- A remount key must carry the full identity (`schema.name`), not just the name (Engram #1396).
- A mutation that leaves the new code rendering alongside the restored code proves the wrong thing;
  the 2.4.7 proof was redone as a verbatim restore of the original line.
