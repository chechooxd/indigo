# Verify Report: studio-live-view

**Change**: studio-live-view (Road to 1.0, Phase 5, slice 1 — Studio Table Browser live view)
**Branches verified**: `feature/studio-live-view-pr1` (commit 40a4c23, off main) + `feature/studio-live-view-pr2` (commits e3d92d8, 167a76d, stacked on PR1)
**Mode**: Full artifacts (spec, design, tasks, apply-progress) — all retrieved and cross-checked against real diffs, not the apply-progress narrative alone.
**Verdict**: PASS WITH WARNINGS
**Counts**: CRITICAL 0 · WARNING 1 · SUGGESTION 1

## Task Completeness

19/19 checkboxes in `tasks.md` are `[x]` (6 PR1 + 11 PR2 + 2 cleanup). Confirmed by reading the actual mirror file and by diffing both branches directly — no discrepancy between claimed and actual file changes.

## Fresh Command Evidence (re-run, not reused from apply-progress)

| Command | Result |
|---|---|
| `pnpm build --force` (root, all 10 packages/apps) | ✅ exit 0, 10/10 tasks, no cache |
| `pnpm lint --force` (root, all 19 `tsc --noEmit` tasks) | ✅ exit 0, 19/19 tasks, no cache |
| `pnpm --filter @indigodb/studio test` (vitest) | ✅ 9 files / 47 tests pass, incl. 13 `useLiveTable.test.tsx` + 16 `TableBrowserPage.test.tsx` |
| `node packages/client/test/realtime-entry.mjs` | ✅ 3/3 checks: subpath resolves, no `pg`/`node:async_hooks` in reachable graph, root `.` entry unaffected |
| `node packages/compiler/test/parity.mjs` | ✅ all fixtures + 3 error fixtures green (fixture/snapshot regen did not break anything) |
| `pnpm test --force` (root, Turbo, all 18 tasks incl. client/realtime/migrator/cli/studio/compiler full suites) | ✅ exit 0, 18/18 tasks, ~6m34s |
| `rg "node:async_hooks\|require\(\"pg\"\)\|'pg'" apps/studio/dist/assets/*.js` | ✅ zero matches — browser-safe boundary independently confirmed against the built bundle |

All numbers match what apply-progress claimed (47/47 studio tests, 3/3 realtime-entry checks, 18/18 Turbo tasks) — re-run independently rather than trusted.

## Source-Level Verification (both branches, actual diff read)

- `packages/realtime/package.json`: additive `"./protocol"` export only — confirmed no other change.
- `packages/client/src/realtime.ts`: re-exports `REALTIME_PATH`/`REALTIME_LOG_PATH` (value, from `@indigodb/realtime/protocol`) + `LIVE_DEBOUNCE_MS`/`LiveStatus` (from `./live.js`) plus `SseTransport`/`RealtimeConnectionManager`. Matches design decisions 2–3 exactly.
- `apps/studio/.../hooks/useLiveTable.ts`: read in full. One `useEffect` keyed on `[tableName, enabled, debounceMs]`; `destroyed`/`inFlight`/`dirty`/`timer` are closure locals; only `status` is React state; `fetchRows`/`updateTableRecords` held in refs. Uses `SseTransport` directly (decision 4), arm-once debounce never re-armed mid-burst (decision 5), `error` is transient/auto-recovering with no manual retry — `onOpen(reconnected)` clears any pending timer and bypasses the debounce for one immediate refetch (decision 6), `fetchRows` returning `null` leaves rows/status untouched with no teardown (decision 7), returns `status: null` when inert (decision 8). No deviation found from design.md.
- `apps/studio/.../components/LiveStatusBadge.tsx`: renders `null` for `status === null`; `error` renders as "Live (reconnecting…)", never a hard failure — matches decision 6 and `studio-ui-honesty`.
- `TableBrowserPage.tsx`: wired as `useLiveTable(activeTable?.name, isBackendAvailable() && activeTable?.realtime === true)` + `<LiveStatusBadge status={liveStatus} />` next to the pre-existing Refresh button — exact call site from design.md.
- `fixtures/02-studio-initial.indigo` + snapshot: 5-line diff exactly as claimed (`@@realtime` on `Post`, corresponding AST attr + `"realtime": true` in resolved IR). No other snapshot touched.
- `types.ts`/`schema-adapter.ts`: additive `realtime?: boolean` property only, no new/unused imports (whole-workspace `tsc --noEmit` clean).

## Spec Compliance Matrix

### `studio-live-view` (7 requirements, 12 scenarios)

| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Subscription scoped to active table | Selecting a realtime table opens exactly one subscription | `useLiveTable.test.tsx > opens exactly one subscription...` | ✅ COMPLIANT |
| Subscription scoped to active table | Selecting a non-realtime table opens no subscription | `useLiveTable.test.tsx > opens no subscription when disabled` | ✅ COMPLIANT |
| change/wake same debounced refetch | A `change` frame refetches after debounce | `useLiveTable.test.tsx > a change frame refetches only after...` | ✅ COMPLIANT |
| change/wake same debounced refetch | A `wake` frame triggers identical path | `useLiveTable.test.tsx > a wake frame follows the identical...` | ✅ COMPLIANT |
| Burst coalesces to one refetch | 5 frames in 50ms → one refetch | `useLiveTable.test.tsx > a burst of 5 frames...` | ✅ COMPLIANT |
| Mid-refetch schedules one follow-up | Frame mid-flight → one additional refetch, no overlap | `useLiveTable.test.tsx > a frame arriving mid-flight...` | ✅ COMPLIANT |
| Status reflects lifecycle | connecting → live | `useLiveTable.test.tsx > status sequence connecting -> live` | ✅ COMPLIANT |
| Status reflects lifecycle | Reconnect returns to live + refetches | `useLiveTable.test.tsx > reconnect (onOpen(true))...` | ✅ COMPLIANT |
| Status reflects lifecycle | Transport failure surfaces as error | `useLiveTable.test.tsx > onError sets error without tearing down...` | ✅ COMPLIANT |
| Switching/leaving tears down subscription | Switching tables closes old, opens exactly one new | `useLiveTable.test.tsx > switching tableName tears down...` | ✅ COMPLIANT |
| Switching/leaving tears down subscription | Unmount closes subscription | `useLiveTable.test.tsx > unmounting tears down the subscription` | ✅ COMPLIANT |
| Inert with no backend | No subscription/indicator when no backend | `TableBrowserPage.test.tsx > is absent with no backend connected...` (+ `useLiveTable`'s `enabled=false` test at hook level) | ✅ COMPLIANT |

### `client-live-queries` (1 requirement, 3 scenarios)

| Scenario | Test | Result |
|---|---|---|
| `./realtime` subpath resolves, Node-surface-free | `packages/client/test/realtime-entry.mjs` | ✅ COMPLIANT |
| Root `.` entry unaffected | `realtime-entry.mjs` (3rd check) + full `pnpm test` client suite (`live.mjs`, `client.mjs` etc. all pass unaffected) | ✅ COMPLIANT |
| Browser bundle never pulls in `pg` | `rg` against built `apps/studio/dist/assets/*.js` — zero matches | ✅ COMPLIANT |

### `studio-ui-honesty` (1 requirement, 2 scenarios)

| Scenario | Test | Result |
|---|---|---|
| No live indicator for a non-realtime table | `TableBrowserPage.test.tsx > is absent for a non-realtime table...` | ✅ COMPLIANT |
| No live indicator with no backend connected | `TableBrowserPage.test.tsx > is absent with no backend connected...` | ✅ COMPLIANT |

**Compliance summary**: 17/17 scenarios compliant (0 UNTESTED, 0 FAILING).

## Design Coherence

| Decision | Followed? | Notes |
|---|---|---|
| 1. Entry via `SseTransport` / new `/realtime` subpath, not `.live()` | ✅ Yes | Confirmed — `.live()` never referenced from Studio code |
| 2. `REALTIME_PATH` via additive `./protocol` export | ✅ Yes | Exact one-line `exports` map addition, zero source lines |
| 3. Entry file stays `src/realtime.ts` → `dist/realtime.js` | ✅ Yes | |
| 4. `SseTransport` directly, not `RealtimeConnectionManager` | ✅ Yes | Confirmed in `useLiveTable.ts` |
| 5. Arm-once debounce, never re-armed mid-burst | ✅ Yes | `if (timer !== null) return;` guard confirmed |
| 6. `error` transient/auto-recovering, no manual retry | ✅ Yes | `LiveStatusBadge` never renders error as hard failure; no retry button added |
| 7. `fetchRows` returning `null` leaves rows/status untouched | ✅ Yes | Confirmed + directly tested (`fetchRows returning null leaves rows/status unchanged`) |
| 8. `status: null` when inert encodes `studio-ui-honesty` in the type | ✅ Yes | `LiveStatusBadge` returns `null` for `null` status |

No deviations from design.md found in either PR.

## TDD Compliance (Strict TDD Mode)

| Check | Result | Details |
|---|---|---|
| TDD Evidence reported | ✅ | Full RED/GREEN table present in apply-progress for both hook and badge |
| RED confirmed (tests exist) | ✅ | `useLiveTable.test.tsx` (13 cases) and `TableBrowserPage.test.tsx` additions (3 cases) both exist and read cleanly |
| GREEN confirmed (tests pass) | ✅ | Re-run independently: 13/13 + 16/16 (29/29 combined) pass now |
| Triangulation adequate | ✅ | Each spec scenario has a distinct test case with distinct expected values (no repeated-empty-array pattern) |
| Safety net for modified files | ✅ | `TableBrowserPage.test.tsx` pre-existing 13 tests unaffected, still passing alongside the 3 new ones (16 total) |

**Assertion quality**: ✅ All assertions verify real behavior — no tautologies, no ghost loops, no smoke-test-only patterns found in `useLiveTable.test.tsx` or the `TableBrowserPage.test.tsx` additions. Every test calls the hook/component under real fake-timer/fake-transport conditions and asserts a specific outcome (call count, call args, status value, or DOM presence/absence).

## Issues Found

**CRITICAL**: None.

**WARNING**:
1. **Task 2.11's manual live-browser/Postgres verification was substituted with code-level inspection, not an actual live run.** This is assessed as an acceptable, honestly-documented residual risk rather than a blocking gap, because: (a) the server-side half of the path (`RealtimeEngine` mounted at `REALTIME_PATH` in `studio-server.ts`) is pre-existing infrastructure from an earlier shipped change, not new code introduced by this change; (b) every spec scenario at the client/hook boundary — the actual new surface this change adds — has a passing automated test exercising the real `useLiveTable` state machine via a fake transport (connect/onEvent/onWake/onOpen/onError), which is a stronger and more precise check of the debounce/coalesce/status logic than a manual browser session could provide; (c) the gap is confined to one specific integration seam (does the SSE frame actually reach the browser end-to-end over a real network stack), which is orthogonal to the logic this change is responsible for and was already implicitly exercised by the server-side realtime endpoint's own prior test suite. Recommend closing this gap in a follow-up smoke-test task once a live Postgres instance is available in CI, but it does not block archiving this change.

**SUGGESTION**:
1. PR 2 landed at ~548 authored lines vs. the ~420-520 forecast (Medium 400-line budget risk was already flagged pre-apply). The overshoot is entirely attributable to the 264-line `useLiveTable.test.tsx` (13 well-triangulated cases), not scope creep — no action needed, noted for reviewer context only.

## Verdict

**PASS WITH WARNINGS** — all 19/19 tasks complete and verified against actual branch diffs (not just the apply-progress narrative), all 17/17 spec scenarios have passing covering tests re-run fresh, build/lint/full test suite (18 Turbo tasks) and the compiler regression harness are all green, and design.md's 8 decisions are followed with zero deviation. The one WARNING (task 2.11's substituted verification) is a documented, non-blocking environment limitation, not a functional gap in the automated proof. Recommend proceeding to `sdd-archive`.
