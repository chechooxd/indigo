# Tasks: Client Type Honesty

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~260-320 |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | auto-chain |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Typed `IndigoDatabaseError` + `withDatabaseErrors` wrapping at all exec sites | PR 1 | `node packages/client/test/database-errors.mjs` | `node packages/client/test/transactions-pg.mjs` (pglite-socket-harness, real 23505) | revert `errors.ts`, `client.ts`, `index.ts` |
| 2 | BigInt → string, const-object enums | PR 1 | `node packages/generator/test/enum-mapping.mjs` | `node packages/client/test/typecheck.mjs` (real `tsc --noEmit`) | revert two `packages/generator/src/client.ts` blocks + goldens |

## Phase 1: Foundation — `IndigoDatabaseError`

- [x] 1.1 RED: `packages/client/test/database-errors.mjs` — assert `withDatabaseErrors` over a fake `run` throwing `{code:"23505"}` throws `IndigoDatabaseError` with `code:"UNIQUE_VIOLATION"` (Requirement: wraps driver-level failures, Scenario: unique violation classified).
- [x] 1.2 RED: same file — non-`23505` code (e.g. `"23503"`) throws `code:"UNKNOWN"`, `sqlstate:"23503"` exposed (Scenario: non-unique falls into UNKNOWN; raw SQLSTATE exposed alongside taxonomy).
- [x] 1.3 RED: same file — a thrown `TypeError` (no `.code`) passes through unwrapped, not an `IndigoDatabaseError` (Scenario: non-pg errors are not wrapped).
- [x] 1.4 RED: same file — `error.cause` is the original thrown value, not `undefined`/re-serialized (Scenario: cause chain is intact).
- [x] 1.5 RED: same file — an already-`IndigoDatabaseError` thrown by `run` propagates unchanged (never double-wrapped, per design).
- [x] 1.6 RED: same file — success path: `run` resolving normally returns its value unmodified through the wrapper.
- [x] 1.7 GREEN: create `packages/client/src/errors.ts` with `DatabaseErrorCode`, `IndigoDatabaseError` (`code`, `sqlstate`, `cause` via `Error.cause`), and `withDatabaseErrors(run: Executor): Executor` per design's interface block. Make 1.1-1.6 pass.
- [x] 1.8 Re-export `IndigoDatabaseError`/`DatabaseErrorCode` from `packages/client/src/index.ts`.

## Phase 2: Wire wrapping into `client.ts`

- [x] 2.1 RED: `packages/client/test/database-errors.mjs` — extension observes the typed `IndigoDatabaseError` (construct `IndigoClientBase` with a fake exec throwing `{code:"23505"}` and a recording `QueryExtension`; assert the extension's `catch` sees `IndigoDatabaseError`).
- [x] 2.2 GREEN: wrap the pool executor in the constructor (`client.ts:~109`) with `withDatabaseErrors` innermost, before `wrapLog`/`applyExtensions` compose (`client.ts:118-119`).
- [x] 2.3 GREEN: wrap the session executor lambda passed into `scoped` inside `$withSession` (`client.ts:~194`) the same way.
- [x] 2.4 GREEN: wrap the `BEGIN` and `COMMIT` `client.query` calls (`client.ts:~210, ~227`) with `withDatabaseErrors`; leave `ROLLBACK` (`client.ts:~220-223`) untouched — its existing poison/`console.error` handling stays.
- [x] 2.5 Add a documented-boundary comment next to the `options.db`-injected exec path (mirrors the existing extension-bypass comment style) explaining wrapping is deliberately skipped when the host engine owns error shapes.
- [x] 2.6 RED: `database-errors.mjs` or `transactions-pg.mjs` — a test exercising the injected `db.exec` path confirms it stays unwrapped (raw driver error, not `IndigoDatabaseError`), proving the documented boundary is a real spec-covered scenario.
- [x] 2.7 GREEN (integration): `packages/client/test/transactions-pg.mjs` — new case triggering a real Postgres unique-constraint violation via `pglite-socket-harness.mjs`'s `pg.Pool`, both as a direct statement failure and inside `$transaction`/`$withSession`; assert `IndigoDatabaseError` with `code:"UNIQUE_VIOLATION"`.
- [x] 2.8 Register `database-errors.mjs` in `packages/client/package.json`'s `test` script.

## Phase 3: Generator — BigInt and const-object enums

- [x] 3.1 RED: `packages/generator/test/enum-mapping.mjs` — assert a `BigInt` scalar column emits `string` (not `bigint`) in the generated `Row` interface.
- [x] 3.2 GREEN: `packages/generator/src/client.ts:34` — change `SCALAR_TO_TS[ScalarType.BigInt]` from `"bigint"` to `"string"`. Do NOT touch `packages/migrator/src/postgres.ts:43,121` (`"bigint"` there is the PostgreSQL DDL type name, unrelated).
- [x] 3.3 RED: `enum-mapping.mjs` — update/add golden assertion expecting `export const X = {...} as const` + `export type X = typeof X[keyof typeof X]` instead of `export enum X {...}`.
- [x] 3.4 GREEN: `packages/generator/src/client.ts:~295-299` — replace the nominal `export enum` emission block with the const-object + paired-type emission per design's before/after.
- [x] 3.5 Add an enum column to `packages/client/test/fixtures/typecheck-fixture.ts` (none exists today), covering both value-position (`X.Value`) and type-position (`col: X`) usage.
- [x] 3.6 RED→GREEN: extend `packages/client/test/typecheck.mjs`'s real `tsc --noEmit` run to cover the new enum-fixture cases; both positions must compile, and the fixture must compile under `erasableSyntaxOnly`.

## Phase 4: Verification and regression guard

- [x] 4.1 Verify (no code change): confirm `SelectedScalars` in `packages/client/src/types.ts` still uses `Pick` and that `typecheck.mjs`'s existing `select`-scoped fixture still proves excluded fields remain compile errors — record as verified in the PR description.
- [x] 4.2 Verify `packages/client/tsconfig.json`'s inherited root `tsconfig.json` `target`/`lib` supports `Error.cause` (ES2022); if not, raise the lib floor.
- [x] 4.3 Run `pnpm build --filter=@indigodb/client` and `pnpm build --filter=@indigodb/generator`.
- [x] 4.4 Run full monorepo `pnpm build && pnpm lint && pnpm test`.
