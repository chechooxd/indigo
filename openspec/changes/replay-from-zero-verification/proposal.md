# Proposal: Replay-from-Zero Verification

## Intent

`packages/migrator/test/appliability.mjs` proves each of 22 fixtures' DDL executes against
real PGlite, but every fixture is a **single hop**: seed `prev` via one `planMigration(null, prev)`,
then apply `next`'s diff. Nothing proves that an **accumulated migration history** — the way
`migrations/` grows after several real `migrate dev` runs — replayed in order from a truly empty
database, reconstructs a database structurally consistent with a fresh `renderPushSql` of the
final schema. That drift between history and schema is exactly the defect class
`fix-migrator-correctness` exists to prevent, and it is currently unguarded. Closes roadmap
Phase 1's "Replay-from-zero verification" epic.

## Scope

### In Scope
- A multi-hop chain test (`packages/migrator/test/` — sibling file or an appliability section)
  driving a schema sequence A → B → C → D through `planMigration` per hop.
- Applying every hop's plan **in order against ONE fresh PGlite instance**, never resetting
  between hops (replay-from-zero).
- Applying `renderPushSql(D)` against a **separate** fresh instance.
- A lightweight `information_schema` introspection helper, scoped to tables/columns/nullability/
  defaults, used only to compare the two live schemas.
- Asserting both instances describe the same live structure; failure names the divergence.
- Test-script wiring so root `pnpm test` covers it.

### Out of Scope
- General-purpose database introspection or a `db pull` product feature — separate, much larger
  roadmap item. The introspection here is test-local, not exported.
- Any NEW CI job. `pnpm test` already runs in CI via `add-ci-floor`'s `ts` job and already runs
  the migrator's test script; extending it needs **no CI config change**.
- Data/row-level migration correctness, concurrency, advisory locking, pool behaviour.
- Any production change under `packages/`, `apps/`, `crates/` source.

## Capabilities

### New Capabilities
- `migration-replay-verification`: replaying an accumulated multi-migration history from an
  empty database yields a live schema equivalent to a fresh push of the final schema.

### Modified Capabilities
- None.

## Approach

Reuse the shipped exports exactly as `migrate-runner.ts` does (`planMigration` →
`renderMigrationSql` → `applyPlan` from `pg-harness.mjs`). Add chain fixtures as an ordered
`NN.indigo` sequence (existing pair fixtures do not chain: no fixture's `next` is another's
`prev`), each hop chosen to cover a distinct diff category already exercised single-hop
(add table, add column, enum add-value, FK addition). Compare via a canonical, sorted
introspection snapshot so a diff is human-readable.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/migrator/test/replay.mjs` | New | Multi-hop chain + push-equivalence suite |
| `packages/migrator/test/fixtures-chain/` | New | Ordered `.indigo` chain sequence |
| `packages/migrator/test/pg-harness.mjs` | Modified | Add introspection snapshot helper |
| `packages/migrator/package.json` | Modified | `test` script runs the new suite |
| `openspec/specs/migration-replay-verification/` | New | Promoted capability |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Push vs. migrate legitimately differ (e.g. `IF NOT EXISTS` guards, constraint naming) | Med | Snapshot only semantic structure; document any accepted divergence as an explicit assertion, not a silent filter |
| Chain fixtures drift from real `migrate dev` usage | Low | Drive the exact shipped export sequence; no re-implemented split |
| PGlite runtime cost grows with hops | Low | Cap the chain at 3–4 hops |

## Rollback Plan

Delete `test/replay.mjs`, `test/fixtures-chain/`, the `pg-harness.mjs` helper, and revert the
`package.json` `test` script and the promoted spec. No production code is touched, so rollback
cannot affect shipped behaviour.

## Dependencies

- `@electric-sql/pglite` (already a `@indigodb/migrator` devDependency).
- Built `packages/migrator/dist` (suites import `../dist/index.js`).

## Success Criteria

- [ ] A 3–4 hop chain replays from an empty database with zero errors.
- [ ] Replayed structure equals `renderPushSql(final)` structure on a separate instance.
- [ ] Introducing a deliberate drift in one hop fails the suite with a named divergence.
- [ ] `pnpm test` from the repo root runs it; no CI config change required.
