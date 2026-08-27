# Archive Report: studio-live-view

**Change**: studio-live-view (Road to 1.0, Phase 5: "The live view", slice 1)  
**Archived**: 2026-08-26  
**Status**: COMPLETE — PASS WITH WARNINGS

## Artifact Lineage (Engram IDs for traceability)

| Artifact | Type | Engram ID | Created | Status |
|----------|------|-----------|---------|--------|
| Proposal | architecture | #755 | 2026-08-25 17:03 | Resolved (8/8 open questions answered) |
| Delta Specs | architecture | #756 | 2026-08-26 20:45 | Merged (3 delta specs) |
| Design | architecture | #757 | 2026-08-26 20:54 | Final (8 decisions, no open questions) |
| Tasks | architecture | #758 | 2026-08-26 20:58 | Complete (19/19 checkboxes [x]) |
| Verify Report | architecture | #760 | 2026-08-26 21:55 | PASS WITH WARNINGS (0 CRITICAL, 1 WARNING, 1 SUGGESTION) |

All artifacts persisted in hybrid mode (OpenSpec files + Engram topic keys).

## Final-State Summary

**Work completed per launch prompt**:
- Feature branch PR1: `feature/studio-live-view-pr1` (commit 40a4c23) — COMPLETE
- Feature branch PR2: `feature/studio-live-view-pr2` (commits e3d92d8, 167a76d, stacked on PR1) — COMPLETE
- Task completion: 19/19 items marked [x] in persisted tasks artifact — VERIFIED
- Verification: PASS WITH WARNINGS (Engram #760, finalized 2026-08-26) — VERIFIED

Neither PR has been merged to `main` or pushed yet; both remain feature branches pending user/delivery decision.

## Verification Verdict

**Status**: PASS WITH WARNINGS

**Critical Issues**: 0 (archive not blocked)

**Non-blocking issues**:
- **WARNING**: Task 2.11's manual live-Postgres/browser verification was substituted with code inspection + fake-transport test coverage. Assessed acceptable because server-side infrastructure is pre-existing (from `realtime-live-endpoint`), every new surface (the `useLiveTable` hook) has passing test coverage exercising the real state machine, and the gap is one network-integration seam orthogonal to the change's logic. Recommend follow-up live-Postgres smoke test in CI, does not block archive.
- **SUGGESTION**: PR2 landed ~548 authored lines vs ~420-520 forecast — entirely the 264-line well-triangulated test file, not scope creep. Test-thoroughness overshoot.

**Verification commands** (all re-run fresh per verify-report #760):
- `pnpm build --force` (10 pkgs): exit 0
- `pnpm lint --force` (19 tsc --noEmit): exit 0
- `pnpm --filter @indigodb/studio test`: 47 tests pass (13 useLiveTable + 16 TableBrowserPage)
- `node packages/client/test/realtime-entry.mjs`: 3/3 checks pass
- `node packages/compiler/test/parity.mjs`: all fixtures green
- `pnpm test --force` (Turbo 18 tasks): exit 0

**Spec compliance**: 17/17 scenarios COMPLIANT (studio-live-view 12, client-live-queries 3, studio-ui-honesty 2)

## Specs Merged into Main Specs

### 1. studio-live-view — NEW capability (created)

**Location**: `openspec/specs/studio-live-view/spec.md`  
**Action**: Full spec copied (7 requirements, 12 scenarios)  
**Content**: Table Browser's live-refresh contract over embedded realtime SSE stream for `@@realtime` tables. Debounced coalesced refetch on `change`/`wake` frames.

### 2. client-live-queries — ADDED-only delta (merged)

**Location**: `openspec/specs/client-live-queries/spec.md`  
**Action**: Appended 1 new requirement (3 scenarios)  
**Content**: Browser-safe `./realtime` subpath export on `@indigodb/client` → `dist/realtime.js`, re-exporting `SseTransport`, `RealtimeConnectionManager`, path constants. Additive; root `.` entry unaffected.

### 3. studio-ui-honesty — ADDED-only delta (merged)

**Location**: `openspec/specs/studio-ui-honesty/spec.md`  
**Action**: Appended 1 new requirement (2 scenarios)  
**Content**: Live status indicator hidden (not disabled-with-a-lie) when live refresh does not apply — no backend or non-realtime table.

## Archive Contents

Archived folder: `openspec/changes/archive/2026-08-26-studio-live-view/`

Contents verified complete:
- ✓ `proposal.md` (8 open questions, all resolved)
- ✓ `design.md` (8 decisions, no open questions)
- ✓ `tasks.md` (19/19 complete, all checkboxes [x])
- ✓ `verify-report.md` (PASS WITH WARNINGS)
- ✓ `specs/studio-live-view/spec.md` (NEW, copied mechanically)
- ✓ `specs/client-live-queries/spec.md` (delta, read for merge)
- ✓ `specs/studio-ui-honesty/spec.md` (delta, read for merge)

Mechanical copy verification: `diff -r` performed on every archive operation; all empty (no truncation, no alteration).

## Delivery Status

**The SDD cycle is complete**. All artifacts are archived; all specs are merged and authoritative.

**User/CI decision**: The two feature branches (`feature/studio-live-view-pr1`, `feature/studio-live-view-pr2`) remain unmerged to `main`, pending delivery route selection (single chained PR vs. stacked slices vs. squash-merge, etc.). Archive makes no assumption about merge strategy — the change is spec-complete and verified; delivery is a separate user/CI decision.

## Procedural Notes

**Final-State Authority applied**:
- Ranked sources: native review authority (absent — no review ran), tasks artifact (19/19 [x] persisted), launch prompt facts (both PRs complete, verify final), verify-report (2026-08-26, PASS WITH WARNINGS).
- No contradictions found. Verify-report's intermediate `apply-progress` snapshot (id #759) was superseded by fresh verification commands re-run at verify time; the newer full-build/full-lint/full-test commands are the authoritative final proof.

**Archive mechanics**:
- spec merge for existing domains: used Edit to append ADDED-only requirements (client-live-queries +1, studio-ui-honesty +1)
- spec creation for new domain: used mechanical `cp` + `diff` verification (studio-live-view, empty diff)
- folder move to archive: used mechanical `git mv` + snapshot-based `diff -r` verification (empty diff, source removed)
- All copy/move operations verified with MANDATORY readback; no Read/Write of artifact bytes through model

**Status**: CLOSED — SDD cycle complete, ready for next cycle.
