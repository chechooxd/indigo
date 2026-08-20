# Proposal: PGlite Adapter Typed-Error Parity

## Intent

`createPgAdapter` wraps every exec path with `withDatabaseErrors`, so pg failures surface as
typed `IndigoDatabaseError`. `createPGliteAdapter` wraps none of them, so identical failures
surface raw and untyped. This breaks the parity guarantee already recorded for
`client-driver-adapters` and forces PGlite users back to SQLSTATE string-matching that the
`client-database-errors` capability exists to eliminate. Exploration confirmed
`withDatabaseErrors` is structural (`"code" in err`, never `instanceof`) and PGlite 0.5.4 ships
its own `DatabaseError extends Error` with `code: string | undefined` — the exact expected shape.
No adaptation is needed; this is a mechanical omission, and no test proves the compatibility
claim at runtime today.

## Scope

### In Scope

- Wrap `createPGliteAdapter`'s `exec` with `withDatabaseErrors`, mirroring `pg.ts`.
- Wrap the executor handed to the caller inside `transaction(fn)` the same way.
- Add a real-PGlite regression test asserting a unique violation throws `IndigoDatabaseError`
  with `code === "UNIQUE_VIOLATION"`, `sqlstate === "23505"`, and an intact `cause`, on both the
  pool-equivalent and transaction paths.

### Out of Scope

- Any change to `packages/client/src/errors.ts` (taxonomy, `sqlstateOf`, wrapper shape).
- Any change to `packages/client/src/adapters/pg.ts`.
- New taxonomy codes or PGlite-specific error classification.
- Making PGlite a runtime dependency; it stays a devDependency.

## Capabilities

### New Capabilities

- None

### Modified Capabilities

- `client-driver-adapters`: add a requirement that `createPGliteAdapter` preserves typed
  database errors on all its exec paths, matching the existing `createPgAdapter` requirement.

## Approach

Mirror `pg.ts`'s exact wrapping pattern. PGlite has no `BEGIN`/`COMMIT` statement sites — it uses
its own `transaction(tx => …)` API — so parity means the two query sites only. Whether the outer
`pglite.transaction()` rejection (e.g. deferred-constraint failure at commit) must also be typed
is the one open question for spec/design.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/client/src/adapters/pglite.ts` | Modified | Wrap both exec sites |
| `packages/client/test/pglite-harness.mjs` | Modified | Real-PGlite error regression test |
| `openspec/specs/client-driver-adapters/spec.md` | Modified | New parity requirement |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| PGlite error shape differs at runtime from its `.d.ts` | Low | The added real-PGlite test is exactly the proof |
| Callers depend on catching raw PGlite errors | Low | `cause` preserves the original instance |

## Rollback Plan

Revert the single commit. `pglite.ts` is self-contained; no shared module changes.

## Success Criteria

- [ ] Both `createPGliteAdapter` exec paths wrapped with `withDatabaseErrors`
- [ ] Real-PGlite unique violation throws `IndigoDatabaseError` / `UNIQUE_VIOLATION` / `23505`
- [ ] `errors.ts` and `pg.ts` unchanged
- [ ] `pnpm lint` and `pnpm test` pass
