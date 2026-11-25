# Verify Report: studio-docs-honesty

**Date**: 2026-11-24
**Branch**: `studio-docs-honesty` — `434a3e9` (WU1), `5bcedec` (WU2)
**Verdict**: PASS — archive-ready

## Task Completion

| Unit | Tasks | Status |
|---|---|---|
| WU1 — Copy feedback | 1.1-1.5 | Complete, committed `434a3e9` after native review (1 CRITICAL fixed: schema-qualified `DdlPanel` key) |
| WU2 — Static removals | 2.1-2.5 | Complete, committed `5bcedec`; 2.4.3 N/A (2.4.2 passed on first run, adapter already threads `note`) |

Unchecked tasks in `tasks.md`: 0.

## Build / Lint / Test

| Check | Result |
|---|---|
| `pnpm --filter @indigodb/studio test` | exit 0 — 34/34 files, 281/281 tests, `pack-contents: OK` |
| `pnpm lint` | exit 0 — 21/21 Turbo tasks |
| `pnpm build` | exit 0 — 11/11 Turbo tasks |
| `node apps/studio/test/pack-contents.mjs` (after `~/.npm` ownership fix, no temp cache) | exit 0 |

## Spec Compliance (delta `specs/studio-ui-honesty/spec.md`)

### ADDED — UI copy never claims a capability or data the product does not have

| Scenario | Test | Status |
|---|---|---|
| Banner keeps factual sentence, drops fabricated one | `DocBrowserPage.test.tsx` › banner drops the fabricated "cluster branches" sentence | COMPLIANT |
| Undocumented column shows honest absence marker | `ColumnsSpecTable.test.tsx` (cell named exactly "No description", fallback literal absent) | COMPLIANT |
| Documented column renders its real note verbatim | `ColumnsSpecTable.test.tsx` (cells named exactly "Unique identifier"/"Soft-delete timestamp"; marker count = 1) | COMPLIANT |
| Mixed documented/undocumented columns | `ColumnsSpecTable.test.tsx` + `column-notes.pipeline.test.ts` (fixture pinned to real `parse`→`resolve`→`resolvedToTables`) | COMPLIANT |
| No fabricated live-row metric for any table | `DocBrowserPage.test.tsx` › 3-row and 0-row tables | COMPLIANT (see note 1) |
| No share or reference-link action | `DocBrowserPage.test.tsx` › offers no share action; `shareReference` deleted, no `#docs` fragment left in `features/docs` | COMPLIANT |

### MODIFIED — Copy-to-clipboard actions give inline, non-blocking feedback

| Scenario | Test | Status |
|---|---|---|
| Copying DSL code shows inline confirmation (ERD) | `DslEditorToolbar.test.tsx`, unedited, 7/7 | COMPLIANT |
| No untranslated copy in fixed confirmation paths | `DslEditorToolbar.test.tsx` (unchanged) | COMPLIANT |
| Copy Schema shows inline confirmation and clears | `DocBrowserPage.test.tsx` › writes the exact DDL, shows inline "Copied", never alerts, and clears | COMPLIANT |
| Rejected write: no dialog, no false confirmation | `DocBrowserPage.test.tsx` › rejected clipboard write | COMPLIANT |
| Copy Schema writes the active table's real DDL | `DocBrowserPage.test.tsx` (asserts `writeText` with the rendered DDL block's text) + table-switch remount tests | COMPLIANT |

13/13 scenarios compliant. Every negative test has a recorded mutation proof (`apply-progress.md`).

## Leftover Scan

`grep -rn -e "alert(" -e "#docs" -e "live rows" -e "cluster branch" -e "Share" -e "system column value" apps/studio/src/features/docs` (non-test) → no matches.

## Notes (non-blocking)

1. The live-row scenario says "connected or not"; tests seed `resolvedSchema: null` only. The removed
   metric no longer exists in any code path, so connection state cannot reintroduce it.
2. WU1 review advisory `R3-undefined-clipboard-branch-unproved` (`useCopyFeedback.test.tsx`: the
   `navigator.clipboard` undefined branch is not separately proved) stays as later work.
3. Benign React duplicate-key warning from `DocsNavSidebar`'s `key={t.name}` with same-named tables
   across schemas — out of scope, pairs with the named `DocsNavSidebar` follow-up.
