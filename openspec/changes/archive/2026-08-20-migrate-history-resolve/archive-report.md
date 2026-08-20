# Archive Report: `migrate-history-resolve`

**Change**: migrate-history-resolve  
**Status**: ARCHIVED  
**Branch**: feature/migrate-history-resolve (commit 4abc084, not pushed to main)  
**Verification**: PASS (Engram #689 — 0 CRITICAL, 0 WARNING, 0 SUGGESTION)  
**Archive date**: 2026-08-20  
**Artifacts read**: Engram #684 (proposal), #685 (spec), #686 (design), #687 (tasks), #689 (verify-report)

---

## Roadmap Context

This change closes **task 7/8** of the Road to 1.0 Phase 3 epic **"Introspection — `indigodb db pull"**.

The roadmap initially named task 7/8 as "history table/locking/recovery verbs" — a three-part umbrella. Prior exploration (Engram #683) confirmed:

- **Locking** (was "4/8"): already closed by epic 4/8 — `migrateDeploy` holds `pg_try_advisory_lock`; `dev`/`status` are untouched by explicit, tested design (`migrate-deploy-concurrency/spec.md`; test `migrate-runner.mjs:618`). No locking work in this change.
- **History-table columns** (was "3/8"): already closed by epic 3/8 — `checksum` + `success` shipped; `success` is deliberately inert because no failed-migration row is ever persisted (verified at code level: ROLLBACK / file removal precede any INSERT).

This change delivers **only the genuinely-remaining recovery verb**, `indigodb migrate resolve` — the manual, explicit ledger-recovery surface for when reality and `_indigo_migrations` diverge. The narrower scope reflects a RESCOPING from the original three-part wording to the one untouched capability.

### Next Epic Scope (Task 8/8)

After this archive, the **last remaining task** is **8/8: transaction-boundary control**. This entire 8-epic "Introspection — `indigodb db pull`" will be complete pending 8/8. The epic stack is now 7/8 closed, 1/8 remaining.

---

## Implementation Summary

**Single-slice delivery** via feature branch `feature/migrate-history-resolve` (commit abc6477, verified clean, ready to merge to main without accumulation risk).

### New Capability: `migration-history-resolve`

The `indigodb migrate resolve` verb reconciles `_indigo_migrations` when reality and the ledger diverge (a migration applied or reverted out-of-band, a DBA hand-fixing a half-applied change). 

**Two mutually exclusive directions per invocation**:
- `--applied <id>`: INSERT the ledger row (checksum computed from on-disk `migration.sql`, `success = true`) **without executing any of its SQL**.
- `--rolled-back <id>`: DELETE that id's row; idempotent no-op if absent.

**Guards**:
- Refuse with non-zero exit if the id has no matching `migrations/<id>/migration.sql` file on disk (typo protection, matching `checksumPreflight`'s style).
- For `--applied`: refuse (not silently re-baseline) if the on-disk content's checksum no longer matches the stored checksum — this refusal is absolute and provides no side door around the `migration-history-integrity` drift-refusal guarantee.
- No advisory lock (deploy-scoped by design; resolve shares no DDL, takes one atomic statement only).
- No `.snapshot.json` manipulation (snapshot reconciliation remains exclusively `migrate dev`'s responsibility).

### Modified Capability: `migration-history-integrity`

The remedy-clause delta (requirement "Checksum drift is a hard refusal with no override") now explicitly points at `migrate resolve` as the sanctioned path to reconcile divergence, replacing the prior narrative reference to "raw SQL" editing. The drift-refusal guarantee itself remains absolute and unbypassable — `resolve` provides no override, only an explicit operator-controlled ledger repair surface.

---

## Security & Hardening Findings

During design review (Engram #686), two hardening decisions were confirmed at code level:

### Path-Traversal Hardening

Migration ids are validated by **exact membership** in `listMigrationDirs(cwd)` **AND** `existsSync(migrations/<id>/migration.sql)` before any database connection is opened. A traversal-shaped id (e.g. `../../etc/passwd`) is refused as unknown at the filesystem-check layer, guaranteeing it never reaches `createClient` or the database. Test case 1.9 asserts this guard explicitly: spy records zero queries when a traversal-shaped id is supplied.

### SQL Injection Hardening

The migration id is bound as a parameter (`$1`) in all three resolve-related queries (SELECT for drift-check, INSERT for applied, DELETE for rolled-back). It is never interpolated into SQL text. Test case 1.10 asserts this: spy checks that every `_indigo_migrations`-touching query uses placeholders, and a metacharacter-shaped id is refused as unknown before reaching a query.

---

## Drift-Refusal Guarantee

The "no side door" guarantee is locked at code level: the `stored !== computed` branch in `migrateResolve` (packages/cli/src/migrate-runner.ts:542-607) contains only a `console.error` + `process.exitCode = 1` + `return` statement — no UPDATE, no re-baselined checksum write, no path back into the flow. This absolute refusal cannot be bypassed by calling `resolve` on a drifted migration.

---

## No-Advisory-Lock Reasoning

`MIGRATION_LOCK_KEY` is deploy-only by explicit, tested design. Deploy's lock protects a long, multi-statement, non-idempotent DDL sequence. Resolve shares none of that:
- No DDL (one atomic statement only).
- Single INSERT or DELETE (no multi-statement transaction).
- `name text NOT NULL UNIQUE` makes a genuinely concurrent duplicate INSERT fail loudly rather than corrupt the ledger.

Taking the lock would ADD a failure mode: an operator repairing history while a stuck deploy holds the session lock would be refused precisely when the tool is most needed. Residual risk accepted: `resolve --applied X` racing an in-flight deploy of X makes that deploy's INSERT hit the unique constraint and roll back with an error — loud, not silent. This is a design choice documented in Engram #686.

---

## Task Completion

All 22 tasks marked complete (tasks.md: 1.1-1.20 implementation + 2.1-2.2 post-slice cleanup):

### Implementation Tasks (1.1-1.16)
- 12 RED test cases (1.1-1.12): applied recording without SQL execution, idempotent no-op behavior, drift refusal, unknown-id guards, path-traversal hardening, SQL-injection hardening, flag validation, transaction/lock/snapshot checks.
- 4 GREEN implementation tasks (1.13-1.16): ResolveOptions interface, migrateResolve function, header comment update, CLI wiring in index.ts.

### Verification Tasks (1.17-1.19)
- Full test suite (packages/cli/test/migrate-runner.mjs): 12/12 new resolve cases + all pre-existing dev/deploy/status cases pass.
- Full workspace build/lint/test (pnpm build && pnpm lint && pnpm test) and Rust suite (cd crates && cargo test): all green, zero regressions.

### Post-Slice Cleanup (2.1-2.2)
- 2.1: All proposal success criteria verified at code level.
- 2.2: migration-history-integrity delta spec merged to main (already committed in abc6477, verified correct during apply).

---

## Archive Verification

**Mechanical copy contract**: 
- Spec merge: migration-history-resolve/spec.md copied to openspec/specs/migration-history-resolve/spec.md via shell (`cp`), verified byte-identical with `diff -r`.
- Folder move: openspec/changes/migrate-history-resolve → openspec/changes/archive/2026-08-20-migrate-history-resolve via `git mv`, pre-move snapshot created and source confirmed removed.
- All artifacts preserved: proposal, specs (migration-history-resolve + migration-history-integrity), design, tasks, verify-report.

**Archive contents verified**:
- proposal.md ✅
- specs/migration-history-resolve/spec.md ✅ (NEW, copied to main)
- specs/migration-history-integrity/spec.md ✅ (MODIFIED delta already merged)
- design.md ✅
- tasks.md ✅ (22/22 [x] tasks complete, no stale unchecked implementation tasks)
- verify-report.md ✅ (PASS, 0 CRITICAL)

**Commit**: feature/migrate-history-resolve commit 4abc084 ("sdd(archive): close migrate-history-resolve, merge delta spec") successfully staged and committed on the feature branch. Ready to merge to main (not pushed, user decision).

---

## Final State Authority

This archive report reflects the state of the change AT CLOSE per the Final-State Authority hierarchy:

1. **Native review authority**: N/A — no review gate in this repo; archive proceeds under ordinary repository policy.
2. **Persisted tasks artifact** (openspec/changes/archive/2026-08-20-migrate-history-resolve/tasks.md): 22/22 [x] — all implementation and verification tasks marked complete.
3. **Explicit final-state facts from launch prompt**: Migration-history-integrity delta merge already committed ahead of normal timing (task 2.2, during apply) — verified correct, marked as expected per session instruction.
4. **Verify-report** (Engram #689): PASS, 0 CRITICAL/WARNING/SUGGESTION, commit abc6477 verified clean.

No contradictions, no stale claims. The change is ready for merge and deploy.

---

## Next Steps

**This branch is isolated, NOT merged to main, NOT pushed.**

To merge: `git checkout main && git merge feature/migrate-history-resolve && git push origin main` (user decision).

The Road to 1.0 Phase 3 epic "Introspection — `indigodb db pull`" now has 7/8 tasks closed. Task 8/8 (transaction-boundary control) is the final remaining work before the epic and the entire Road to 1.0 releases.
