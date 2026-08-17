# Proposal: Shadow-Replay Diff Source (minimal introspection + shadow DB)

## Intent

`migrateDev` computes its diff against `migrations/.snapshot.json` (`loadSnapshot()` →
`planMigration(prev, next)`). A git-tracked JSON blob is not the database: if it is stale,
deleted, merged badly, or hand-edited, the generated migration is silently wrong. Phase 3's
epic "Delete the snapshot as source of truth" replaces it with real, derived state.

**Roadmap-ordering inconsistency (stated plainly, up front):** the roadmap lists epic 1
("Delete the snapshot as source of truth") *before* epic 2 ("Introspection — `indigodb db pull`"),
but that ordering contradicts the code dependency graph. `planMigration`'s `prev` parameter must
already be a full `ResolvedSchema`, so diffing against a shadow-replayed database *structurally
requires* converting that database back into `ResolvedSchema` first — which is epic 2's literal
scope. Epic 1 cannot be done without a slice of epic 2.

This change therefore ships a **minimal introspection primitive** (internal plumbing, not the
`db pull` package/command) plus the shadow-replay diff source that consumes it. It is explicitly
NOT byte-for-byte `.indigo` regeneration, NOT checksum/staleness detection, NOT destructive-change
`--force` prompting, NOT concurrent-deploy locking — each belongs to a different Phase 3
epic/exit-criterion.

## Scope

### In Scope

- **Minimal introspection primitive**: `information_schema`/`pg_catalog` → `ResolvedSchema`-shaped
  value, scoped to exactly what `planMigration` reads: tables, columns (type, nullable, default),
  PK, FKs (incl. referential actions), indexes, enums (full member sets). Promotes the approach
  already proven in `packages/migrator/test/pg-harness.mjs`'s `introspectPublicSchema` from
  test-only tooling into production code, widened from columns-only to the above surface.
- **Shadow-database mechanism** using PGlite (in-process WASM Postgres), per the exploration's
  recommendation over a real `CREATE DATABASE` shadow — a real shadow needs `CREATEDB`, which many
  managed Postgres tenants do not grant, plus orphan cleanup on crash. Replays the committed
  migration sequence in `_indigo_migrations`-recorded order onto a fresh instance.
- **`migrate-runner.ts` swap**: `migrateDev` uses shadow-replay-then-introspect as the `prev`
  source for `planMigration` instead of `loadSnapshot()`.
- **Named, documented limitation**: introspected `prev` cannot recover a field's *logical* name
  (only physical `dbName`), so `matchColumns`'s rename-detection signal — which keys on logical
  name first — degrades for schemas using `@map`. This is flagged as an open **design question for
  `sdd-design`**, not silently accepted. A one-time transition cost (an existing `@map` rename may
  read as drop+add on the first post-adoption migration) must be either mitigated or explicitly
  documented and guarded.

### Out of Scope (explicit; each a follow-up change)

- The full `db pull` CLI command / new package and byte-for-byte `.indigo` file regeneration
  (epic 2's actual remaining scope).
- `checksum` column on `_indigo_migrations` + edited-applied-migration detection.
- `pg_advisory_lock` around `migrate deploy` (concurrent-deploy safety).
- Destructive-statement classification and `--force` gating.
- Changing `migrateDeploy` / `migrateStatus` behavior beyond what replay ordering requires.

## Capabilities

### New Capabilities

- `schema-introspection`: deriving a `ResolvedSchema`-shaped value from a live Postgres database,
  restricted to the structural facts the migration diff consumes; explicit fidelity boundaries
  (no logical names, no `@note`/table groups/datasource metadata).
- `shadow-database-replay`: constructing an ephemeral database by replaying the recorded migration
  sequence, and the ordering/consistency guarantees that replay relies on.

### Modified Capabilities

- `migration-diff-completeness`: the `prev` state fed to `planMigration` changes source from the
  on-disk snapshot to shadow-replay + introspection; rename-detection requirements must be restated
  for a `prev` that carries only physical names.
- `migration-appliability-tests`: replay/equivalence coverage extends from
  `packages/migrator/test/replay.mjs`-style chain-vs-push proofs to shadow-replay-derived `prev`.

## Approach

Exploration Option 1 (recommended). Three seams, in order:

1. `introspectResolvedSchema(db)` in `@indigodb/migrator` — pure, executor-shaped (accepts a query
   function, so it works against both `pg` and PGlite), returning the `ResolvedSchema` subset
   `planMigration` reads. `name` is set equal to `dbName` for every introspected table/column.
2. Shadow builder — spin a fresh PGlite instance, read `_indigo_migrations` (id order) from the
   real database, apply each corresponding `migrations/<dir>/migration.sql` in that order, and
   warn loudly if recorded order and on-disk lexicographic order disagree or a recorded migration
   directory is missing (no checksums yet, so this diagnostic is the only desync signal).
3. `migrateDev` — `prev = introspectResolvedSchema(shadow)` replaces `loadSnapshot()`. `.snapshot.json`
   writing is retained or dropped per `sdd-design`'s call; the read path stops being authoritative.

Verification reuses the existing PGlite harness: assert that a shadow-replay-derived `prev` yields
the same `MigrationPlan` as the snapshot-derived `prev` across the fixture corpus (excluding the
known `@map` divergence, which gets its own explicit test asserting the documented behavior).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/migrator/src/introspect.ts` | New | `introspectResolvedSchema` production primitive |
| `packages/migrator/src/shadow.ts` | New | PGlite shadow builder + migration replay |
| `packages/migrator/test/pg-harness.mjs` | Modified | `introspectPublicSchema` superseded / re-pointed at production code |
| `packages/migrator/src/migrate.ts` | Modified | Possible `matchColumns` adjustment for physical-only `prev` |
| `packages/cli/src/migrate-runner.ts` | Modified | `migrateDev`'s `prev` source; snapshot read no longer authoritative |
| `packages/migrator/package.json`, `packages/cli/package.json` | Modified | PGlite promoted from test tooling to runtime dependency |
| `packages/migrator/test/*` | Modified | Plan-equivalence + `@map` divergence coverage |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `@map` rename misdiagnosed as drop+add on first post-adoption migration | High | Named as an explicit `sdd-design` question; dedicated test asserting documented behavior; consider a warning when introspected `prev` has physical/logical ambiguity |
| PGlite semantics diverge from real Postgres for some DDL | Medium | Replay only IndigoDB-generated SQL (a narrow DDL subset already proven under PGlite in `replay.mjs`); pin the PGlite version |
| PGlite as a runtime dep inflates CLI install/bundle size | Medium | Explicit packaging decision for `sdd-design`; lazy-import so only `migrate dev` pays the cost |
| Recorded vs on-disk migration order desync (no checksums yet) | Medium | Loud diagnostic + refuse to replay on missing/reordered migration dirs; real checksums deferred to their own change |
| Introspection fidelity gaps produce spurious diff noise | Medium | Positive-selection scope is exactly what `planMigration` reads; plan-equivalence tests over the fixture corpus |

## Rollback Plan

1. `migrateDev`'s `prev` source is a one-line seam — revert it to `loadSnapshot()`; the snapshot
   read path and `.snapshot.json` writing are preserved through this change specifically so this
   revert is a no-op for users.
2. `introspect.ts` / `shadow.ts` are additive modules with no other callers — deleting them (and
   the PGlite dependency line) removes the feature entirely.
3. No database schema changes and no migration-file-format changes are made, so no data or
   on-disk migration history needs undoing.

## Dependencies

- **Hard dependency on epic 2's introspection scope** (see Intent). This change takes a minimal
  internal slice of it; the full `db pull` epic later builds its user-facing surface on the same
  primitive rather than duplicating it.
- `@electric-sql/pglite` promoted from test-only tooling to a runtime dependency — a packaging
  decision requiring confirmation, not a free reuse.
- `_indigo_migrations` current shape (`id, name, applied_at`) is sufficient for ordered replay;
  no checksum column is added here.

## Success Criteria

- [ ] `migrate dev` generates a correct migration with `migrations/.snapshot.json` deleted from disk.
- [ ] `introspectResolvedSchema` round-trips every fixture schema: push → introspect → `planMigration`
      against the same schema yields an empty plan.
- [ ] Shadow-replay-derived `prev` yields the same `MigrationPlan` as snapshot-derived `prev` across
      the fixture corpus, except the documented `@map` case.
- [ ] Missing or out-of-order recorded migrations produce an explicit diagnostic, not a silent wrong diff.
- [ ] The `@map`/logical-name limitation is resolved or explicitly documented with a test asserting
      the chosen behavior.
- [ ] `pnpm build`, `pnpm lint`, `pnpm test` and `cd crates && cargo test` stay green.
