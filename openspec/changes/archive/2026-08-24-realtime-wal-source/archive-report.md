# Archive Report: realtime-wal-source

**Change Name**: `realtime-wal-source`  
**Road Map**: Road to 1.0, Phase 4, Slice 2  
**Archive Date**: 2026-08-24  
**Status**: ✅ Archived and closed

## Artifact Traceability

All SDD artifacts for this change have been persisted to Engram and merged into the main specs. Observation IDs for future reference:

| Artifact | Engram ID | Topic Key |
|----------|-----------|-----------|
| Proposal | #710 | `sdd/realtime-wal-source/proposal` |
| Specifications | #711 | `sdd/realtime-wal-source/spec` |
| Design | #712 | `sdd/realtime-wal-source/design` |
| Tasks | #713 | `sdd/realtime-wal-source/tasks` |
| Verify Report — PR A | #715 | `sdd/realtime-wal-source/verify-report-pr-a` |
| Verify Report — PR B | #717 | `sdd/realtime-wal-source/verify-report-pr-b` |

## What Shipped

This change delivers the first production slice of the realtime v2 capability, replacing `PgNotifySource` (which loses events during client disconnection) with `WalSource`, a Postgres logical-replication-based consumer that resumes exactly where it stopped.

### Deliverables (by domain)

#### Domain: `realtime-wal-source` (NEW)
- **WalSource** — new `packages/realtime/src/wal-source.ts`, a `RealtimeSource` implementing Postgres logical replication over `pgoutput`, with event-shape parity to `PgNotifySource`, exponential backoff (1s→30s), and at-least-once delivery.
- **Engine default** — `packages/realtime/src/engine.ts` wired to use `WalSource` by default; `PgNotifySource` remains exported and constructible for explicit opt-in.
- **Dependency** — `pg-logical-replication@2.5.0` added to `@indigodb/realtime`, deduped against `pg ^8.13.0`.
- **Real-Postgres test harness** — `packages/realtime/test/{parity,resume,pg-harness}.mjs`, executable only with `INDIGODB_TEST_DATABASE_URL` set (self-skips in CI's `ts` job).

#### Domain: `realtime-replication-ddl` (NEW)
- **Replication lifecycle** — `renderReplicationPreSql()` (slot create/drop), `renderPublicationSql()` (publication SET TABLE), `renderReplicaIdentity()` (FULL/DEFAULT per @@realtime state).
- **Slot naming** — fixed default `indigo_realtime`, override via `INDIGODB_REALTIME_SLOT` env var; single `resolveSlotName()` shared by DDL and consumer paths.
- **NOTIFY retirement** — `renderDropLegacyNotify()` emits `DROP TRIGGER`/`DROP FUNCTION` for `indigo_notify_*` objects; legacy call sites removed from emit path.
- **Preflight diagnostics** — `assertLogicalReplication()` in CLI, validates `wal_level=logical` and `REPLICATION` privilege before DDL, actionable error messages.
- **Two-phase push** — `db push` now executes pre-transaction slot statements before main DDL, `--print` reflects both blocks.
- **Versioned migrations** — `migrate.ts` diffs and applies publication/slot/replica-identity changes in correct order; converges notify-era schemas.

#### Domain: `ci-pipeline` (MODIFIED)
- **Fourth CI job** — new `postgres` job runs real-Postgres `@indigodb/realtime` and `@indigodb/migrator` test suites via `docker run -d -c wal_level=logical` (not `services:`, which cannot pass container args).
- **Isolation** — `postgres` job has no `needs:` dependency, failures are independent of `ts`/`rust`/`wasm-drift`.
- **TS job stays Postgres-free** — constraint made explicit; PGlite in-process tests remain in `ts`, real-Postgres tests moved to new `postgres` job.

## Verification Status

### PR A (WalSource): **PASS WITH WARNINGS**
- **Status**: 24/24 implementation checklist items complete.
- **Independent verification**: Real Postgres (docker run postgres:17), all 23 real-DB unit/integration tests pass: insert/update/delete parity (full `old` on UPDATE/DELETE), no-loss-on-reconnect, backoff exponential growth, malformed-message handling.
- **Spec compliance**: 11/13 scenarios have runtime test coverage; 2 scenarios (`WalSource` as default source, `PgNotifySource` remains available) verified by direct code inspection only.
- **Warning (non-blocking)**: Default-source-swap runtime test coverage gap — both scenarios correct by code inspection but lack automated `RealtimeEngine` test. Recommend follow-up unit test asserting `instanceof WalSource` before or shortly after archive.

**Verification Report**: Engram #715 (per observation IDs in task completion gate)

### PR B (DDL, Preflight, CI): **PASS**
- **Status**: 24/24 implementation checklist items complete.
- **Independent verification**: 18/18 workspace turbo tasks green (build/lint/test), real Postgres e2e runs confirm:
  - Publication + slot DDL idempotent and correctly ordered
  - Preflight rejects non-logical wal_level with actionable error (exit 1, no DDL applied)
  - NOTIFY trigger/function retirement complete (no live call sites remain)
  - Slot/publication membership diff keying correct (no spurious DDL on unchanged schema)
  - PGlite shadow-replay tolerance scoped correctly (affects only read-only diff planning, not apply)
  - Dependency cycle (client→realtime→migrator→client) broken (now acyclic DAG)
  - All 8 flagged design deviations independently verified safe and correct

**Verification Report**: Engram #717 (per observation IDs in task completion gate)

### Combined Status
**Both PRs PASS**. Two chained PRs merged to `main` locally and verified complete. No CRITICAL issues. One non-critical WARNING in PR A (default-source-swap test gap) and two cosmetic SUGGESTIONS in PR B (duplicated regex, minor double-connect in migrate-deploy preflight) — none block archive.

## Spec Merge Summary

| Domain | Action | Details |
|--------|--------|---------|
| `realtime-wal-source` | Created (NEW full spec) | 7 requirements, 13 scenarios, complete spec copied to `openspec/specs/realtime-wal-source/` |
| `realtime-replication-ddl` | Created (NEW full spec) | 7 requirements, 14 scenarios, complete spec copied to `openspec/specs/realtime-replication-ddl/` |
| `ci-pipeline` | Merged delta | Added "Postgres job" (2 req, 2 scenarios) + "TS job stays Postgres-free" (1 req, 1 scenario), modified "Any failing job fails the run" (now 4 jobs, 2 scenarios) |

## Design Deviations and Resolution

All deviations from the original design were discovered during implementation and verified safe:

1. **`introspect.ts` detection signal** — Moved from retired `indigo_rt_*` trigger to `pg_publication_tables` membership query. Necessary because NOTIFY trigger is now dropped; query parameterized, not interpolated.
   - *Status*: Real and correctly implemented; proven live by `shadow.mjs` C.7 replay test and golden round-trip fixtures.

2. **`migrate.ts` `membershipChanged` diff keying** — Realtime-table-set membership keyed off actual diff, not "any realtime exists" boolean. Fixes `planMigration(introspected, next)` no-op invariant on unchanged schema.
   - *Status*: Verified no regression; `membershipChanged` keying prevents spurious publication DDL on first migration.

3. **PGlite `wal_level=logical` tolerance in `shadow.ts`** — Error message regex match `/wal_level.*logical/i` only wraps pre-transaction loop of throwaway diff-planning shadow database, never production apply path.
   - *Status*: Scoped correctly; cannot mask real wal_level failure in `migrate dev` against real target Postgres.

4. **Dependency cycle fix** — `@indigodb/migrator` imports `packages/client/dist/index.js` by relative path to avoid circular dep; `client` no longer depends on `migrator`.
   - *Status*: Verified acyclic DAG; test suite passes with deterministic build order.

5. **NOTIFY retirement** — No `renderNotifyFunction`/`renderCreateTrigger` call sites survive in live code (only in drop paths).
   - *Status*: Verified via codebase search; retirement complete.

6. **Slot/publication DDL correctness** — Guarded `SELECT WHERE NOT EXISTS` for idempotency, not `DO $$ EXCEPTION`; `ALTER PUBLICATION SET TABLE` declarative.
   - *Status*: Verified both by source read and golden fixtures; all scenarios pass live.

7. **CLI preflight + two-phase push** — `assertLogicalReplication` runs before DDL; `db push --print` shows both blocks.
   - *Status*: Verified live e2e against both compliant and non-compliant Postgres.

8. **CI `postgres` job** — Real Postgres via `docker run -d`, not `services:` (which cannot pass `-c wal_level=logical`).
   - *Status*: Verified in workflow definition; job runs independently with no `needs:`.

**Conclusion**: All deviations are real, independently verified, and safe. No regression discovered.

## Known Follow-ups (Non-blocking)

Explicitly logged for future work, not blockers to archive:

1. **PR A runtime test coverage gap** — Default-source-swap scenario lacks automated test. Recommend unit test (e.g., `new RealtimeEngine({...}).source instanceof WalSource`) before or shortly after archive.

2. **`REPLICA IDENTITY FULL` WAL cost** — Materially raises WAL volume per UPDATE; worth revisiting once shape-log API narrowing is available (future slice, LSN-addressed `GET ?handle&offset`).

3. **Acknowledge point is commit-granular** — Currently ack fires after every row of a transaction is dispatched; revisit moving behind subscriber flush if SSE back-pressure becomes real (slice 3).

4. **@@map table-rename pre-existing gap** — `matchTables()` lacks a path for tables with simultaneous model-name AND `@map` changes; already worked around in PR B fixtures (kept table `@map`'d from the start). Out of scope for this slice.

5. **Cosmetic suggestions** (non-blocking) — `isPgliteLogicalReplicationUnsupported` regex duplicated between `shadow.ts` and test `pg-harness.mjs`; `migrate deploy` opens a separate connection for preflight. Both low-risk, low-priority.

## Post-slice Cleanup Tasks

- [x] C1 — Proposal Success Criteria fully met: parity ✅, no-loss-on-reconnect ✅, backoff ✅, idempotent DDL ✅, legacy retirement ✅, preflight ✅, CI ✅.
- [x] C2 — Specs merged: `realtime-wal-source` (NEW) copied, `realtime-replication-ddl` (NEW) copied, `ci-pipeline` delta merged.
- [ ] C3 — Logged follow-up: `REPLICA IDENTITY FULL` WAL cost (future slice, shape-log narrowing).
- [ ] C4 — Logged follow-up: ack point is commit-granular, revisit for SSE back-pressure (slice 3).

Tasks C1 and C2 are complete; C3 and C4 are deferred by design to future slices.

## Summary

**realtime-wal-source** is production-ready and complete. Both PRs shipped, verified (PR A PASS WITH WARNINGS, PR B PASS), and archived. The change closes the "events lost during disconnection" gap inherent to v1's NOTIFY-based realtime, delivering logical-replication-based WAL event streaming with resume-after-disconnect, correct event ordering, and no truncation.

The three modified/new domain specs have been synced into the main spec repository. The change folder has been moved to the archive dated 2026-08-24 and is ready for the next phase.

---

**Archive Completion**: All change artifacts (proposal, spec, design, tasks, verify reports) persisted to Engram. Main specs updated. Change folder moved to archive. Ready for closure.
