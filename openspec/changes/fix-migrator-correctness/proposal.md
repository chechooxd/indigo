# Proposal: Fix Migrator DDL Correctness

## Intent

`packages/migrator` emits DDL that irreversibly mutates user databases and has **zero tests**. Five defects, each reproduced by running the built migrator:

- FK constraints emitted **before** their referenced table (no topological sort) → the first `migrate dev --name init` fails on any schema not declared in dependency order.
- Four change classes emit **zero DDL**: `@map` rename, `onDelete` change, enum value removal, PK change. A silent no-op is worse than an error — snapshot unchanged, database diverges permanently, no signal anywhere.
- `ADD COLUMN ... NOT NULL` with no default, unguarded against populated tables.
- `ALTER TYPE ... ADD VALUE` inside the runner's wrapping transaction; PostgreSQL rejects it.
- Inherited from `fix-compiler-correctness`: `ForeignKey.onUpdate` and `ResolvedEnum.members` reach the IR, no renderer reads them.

## Scope

### In Scope
- **Golden test harness for `packages/migrator`** (schema-pair fixtures → expected SQL), mirroring `packages/compiler/test/parity.mjs`. Slice one — nothing else is TDD-able without it.
- Topological table ordering; FK emission moved out of `createTable`/`tableConstraints`.
- DDL for the four silent no-op classes.
- Guarded `ADD COLUMN NOT NULL`; appliable enum `ADD VALUE`.
- `ON UPDATE` emission; enums rendered from `members`/`dbName` instead of `values`.

### Out of Scope
Drift detection; shadow database; introspection/`db pull`; checksums; advisory locking; `migrate resolve`/`reset`/baseline; failed-migration recording; destructive-change prompts; **field-rename ambiguity**; integration tests against real PostgreSQL. Each is its own later change.

## Capabilities

### New Capabilities
- `migration-ddl-ordering`: FK constraints follow their referenced tables regardless of declaration order; enum `ADD VALUE` emitted so it is appliable.
- `migration-diff-completeness`: `@map` rename, enum value removal and PK change emit correct DDL.
- `migration-safety-guards`: `ADD COLUMN NOT NULL` without a default is never emitted unguarded.
- `migration-golden-tests`: every DDL-emitting change class is pinned by an approved golden; regeneration is explicit and its diff is the review artifact.

### Modified Capabilities
- `referential-actions`: `onDelete`/`onUpdate` MUST reach emitted DDL, and a referential-action change MUST be detected and re-issued — `fkSignature` (`migrate.ts:135`) omits both today, which is why the change is silent.
- `enum-value-mapping`: an enum value's `dbName` MUST be what reaches the database.

## Approach

**Key distinction that makes this tractable**: a `@map` change is an **unambiguous rename** — `.indigo` carries the logical field name separately from the physical one, so only the physical target moved. It emits `RENAME COLUMN` and preserves data. Renaming the **field** (`createdAt` → `creationDate`, no `@map`) is ambiguous (rename vs drop+add), needs the destructive-change analyzer, and is out of scope.

Three slices, sized generously (the predecessor underestimated a comparable unit at ~300 lines and landed at 557): (1) harness + Turbo wiring; (2) ordering + enum transaction handling; (3) diff completeness + `onUpdate` + `members`.

Preserve `diffResolved`'s top-level order (enums → notify function → new/altered tables → dropped tables CASCADE → dropped enums). That skeleton is sound; the defect is only intra-table FK placement.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/migrator/test/` + fixtures | New | Golden harness, schema-pair fixtures, approved SQL |
| `packages/migrator/package.json` | Modified | `test` script so Turbo picks the suite up |
| `packages/migrator/src/migrate.ts` | Modified | Ordering, FK placement, new diff classes, `onUpdate`, `members` |
| `packages/migrator/src/postgres.ts` | Modified | `ON UPDATE` in `renderForeignKey`, enums from `members` |
| `packages/cli/src/migrate-runner.ts` | Modified | Transaction boundaries for enum `ADD VALUE` (split strategy is a design decision) |
| `crates/` | **Untouched** | No `build:wasm` or compiler-snapshot regeneration required |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| **Behavior change**: schemas that reported "No schema changes" now produce migrations | Certain | Intended. Release note naming each newly-emitting class; goldens make the output reviewable before it reaches a database |
| Harness slice underestimated (fixture files inflate the diff) | High | Size slice one generously; goldens excluded from authored-risk count, included in snapshot identity |
| Enum `ADD VALUE` transaction split weakens atomicity | Med | Design owns the split strategy; the non-atomic window is documented, not hidden |
| `@map` rename misfires when a field is renamed in the same edit | Med | Strictly `@map`-only moves; simultaneous field rename stays detectable and deferred, never silently renamed |
| No real PostgreSQL in CI — goldens pin SQL **text**, not appliability | High | Explicitly out of scope; golden diffs reviewed by hand against PostgreSQL semantics |

## Rollback Plan

Generation is pure — no runtime or persisted migrator state. Revert the slice commits on the stacked branch and the renderers return to current output. **Caveat**: migrations already generated *and applied* under the new behavior are not undone by a code revert; the database keeps the applied DDL, so reverting mid-adoption requires re-baselining `migrations/.snapshot.json` by hand.

## Dependencies

- **Branch topology (hard constraint)**: MUST stack on `fix/compiler-schema-validation` (HEAD `f6e3faf`), NOT branch from `main`. `ForeignKey.onUpdate` and `ResolvedEnum.members` exist only there; branching from `main` would not compile.
- **Strict TDD is active** (`strict_tdd: true`) and this package has no harness at all — building it is task one, not an afterthought.
- Gates: `pnpm test`, `pnpm build`, `pnpm lint`, `cd crates && cargo test` (unaffected, must stay green).

## Success Criteria

- [ ] `pnpm test` runs a green migrator golden suite; `packages/migrator` no longer has zero tests
- [ ] FK statements never precede their referenced table's `CREATE TABLE`, for any declaration order — pinned by a fixture declaring `Post` before `User`
- [ ] Each of the four previously-silent classes emits DDL pinned by an approved golden; none returns an empty statement array
- [ ] A `@map` move emits `RENAME COLUMN` and preserves data; a bare field rename does NOT silently rename
- [ ] `ADD COLUMN ... NOT NULL` with no default is never emitted unguarded; enum `ADD VALUE` is appliable through `migrate dev`
- [ ] `ON UPDATE` appears in emitted DDL; enum DDL uses `members`/`dbName` so enum-value `@map` reaches the database
- [ ] `diffResolved`'s existing top-level statement order is regression-pinned
- [ ] `pnpm build` and `pnpm lint` green
