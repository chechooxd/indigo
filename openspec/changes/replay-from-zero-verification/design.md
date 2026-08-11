# Design: Replay-from-Zero Verification

## Technical Approach

A new sibling suite `packages/migrator/test/replay.mjs` builds two live PGlite
databases from the same final schema by two different routes, then proves they
describe the same structure:

- **Migrate path** — one `withDatabase` call wrapping the whole chain. Hop `i`
  runs `planMigration(schema[i-1] ?? null, schema[i])` → `renderMigrationSql`
  → `applyPlan(db, sql)`. No reset, no second `withDatabase`, no
  `seedDatabase` shortcut: the instance accumulates exactly as `migrations/`
  does across successive `migrate dev` runs.
- **Push path** — a second, separate `withDatabase` call applying
  `renderPushSql(final)` once.

Both snapshots are introspected via `information_schema` and compared. This
reuses `pg-harness.mjs`'s existing `withDatabase`/`applyPlan` primitives
unchanged — `applyPlan` already honours the shipped `splitMigrationSql` phase
split, which the chain depends on (hop 3 adds an enum value; hop 4 uses it in
a `DEFAULT` — a cross-migration boundary PostgreSQL requires).

## Architecture Decisions

### Decision: Positive-selection comparator, not deep-equal with an ignore list

**Choice**: The comparator selects exactly five properties (table, column,
type, nullability, default-shape) and compares only those.
**Alternatives considered**: full `pg_dump`-style dump diff; `deepStrictEqual`
over raw `information_schema` rows with an exclusion filter.
**Rationale**: The spec forbids extending the allowlist. A positive selection
makes non-compared facts (constraint/index names, FK action names, `IF NOT
EXISTS` guard artifacts, **and column ordinal position**) out of scope *by
construction* rather than by a filter someone can quietly grow. Ordinal
position matters concretely: the migrate path appends `User.name` via `ALTER
TABLE ADD COLUMN` (last ordinal) while push creates it inline in declaration
order — a legitimate, non-semantic divergence that a raw dump diff would flag.

### Decision: Helper lives in `pg-harness.mjs`, not private to `replay.mjs`

**Choice**: Export `introspectPublicSchema(db)` and
`assertSameStructure(a, b, labels)` from `pg-harness.mjs`.
**Alternatives considered**: private functions inside `replay.mjs`.
**Rationale**: `pg-harness.mjs`'s documented role is "ONLY the mechanics of
driving [PGlite]" plus thin assertion helpers (`assertApplies`,
`assertRejects`). Introspection is PGlite-driving mechanics and the comparator
is a thin assertion helper — same category, same naming convention. Exporting
also lets the comparator be self-tested independently of the chain (see
Testing Strategy). It stays test-local: nothing is added to `src/` or `dist/`.

### Decision: Chain fixtures in a separate `fixtures-chain/` directory

**Choice**: New directory, ordered `schema-NN.indigo` files, loaded by a new
`loadChainFixture(dir)` in `lib.mjs`.
**Alternatives considered**: adding chain files inside `fixtures/`.
**Rationale**: `migrator.mjs` and `appliability.mjs` both `readdirSync`
`fixtures/` and expect every directory to be a `prev`/`next` pair with an
`expected.json` golden. A separate directory keeps those loops untouched.
`loadChainFixture` sits beside `loadFixture` because fixture resolution is
`lib.mjs`'s stated role.

## Data Flow

    schema-01..04.indigo
        │
        ├── planMigration per hop ──► renderMigrationSql ──► applyPlan ──┐
        │   (ONE withDatabase, hops 1..4, no reset)                      │
        │                                                          db(A) │
        └── renderPushSql(schema-04) ──► db.exec ────────────────────────┤
            (separate withDatabase, single shot)                   db(B) │
                                                                         ▼
                             introspectPublicSchema(A) vs (B) ──► assertSameStructure

## Chain Fixture Plan — `test/fixtures-chain/user-post-status/`

| File | Delta vs previous | Hop change class |
|------|-------------------|------------------|
| `schema-01.indigo` | `enum Status { ACTIVE INACTIVE }`; `Table User { id Int @id @default(autoincrement()); email String @unique; status Status @default(ACTIVE) }` | create enum + create table (from `null`) |
| `schema-02.indigo` | adds `name String?` to `User` | add column |
| `schema-03.indigo` | adds member `PENDING` to `Status` (appended last) | add enum value (pre-transaction) |
| `schema-04.indigo` | adds `Table Post { id Int @id @default(autoincrement()); authorId Int; author User @relation(fields: [authorId], references: [id]); status Status @default(PENDING) }` | add table + add FK, consuming `PENDING` |

Every hop is add-table, add-column, add-enum-value, or add-FK. Nothing is
dropped, renamed, or restructured, per the additive-only requirement.

## Interfaces / Contracts

```js
// pg-harness.mjs — introspection query (public base tables only).
const INTROSPECT_SQL = `
SELECT c.table_name, c.column_name, c.data_type, c.udt_name,
       c.is_nullable, c.column_default, c.is_identity, c.identity_generation
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
ORDER BY c.table_name, c.column_name;`;

// Normalized entry, keyed `${table}.${column}` in a Map built in sort order.
// type:    data_type === 'USER-DEFINED' ? `enum:${udt_name}` : data_type
// nullable: is_nullable === 'YES'
// default: is_identity === 'YES' ? `identity:${identity_generation}`
//                                : (column_default ?? null)   // whitespace-collapsed
{ table, column, type, nullable, default: defaultShape }
```

`ORDER BY table_name, column_name` (never `ordinal_position`) is what makes
the snapshot order-independent. `udt_name` is required because every enum
column reports `data_type = 'USER-DEFINED'`; without it, two different enum
types would compare equal. `is_identity` carries the `autoincrement` default,
which surfaces as identity rather than `column_default` on both paths.

### Divergence report

`assertSameStructure(a, b, { aLabel: "migrate-path", bLabel: "push-path" })`
collects every divergence and throws once with them newline-joined, sorted by
key. Line forms, exactly:

```
table "Post": present in migrate-path, absent in push-path
User.name: absent in push-path
User.email: nullable mismatch — migrate-path=false, push-path=true
User.name: type mismatch — migrate-path=text, push-path=integer
Post.status: default mismatch — migrate-path='PENDING'::"Status", push-path=NULL
```

A table absent from one side entirely emits **one** table-level line, not one
line per column, so a missing table does not bury the report.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/migrator/test/replay.mjs` | Create | Chain replay + push-equivalence suite; `check()` runner copied from `appliability.mjs` |
| `packages/migrator/test/fixtures-chain/user-post-status/schema-0{1..4}.indigo` | Create | Ordered chain (table above) |
| `packages/migrator/test/pg-harness.mjs` | Modify | Add `introspectPublicSchema`, `assertSameStructure` |
| `packages/migrator/test/lib.mjs` | Modify | Add `loadChainFixture(dir)` — sorted `schema-NN.indigo`, parse+resolve each, error on empty/gapped sequence |
| `packages/migrator/package.json` | Modify | `test` script appends `&& node test/replay.mjs`; add `test:replay` |
| `openspec/specs/migration-appliability-tests/spec.md` | Modify (archive) | Promoted requirements |

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Harness self-test (RED first) | Comparator detects a deliberate divergence | Two hand-written PGlite DDL instances differing in exactly one non-excluded property (`"n" text` vs `"n" integer`); assert `assertSameStructure` throws and the message contains `T.n`, `text`, `integer` |
| Harness self-test | Comparator tolerates excluded categories | Two instances with identical columns but differently-named PK constraint and index; assert it does **not** throw |
| Harness self-test | Missing table reported once | Instance B lacks a 3-column table; assert exactly one `table "..."` line |
| Integration | Chain replays from empty | One `withDatabase`, hops 1..4 in order; assert each `applyPlan` returns ≥1 executed unit and hop 3 returns 2 (pre-transaction + body) |
| Integration | Replay ≡ push | `assertSameStructure(introspect(A), introspect(B))` |

**TDD sequencing.** No production code changes, so the RED is the comparator's
own credibility: write the three harness self-tests first against a
not-yet-existing `assertSameStructure` (import failure, then a comparator that
never throws) and observe them fail. GREEN is implementing the helper. Only
then is the chain test written — a comparator that silently passes everything
would otherwise make the real assertion worthless. This mirrors the existing
"harness self-test" at `appliability.mjs:78`, which exists for the same reason.

## Review Budget

Estimated authored lines: `replay.mjs` ~130, `pg-harness.mjs` ~90, four
fixtures ~60, `lib.mjs` ~20, `package.json` ~2 → ~300 code lines plus SDD
artifacts. Comfortably under the 800-line budget; **a single slice suffices**,
no chained PRs.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file
classification, or process-integration boundary. The suite is plain Node
driving an in-process WASM engine, invoked by the existing `test` script.

## Migration / Rollout

No migration required. Test-only; rollback is deleting the new files and
reverting two small edits.

## Open Questions

- [ ] None blocking. One assumption to validate at apply time: both paths
  render columns through the same `renderColumn` in `postgres.ts`, so
  `column_default` text is expected to normalize identically in PostgreSQL. If
  a benign textual difference appears (e.g. cast spelling), fix it by
  normalizing the default string in the comparator — not by widening the
  allowlist.
