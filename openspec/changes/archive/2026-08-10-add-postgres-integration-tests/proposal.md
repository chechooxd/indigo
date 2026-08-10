# Proposal: PostgreSQL Appliability Tests for the Migrator

## Intent

`packages/migrator` emits DDL that irreversibly mutates user databases, and no test
has ever executed one statement of it. The 20 golden fixtures pin generated SQL
**text**; both archived changes stated honestly that nothing proves the DDL
*applies*. `fix-migrator-correctness`'s release notes name this as the follow-up.
Close the gap: prove the emitted SQL runs against real PostgreSQL.

## Scope

### In Scope

- Execute emitted DDL against PGlite for each existing golden fixture: apply `prev`, then apply the plan, assert success.
- For refusal fixtures (diagnostics present), assert no DDL is emitted and nothing is executed.
- Prove `renderPushSql` idempotency by executing it twice against the same database.
- Two explicit regression tests seeded from the historical bugs: FK emitted before its referenced table, and enum `ADD VALUE` inside the migration transaction.
- Wire the suite into `packages/migrator`'s `test` script so root `pnpm test` covers it.

### Out of Scope

Concurrency, advisory locking, connection-pool behaviour, drift detection,
checksums, `db pull`, `packages/client`'s runtime surface, CI wiring
(no `.github/` exists — its own change).

## Capabilities

### New Capabilities
- `migration-appliability-tests`: emitted DDL must execute successfully against a real PostgreSQL engine; refusals must emit nothing; `renderPushSql` must be idempotent.

### Modified Capabilities
- `migration-golden-tests`: the requirement "Golden fixtures pin generated text, not applicability" must be narrowed — appliability is no longer out of scope; goldens keep owning exact text while the new capability owns execution.

## Approach

**Decision (settled, evidence-based): PGlite `@electric-sql/pglite` 0.5.4, not
testcontainers.** Measured this session: Docker is installed but its daemon is not
running and no local PostgreSQL binaries exist, so testcontainers would gate the
suite on Docker. PGlite reports `PostgreSQL 18.3 ... on wasm32-unknown-linux-gnu`;
every DDL shape the migrator emits applied cleanly, and it **reproduced both fixed
bugs with their exact errors** (`relation "U" does not exist`; `unsafe use of new
value "B" of enum type "S"`). It rejects the SQL we used to emit, which makes it a
regression net rather than a rubber stamp. It also fits the repo: zero
infrastructure, an established WASM-in-Node precedent, the stated rule that a
TypeScript-only dev never needs a heavy toolchain, and a client design that already
names PGlite as a driver-adapter target.

Extend the existing plain-Node harness (`test/migrator.mjs` + `lib.mjs`); add no
test framework. Each fixture gets a fresh in-memory database.

**Honest framing:** this closes *"does the emitted SQL apply"*, NOT *"does the
system behave correctly under production concurrency"*. PGlite is
single-connection/single-user and cannot test concurrent deploys, advisory locking,
or pools; it is a WASM build that may lag server versions or lack extensions. Those
limits must be stated in the spec, not buried. If concurrency testing ever becomes
a real need, testcontainers is the named option.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/migrator/test/` | Modified | New appliability runner alongside the golden harness |
| `packages/migrator/package.json` | Modified | Add `@electric-sql/pglite` devDependency; `test` runs both |
| `openspec/specs/migration-golden-tests/` | Modified | Narrow the "not applicability" disclaimer |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| PGlite diverges from server PostgreSQL | Low | Proven against every emitted DDL shape; state the limitation explicitly |
| Suite reads as broader proof than it is | Med | Spec and test names say "appliability", never "correctness under load" |
| WASM startup slows `pnpm test` | Low | One shared module init; per-fixture databases are in-memory |

## Rollback Plan

Revert the test files and the `@electric-sql/pglite` devDependency, and restore
`packages/migrator/package.json`'s `test` script to `node test/migrator.mjs`.
No production code, no runtime dependency, no schema or data changes — the golden
harness is untouched and stays green independently.

## Dependencies

- `@electric-sql/pglite` ^0.5.4 (devDependency only)

## Success Criteria

- [ ] Every non-refusal golden fixture applies `prev` then its plan against PGlite without error.
- [ ] Every refusal fixture asserts zero emitted statements and executes nothing.
- [ ] `renderPushSql` applied twice succeeds both times.
- [ ] Reverting the FK-ordering fix makes the suite fail with `relation ... does not exist`.
- [ ] Reverting the enum pre-transaction split makes the suite fail with `unsafe use of new value`.
- [ ] `pnpm test` from the repo root runs the new suite and is green.
