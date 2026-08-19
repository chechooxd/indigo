# Tasks: PGlite Adapter Typed-Error Parity

Single-commit change (design.md — no PR slicing). Strict TDD: RED tasks must
be run and observed failing against the current `pglite.ts` before the GREEN
wrap lands. All tasks are sequential (one file pair, one commit); nothing here
parallelizes.

## 1. RED — prove the gap with two failing regression tests

- [x] 1.1 In `packages/client/test/adapters.mjs`, add a new `Phase 4:
      createPGliteAdapter error-parity` section (after the existing Phase 3.1
      block, before the `if (failures > 0)` tail), importing `withDatabase`
      from `./pglite-harness.mjs` alongside the existing imports.
      _Satisfies: spec.md Scenario "Typed error thrown on a plain exec" /
      "Typed error thrown inside a transaction callback" (test scaffolding)._
- [x] 1.2 Add check `"createPGliteAdapter: a unique-constraint violation on
      the direct exec path surfaces as IndigoDatabaseError"`: inside
      `withDatabase`, create table `"User"(id SERIAL PRIMARY KEY, email TEXT
      NOT NULL UNIQUE)`, build `createPGliteAdapter(db)`, insert `a@x.com`
      via `adapter.exec`, insert `a@x.com` again via `adapter.exec` inside a
      `try/catch`, and assert on the caught error: `instanceof
      IndigoDatabaseError`, `.code === "UNIQUE_VIOLATION"`, `.sqlstate ===
      "23505"`, `.cause !== undefined`.
      _Satisfies: spec.md Scenario "Typed error thrown on a plain exec"._
- [x] 1.3 Add check `"createPGliteAdapter: a unique-constraint violation
      inside a transaction callback surfaces as IndigoDatabaseError and
      escapes $transaction"`: same table fixture, seed `a@x.com` via
      `adapter.exec` outside the transaction, then call
      `adapter.transaction(async (exec) => { await exec(insert a@x.com
      again); })`, catch the rejection, and assert the same four properties
      (`instanceof IndigoDatabaseError`, `.code === "UNIQUE_VIOLATION"`,
      `.sqlstate === "23505"`, `.cause !== undefined`).
      _Satisfies: spec.md Scenario "Typed error thrown inside a transaction
      callback"._
- [x] 1.4 Run `pnpm --filter @indigodb/client build && node
      packages/client/test/adapters.mjs` and confirm both new checks report
      `FAIL` against the current (unwrapped) `pglite.ts` — the caught error
      must be the raw PGlite `DatabaseError`, not `IndigoDatabaseError`. This
      is the required RED evidence; do not proceed to section 2 until both
      fail for the expected reason (not a harness/import bug).

## 2. GREEN — wrap both `createPGliteAdapter` executors

- [x] 2.1 In `packages/client/src/adapters/pglite.ts`, add `import {
      withDatabaseErrors } from "../errors.js";`.
      _Satisfies: spec.md Requirement "`createPGliteAdapter` promotes the
      PGlite test harness to a public export" (error-parity clause)._
- [x] 2.2 Wrap the plain `exec` executor: `const exec: Executor =
      withDatabaseErrors(async (sql, params) => (await pglite.query(sql,
      params)).rows);` — mirrors `pg.ts`'s `exec` wrapping exactly (design.md
      "Interfaces / Contracts").
      _Satisfies: spec.md Scenario "Typed error thrown on a plain exec"._
- [x] 2.3 Wrap the executor passed into `fn` inside `transaction`: `const
      transaction: DriverAdapter["transaction"] = (fn) =>
      pglite.transaction(async (tx) => fn(withDatabaseErrors(async (sql,
      params) => (await tx.query(sql, params)).rows)));` — leave the outer
      `pglite.transaction(...)` promise itself unwrapped (design.md Decision
      "Outer `pglite.transaction()` rejection").
      _Satisfies: spec.md Scenario "Typed error thrown inside a transaction
      callback"._
- [x] 2.4 Confirm no other line in `pglite.ts` changed: signature, `PGliteLike`,
      `close` handling, and JSDoc stay as-is except for the new import and the
      two executor bodies.
      _Satisfies: proposal.md "Out of Scope" — no taxonomy/`pg.ts` changes._

## 3. Verify GREEN and no regressions

- [x] 3.1 Run `pnpm --filter @indigodb/client build && node
      packages/client/test/adapters.mjs` again; both Phase 4 checks and the
      existing Phase 2/3 checks (including Phase 3.1's "never a raw
      BEGIN/COMMIT/ROLLBACK" assertion) must now report `ok`.
      _Satisfies: spec.md Scenario "Typed error thrown on a plain exec" /
      "Typed error thrown inside a transaction callback"; proposal.md Success
      Criteria._
- [x] 3.2 Run `pnpm lint` and `pnpm test` from the repo root; both must pass.
      _Satisfies: proposal.md Success Criteria ("`pnpm lint` and `pnpm test`
      pass")._
- [x] 3.3 Diff `packages/client/src/errors.ts` and
      `packages/client/src/adapters/pg.ts` against `HEAD` and confirm they
      are unchanged.
      _Satisfies: proposal.md Success Criteria ("`errors.ts` and `pg.ts`
      unchanged")._

## 4. Commit

- [x] 4.1 Single conventional commit covering `pglite.ts` +
      `test/adapters.mjs` (e.g. `fix(client): wrap createPGliteAdapter
      executors with withDatabaseErrors`). No PR slicing — direct commit to
      `main` per the design's single-commit scope.
