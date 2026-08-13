# Design: Client Type Honesty

## Technical Approach

Four independent edits, one PR (proposal "Approach"). One new runtime module
(`packages/client/src/errors.ts`) carrying `IndigoDatabaseError` plus an
`Executor`-shaped wrapper applied at every raw-driver call site in
`client.ts`; two localized emission edits in `packages/generator/src/client.ts`;
test/golden updates alongside each. `select` narrowing is verification only —
`SelectedScalars` (`types.ts`) already uses `Pick`, exercised by
`test/typecheck.mjs`'s real `tsc --noEmit` fixture; the only deliverable is a
regression-guard note, no code change.

## Architecture Decisions

### Decision: Wrapping sits INSIDE the extension chain (innermost)

**Choice**: `withDatabaseErrors(run)` wraps the raw driver executor before
`wrapLog`/`applyExtensions` compose over it, at all three exec paths.
**Alternatives considered**: wrapping outside the composed chain (once, around
`this.exec`).
**Rationale**: outside-wrapping would also swallow errors thrown by a
`QueryExtension` itself and would let extensions observe raw pg errors —
splitting the taxonomy exactly where `client-query-extensions` says errors
propagate unwrapped. Innermost placement means every extension, plus every
delegate, sees the typed error, while extension-authored errors stay untouched.

### Decision: all three exec paths, including BEGIN/COMMIT

**Choice**: wrap (a) the `pool.query` executor built in the constructor
(client.ts:108), (b) the session executor lambda passed to `scoped`
(client.ts:213-217), and (c) the `BEGIN`/`COMMIT`/`ROLLBACK` control statements.
**Alternatives considered**: pool path only.
**Rationale**: `$transaction` would silently escape the taxonomy otherwise —
the same class of bug `client-extension-seam` fixed for the extension seam.
`COMMIT` matters concretely: a DEFERRABLE unique constraint raises 23505 at
COMMIT, not at the failing statement. `ROLLBACK` failure keeps its existing
poison/`console.error` handling.

### Decision: injected `db.exec` path stays unwrapped

**Choice**: no wrapping when `options.db` is supplied.
**Rationale**: the host engine (PGlite, a shared pool) owns its own error
shapes; SQLSTATE presence is not guaranteed. Documented boundary, same style as
the existing BEGIN/COMMIT extension-bypass comment.

### Decision: SQLSTATE detection is structural, taxonomy is minimal

**Choice**: read `.code` off the caught value; `"23505"` → `UNIQUE_VIOLATION`,
anything else (including a missing/short code) → `UNKNOWN`. Never double-wrap
an existing `IndigoDatabaseError`.
**Alternatives considered**: `err instanceof pg.DatabaseError`; an exhaustive
SQLSTATE catalog (explicitly out of scope).
**Rationale**: `instanceof` breaks across duplicate `pg` copies in a pnpm tree.
Structural reading keeps the wrapper driver-agnostic and additive — new codes
join the union later without touching call sites.

### Decision: const-object enums, parenthesized `typeof`

**Choice**: emit a `const` (value space) plus a `type` alias (type space) under
one identifier.
**Rationale**: TS keeps value and type declaration spaces separate, so `const X`
and `type X` coexist legally — unlike `type X` + `interface X`. `baseType()`
(generator client.ts:45-48) returns the bare enum name for type position and
needs no change; `__meta` never emits enum members in value position (verified:
the emission block at client.ts:295-299 is the only enum reference).

Before / after, both positions proven:

```ts
// before                          // after
export enum Status {               export const Status = {
  ACTIVE = "active",                 ACTIVE: "active",
  INACTIVE = "INACTIVE",             INACTIVE: "INACTIVE",
}                                  } as const;
                                   export type Status = (typeof Status)[keyof typeof Status];

interface UserRow { status: Status }   // type position → the alias ("active" | "INACTIVE")
db.user.create({ data: { status: Status.ACTIVE } }); // value position → the const
```

## Data Flow

    delegate ──→ this.exec ──→ extensions ──→ wrapLog ──→ withDatabaseErrors ──→ pg
                                                              │
                                            IndigoDatabaseError │ { code, sqlstate, cause }
                                                              ↓ (propagates back out
                                                                 through the chain typed)

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/errors.ts` | Create | `IndigoDatabaseError`, `DatabaseErrorCode`, `withDatabaseErrors` |
| `packages/client/src/client.ts` | Modify | Wrap pool executor, session executor, BEGIN/COMMIT |
| `packages/client/src/index.ts` | Modify | Re-export the error class + code type |
| `packages/generator/src/client.ts` | Modify | `SCALAR_TO_TS[BigInt]` → `"string"`; enum emission block |
| `packages/generator/test/enum-mapping.mjs` | Modify | Golden expects const-object form |
| `packages/client/test/fixtures/typecheck-fixture.ts` | Modify | Add an enum column (both positions) |
| `packages/client/test/database-errors.mjs` | Create | Fake-executor taxonomy tests |
| `packages/client/test/transactions-pg.mjs` | Modify | Real 23505 over the pg.Pool path |
| `packages/client/package.json` | Modify | Add `database-errors.mjs` to `test` |

Do NOT touch `packages/migrator/src/postgres.ts`'s `"bigint"` — that is the
PostgreSQL column type, not a TS type.

## Interfaces / Contracts

```ts
export type DatabaseErrorCode = "UNIQUE_VIOLATION" | "UNKNOWN";

export class IndigoDatabaseError extends Error {
  readonly code: DatabaseErrorCode;
  readonly sqlstate: string;   // raw SQLSTATE, "" when absent
  // `cause` carries the original pg DatabaseError (Error.cause, ES2022)
  constructor(code: DatabaseErrorCode, sqlstate: string, message: string, cause: unknown);
}

/** Innermost Executor decorator — never double-wraps. */
export function withDatabaseErrors(run: Executor): Executor;
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | 23505 → `UNIQUE_VIOLATION`; other SQLSTATE → `UNKNOWN`; `cause`/`sqlstate` preserved; no double-wrap; success path untouched | `database-errors.mjs`: `withDatabaseErrors` over a fake run throwing a synthetic `{ code: "23505" }` |
| Unit | Extensions observe the typed error (chain ordering) | `IndigoClientBase` with an extension recording what it catches |
| Integration | Real unique violation, statement-level and inside `$transaction` | `transactions-pg.mjs` via `pglite-socket-harness.mjs` (real `pg.Pool`) |
| Unit | BigInt → `string`; const-object enum text | `enum-mapping.mjs` golden + a BigInt column assertion |
| Type | Enum in type and value position; `select` narrowing regression guard | `typecheck.mjs` fixture, real `tsc --noEmit` |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file
classification, or process-integration boundary.

## Migration / Rollout

No migration required. Generated-surface break is intended and unpublished;
consumers regenerate via `indigodb generate`.

## Open Questions

- [ ] None blocking.
