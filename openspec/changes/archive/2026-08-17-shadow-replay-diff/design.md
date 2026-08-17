# Design: Shadow-Replay Diff Source

## Technical Approach

Three seams, in dependency order, delivered as a chained PR series:

1. **Physical-identity fallback matching** in `packages/migrator/src/migrate.ts` — the diff
   engine must be able to match `prev` against `next` when `prev` carries only *physical*
   names. Today it keys tables and enum members on the *logical* name only, so an
   introspected `prev` would not merely degrade rename detection: it would produce a
   *wrong plan* for every `@@map` table and refuse generation for every `@map` enum member.
   This is a prerequisite, not a side effect.
2. **`introspectResolvedSchema(query)`** in `packages/migrator/src/introspect.ts` — a pure,
   executor-shaped catalog reader producing the exact `ResolvedSchema` subset
   `planMigration` reads.
3. **`buildShadowSchema(source)`** in `packages/migrator/src/shadow.ts` + the
   `migrate-runner.ts` `prev`-source swap.

Fixed constraints (user-resolved, not re-litigated here): the `@map` logical-name rename
degradation is **accepted and documented**; `.snapshot.json` **keeps being written** and only
its read path changes; PGlite is a **hard runtime dependency** of `@indigodb/migrator` with no
pluggable shadow-backend abstraction.

## Architecture Decisions

### Decision 1: Physical-identity fallback at all three matching levels

**Choice**: extend the existing `matchColumns` two-pass idea (logical name → physical
`dbName`) to tables and enum members, and make a pass-2 match a real diff pair.

| Level | Today | Change |
|---|---|---|
| Tables | `prevTables` keyed by `table.name` only | `matchTables`: pass 1 `name`, pass 2 `dbName`; drop detection uses a consumed set, not `nextTables.has(name)` |
| Columns | pass 2 consumes but produces **no pair** → column ALTERs silently skipped | pass 2 also pushes `{old, col}` into `pairs` (`dbName` equal by construction, so the RENAME branch cannot fire) |
| Enum members | matched by `name` only → a `@map`'d member reads as add + remove → `enum-value-removed` **blocks generation** | pass 1 `name`, pass 2 `dbName`, residuals only |

**Alternatives considered**: (a) relabel the introspected `prev` with logical names borrowed
from `next` (a dbName→name map) — rejected: it makes "introspection" depend on `next`, is no
longer introspection, and fabricates names the database never had; (b) accept the breakage as
part of the documented `@map` degradation — rejected: these are *steady-state* wrong plans and
a hard refusal for `@map`'d enums (fixture `enum-value-mapped`), not a one-time rename cost.

**Rationale**: the database only ever knows physical names. Physical identity is the truth;
logical names are cosmetic. Pass-2-produces-no-pair is also a pre-existing latent bug
(a type change on a column renamed in the same edit emits nothing today) — closing it is the
same fix.

### Decision 2: Shadow replay, not direct introspection of the target database

**Choice**: replay the recorded migration chain onto a fresh in-process PGlite instance and
introspect *that*.

**Alternatives considered**: introspect the user's real database directly (cheaper, no PGlite);
a real `CREATE DATABASE` shadow.

**Rationale**: the real database may hold objects IndigoDB does not manage (other tools'
tables, extra indexes, hand-added columns) — diffing against it would emit destructive DDL for
them. Replay yields exactly *IndigoDB-managed* state, which is what the snapshot represented.
A real shadow database needs `CREATEDB` (often ungranted on managed Postgres) and leaks orphan
databases on crash.

### Decision 3: `introspectResolvedSchema` inverts the *renderer*, not the catalog

**Choice**: introspection reconstructs values that make `columnSignature` /
`renderDefaultClause` / `indexName` / `fkName` / `renderIndexDdl` produce the **same text** as
a schema-derived `ResolvedSchema` — not a faithful catalog dump.

Concretely: `col.type` is the *Indigo* scalar (`text`→`String`, `integer`→`Int`,
`bigint`→`BigInt`, `double precision`→`Float`, `boolean`→`Boolean`, `timestamptz`→`DateTime`,
`jsonb`→`Json`, `numeric`→`Decimal`, `bytea`→`Bytes`), never the PostgreSQL spelling, because
`columnSignature` compares `col.type` directly and `alterColumn` re-maps it through
`mapScalarToPg`. `nativeType` is recovered where the pg type is not in that inverse table:
`character varying(n)`→`{VarChar,[n]}` on `String`, `uuid`→`{Uuid,[]}` on `String`,
`numeric(p,s)`→`{Numeric,[p,s]}` on `Decimal`. An unmappable pg type **throws** (naming
`table.column` and the type) rather than guessing — a wrong type inference emits a destructive
`ALTER COLUMN TYPE`, and since replay only ever executes IndigoDB-generated DDL, this can only
mean an invariant break.

Two normalizations are load-bearing:

- **FK actions**: `confdeltype`/`confupdtype` `'a'` (NO ACTION) maps to **absent**, not
  `"NO ACTION"`. `fkDefinition` compares that text; emitting `"NO ACTION"` where the schema
  side is `undefined` would drop-and-re-add every FK on every run.
- **Explicit names**: `index.name` / `fk.name` are populated **only when the actual object
  name differs from the auto-derived formula** (`indexName` / `fkName`). Always populating them
  would make every auto-named index look like an explicitly-named one.

**Alternatives considered**: a raw catalog snapshot plus a comparison layer that knows how to
equate the two representations — rejected: it duplicates the renderer's naming/typing rules in
a second place, exactly the drift `indexName`'s shared-helper decision (#9) exists to prevent.

### Decision 4: `@unique` vs single-column `@@unique` — classify as `col.unique`

Both produce byte-identical DDL (`CREATE UNIQUE INDEX "<table>_<col>_key"`), so introspection
cannot tell them apart. A single-column unique index whose name equals
`${table}_${col}_key` becomes `col.unique = true` and is **not** listed in `table.indexes`;
every other index (multi-column, or single-column with a divergent name) becomes a
`table.indexes` entry. PK-backing indexes (`indisprimary`) and expression indexes are excluded
(the latter throws — IndigoDB cannot emit them).

**Alternatives considered**: normalize `col.unique` into `table.indexes` on both sides inside
`migrate.ts`, making the two forms genuinely equivalent — technically the cleaner fix, rejected
here because it moves the unique add/drop out of the column pass into the index pass and
reorders statements across the whole golden corpus, well beyond this change's scope. Recorded
as a follow-up.

**Consequence**: a schema using single-column `@@unique([x])` gets one drop+recreate of an
identical index on its first post-adoption migration. Documented, and covered by the divergence
test alongside `@map`.

### Decision 5: Shadow builder is I/O-injected; PGlite is dynamically imported

`shadow.ts` receives the history list, the on-disk directory list and a reader function — it
never touches `node:fs`, `pg`, or `process.cwd()`. `@electric-sql/pglite` is loaded via
`await import(...)` inside `buildShadowSchema`, so `db push`, `generate`, `migrate deploy` and
`migrate status` never pay the WASM instantiation cost. An optional `createShadow` seam lets
the diagnostic tests run without spinning WASM.

**Desync rules** (no checksums exist yet, so these are the only signals):

| Condition | Behavior | Rationale |
|---|---|---|
| Recorded id with no on-disk directory | **Refuse** (`ShadowReplayError`, naming the ids) | State is unreconstructible; any plan would be a guess |
| On-disk directory not in history (pending) | **Refuse**, message points at `indigodb migrate deploy` | `deploy` would later apply pending-then-new, producing a different database than `dev` just produced |
| Same set, recorded order ≠ lexicographic order | **Warn**, replay in **recorded** order | Recorded order reproduces the actual database; the divergence still matters (a fresh `deploy` applies lexicographically) so it is reported |
| Empty history | Empty `ResolvedSchema` (`tables: []`, `enums: []`) | Equivalent to today's `loadSnapshot() === null` for `computeStatements` |

Replay applies each `migrations/<id>/migration.sql` through the shipped `splitMigrationSql`
(pre-transaction statements individually, then one `BEGIN`/body/`COMMIT`) — identical to
`applyMigrationSql` and `pg-harness.mjs`'s `applyPlan`, never a re-derived split.

### Decision 6: `pg-harness.mjs`'s `introspectPublicSchema` is kept, not superseded

It stays as an intentionally *independent, coarser* oracle (raw `information_schema` positive
selection). Re-pointing it at `introspectResolvedSchema` would make `replay.mjs`'s structural
equivalence proof self-confirming — the code under test would be its own comparator. The
proposal's "superseded" line is deliberately not followed here.

### Decision 7: `INDIGODB_MIGRATE_PREV=snapshot` escape hatch

`loadSnapshot()` stays live behind one env check. This is the promised one-line revert, keeps
the function from becoming dead code, and unblocks the one case shadow replay legitimately
refuses: a project adopting `migrate` on a database previously built with `db push` (tables
exist, history is empty). Drift/adoption detection is a separate Phase 3 epic.

## Data Flow

    migrate dev
      │
      ├─ pg.Client ──→ ensureHistory ──→ SELECT name FROM _indigo_migrations ORDER BY id
      │                                            │
      │                                     recorded ids
      │                                            ▼
      │   listMigrationDirs() ──────────→ buildShadowSchema (shadow.ts)
      │   read migrations/<id>/          ├─ desync rules (refuse | warn)
      │                                  ├─ new PGlite()  (dynamic import)
      │                                  ├─ replay each migration.sql in recorded order
      │                                  └─ introspectResolvedSchema(pglite.query)
      │                                            │
      │                                        prev: ResolvedSchema
      ▼                                            ▼
    resolve(schema) ── next ──→ planMigration(prev, next) ──→ MigrationPlan
                                                                  │
                        write migrations/<ts>_<name>/migration.sql │
                        apply + INSERT history + COMMIT            │
                        saveSnapshot(next)   ← STILL WRITTEN ──────┘

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/migrator/src/migrate.ts` | Modify | `matchTables` (new); `matchColumns` pass 2 yields pairs; enum-member physical fallback; `computeStatements` uses consumed sets for table drop detection |
| `packages/migrator/src/introspect.ts` | Create | `introspectResolvedSchema(query, options?)` — 6 catalog queries (tables, columns, PK/FK constraints, indexes+`amname`, enums, `indigo_rt_*` triggers) + renderer-inverse mapping |
| `packages/migrator/src/shadow.ts` | Create | `buildShadowSchema(source, options?)`, `ShadowReplayError`, `MigrationSource` |
| `packages/migrator/src/index.ts` | Modify | Export `introspectResolvedSchema`, `buildShadowSchema`, `ShadowReplayError` + types |
| `packages/migrator/package.json` | Modify | `@electric-sql/pglite` moved `devDependencies` → `dependencies` (same `^0.5.4` range) |
| `packages/cli/src/migrate-runner.ts` | Modify | `migrateDev` restructured to connect before planning; `recordedMigrations(client)` (ordered) added next to `appliedMigrations` (Set, untouched); `prev` from `buildShadowSchema`; `saveSnapshot` preserved; `loadSnapshot` reachable only via `INDIGODB_MIGRATE_PREV=snapshot` |
| `packages/migrator/test/introspect.mjs` | Create | Round-trip + mapping unit coverage |
| `packages/migrator/test/shadow.mjs` | Create | Plan-equivalence corpus, divergence, desync diagnostics |
| `packages/migrator/package.json` (scripts) | Modify | `test` chain gains `introspect.mjs`, `shadow.mjs` |
| `packages/cli/package.json` | Unchanged (deps) | PGlite arrives transitively via `@indigodb/migrator`; the CLI adds no direct dependency and its existing devDependency (used by `studio-harness.mjs`) stays |

## Interfaces / Contracts

```ts
// introspect.ts — satisfied by both pg.Client.query and PGlite.query
export type IntrospectionQuery =
  (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export function introspectResolvedSchema(
  query: IntrospectionQuery,
  options?: { schema?: string; exclude?: string[] }, // default "public", ["_indigo_migrations"]
): Promise<ResolvedSchema>;
```

Populated: `tables[].{name, dbName, columns, primaryKey, foreignKeys, indexes, realtime?}`
with `name === dbName`; `columns[].{name (=== dbName), dbName, type, isEnum, nullable, isPk,
unique, autoincrement, default?, nativeType?}`; `enums[].{name, values, members}` with member
`name === dbName`.
Deliberately absent/empty: `tables[].note`, `.color`, `.group`; `columns[].note`;
`tables[].relations: []`; `tableGroups: []`; `datasource` omitted. Column order follows
`ordinal_position`; index/FK order follows object name for determinism.

```ts
// shadow.ts
export interface MigrationSource {
  recorded: string[];                    // _indigo_migrations, ORDER BY id
  onDisk: string[];                      // migration directory names, sorted
  read(id: string): string;              // migrations/<id>/migration.sql
}
export class ShadowReplayError extends Error { readonly ids: string[]; }
export function buildShadowSchema(
  source: MigrationSource,
  options?: { onWarning?: (message: string) => void; createShadow?: () => Promise<ShadowDb> },
): Promise<ResolvedSchema>;
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit (`migrate.ts`) | Physical-identity fallback: `@@map` table steady-state diff, `@map` column type/nullability change is *not* silently skipped, `@map`'d enum member no longer trips `enum-value-removed` | New fixtures + existing golden harness (`migrator.mjs`); every current golden must stay byte-identical — a changed golden means the fallback altered logical-name-matched behavior |
| Unit (`introspect.ts`) | Type/nativeType inversion table, identity→`autoincrement`, default parsing (`now()`, `gen_random_uuid()`, literals, enum-cast literals), NO ACTION→absent, derived-vs-explicit name policy, unmappable type throws | `introspect.mjs`, PGlite, hand-written DDL |
| Integration | **Round-trip**: for every fixture schema, `renderPushSql` → introspect → `planMigration(introspected, same)` is an **empty plan** | `introspect.mjs` over `fixtures/*/{prev,next}.indigo` |
| Integration | **Plan equivalence**: for every `fixtures/<case>`, apply `prev`, introspect, assert `planMigration(introspectedPrev, next)` equals `planMigration(resolvedPrev, next)` | `shadow.mjs`; divergence allow-list is explicit per case, never a global tolerance |
| Integration | **Documented divergences**, asserted positively: `map-rename-only` / `map-rename-with-dependents` → DROP+ADD instead of `RENAME COLUMN`; `map-rename-ambiguous` → no `ambiguous-column-remap` diagnostic, DROP+ADD; single-column `@@unique` → one identical-index drop+recreate | `shadow.mjs` — each asserts the *expected degraded plan*, so a future improvement fails loudly |
| Integration | **Chain replay through the shadow**: `fixtures-chain/user-post-status` written as real `migrations/<id>/migration.sql` dirs, replayed, introspected; must equal `renderPushSql(final)` structure via `assertSameStructure`; plus a `@@realtime` chain proving `plpgsql` triggers replay under PGlite | `shadow.mjs` + existing `pg-harness.mjs` comparator |
| Integration | **Desync diagnostics**: recorded-but-missing → refuse; pending-on-disk → refuse naming `migrate deploy`; reordered-same-set → warn + replay in recorded order; empty history → empty schema | `shadow.mjs` with an injected `createShadow` (no real WASM needed for the refusal paths) |
| Manual smoke | `migrate dev` with `migrations/.snapshot.json` deleted generates the correct migration and rewrites the snapshot | Success-criterion check |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. The one new external surface is an in-process WASM Postgres given
only IndigoDB-generated SQL from the project's own `migrations/` directory; no user input is
interpolated into introspection SQL (identifiers arrive as bound parameters).

## Migration / Rollout

No data migration. `.snapshot.json` keeps being written, so downgrading to a prior CLI is
seamless. `INDIGODB_MIGRATE_PREV=snapshot` restores the old read path without a code change.

**PR slicing** (session budget 800 lines; estimated authored total ≈1100+, so chained):

| PR | Scope | Est. authored lines | Standalone value |
|---|---|---|---|
| A | Decision 1 only: physical-identity fallback in `migrate.ts` + fixtures/unit tests | ~200 | Closes the pass-2-no-pair latent bug; no behavior change for logical-name-matched schemas |
| B | `introspect.ts` + `index.ts` export + `introspect.mjs` (round-trip + mapping) | ~500 | The primitive the future `db pull` epic builds on; no caller yet |
| C | `shadow.ts` + `migrate-runner.ts` swap + PGlite dependency promotion + `shadow.mjs` | ~400 | The user-visible change |

Feature Branch Chain: A → feature branch; B targets A; C targets B. Each slice keeps
`pnpm build`, `pnpm lint`, `pnpm test` and `cd crates && cargo test` green on its own.

## Open Questions

- [ ] Does PGlite 0.5.4 ship `plpgsql` in its base build? Required for `@@realtime` trigger
      replay. Verified by a test in PR C; if absent, realtime tables need the notify
      function/trigger statements skipped during replay (they are trigger-only, so skipping
      them changes no introspected structure except `realtime`, which would then need
      deriving from the migration text — a real, scoped fallback, not a blocker).
- [ ] Column order: `ordinal_position` vs schema declaration order can differ for
      `ALTER`-added columns, which only affects `DROP COLUMN` statement *ordering* in a plan.
      If the equivalence corpus shows churn, sort dropped columns by `dbName` in `diffTable`
      (a golden-affecting change that would then belong in PR A).
