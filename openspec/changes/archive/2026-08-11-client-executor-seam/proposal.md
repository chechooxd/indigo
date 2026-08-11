# Proposal: Carve the Executor seam in `@indigodb/client`

## Intent

`ModelDelegate` is already driver-agnostic: `Executor` exists (`packages/client/src/types.ts:92`) and the delegate constructor already takes one (`delegate.ts:59-62`). The only gap is `IndigoClientBase` itself — its constructor (`client.ts:43-55`) unconditionally builds `new Pool(...)`, derives `this.exec` from it (`client.ts:76-80`), and `$disconnect()` (`client.ts:91-95`) unconditionally calls `this.pool.end()`. There is no way to hand the client a pre-built executor.

Consequences: `packages/client` has ZERO tests and no test script, because exercising it requires a live PostgreSQL. This closes roadmap Phase 1's "Carve the Executor seam" epic and unblocks a PGlite-backed test harness.

## Scope

### In Scope
- `IndigoClientOptions` gains an optional executor-injection path; when supplied, no `pg.Pool` is constructed and the `connectionString`/`DATABASE_URL` requirement does not apply.
- A matching close seam so `$disconnect()` has something to close (or deliberately not close) when no real pool exists.
- `this.exec` remains the single downstream contract, identically shaped on both paths, including `log` behaviour.
- A minimal test harness for `packages/client` plus a test-only PGlite-backed executor adapter proving the seam.

### Out of Scope
- Transactions (`$transaction`), `upsert`/`aggregate`/`groupBy`, `include`/nested writes, `AND`/`OR`/`NOT` composition.
- Any shipped production alternate-driver adapter (Neon HTTP, PGlite-for-production, D1).
- **Must not change**: `delegate.ts` and the generator's emitted `IndigoClient` subclass (`packages/generator/src/client.ts`). This is a seam addition, not a rewrite.

## Capabilities

### New Capabilities
- `client-executor-injection`: injecting a pre-built executor + close seam into `IndigoClientBase`, with unchanged default `pg.Pool` behaviour.
- `client-runtime-tests`: a test harness for `packages/client` running CRUD against an in-process PGlite-backed executor.

### Modified Capabilities
- None.

## Approach

Add an optional injection option to `IndigoClientOptions`. Branch once in the constructor: injected path assigns `this.exec` from the adapter and keeps `pool` absent; default path is byte-for-byte today's behaviour. `$disconnect()` closes whichever seam exists, always after tearing down realtime.

**Open for design**: the exact shape — a paired `{ exec, close? }` adapter vs. two separate top-level options. Precedent: `harden-studio-server`'s `StudioDb` port (`{ query, readOnly, close }`); `packages/client` needs no read-only concept, so a simpler two-member shape is likely sufficient. Also for design: how `pool` is typed internally once it may be absent.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/client/src/client.ts` | Modified | Options type, constructor branch, `$disconnect()` |
| `packages/client/test/` | New | Harness + PGlite adapter + CRUD tests |
| `packages/client/package.json` | Modified | `test` script, dev dependency |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Behaviour drift on the default `pg.Pool` path | Low | Injection is opt-in; default branch untouched |
| PGlite dialect gaps vs. real Postgres | Med | Proven precedent: `packages/migrator/test/pg-harness.mjs`, `packages/cli/test/studio-harness.mjs` |
| Injected-executor lifecycle owned externally | Med | Close seam is optional; no-op close is a valid caller choice |

## Rollback Plan

Single-file source change plus additive test files. Revert `packages/client/src/client.ts` and drop `packages/client/test/` and the `test` script. No schema, IR, WASM, or generated-code contract is touched, so no rebuild cascade and no downstream migration.

## Dependencies

- A PGlite dev dependency in `packages/client`.
- No `crates/` change, therefore no `build:wasm` or golden-snapshot regeneration.

## Success Criteria

- [ ] A client can be constructed with an injected executor and no `connectionString`/`DATABASE_URL`.
- [ ] Default construction behaviour, including its missing-connection-string error, is unchanged.
- [ ] `$disconnect()` succeeds on both paths and never calls `pool.end()` when no pool was built.
- [ ] `pnpm test` runs `packages/client` tests green against PGlite.
- [ ] `delegate.ts` and `packages/generator/src/client.ts` are unmodified in the final diff.
