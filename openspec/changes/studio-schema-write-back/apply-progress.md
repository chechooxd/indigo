# Apply Progress: Studio schema write-back and editor diagnostics

## Scope of this batch

PR #1a only — `## Phase 1: PR #1a` from `tasks.md` (tasks 1.1–1.12). Phase 2
(`PUT /api/schema/source`) and Phase 3 (Studio UI) are NOT started; they land
on their own stacked branches per the `stacked-to-main` chain strategy.

**Mode**: Strict TDD (`node packages/cli/test/studio-schema-source.mjs` focused test).

## Completed Tasks (Phase 1)

- [x] 1.1 RED — `studio-schema-source.mjs` imports `splitDatasource`, which did not exist yet.
- [x] 1.2 GREEN — hoisted `DATASOURCE_SENTINEL`, implemented `splitDatasource`, `redactSource` is now a one-line wrapper.
- [x] 1.3 RED — GET-is-per-request test (SW-2).
- [x] 1.4 GREEN — threaded `schemaPath` into `StudioOptions`/`startStudio`, per-request read + redact, deleted the startup `publicSource` snapshot, `index.ts` wiring.
- [x] 1.5 RED — `X-Indigo-Schema-Version` header test (SW-3).
- [x] 1.6 GREEN — publish `sha256(fileBytes).hex().slice(0,16)` header on GET when `schemaPath` is set.
- [x] 1.7 RED+GREEN — no-datasource-block GET case (SW-18, read half); passed immediately once 1.2/1.4 landed, as the design predicted.
- [x] 1.8 — added `withSchemaFile(contents, fn)` to `studio-harness.mjs`, additive only.
- [x] 1.9 — reachability guard: `strictEqual(ran, 4, ...)`.
- [x] 1.10 — wired `studio-schema-source.mjs` into `packages/cli/package.json`'s `test` chain (right after `studio-server.mjs`).
- [x] 1.11 — regression: `studio-server.mjs` (unmodified) still all green after the refactor.
- [x] 1.12 — `pnpm --filter @indigodb/cli test`: all suites green together (exit 0).

## RED Evidence (actually observed, not assumed)

### 1.1 — `splitDatasource` import (before any implementation)

```
file:///.../packages/cli/test/studio-schema-source.mjs:16
import { splitDatasource, redactSource } from "../dist/studio-server.js";
         ^^^^^^^^^^^^^^^
SyntaxError: The requested module '../dist/studio-server.js' does not provide an export named 'splitDatasource'
```

Whole-suite import failure, as predicted by task 1.1 — this is the strongest possible RED (nothing in the file could even run).

### 1.3 — GET is per-request (SW-2), before `schemaPath` threading

```
FAIL GET /api/schema/source is per-request: an external edit is visible on the next GET (SW-2)
Error: expected the second GET to reflect the on-disk mutation; got:
// datasource redacted by Studio

Table User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  createdAt DateTime @default(now()) @map("created_at")
}
```

Confirms the stale-snapshot bug: the second GET still returned the pre-mutation text (no `Table Widget`).

### 1.5 — `X-Indigo-Schema-Version` header (SW-3), before header implementation

```
FAIL GET /api/schema/source publishes X-Indigo-Schema-Version, which changes with content (SW-3)
Error: expected an X-Indigo-Schema-Version header
```

### 1.7 — no-datasource-block GET, run before 1.4's GREEN landed

Passed immediately (not RED) — matches the design's explicit note ("Expected
to pass once 1.2/1.4 land unmodified"). At that point in the sequence
`schemaPath` was accepted by `withStudio`'s `...options` spread but silently
ignored by `startStudio` (not yet destructured), so the route fell back to
the startup `source` string — which, for a no-datasource fixture with no
external mutation in this test, is identical to what per-request reads
would also produce. Documented here per the strict-TDD gate rather than
silently treated as coverage.

## GREEN Evidence

After implementing 1.2/1.4/1.6:

```
  ok   splitDatasource: split/reconstruct property holds over 4 fixtures (SW-17)
  ok   GET /api/schema/source is per-request: an external edit is visible on the next GET (SW-2)
  ok   GET /api/schema/source publishes X-Indigo-Schema-Version, which changes with content (SW-3)
  ok   GET /api/schema/source: a schema with no datasource block round-trips unchanged, no sentinel (SW-18, read half)
@indigodb/cli studio-schema-source: all green
```

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1.1–1.2 | `test/studio-schema-source.mjs` | Unit | N/A (new file); `studio-server.mjs` baseline: all green before touching production code | ✅ Written (import throws) | ✅ Passed | ✅ 4 fixtures (single-line, multi-line, nested braces, CRLF) | ✅ `redactSource` reduced to a 1-line wrapper over `splitDatasource` |
| 1.3–1.4 | `test/studio-schema-source.mjs` | Integration (real HTTP server, real file on disk) | ✅ `studio-server.mjs` still green pre-change | ✅ Written (observed the stale-snapshot output above) | ✅ Passed | ➖ Single scenario (external mutation visible on next GET) | ➖ None needed |
| 1.5–1.6 | `test/studio-schema-source.mjs` | Integration | ✅ (same server) | ✅ Written (observed missing-header failure) | ✅ Passed | ✅ 2 cases (present+16-hex, and changes after mutation) | ➖ None needed |
| 1.7 | `test/studio-schema-source.mjs` | Integration | ✅ | ➖ Documented pass-before-GREEN case (see above), not a violation of the RED gate — this is the exact scenario tasks.md calls out as "expected to pass once 1.2/1.4 land unmodified" | ✅ Passed | ➖ Single scenario | ➖ None needed |
| 1.8 | `test/studio-harness.mjs` | Test infra (no production assertions of its own) | N/A — additive export only, no existing signature touched | N/A (harness helper, not a behavior under test) | ✅ Used successfully by 1.3/1.5/1.7 | ➖ N/A | ➖ None needed |
| 1.9–1.12 | `test/studio-schema-source.mjs`, `package.json` | Structural | N/A | N/A | ✅ `ran === 4` asserted and confirmed; full `pnpm --filter @indigodb/cli test` green | ➖ N/A | ➖ None needed |

### Test Summary
- **Total tests written**: 4 `check()` cases in `studio-schema-source.mjs` (`ran === 4`, asserted)
- **Total tests passing**: 4/4, plus the full pre-existing `studio-server.mjs` suite (regression) and every other pre-existing `@indigodb/cli` suite
- **Layers used**: Unit (1 — `splitDatasource` property test), Integration (3 — real `startStudio` HTTP server + real file on disk via `withSchemaFile`)
- **Approval tests** (refactoring): the pre-existing `studio-server.mjs` `redactSource` tests (unmodified) serve this role for the `redactSource` refactor — confirmed still green after 1.2, proving the one-line-wrapper refactor preserved behavior exactly
- **Pure functions created**: 1 (`splitDatasource`)

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `node packages/cli/test/studio-schema-source.mjs` → `@indigodb/cli studio-schema-source: all green` (4/4 `check()` cases) |
| Runtime harness command/scenario and exact result | `pnpm --filter @indigodb/cli test` → full chain (`studio-server.mjs` through `migrate-runner.mjs`) exit 0, no `FAIL` lines; includes real PGlite-backed HTTP server runs (not mocked) |
| Rollback boundary | Restore the deleted `const publicSource = redactSource(source);` snapshot and its `/api/schema/source` call site in `studio-server.ts`; drop `DATASOURCE_SENTINEL`/`splitDatasource`/`DatasourceSplit`/`StudioOptions.schemaPath` exports; drop `schemaPath` from `index.ts`'s `startStudio` call; drop `withSchemaFile` from `studio-harness.mjs`; drop `test/studio-schema-source.mjs` and its `package.json` chain entry. Nothing downstream (Phase 2/3) depends on any of this yet |

## Files Changed

| File | Action | What Was Done |
|------|--------|----------------|
| `packages/cli/src/studio-server.ts` | Modified | Hoisted `DATASOURCE_SENTINEL`; added `DatasourceSplit` + `splitDatasource` (single brace-depth scanner); `redactSource` is now a 1-line wrapper (unchanged exported signature); added `StudioOptions.schemaPath?: string`; deleted the startup `publicSource` snapshot; `GET /api/schema/source` now re-reads the file and calls `splitDatasource` per request when `schemaPath` is set, publishing `X-Indigo-Schema-Version`; falls back to `redactSource(source)` with no header when `schemaPath` is absent (decision 13); added `createHash` import |
| `packages/cli/src/index.ts` | Modified | Passes `schemaPath` (already in scope from `loadSchema`) into `startStudio`'s options |
| `packages/cli/test/studio-harness.mjs` | Modified (additive) | Added `withSchemaFile(contents, fn)` export; `withStudio`'s existing signature and every existing call site are untouched |
| `packages/cli/test/studio-schema-source.mjs` | Created | New suite: SW-17 property test, SW-2 per-request GET, SW-3 version header, SW-18 read-half |
| `packages/cli/package.json` | Modified | Added `studio-schema-source.mjs` to the `test` script chain |

## Deviations from Design

None — implementation matches design.md decisions 2, 5, 13, and the "one scanner" `splitDatasource` shape exactly. The `ran` count (4) differs from design's provisional placeholder of "6" — task 1.9 explicitly calls that placeholder provisional and instructs taking `N` from the actual counted run, which is what was done.

## Issues Found

None. All Phase 1 non-negotiables from the launch brief were verified directly rather than assumed:
- `redactSource`'s exported signature is unchanged; the pre-existing `studio-server.mjs` `redactSource` unit test and the `/api/schema/source` integration test both pass unmodified.
- The split/reconstruct property (non-negotiable 3) is asserted over the required 4 fixture shapes (single-line, multi-line, nested braces, CRLF) with byte-for-byte equality.
- `withStudio` needed no signature change — confirmed by diff: `studio-harness.mjs`'s only change is the new additive `withSchemaFile` export; `withStudio`'s body/signature/call sites are untouched.
- The startup snapshot bug is fixed and proven by the SW-2 RED evidence above and its GREEN confirmation.

## Remaining Tasks

- [ ] Phase 2: PR #1b — `PUT /api/schema/source` (tasks 2.1–2.37)
- [ ] Phase 3: PR #2 — Studio Save UI (tasks 3.x)

## Workload / PR Boundary

- Mode: stacked PR slice (`stacked-to-main`, `auto-chain`)
- Current work unit: Unit 1 / PR #1a — `splitDatasource` refactor, per-request GET, version header, `schemaPath` plumbing
- Boundary: starts from `main`@`760d30b` on branch `feat/studio-schema-write-back-1a`; ends at Phase 1 task 1.12 (full `@indigodb/cli` suite green). Phase 2 targets this branch next per `stacked-to-main`.
- Estimated review budget impact: forecast ~285 authored lines; actual diff is smaller (`packages/cli/src/studio-server.ts` +~120/−~20, `index.ts` +1, `studio-harness.mjs` +24, plus the new 224-line `studio-schema-source.mjs` test file) — comfortably under the 400-line/800-line budgets, Low risk confirmed.

## Root Gate (full repo)

`pnpm clean && pnpm build --force && pnpm lint && pnpm test` — all green, exit 0 at every step:
- `pnpm clean`: 10/10 tasks successful
- `pnpm build --force`: 10/10 tasks successful (cache bypassed as required)
- `pnpm lint`: exit 0 (includes Studio's `tsc -b --noEmit`)
- `pnpm test`: 18/18 Turbo tasks successful, includes `workspace pack-contents guard: all green` and `check-realtime-projection-db-gate: PASSED`; no `FAIL` lines anywhere in the full log

## Status

12/12 Phase 1 tasks complete. Ready for `sdd-apply` to continue with Phase 2 (PR #1b) on a fresh batch, or for review/PR of this Phase 1 slice.
