# Archive Report: Transactions Epic (`$transaction`)

**Status**: ARCHIVED
**Date**: 2026-08-11
**Archived to**: `openspec/changes/archive/2026-08-11-transactions-epic/`
**Roadmap Impact**: Closes Phase 2 ("Make it an ORM"), Epic 1 of 8 — "Transactions"

## Artifact Traceability (Engram)

All artifacts retrieved and verified complete:

| Artifact | Type | Observation ID | Status |
|----------|------|---|---|
| sdd/transactions-epic/proposal | architecture | #511 | Approved scope, dependencies, rollback plan |
| sdd/transactions-epic/spec | architecture | #512 | Full specs + post-verify amendment note |
| sdd/transactions-epic/design | architecture | #513 | Technical approach, file changes, threat matrix |
| sdd/transactions-epic/tasks | architecture | #514 | 37/37 implementation tasks (Phases 1-8) |
| sdd/transactions-epic/verify-report | architecture | #516 | Re-verification PASS after remediation |
| sdd/transactions-epic/archive-report | architecture | #517 | This report |

## Scope Delivered

### New Capability: client-transactions
- Interactive `$transaction(fn)` callback form on `IndigoClientBase`
- One exclusive session per transaction via `pool.connect()` (pg path) or `db.transaction` hook (injected path)
- Commit on success, rollback on throw or rejection
- Session always released in `finally` block
- Nested transactions prevented: compile-time (`tx` never exposes `$transaction`) + runtime (`AsyncLocalStorage` guard)
- Unsupported executors fail with explicit error
- Typed delegates bound to transaction session
- 9 requirements, 11 scenarios — all covered by regression tests

### Modified Capability: client-executor-injection
- Added optional `transaction?: <T>(fn: (exec: Executor) => Promise<T>) => Promise<T>` field to `IndigoClientOptions.db`
- Existing requirements unchanged when field is absent
- 1 new requirement, 3 scenarios (hook present/absent behavior)

**Specification Domains Merged**:
- `openspec/specs/client-transactions/spec.md` (new, full spec)
- `openspec/specs/client-executor-injection/spec.md` (merged delta: 1 requirement + 3 scenarios appended)

## Implementation Completeness

**Task Gate**: PASS — All 37 implementation tasks marked complete in `tasks.md`

Breakdown by phase:
- Phase 1 (Slice 1 Types): 2/2 tasks
- Phase 2 (Slice 1 RED Tests): 7/7 tasks
- Phase 3 (Slice 1 GREEN): 6/6 tasks
- Phase 4 (Slice 1 Verification): 2/2 tasks
- Phase 5 (Slice 2 RED Tests): 5/5 tasks
- Phase 6 (Slice 2 GREEN): 6/6 tasks
- Phase 7 (Slice 2 Verification): 1/1 tasks
- Phase 8 (Remediation — pg.Pool coverage): 4/4 tasks

## Verification History and Remediation

**Initial Verification (first pass)**: Flagged 2 CRITICAL issues

1. **CRITICAL #1**: pg.Pool path untested
   - **Finding**: Original test suite used only the PGlite injected-harness path; `pool.connect()` / raw BEGIN/COMMIT/ROLLBACK never exercised against a real PostgreSQL wire protocol.
   - **Remediation**: Added Phase 8 tasks (8.1–8.4). Implemented `pglite-socket-harness.mjs` fronting PGlite with `@electric-sql/pglite-socket` wire protocol, and `transactions-pg.mjs` exercising the real `pg.Pool` path with 5 checks (dedicated-connection checkout via `max: 1` pool starvation, commit persistence, rollback after throw, sequential release, no hang/leak). PGlite's single-writer limitation is documented in the harness.
   - **Closure Evidence**: Live-executed test suite: `pnpm --filter @indigodb/client test` → 21/21 passing (10 client.mjs + 6 transactions.mjs + 5 transactions-pg.mjs).

2. **CRITICAL #2**: Unreachable `tx.$transaction` runtime error branch
   - **Finding**: The spec required `tx.$transaction(...)` to reject with a "nested transactions are not supported" error at runtime, but the design never exposes `$transaction` on the transaction-scoped object (`Executor` / generated `TransactionClient`), making that runtime error unreachable and creating a spec-implementation divergence.
   - **Remediation**: Post-verify, the spec was amended (amendment note at top of `client-transactions/spec.md`) to match the shipped design: nesting through `tx` is prevented structurally (compile-time — no such member exists), while reentrant calls on the same client instance are prevented by the `AsyncLocalStorage` guard (runtime). No new code needed; the spec was corrected to match the intentional, safer product decision.
   - **Closure Evidence**: Spec amended. `tx`'s type (`Executor` / `TransactionClient`) never declares a `$transaction` member (source inspection: `client.ts`, `generator/src/client.ts`). Generator test `transaction-emission.mjs` includes an explicit assertion "TransactionClient never exposes $transaction" (PASS).

**Re-verification (second pass)**: **PASS** — 0 CRITICAL, 0 WARNING, 1 SUGGESTION

- **SUGGESTION** (non-blocking): "No isolation/timeout/read-only options" scenario has only structural coverage (the API signature has no second argument), no dedicated negative runtime test — accepted as low-risk.
- Scope drift: none. Only expected files touched. New devDependency correctly placed.

**Live Command Evidence** (re-verification session):
- `pnpm --filter @indigodb/client test` → exit 0, 21/21
- `pnpm build --force` → exit 0, 10/10 packages
- `pnpm lint --force` → exit 0, 18/18 tasks
- `pnpm test --force` (root) → exit 0, 16/16 tasks (incl. generator `transaction-emission.mjs` 5/5)

## Files Changed (Implementation)

### Client Runtime
- `packages/client/src/client.ts`: `$withSession`, `$transaction`, AsyncLocalStorage nesting guard, session-executor wiring
- `packages/client/src/types.ts`: `TransactionHook` type alias, optional `transaction` field on the `db` shape
- `packages/client/test/pglite-harness.mjs`: updated to return `{ exec, transaction }`
- `packages/client/test/transactions.mjs`: new regression suite (6 scenarios, all PASS)
- `packages/client/test/pglite-socket-harness.mjs`: new wire-protocol harness (PGlite + `@electric-sql/pglite-socket`)
- `packages/client/test/transactions-pg.mjs`: new real `pg.Pool` coverage suite (5 checks, all PASS)

### Generator
- `packages/generator/src/client.ts`: emitted `__delegates` factory, `TransactionClient` interface, updated constructor, emitted `$transaction` method
- `packages/generator/test/transaction-emission.mjs`: new generator test (10 assertions, all PASS)

### Dependencies
- `@electric-sql/pglite-socket@^0.2.7` added as a devDependency, pinned to match the existing `@electric-sql/pglite` peer version

## Roadmap Context

**This change closes**: Phase 2 ("Make it an ORM"), Epic 1 of 8 — "Transactions"

**Remaining Phase 2 epics** (7 of 8):
- Epic 2: Relations — pairing, then loading
- Epic 3: Nested writes
- Epic 4: Where composition and filters
- Epic 5: Batch, aggregate, paginate
- Epic 6: Type honesty
- Epic 7: Native type attributes + driver adapters
- Epic 8: Extension seam

This closure is scoped to the Transactions epic alone; Phase 2 remains in flight.

## Archive Verification Checklist

- [x] Main specs updated correctly (`openspec/specs/client-transactions/spec.md` created, `client-executor-injection` delta merged)
- [x] Change folder moved to archive (`openspec/changes/archive/2026-08-11-transactions-epic/`)
- [x] Archive contains all artifacts (proposal, specs, design, tasks, verify-report, archive-report)
- [x] Archived `tasks.md` has no unchecked implementation tasks (all 37 marked `[x]`)
- [x] Active changes directory no longer has this change
- [x] Mechanical copy verified with empty `diff -r` output

## Final State Authority

1. **Explicit final-state facts**: 37/37 tasks complete, re-verification PASS, 2 CRITICALs remediated, full build/lint/test clean — all confirmed by independent live command evidence in the re-verification session.
2. **Intermediate artifacts** (verify-report #516, apply-progress): historical context; stale snapshot claims rank below the explicit final-state facts above.
3. **Spec amendment history**: the spec was amended post-verify to match implemented behavior (compile-time nesting prevention); the amendment is permanent and part of the archive's authoritative spec domain.

---

**Archive Status**: COMPLETE
**Observation IDs Recorded**: #511, #512, #513, #514, #516, #517
Project: indigo
Topic: sdd/transactions-epic/archive-report
