# Archive Report: client-transaction-array-form

**Status**: Complete  
**Archive Date**: 2026-08-19  
**Change**: `client-transaction-array-form`  
**Commits**: 88f5930 (Slice 1), 35eef8a (Slice 2), 751b116 (Slice 3)

---

## Executive Summary

The `client-transaction-array-form` change delivers full Prisma-parity array form support for `$transaction([...])`, resolving a gap in the Phase 2 roadmap where only the interactive callback form had shipped. The change introduces a new deferred-query execution model (`IndigoPromise<T>`) that enables both standalone async execution (byte-identical to prior behavior) and atomic array-form transaction execution. All three implementation slices landed on main; verification passed; and the feature is production-ready.

---

## Change Closure & Artifact IDs

### SDD Artifacts (Engram)
- **Proposal** (#628): Scoped the intent, identified architectural constraint (multi-statement ops cannot be captured as SQL), proposed rebindable operation thunks as the solution.
- **Spec** (#632): Two delta specs — `client-deferred-queries` (NEW) and `client-transactions` (MODIFIED), defining the contract, semantics, and both forms' behavior.
- **Design** (#634): Technical approach detailing the rebindable thunk pattern, identified that 9/13 delegate methods already have `*Impl` split, confirmed 3-slice delivery across a ~1000-line budget.
- **Tasks** (#637): TDD-style task breakdown sliced into 3 sequential commits (contract, rewrap, wiring+tests); all 28 executable tasks marked complete (except 3.9 COMMIT and 2 archive-cleanup items, reconciled as stale checkboxes during archive per verify-report proof of completion).
- **Verify-Report** (#643): PASS verdict with 0 CRITICAL issues; 205/205 client tests green, full generator suite green, root build/lint/test green (unrelated pre-existing compiler fixture-13 flake). Flagged 3 cosmetic cleanup items as archive-time housekeeping, all now complete.

---

## Implementation Summary

### Slice 1: Contract (88f5930)
- **Content**: `promise.ts` (new), `types.ts`, `index.ts`, `test/deferred.mjs`
- **Lines**: ~365 added, ~0 removed
- **Verification**: New unit suite green, purely additive, no existing file behavior touched

### Slice 2: Delegate Rewrap (35eef8a)
- **Content**: Extracted 4 `*Impl` methods (findFirstImpl, findUniqueImpl, deleteImpl, countImpl), rewrapped all 13 public methods to return `defer(...)`
- **Lines**: ~155 added, ~55 removed
- **Verification**: Existing PGlite suite unchanged and green; byte-identical SQL for all 13 methods vs. pre-change behavior

### Slice 3: Wiring + Tests (751b116)
- **Content**: `client.ts` guard, `generator/src/client.ts` bundle/overloads, `transactions.mjs`, `transactions-pg.mjs`, `typecheck-fixture.ts`
- **Lines**: ~335 added, ~15 removed
- **Verification**: New array-form scenarios green, real-Postgres rollback confirmed, typecheck assertions pass, full workspace build/lint/test green

---

## Spec Merges & Cleanup

### New Specs Created
- **`openspec/specs/client-deferred-queries/spec.md`**: Mechanical copy from delta; defines `IndigoPromise<T>` as lazy, memoized, single-fire thenable implementing `Promise<T>` structurally, with deferral, standalone execution, and rebindable semantics.

### Existing Specs Merged
- **`openspec/specs/client-transactions/spec.md`**: 
  - **Removed**: Stale sentence "The sequential array form (`$transaction([...])`) is out of scope for this spec." (line 20 original)
  - **Updated Purpose**: Now describes both callback form (on `IndigoClientBase`) and array form (on generated `IndigoClient`)
  - **Added 7 New Requirements**: Array-form atomicity, per-op rollback, model rebinding, empty-array no-op, validation guards, nesting rejection, and base-client boundary
  - **Modified 1 Requirement**: "Unsupported executors fail explicitly" now covers both callback and array forms

### Release Notes
- **`RELEASE_NOTES.md`**: Documents the one observable user-visible change: `instanceof Promise === false` for delegate method return values. Reassures callers that all other semantics and SQL execution remain unchanged.

---

## Archive Contents

```
openspec/changes/archive/2026-08-19-client-transaction-array-form/
├── proposal.md                (original SDD proposal)
├── design.md                  (technical design and decisions)
├── tasks.md                   (implementation tasks, all marked complete)
├── RELEASE_NOTES.md          (release note for instanceof Promise change)
├── specs/
│   ├── client-deferred-queries/spec.md    (delta spec, copied as new main spec)
│   └── client-transactions/spec.md        (delta spec, merged into main)
├── apply-progress.md          (snapshot from apply phase)
└── archive-report.md          (this file)
```

---

## Final-State Authority & Reconciliation

Per the Final-State Authority hierarchy in the archive skill:

1. **Native review authority**: Not applicable; receipt-driven development is off for this repo.
2. **Persisted tasks artifact**: All implementation tasks completed and marked `[x]`. Tasks 3.9 [COMMIT] and the 2 post-slice-3 cleanup items were left unchecked in the filesystem, but per `verify-report` (#643, 2026-08-19 22:56:54):
   - Task 3.9 [COMMIT]: Commit 751b116 verifiably exists on main and matches the exact description
   - Post-slice-3 cleanup (spec purpose-sentence removal, release note): Both completed during archive phase
   - Stale checkbox reconciliation: Approved and justified by verify-report proof of underlying completion
3. **Explicit final-state facts from launch prompt**: User instruction explicitly listed the cleanup items and confirmed the underlying work is done.
4. **Verify-Report snapshot** (#643): PASS verdict with warning-level cosmetic notes, all now resolved.

**Reconciliation**: The 3 unchecked tasks were reconciled during archive because (a) verify-report proves their underlying work is complete, (b) user instruction confirms the cleanup is part of the archive phase, (c) the changes are mechanical (checkbox checks, spec sentence removal, release note creation) not re-implementation.

---

## Key Architectural Findings

### SQL-Capture Impossible (Confirmed During Design)
Multi-statement operations like `findMany` + relation loading, nested writes, and conditional-count upserts cannot be represented as pre-captured SQL statements because:
- `loadRelations` derives query parameters from returned rows (statement 1 → keys → statement N)
- Nested writes fold child keys into parent INSERT params
- Conditional updates may elide the UPDATE entirely if no scalars changed

**Solution**: Rebindable operation thunks (model name, operation name, original args, executable closure) instead. Both standalone and transacted calls re-invoke against their respective delegates, avoiding SQL capture entirely.

### Delegate Method Rewrap Pattern
All 13 public delegate methods now return:
```typescript
defer(this.meta.name, "<op>", this, (d) => d.<op>Impl(args))
```
This pattern:
- Defers execution until `.then()`, `.catch()`, or `__claim(delegate)` is called
- Preserves lazy dispatch through multi-statement `*Impl` bodies unchanged
- Allows session rebinding by re-invoking the same `*Impl` against a session-scoped delegate
- Maintains byte-identical SQL for all 13 methods (verified via PGlite regression suite)

### `instanceof Promise === false` Consequence
`IndigoPromise<T>` implements `Promise<T>` structurally (via `.then/.catch/.finally/Symbol.toStringTag`) rather than extending it. This decision:
- Avoids Promise's constructor-eager-execution, which defeats laziness
- Avoids Promise's species-construct behavior incompatible with the `(model, op, self, run)` constructor
- Provides full assignability to `Promise<T>` call sites (structural typing)
- Breaks `instanceof Promise` checks (the one user-visible change, release-noted)

---

## Delivery & Rollback

### Per-Slice Revert
Each slice can be reverted independently:
- Revert slice 3: Wiring removed, array form unavailable, callback form still works
- Revert slice 2: Delegate wrappers removed, methods return eager Promises again (bodies byte-identical)
- Revert slice 1: No downstream consumers, artifact-only removal

No schema, SQL, or migration state touched. Zero data migration required.

### Rollout Requirement
Generated clients MUST be regenerated after deployment. Stale clients (pre-upgrade) return plain `Promise<T>`, triggering `NOT_A_DEFERRED_OPERATION` error with a clear "regenerate your client" message.

---

## Closure Confirmation

- [x] All 28 implementation tasks marked complete (3 reconciled as archive-time stale checkboxes with verify-report proof)
- [x] Verification: PASS (0 CRITICAL, 0 SUGGESTION, 1 WARNING flagged as archive-housekeeping — all resolved)
- [x] Spec deltas merged into main specs (1 new, 1 modified)
- [x] Archive folder moved to `openspec/changes/archive/2026-08-19-client-transaction-array-form/`
- [x] Release note documented (`instanceof Promise === false`)
- [x] No unmerged artifacts remain in openspec/changes/

**SDD Cycle: COMPLETE**

The change is fully implemented, verified, and archived. Ready for release.
