# Design: PGlite Adapter Typed-Error Parity

## Technical Approach

`createPgAdapter` decorates every executor it hands out with `withDatabaseErrors`;
`createPGliteAdapter` decorates none. Close the gap mechanically: wrap the two
executors `createPGliteAdapter` constructs (`exec`, and the executor passed to
`fn` inside `transaction`) with the same decorator, at the same position —
innermost, at construction, before `IndigoClientBase` composes `wrapLog`/
extensions over it. `withDatabaseErrors` is structural (`"code" in err`, string
check, never `instanceof`), and PGlite's `DatabaseError extends Error` carries
`code: string | undefined`, so no adaptation layer is needed. Proof of that
runtime claim is the new real-PGlite regression test, not a type assertion.

## Architecture Decisions

| Decision | Choice | Alternatives rejected | Rationale |
|---|---|---|---|
| Wrapping sites | The two executors built inside `createPGliteAdapter` only | Wrap in `IndigoClientBase` for all adapters; wrap in `PGliteLike` | `pg.ts` already owns wrapping per-adapter; centralizing would duplicate wrapping for pg and change the documented "injected `db.exec` stays unwrapped" boundary in `client.ts` |
| Outer `pglite.transaction()` rejection | Leave untyped (resolves the proposal's open question) | Wrap the whole `pglite.transaction(...)` promise | pg.ts wraps *statement* sites (`BEGIN`/`COMMIT`), not the transaction construct. PGlite exposes no statement site for commit; wrapping the outer promise would also re-type user errors thrown from `fn` that happen to carry a string `code`, which pg.ts never does. Parity means same rule, not same surface |
| Test placement | New Phase 4 block in `packages/client/test/adapters.mjs` | New assertions inside `pglite-harness.mjs` | The harness is assertion-free lifecycle infra; `adapters.mjs` already hosts real-PGlite `createPGliteAdapter` coverage (Phase 3.1) and is already wired into `pnpm test` with no external Postgres |
| Harness reuse | Import `withDatabase` from `./pglite-harness.mjs` | Inline `new PGlite()` + `try/finally` | `withDatabase` is the existing isolation+teardown contract; extending its consumers is the stated intent |

## Data Flow

    client.$queryRaw / $transaction
             │
             ▼
      IndigoClientBase  ──(extensions, wrapLog)──┐
                                                 ▼
                       createPGliteAdapter.exec = withDatabaseErrors(raw)   ← added
                                                 │
                                                 ▼
                                   pglite.query → DatabaseError{code:"23505"}
                                                 │
                                                 ▼
                          IndigoDatabaseError{ UNIQUE_VIOLATION, "23505", cause }

Transaction path is identical, with `tx.query` in place of `pglite.query`; the
outer `pglite.transaction()` promise itself stays unwrapped.

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/client/src/adapters/pglite.ts` | Modify | Import `withDatabaseErrors`; wrap both executors |
| `packages/client/test/adapters.mjs` | Modify | Phase 4: two real-PGlite unique-violation regressions (direct exec path, transaction path) |
| `openspec/changes/pglite-adapter-error-parity/specs/client-driver-adapters/spec.md` | Written | Parity requirement delta (owned by sdd-spec; merges into `openspec/specs/client-driver-adapters/spec.md` on archive) |
| `packages/client/test/pglite-harness.mjs` | Unchanged | `withDatabase` is reused as-is; the proposal listed it as modified, but no assertion belongs in lifecycle infra |

## Interfaces / Contracts

No public type changes. `createPGliteAdapter`'s signature, `PGliteLike`, and
`DriverAdapter` are untouched. Exact edit:

```ts
import { withDatabaseErrors } from "../errors.js";

const exec: Executor = withDatabaseErrors(
  async (sql, params) => (await pglite.query(sql, params)).rows,
);

const transaction: DriverAdapter["transaction"] = (fn) =>
  pglite.transaction(async (tx) =>
    fn(withDatabaseErrors(async (sql, params) => (await tx.query(sql, params)).rows)),
  );
```

Behavioral contract change: failures from these two paths now throw
`IndigoDatabaseError` with `.cause` set to the original PGlite error. Non-driver
errors (e.g. `TypeError`) and errors without a string `code` still pass through
untouched — that is `withDatabaseErrors`' own rule, not new logic here.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | `withDatabaseErrors` classification | Already covered by `test/database-errors.mjs`; no new unit test |
| Integration | Real PGlite unique violation via `createPGliteAdapter` exec path | `withDatabase` → `CREATE TABLE "User"(id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE)`, insert `a@x.com`, insert again, assert `instanceof IndigoDatabaseError`, `code === "UNIQUE_VIOLATION"`, `sqlstate === "23505"`, `cause !== undefined` |
| Integration | Same violation inside `client.$transaction` | Same fixture; second insert issued through the `tx` executor, same four assertions; assert the rejection escapes `$transaction` |
| Regression | Existing Phase 3.1 no-raw-control-statement test | Must still pass unchanged — wrapping adds no SQL |

RED first: both new checks must fail on current `pglite.ts` before the wrap.
Note `adapters.mjs` imports from `../dist/`, so `pnpm --filter @indigodb/client build` precedes the run.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file
classification, or process-integration boundary.

## Migration / Rollout

No migration. Single commit; revert restores the prior untyped behavior.
Callers currently catching raw PGlite errors by `instanceof`/`.code` see typed
errors instead — the original instance stays reachable via `.cause`. Worth a
changelog line as a behavior change, not a breaking API change.

## Open Questions

- None. The proposal's open question (outer `transaction()` rejection) is
  resolved above as deliberately out of scope.
