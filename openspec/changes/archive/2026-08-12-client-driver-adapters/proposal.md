# Proposal: Client Driver Adapters

## Intent

The `Executor` seam (`client-executor-injection`) is complete but **anonymous**: every
non-`pg` consumer must hand-write `{ exec, transaction, close }` from scratch. Two
correctness traps are invisible at that seam:

1. Passing `db` sets `this.pool = null`, so `$transaction` throws unless the caller
   supplies a `transaction` hook — a silent regression versus `connectionString`.
2. The injected path is deliberately **not** wrapped by `withDatabaseErrors`, so a
   hand-rolled `pg` executor loses typed `IndigoDatabaseError`s.

Ship named, documented adapters that carry those invariants so "bring your own driver"
is a supported path, not a footgun. Half 2 of Phase 2 epic 4/5, split out per the
exploration: structurally disjoint from the Rust half (no WASM rebuild, no snapshot regen).

## Scope

### In Scope

- `createPgAdapter(config)` — wraps `pg.Pool`, returns `{ exec, transaction, close }` at
  full parity with the built-in path: `withDatabaseErrors` wrapping, client checkout +
  `BEGIN`/`COMMIT`/`ROLLBACK` with poison-aware `release`, `pool.end()` on close.
- `createPGliteAdapter(pglite)` — structurally typed (duck-typed `{ query, transaction }`),
  promoting `test/pglite-harness.mjs`'s `createPgliteDb` to a real export. PGlite stays a
  devDependency; no runtime dep, no type import.
- `packages/client/src/adapters/` + re-exports from `index.ts`.
- Docs: "bring your own driver" guide, including Neon HTTP shaped as an `Executor`.
- Tests: PGlite adapter end-to-end; pg adapter transaction/error/close behavior.

### Out of Scope

- `createNeonAdapter` as code, and any `@neondatabase/serverless` dependency
  (documentation-only; the exploration found no reason to bundle a serverless HTTP driver
  that cannot honor the session-bound `transaction` hook).
- Changing `IndigoClientBase`, `IndigoClientOptions`, or the `Executor` type.
- Deprecating `connectionString`.

## Capabilities

### New Capabilities
- `client-driver-adapters`: named factories producing `IndigoClientOptions["db"]` values,
  and the parity guarantees each one must uphold.

### Modified Capabilities
- None. `client-executor-injection` requirements are unchanged; adapters are consumers of
  that seam, not modifications to it.

## Approach

Pure additive layer over the existing seam. `createPgAdapter` reuses the exact logic
already living in the `IndigoClientBase` constructor's `else` branch and `$withSession`'s
pool branch — extracted, not reinvented, so the two paths cannot drift.
`createPGliteAdapter` takes a minimal structural interface so no PGlite types enter the
public surface. Neon is a documented recipe.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/client/src/adapters/pg.ts` | New | `createPgAdapter` |
| `packages/client/src/adapters/pglite.ts` | New | `createPGliteAdapter` |
| `packages/client/src/index.ts` | Modified | Re-export adapters |
| `packages/client/test/` | Modified | Adapter tests; harness may consume the real adapter |
| Docs | New | Bring-your-own-driver guide |
| `packages/compiler/wasm/`, `fixtures/snapshots/` | None | No compiler impact |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| pg adapter drifts from built-in pool path | Med | Extract shared helper; both paths call it |
| Named adapters read as endorsement of untested drivers | Low | Docs state Neon is unverified/user-owned |
| Structural PGlite typing too loose | Low | Test against the real PGlite devDependency |

## Rollback Plan

Revert the single PR. Nothing else imports the new module; `IndigoClientOptions.db`
continues to accept hand-written executors exactly as today.

## Dependencies

- None. No new runtime or peer dependencies.

## Success Criteria

- [ ] `createPgAdapter` + `createPGliteAdapter` exported from `@indigodb/client`
- [ ] A client built via `createPgAdapter` passes `$transaction`, typed-error, and
      `$disconnect` behavior identical to a `connectionString` client
- [ ] PGlite test suite runs through the exported adapter
- [ ] No new dependency in `packages/client/package.json`
- [ ] `pnpm build`, `pnpm lint`, `pnpm test` green; zero WASM/snapshot diff
