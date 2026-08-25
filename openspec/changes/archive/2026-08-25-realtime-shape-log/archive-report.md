# Archive Report: realtime-shape-log

**Change**: realtime-shape-log (Road to 1.0, Phase 4, Slice 3 of the realtime epic)  
**Date Archived**: 2026-08-25  
**Status**: Complete and verified

## Executive Summary

Slice 3 of the realtime epic shipped the durable shape log (`_indigo_realtime_log`), persisting every committed change on `@@realtime` tables keyed by commit LSN with pre-evaluated read-authorization buckets. Two chained PRs (A: persistence layer, B: bucket auth + RLS) were both implemented, verified, and merged to `main` successfully. The log is ready for slice 4's HTTP endpoint and live `.live()` client API.

## What Shipped

### Core Capability: LSN-Addressed, Durable Change Log

- **Table**: `_indigo_realtime_log` — one shared table for all `@@realtime` models, discriminated by `table_name`, mirroring the `_indigo_migrations` pattern
- **Columns**: `id (bigserial PK)`, `lsn (pg_lsn)`, `table_name`, `op (INSERT/UPDATE/DELETE)`, `pk (jsonb)`, `new/old (jsonb)`, `txid`, `ts`, `buckets (text[])`
- **Lifecycle**: Created when the first `@@realtime` model is added; dropped when the last is removed; idempotent via `DO $$ / IF NOT EXISTS` pattern in `db push`

### Write Ordering: Insert → Dispatch → Ack

`WalSource` persists before dispatching to subscribers and before acknowledging the LSN:
- A dedicated second `pg.Client` (ordinary connection) opens alongside the logical replication connection
- Per-transaction multi-row parameterized `INSERT` writes all changes in that transaction's batch as one statement
- Failed insert tears down the replication connection and redelivers on reconnect (durable: persist-then-ack, never ack-then-crash)
- Shared serial promise chain prevents LSN interleaving even under concurrent commits

### Read Authorization: Buckets Computed at Write Time

- **No `@@allow` rules (public model)**: `buckets = NULL` — readable by any authenticated user
- **`@@allow` with `read` rules**: `buckets = {claim_values}` — union of field values matching `field == claim` across all `read` rules (PERMISSIVE-OR semantics)
- **`@@allow` with create-only rules (no `read` rules)**: `buckets = []` (empty array, deny-all) — real table has RLS enabled with no matching `read` policy, so log must not be more permissive
- **NULL-field handling**: Fields with `NULL` values contribute no element (match semantics: `NULL` never satisfies `col = claim`)
- **UPDATE semantics**: `buckets` unioned from both `new` and `old` (REPLICA IDENTITY FULL); losing owner still observes row leaving their view

### RLS on the Log Table

- `ALTER TABLE _indigo_realtime_log ENABLE ROW LEVEL SECURITY; ALTER TABLE … FORCE ROW LEVEL SECURITY;`
- One `FOR SELECT` policy: `USING (buckets IS NULL OR NULLIF(current_setting('app.user_id', true), '') = ANY(buckets))`
- One `FOR INSERT WITH CHECK (true)` policy (required: `FORCE RLS` blocks even the owner's inserts without an INSERT policy)
- No UPDATE/DELETE policies: append-only by construction
- Reuses slice 1's `AUTH_SETTING` and `NULLIF(current_setting(…), '')` idiom for consistency with real-table policies

### Schema Lifecycle

- Migrator: `postgres.ts` emits log DDL + indexes + RLS whenever `@@realtime` models exist
- Versioned migrations: `migrate.ts` create/drop gated on `prevHasRealtime !== nextHasRealtime` state change; drop routed through `forced(...)` data-loss gate
- Shadow-replay: `introspect.ts` excludes `_indigo_realtime_log` from the default-exclude list so round-trip `planMigration(introspect(db), next)` remains a no-op
- Publication: log table is never included in `_indigo_realtime_publication` (decision 14 tested)

## Verification Status

**Both PRs: PASS** — 2/2 passed verification with zero CRITICAL issues.

### PR A — Persistence (Commit `0e681c7`)
**Verdict**: PASS  
**Coverage**: Table DDL, idempotency, introspection fix, serial write ordering, SQL injection safety, multi-row INSERT batching, `RealtimeEvent.lsn` parity, log ordering, durability (crash recovery), idempotency, CI integration.  
**Test Results**:
- Unit: `wal-source.mjs` 23/23, `pg-harness.mjs` pass, `parity.mjs` 2/2, `introspect.mjs` all green
- Real Postgres: `log.mjs` 4/4 (ordering, batch granularity, durability, idempotency), `migrator/test` all green
- Workspace: `pnpm build` 10/10, `pnpm lint` 18/18, `pnpm test` 18/18

**Known Issues**:
- **WARNING** (non-blocking): `resume.mjs` timeout hang — confirmed via A/B test on pristine `main` to be pre-existing, unrelated to PR A's second-connection changes
- **WARNING** (non-blocking): `teardownAfterLogFailure` can schedule redundant reconnect timers in rare cascading-failure scenario; guarded by `service !== service` supersession check, harmless

**Artifact ID**: #727 (Engram `sdd/realtime-shape-log/verify-report-pr-a`)

### PR B — Bucket Auth + RLS (3 commits: 6112019, 707af10, 15a7ae5)
**Verdict**: PASS  
**Coverage**: `computeBuckets` matrix (all 4 AllowOperand pairs: field==claim, field==literal, field==field, claim==claim), NULL-field skip, caller-independent-rule collapse to `null`, deny-all for create-only-rules, RLS block enforcement, INSERT-with-CHECK proof under `FORCE` RLS, row-isolation via app.user_id, textual-vs-cast-type consistency matrix, append-only via policy absence.  
**Test Results**:
- Unit: `migrator/buckets.mjs` 29/29 (computeBuckets matrix), `wal-source.mjs` 27/27 (incl. @map wiring), `realtime-ddl.mjs` 28/28
- Real Postgres: `buckets.mjs` 5/5 (B4.1 append-only, B5.1-B5.4 RLS + isolation), `log.mjs` 4/4 (unaffected), `rls-enforcement.mjs` 8/8 (slice 1 regression check)
- Workspace: `pnpm build` 10/10, `pnpm lint` 18/18, `pnpm test` 18/18

**Known Issues**:
- **WARNING** (non-blocking): Missing `sdd/realtime-shape-log/apply-progress-pr-b` Engram artifact — breaks artifact-persistence discipline, but all claims independently verified against code, tests, and real Postgres
- **WARNING** (non-blocking, design prose imprecision): design.md decision-9 states `NULL` is "decided earlier in the pipeline," but both `NULL` and `[]` ARE computed inside `computeBuckets` via sequential early returns; no logic bug, just prose could be tighter

**Artifact ID**: #728 (Engram `sdd/realtime-shape-log/verify-report-pr-b`)

## Known Deviations and Corrections

### Buckets NULL vs. `[]` Semantics — Corrected During Cycle (Decision 2a)

**Original finalized spec.md**: Stated create-only rules (@@allow present, no `read` action) → `buckets = NULL`  
**Design.md (original)**: Stated create-only rules → `buckets = []`  
**User confirmation** (2026-08-24): Rationale re-examined — create-only-rules model has RLS enabled on real table, deny-by-default semantics with no matching `read` policy means the real table denies all reads, so log's `buckets` must NOT be more permissive (NULL = public would violate this). Create-only → `[]` is correct (deny-all bucket matching).

**Resolution**: spec.md and tasks.md corrected to `[]`; design.md required no change. All three artifacts now agree. Tests drive this via hand-built `ResolvedTable` fixtures, not `.indigo` source (compiler guard still blocks `@@realtime`+`@@allow` together). Full rationale in Engram `sdd/realtime-shape-log/decisions` #721, decision 2a.

## Deferred Items (Slice 4)

Per design's scope and proposal:

1. **HTTP endpoint**: `GET /api/realtime/log?handle={handle}&offset={lsn}` — slice 4 deliverable; log is the backing store, this slice ships the plumbing
2. **`.live()` client API**: `table.live().onchange(...)` wrapper over the HTTP log endpoint — slice 4 scope
3. **Subscriber identity in SSE**: `Subscriber` gains no `userId` this slice; `RealtimeEngine.dispatch()` remains table-only; row-filtering deferred to slice 4
4. **Compiler guard**: `@@realtime` + `@@allow` remains rejected by `crates/indigo-compiler/src/validate.rs:86-97`; lifted in slice 4 once live push filtering is ready
5. **Log retention/pruning**: Documented follow-up (append-only policy set means future pruner needs bypassing role or separate DELETE policy); no active deadline

## Artifact Synchronization

### Specs Merged

| Domain | Action | Details |
|--------|--------|---------|
| `realtime-shape-log` | Created (NEW) | Full spec copied to `openspec/specs/realtime-shape-log/spec.md` |
| `realtime-wal-source` | Modified (DELTA) | 3 new requirements appended: log-writer connection, `lsn` on `RealtimeEvent`, insert→dispatch→ack ordering |

### Archive Contents

Moved to `openspec/changes/archive/2026-08-25-realtime-shape-log/`:
- `proposal.md` — original proposal and intent
- `design.md` — 14 architecture decisions and implementation strategy
- `tasks.md` — TDD checklist (all A/B tasks complete, C1-C4 archive-phase cleanup deferred)
- `specs/realtime-shape-log/spec.md` — full spec (NEW)
- `specs/realtime-wal-source/spec.md` — delta spec (ADDED to main)

### Task Completion

All implementation tasks (A0.1–A9.3, B1.1–B6.4) marked complete. Post-slice cleanup (C1–C4) intentionally deferred to archive phase:
- C1: Confirm IR-level success criteria coverage (buckets on a model with @@allow via hand-built ResolvedTable)
- C2: ✓ Completed — specs merged and archived
- C3, C4: Follow-up documentation (non-blocking)

## Source of Truth Committed

Main specs now reflect the new behavior:
- `openspec/specs/realtime-shape-log/spec.md` — defines `_indigo_realtime_log` and buckets semantics
- `openspec/specs/realtime-wal-source/spec.md` — updated with log-writer connection, `lsn` field, ordering requirements

The change has been fully planned (proposal #722), specified (spec #723 + #725), designed (design #724), implemented (PR A + B), verified (verify-report-pr-a #727, verify-report-pr-b #728), and archived.

## Artifact References (Engram IDs for Traceability)

- Proposal: #722
- Spec: #723
- Design: #724
- Tasks: #725
- Verify Report PR A: #727
- Verify Report PR B: #728
- Archive Report: (this document)

All SDD artifacts for this change are now persisted. Ready for the next slice.
