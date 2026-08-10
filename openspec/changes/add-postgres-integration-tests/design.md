# Design: PostgreSQL Appliability Tests for the Migrator

## Technical Approach

A second plain-Node entry point, `packages/migrator/test/appliability.mjs`, replays every
existing golden fixture against an in-process PGlite (`PostgreSQL 18.3`, WASM) engine. It adds
no test framework and no production code: it drives the *shipped* migrator exports
(`planMigration` → `renderMigrationSql` → `splitMigrationSql` → `renderPushSql`) exactly the
way `packages/cli/src/migrate-runner.ts` drives them.

Scope word is **appliability** — "the emitted SQL executes without error on a single-connection
engine" — never *correctness*. PGlite is single-connection/single-user: concurrent deploys,
advisory locking and connection-pool behaviour stay untestable and out of scope, and the
runner's own banner says so.

## Architecture Decisions

### Decision A: `prev` is materialised with `planMigration(null, prev)`

| Option | Tradeoff | Decision |
|---|---|---|
| `planMigration(null, prev)` | Reproduces the DDL a real migration history actually contains; puts the create-from-nothing path itself under execution test for the 16 fixtures that have a `prev` | **Chosen** |
| `renderPushSql(prev)` | Idempotent guards (`IF NOT EXISTS`, `DO $$`) can mask ordering defects the exact path would surface | Rejected as primary |

`renderPushSql` is not left uncovered: the idempotency requirement applies `renderPushSql(next)`
twice to a clean database for **all 20** fixtures — stronger coverage than a single seeding run.

### Decision B: a fresh in-memory PGlite instance per fixture

| Option | Tradeoff | Decision |
|---|---|---|
| Fresh `new PGlite()` per fixture | Isolation is structural, not procedural; order-independence is guaranteed | **Chosen** |
| One instance + `DROP SCHEMA public CASCADE` between fixtures | Faster, but a reset bug silently becomes a contamination bug — the exact failure the isolation requirement exists to prevent | Rejected |

The WASM module is compiled once per process and shared across instances, so per-fixture cost is
boot, not compile. Each fixture needs two isolated databases (migrate path, push-twice path).

### Decision C: phase separation is driven through the real `splitMigrationSql`

The runner re-implements only `applyMigrationSql`'s four-line client driving (that function is
private to `@indigodb/cli` and typed to `pg.Client`); the *decision* of what runs outside the
transaction comes from the production `splitMigrationSql` applied to real `renderMigrationSql`
output. Re-deriving the split from `plan.statements[].phase` would test a parallel
implementation that can drift from the marker protocol.

Two mechanisms make the separation load-bearing:

1. **Round-trip invariant** (all fixtures): `splitMigrationSql(renderMigrationSql(plan))
   .preTransaction` must match `plan.statements.filter(s => s.phase === "pre-transaction")` in
   count and text. If the renderer stopped emitting markers, this fails even where the DDL would
   still apply.
2. **Constructed negative pair.** Finding: **no existing fixture emits `ADD VALUE` *plus* a
   same-migration use of the new value** — `enum-add-value` and `enum-value-mapped` emit the
   `ALTER TYPE` alone, and PostgreSQL permits that inside a transaction. Replaying a fixture
   therefore cannot prove the split. The negative test constructs the missing shape by hand
   (`ALTER TYPE ... ADD VALUE` followed by a consuming statement) and asserts both directions:
   single-transaction execution is **rejected** with `unsafe use of new value`, split execution
   **succeeds**.

Like the FK-ordering pair, this is the constructed regression the spec asks for, not a replay.

### Decision D: refusal fixtures assert positively

For `enum-value-removed`, `map-rename-ambiguous`, `not-null-no-default`: assert
`diagnostics.length > 0` with a known `MigrationDiagnosticCode`; `statements.length === 0`;
`renderMigrationSql(plan) === ""`; and the runner's per-fixture **executed-statement counter is
exactly `0`**. They are not inert — their `prev` state still applies and their `pushSql`
idempotency check still runs. A harness self-test (`CREATE TABLE "X" ("id" nosuchtype)`) proves
the counter and the error path are real, so "zero executed" cannot mean "errors swallowed".

### Decision E: separate entry point, sequenced into `test`

`"test": "node test/migrator.mjs && node test/appliability.mjs"`, plus `test:goldens` and
`test:appliability` for targeted runs. `turbo.json`'s `test` task already depends on `build`
with no package list, so no Turbo change is needed. Tradeoff: PGlite startup makes `pnpm test`
slower. Accepted — there is no CI (`.github/` does not exist), so an opt-in suite would never
run, and inapplicable DDL is the exact risk this change exists to close. The fast text suite
runs first and fails first.

### Decision F: RED is demonstrated at the harness level

The fixture suite exercises already-correct code and goes green immediately; claiming a RED for
it would be theatre. RED is real for the two regression pairs:

1. Write `assertApplies(legacySql)` against deliberately hand-constructed pre-fix emission (FK
   before its referenced table; `ADD VALUE` + use in one transaction). **This fails** — PGlite
   rejects both with `relation "..." does not exist` and `unsafe use of new value`. That failure
   is the RED and proves the harness has detection power.
2. Invert to `assertRejects(legacySql, /pattern/)` and pair with
   `assertApplies(currentEmission)`. GREEN.

The captured RED output is the verification artifact.

## Data Flow

    fixture dir ──► loadFixture ──► {prev, next}  (parse + resolve, @indigodb/core)
                                       │
              ┌────────────────────────┴───────────────────────┐
              ▼                                                ▼
    planMigration(null, prev)                         renderPushSql(next)
    planMigration(prev, next)                                  │
              │                                          run twice on DB#2
      renderMigrationSql                                       │
              │                                                ▼
      splitMigrationSql ──► pre-tx stmts (one exec each)     assert both OK
                       └──► BEGIN · transactional body · COMMIT   (DB#1)

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/migrator/test/appliability.mjs` | Create | Suite entry: per-fixture apply, refusal assertions, push idempotency, the two regression pairs, harness self-test |
| `packages/migrator/test/pg-harness.mjs` | Create | PGlite lifecycle (`withDatabase`), `applyPlan`, `assertApplies`, `assertRejects`, executed-statement counter |
| `packages/migrator/test/lib.mjs` | Modify | Export `loadFixture(dir)` → `{prev, next}`; `computeActual` refactored onto it. No behaviour change |
| `packages/migrator/package.json` | Modify | `@electric-sql/pglite` `^0.5.4` devDependency; `test`/`test:goldens`/`test:appliability` scripts |
| `pnpm-lock.yaml` | Modify | Generated |
| `openspec/specs/migration-golden-tests/spec.md` | Modify | Narrow the "not applicability" disclaimer (archive step) |

Untouched: `packages/migrator/src/**`, all `expected.json` goldens, `regen-goldens.mjs`,
`migrator.mjs`, every other package.

## Interfaces / Contracts

```js
// test/pg-harness.mjs — no production API is added or changed
export async function withDatabase(fn);              // fresh PGlite, always closed
export async function applyPlan(db, migrationSql);   // splitMigrationSql-driven; returns count
export async function assertApplies(db, sql);
export async function assertRejects(db, sql, pattern);
```

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | `splitMigrationSql` marker contract | Existing cases in `migrator.mjs`, untouched |
| Golden | Exact SQL text | Existing `expected.json`, untouched |
| Appliability | 20 fixtures apply; refusals emit nothing; push is idempotent | `appliability.mjs` against PGlite |
| Regression | FK ordering, enum pre-transaction split | Constructed pre-fix SQL asserted rejected + current emission asserted applied |
| Out of scope | Concurrency, advisory locks, pools | Stated, not simulated |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. SQL executed is repo-authored fixture output run in-process
through a WASM engine; there is no shell interpolation and no external input.

## Migration / Rollout

No migration. Test-only, devDependency-only. Rollback = revert the two new files, the `lib.mjs`
export, and the `package.json` entries; the golden suite stays green independently.

## Review Budget

Authored changed lines ≈ **330** (`appliability.mjs` ~220, `pg-harness.mjs` ~90, `lib.mjs` ~10,
`package.json` ~4) against the 800-line budget. `pnpm-lock.yaml` is generated and excluded from
authored count. Single PR; no chaining needed.

## Alternatives Rejected

| Alternative | Reason |
|---|---|
| testcontainers + real PostgreSQL | Docker daemon is not running and no local PostgreSQL binaries exist; would gate the suite on infrastructure the repo explicitly avoids |
| vitest/jest | No test framework exists in the repo; `parity.mjs` and `migrator.mjs` set the plain-Node precedent |
| Fold appliability into `migrator.mjs` | Couples the fast text gate to WASM startup and removes targeted invocation |
| Assert against `plan.statements[].phase` directly | Tests a parallel split implementation that can drift from the production marker protocol |
| Seed `prev` with `renderPushSql` | Idempotent guards mask ordering defects |

## Open Questions

- [ ] Exact consuming statement for the enum negative test (`SELECT 'X'::"T"` vs `INSERT`) is
      confirmed at apply time; exploration already reproduced the error, so this is a detail,
      not a risk.
