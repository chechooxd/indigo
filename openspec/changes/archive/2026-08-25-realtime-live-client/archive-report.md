# Archive Report: realtime-live-client

**Change**: `findMany().live()` typed client for `@@realtime` + `@@allow` models (Phase 4, Slice 5 — final roadmap piece)
**Status**: ARCHIVED | Verification: **PASS WITH WARNINGS** (0 CRITICAL, 3 non-blocking)
**Verification Date**: 2026-08-25 16:33:07 UTC
**Archive Date**: 2026-08-25
**Commit Hash**: `931c74a` — sdd(archive): close realtime-live-client, merge delta specs

## What Shipped

### Core Feature: `.live()` Client API
- Generated method `findMany(args).live(handlers?)` on `RealtimeModelDelegate` for `@@realtime` + `@@allow` models only
- Initial snapshot via `findMany(args)` inside `$authSession`, bootstrapping the live query
- Debounced (50ms trailing, first-wake-armed) refetch on SSE `event: wake`
- Burst coalescing: N wakes within 50ms → exactly 1 refetch + 1 listener notification
- In-flight refetch protection: wake mid-flight → dirty flag → exactly 1 follow-up after in-flight completes
- Per-table handle cache: minted once via app-supplied `getHandle(table)`, reused across `.live()` calls until `exp`/failure
- Status lifecycle: `connecting` → `live` → `error` (never reverts without new `.live()` call)
- Handle failure/retry: one re-mint on verified failure, then `onError` + `status: "error"` if exhausted
- Teardown: decrements per-table SSE refcount; connection closes only when last subscriber (`.live()` or `.subscribe()`) ends

### Architectural Contributions to Phase 4 Roadmap
- **RLS-scoped live queries now fully functional**: every read (snapshot + all refetches) runs inside `$authSession`, preventing the silent-zero-rows bug that made `@@allow` models unreachable via realtime
- **Wake-observable client contract established**: `realtime-live-endpoint` spec now documents wake frames as a load-bearing consumer interface for `.live()`, not just server-side implementation detail
- **Handle provisioning contract pinned**: `getHandle` callback mechanism locks in the app-responsibility boundary — IndigoDB never mints handles, only provides mint/verify helpers
- **Byte-identical non-qualifying models**: `.live()` emission gated by `table.realtime && table.allow?.length`, ensuring `@@realtime`-only and non-realtime models inherit zero new generated code

## Verification Summary

Per `sdd/realtime-live-client/verify-report` (Engram #750), verified 2026-08-25 16:33:07 UTC:

### Test Evidence
- `pnpm build --force`: 10/10 packages green
- `pnpm lint --force`: 18/18 green (tsc --noEmit per package)
- `pnpm test --force`: 18/18 Turbo test tasks green
  - `@indigodb/client:test` (live.mjs): ~50 cases, all passing
  - `@indigodb/generator:test` (live-emit.mjs): all passing
- Full workspace build/lint/test independently verified clean on feature branch HEAD `8c0b97d` before merge

### Load-Bearing Claims Verified
1. **`$authSession` on every refetch** — traced: both `bootstrap()` and `refetch()` call `deps.runScoped(userId)` independently, each re-entering `$authSession` with a fresh `set_config('app.user_id', ...)` call. No bare-`findMany` path exists in live.ts, client.ts, or realtime-delegate.ts. Test coverage: implicit in every debounce/coalesce test asserting `runScoped` call counts.
2. **Debounce correctness** — traced: `if (debounceTimer !== null) return;` = armed-by-first-wake-never-re-armed (starvation guard verified in test 5.3, sustained->20/s refetch scenario). Design's flagged starvation bug is correctly fixed.
3. **Single in-flight + dirty flag** — traced: `if (inFlight) { dirty = true; return; }`, then `finally` re-runs exactly once if dirty. Test 5.5: controlled two-refetch scenario with manual releasers confirms maxConcurrent stays 1.
4. **Fresh op per refetch** — traced: closure re-invokes `d.findMany(args)` per call (bootstrap and every refetch); original bootstrap op never awaited/reused. No OPERATION_REUSED regression.
5. **`onResync` catch-up** — traced: `RealtimeConnectionManager.subscribe` forwards `onResync` only on reconnected=true; live.ts clears debounce timer and calls `refetch()` immediately. Test 7.1: refetch fires well before 50ms window.
6. **Per-table handle cache + in-flight dedup** — traced: `handleCache` Map + `handleInflight` Map on IndigoClientBase; two same-tick calls both see in-flight promise, preventing double `getHandle` call. Test verified: "two calls before either resolves → getHandle called exactly once".
7. **Generator gate byte-identity** — independently verified: rebuilt main's pre-PR generator, generated identical fixture for `@@realtime`-only model, diffed against feature branch's output: diff exit 0 (zero differences). `.subscribe()` emission confirmed unaffected.
8. **Error handling (nesting guard)** — traced: `$withSession` throws → rejected promise → caught by `.live()`'s try/catch → `onError` + `status: "error"`, never rethrowing. Test 8.1/8.2: nesting-guard message received by `onError`, no synchronous throw.

**Verdict**: Core implementation load-bearing claims all verified via code inspection and test evidence. Change is functionally complete and correct per design.

## Known Issues & Warnings

### WARNING W1: Spec Requirement 10/11 reconciliation needed at merge time (RESOLVED IN THIS ARCHIVE)

**Issue**: `client-live-queries` spec's Requirement 10 ("Only a verified handle failure triggers re-mint") was written in terms of HTTP `401` responses from the log endpoint (`GET ?handle&offset`). This slice never calls the log endpoint — it bootstraps via `findMany` and tails via SSE wake only. Reachable handle failures in this implementation are:
1. Local decode validation failure (malformed payload, bad base64url, `v!==1`, `t` mismatch, empty `u`, past/non-finite `exp`) → verified failure → re-mint
2. `getHandle()` rejection → provider failure → retry once, then error

**Resolution in this archive** (W1 RECONCILED): Updated `client-live-queries` spec Requirement 10 to explicitly mark the HTTP-401 classification as **"Forward-looking contract, refined by incremental-reconciliation slices calling the log endpoint"**. The spec now documents:
- In-this-slice behavior: local decode validation + `getHandle` rejection classification
- Future-slice contract: HTTP `401` from log endpoint will count as verified handle failure
- Other HTTP responses (5xx, 404, 400) and network failures remain transport errors

This reconciliation is documented in the merged spec text (lines 195-219 of merged `openspec/specs/client-live-queries/spec.md`) and explicitly noted as a forward-looking design contract for any future slice that calls the log endpoint from `.live()` or a related API. The spec is now accurate and complete for the scope shipped in this slice.

### WARNING W2: No committed tsc --strict check over real `generateClient()` output (pre-existing project-level gap)

**Issue**: The repository has no committed test/CI step that runs `tsc --strict` over actual generated client code (via `generateClient()`). Generator-source typecheck exists, but generated-output typecheck does not. This PR's new `.live()` generated code inherits this gap.

**Status**: Independently verified in this session (throwaway compile) that generated `.live()` code does type-check cleanly under `--strict`, but that evidence is not part of the repo. Pre-existing gap, not new to this change — realtime delegate code (`subscribe()`, `@RealtimeModelDelegate` base) similarly uncovered by any committed type-check over generated output.

**Suggested follow-up** (not blocking): Add a test fixture with `.live()` and run `tsc --strict --noEmit` over real `generateClient()` output, closing this gap for all generated client code going forward.

### WARNING W3: Actual PR size ~4x design forecast (disclosed and orchestrator-approved)

**Issue**: Design.md forecast ~330-400 lines, tasks.md rated `400-line budget risk: Medium`. Actual diff: 1,637 insertions + 15 deletions = 1,652 authored lines across 11 files under `packages/`, ~4.1x forecast.

**Status**: Not a hidden overrun. Both tasks.md's own "Review Workload Forecast" and apply-progress's findings explicitly flag the size delta. Orchestrator explicitly approved single-PR route despite "Decision needed before apply: Yes" gate. Disclosure was transparent; execution proceeded under explicit approval.

**Implications**: Real review burden on any human reviewer is substantial (the PR is essentially Phase 4's entire realtime-client epic's payoff concentrated in one shot). Flagged for awareness at merge time, not blocking archive.

## Phase 4 Roadmap Completion

This slice closes the entire originally-scoped Phase 4 architecture from issue #268:

**Originally-Scoped Architecture (NOW COMPLETE, end-to-end):**
1. ✓ Schema `@@allow` guard → RLS policy generator
2. ✓ WAL capture → realtime-log table + trigger
3. ✓ Shape log with buckets → per-identity row visibility
4. ✓ Signed-handle endpoint + SSE wake → client trigger signal
5. ✓ Typed `.live()` client → RLS-scoped live queries

All five pieces are now implemented, verified, and shipped in the mainline. Clients can now observe `@@realtime` + `@@allow` models via `.live()` with full identity-scoped guarantees.

## What Remains Deferred (Out of Scope)

**`.live()`-related (out of original Phase 4 scope, explicitly deferred):**
- `.live()` for `@@realtime` WITHOUT `@@allow` (different strategy, different SSE contract)
- Incremental / log-driven reconciliation (client-side partial updates vs full refetch)
- Log retention/pruning; Studio surfacing
- `.subscribe()`'s pre-existing wake-frame bug for `@@allow` models (known issue, out of scope)
- Type-checking generated client output via `tsc --strict` in CI (pre-existing gap, not new to this change)

## Artifacts & Traceability

### SDD Change Artifacts
- **Proposal** (Engram #745): `sdd/realtime-live-client/proposal` — scope, approach, open questions (all resolved)
- **Spec** (Engram #746): `sdd/realtime-live-client/spec` — delta specs for client-live-queries (NEW) and realtime-live-endpoint (MODIFIED), with W1 reconciliation note
- **Design** (Engram #747): `sdd/realtime-live-client/design` — 10 architecture decisions, handle-failure state machine, files, guard forecast
- **Tasks** (Engram #748): `sdd/realtime-live-client/tasks` — 15-section implementation plan (57/58 tasks completed; C2 "merge specs" is archive-phase task, not apply-scope)
- **Apply Progress** (Engram #749): sdd-apply phase report with learned findings and verification-time discoveries
- **Verify Report** (Engram #750): `sdd/realtime-live-client/verify-report` — PASS WITH WARNINGS, 0 CRITICAL, full test evidence and load-bearing claim verification

### Merged Main Specs
- **NEW**: `openspec/specs/client-live-queries/spec.md` — 13 requirements, 28 scenarios, forward-looking contract note for HTTP-401 handling (W1 reconciliation)
- **MODIFIED**: `openspec/specs/realtime-live-endpoint/spec.md` — updated SSE dispatch + Handle payload requirements, added client-observable contract text, added `.live()` consumer scenario

### Archive
- **Location**: `openspec/changes/archive/2026-08-25-realtime-live-client/`
- **Contents**: proposal.md, design.md, tasks.md (57/58 items checked), specs/ (client-live-queries, realtime-live-endpoint)
- **Verification**: Byte-identical to pre-move source (diff -r confirms zero differences)

## Deployment & Merge Notes

1. **No breaking changes**: `.live()` is purely additive; `.subscribe()` byte-identical; non-qualifying models unaffected
2. **No server-side changes**: `packages/realtime/`, `crates/`, `packages/compiler/wasm/` unchanged (WASM rebuild not needed)
3. **No migration required**: No DDL, no migration file, no schema change
4. **Rollback**: Revert emission branch (generated output byte-identical to today), delete live.ts, revert handleFrame wake branch, drop RealtimeOptions.getHandle
5. **Dependencies**: Requires INDIGODB_REALTIME_SECRET at runtime for any `@@realtime` + `@@allow` model (pre-existing requirement from Phase 4 Slice 4)

## SDD Cycle Complete

The change has been fully planned (proposal), specified (delta specs merged into main specs), designed (10 architecture decisions, state machine, file map), implemented (1,652 lines, 10 packages, 18 test tasks), verified (PASS WITH WARNINGS, 0 CRITICAL, full command evidence), and archived.

Archive date: **2026-08-25**
Archive status: **Byte-verified, W1 reconciliation complete, ready for merge to main**

---

**Archive Report** — Engram `sdd/realtime-live-client/archive-report` | OpenSpec `openspec/changes/archive/2026-08-25-realtime-live-client/archive-report.md`
