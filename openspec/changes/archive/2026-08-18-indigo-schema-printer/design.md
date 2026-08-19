# Design: IndigoDB Schema Printer + `db pull`

## Technical Approach

A pure, I/O-free printer `printSchema(resolved, options?) -> string` in `@indigodb/core`
inverts `parse` + `resolve` for the subset of `ResolvedSchema` that `.indigo` can express.
`indigodb db pull` is a thin CLI shell: resolve a bare connection -> `pg.Client` ->
`introspectResolvedSchema` (unchanged) -> `printSchema` -> write file.

Data flow:

    --url / DATABASE_URL ──→ pg.Client ──→ introspectResolvedSchema ──→ ResolvedSchema
                                                                            │
                              schema.indigo ←── writeFileSync ←── printSchema

## Architecture Decisions

### Decision: printer lives in `@indigodb/core` (`packages/core/src/print.ts`)

| Option | Tradeoff | Verdict |
|---|---|---|
| `@indigodb/core` | Owns `ir.ts` (the input contract) and already re-exports `parse`; zero new packages/deps; Studio gets it free | **Chosen** |
| New `@indigodb/printer` | Package/build/CI overhead for ~300 lines with exactly one IR dependency | Rejected |
| `@indigodb/migrator` | migrator emits SQL, not `.indigo`; would invert the package's stated purpose | Rejected |
| `@indigodb/cli` | Unreachable from Studio/tests; buries a reusable pure function in a binary | Rejected |

Rationale: the printer's only input is `ResolvedSchema`, the type `core` defines. Keeping it
in `core` preserves the "resolve once, consumers read the IR" architecture rule.

### Decision: raw FKs print as structured `// @fk(...)` comment lines

`.indigo` has **no** syntax for a bare FK constraint — `resolve.rs` derives `foreignKeys`
only from `@relation(fields:, references:)` on a relation field, and synthesizing a relation
field name/target is explicitly the out-of-scope follow-up. Concrete form, emitted after the
field list, one line per `ForeignKey`, in IR order:

```
Table Post {
  id       Int @id @default(autoincrement())
  authorId Int

  // @fk(fields: [authorId], references: [id], model: User, onDelete: Cascade, name: "post_author_fkey")
  @@index([authorId])
}
```

| Option | Tradeoff | Verdict |
|---|---|---|
| Structured comment | Preserves catalog truth, human-readable, lexer-invisible (round-trip unaffected), directly liftable into `@relation(...)` by the follow-up | **Chosen** |
| Silently drop FKs | Loses information with no user-visible trace; the pulled file lies about the database | Rejected |
| Synthesize `@relation(...)` | Requires field naming + cardinality inference = the named out-of-scope follow-up | Rejected |

`model:`/`references:` are printed as **schema-level names**: `refTable` is mapped back through
`tables.find(t => t.dbName === refTable).name`, `refColumns` through that table's
`columns.find(c => c.dbName === x).name`. `onDelete`/`onUpdate` invert the IR's SQL text
(`"SET NULL"`) back to the schema spelling (`SetNull`) via the 5-entry
`REFERENTIAL_ACTIONS` table (`Cascade|Restrict|SetNull|SetDefault|NoAction`), so the comment
is copy-paste-ready. Optional args (`onDelete`, `onUpdate`, `name`) appear only when present.
`name:` is only in the IR when it differs from the derived `<table>_<cols>_fkey`.

### Decision: composite PKs use repeated field-level `@id`, not `@@id`

`@@id([a,b])` is rejected by the compiler (`fixtures/09-rejected-composite-id.indigo`), but
`resolve.rs` builds `primary_key` by collecting every `is_pk` column in **declaration order**.
So a composite PK is printed as `@id` on each PK field. Because declaration order fixes the
resulting `primaryKey` order, the printer **throws** when `table.primaryKey` is not a
subsequence of `table.columns` order — the "throw, never guess" invariant `introspect.ts`
already established, rather than silently emitting a differently-ordered key.

### Decision: `db pull` never writes credentials into the schema

The printed `datasource` always renders `url = env("DATABASE_URL")`, even when `--url` was
passed, because the schema file is committed and a literal DSN is a credential leak.
`printSchema` emits a `datasource` block only when `schema.datasource` is set; the CLI
synthesizes `{ name: "db", provider: "postgresql", url: env("DATABASE_URL") }` (introspection
never populates `datasource`). No `generator` block is emitted (`ResolvedSchema` has none) —
`indigodb generate` falls back to its default output path.

### Decision: overwrite by default (user-fixed)

`mkdirSync(dirname, {recursive:true})` + `writeFileSync`. No prompt, no `--force`. When the
target existed, log `⚠️  Overwrote <path>`, so the destructive act is visible after the fact.

## Emission Rules (deterministic)

- **Order**: header comment -> `datasource` -> enums -> tables. Within each collection, the
  IR array order is preserved **verbatim** — ordering stability is the introspector's job
  (`ORDER BY relname/typname/ordinal_position`), not the printer's. One blank line between
  top-level blocks; LF only; file ends with exactly one `\n`.
- **Field line**: `name` and type padded to the block's max width (matches
  `template.ts`/fixtures; accepted tradeoff: adding a long field reflows the block).
  Type = `col.type` + `?` when `nullable`. Lists are unrepresentable — `ResolvedColumn` has
  no `list` field, so array columns cannot be pulled at all (already unreachable:
  `introspect.ts` throws on array `udt_name`).
- **Field attribute order (fixed)**: `@id` -> `@unique` -> `@default(...)` -> `@db.X(...)` ->
  `@map("...")` -> `@note("...")`.
  - `@default`: `{kind:"function"}` -> `now()` / `uuid()` / `autoincrement()`;
    `{kind:"value"}` -> quoted+escaped string, raw number, `true`/`false`; **enum columns
    (`isEnum`) emit a bare identifier** (`@default(ACTIVE)`), not a quoted string.
  - `@db.X`: `@db.${nativeType.name}` plus `(${args.join(", ")})` when args exist.
  - `@map` only when `col.dbName !== col.name`.
- **Block attribute order (fixed)**, preceded by one blank line: `@@map` (when
  `dbName !== name`) -> `@@unique` -> `@@index` -> `@@realtime` -> `@@note`.
  Index args follow fixture 16: positional column array, then `name: "..."` (string), then
  `type: gin` (bare identifier). Index/PK columns are **physical names in the IR** and are
  mapped back to field names via `columns.find(c => c.dbName === x)`; an unresolvable column
  throws.
- **Enums**: `enum Name { MEMBER }`, one member per line, `@map("...")` only when
  `member.dbName !== member.name`. Uses `members` when present, else `values`.

## Interfaces

```ts
// packages/core/src/print.ts
export interface PrintOptions {
  /** Free text emitted as a leading `//` comment block (CLI passes the pull banner). */
  header?: string;
  /** Indent unit. Default two spaces. */
  indent?: string;
}
export function printSchema(schema: ResolvedSchema, options?: PrintOptions): string;
export class IndigoPrintError extends Error {} // unrepresentable IR, never a guess

// packages/cli/src/util.ts
export function resolveBareConnectionString(flagUrl?: string): string;
```

`resolveConnectionString` cannot be reused: it takes a `ResolvedSchema` and reads
`resolved.datasource.url` — `db pull` has no schema file yet (that file is its *output*), so
there is nothing to resolve from. `loadEnv()` **is** reused as-is (schema-independent).
The new helper is `flagUrl ?? process.env.DATABASE_URL`, else `console.error` + `exit(1)`
naming both inputs.

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/core/src/print.ts` | Create | `printSchema`, `IndigoPrintError`, emission rules |
| `packages/core/src/index.ts` | Modify | Export `printSchema`, `PrintOptions`, `IndigoPrintError` |
| `packages/core/test/print.mjs` | Create | Unit + pure round-trip suite |
| `packages/cli/src/util.ts` | Modify | Add `resolveBareConnectionString` |
| `packages/cli/src/index.ts` | Modify | Register `db pull` under the existing `db` command |
| `packages/cli/test/pull.mjs` | Create | Connection-resolution + write-behavior tests |
| `packages/migrator/test/pull-roundtrip.mjs` | Create | PGlite DB-backed round trip |
| `packages/core/package.json`, `packages/cli/package.json` | Modify | `test` script wiring |

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | Every IR shape: nullability, `nativeType`, all `default` kinds (incl. enum bare ident), `@map`, single + composite `@id`, `@unique`, enum member `@map`, `@@index`/`@@unique` `name:`/`type:`, `@@map`/`@@realtime`/`@@note`, FK comment form, empty schema | `packages/core/test/print.mjs`, plain Node + `node:assert` (repo convention: `parity.mjs`) |
| Unit | Throw paths: PK order not a column subsequence; index/FK column with no matching `dbName`; FK `refTable` with no matching table | Same file, `assert.throws` |
| Integration (no DB) | For every `fixtures/*.indigo` in the covered subset: `resolve(parse(print(resolve(parse(src)))))` deep-equals `resolve(parse(src))` after `normalizeForRoundTrip` | Same file — cheap, uses the existing 17-fixture corpus |
| Integration (DB) | `renderPushSql` -> PGlite -> `introspectResolvedSchema` -> `printSchema` -> `parse`+`resolve` -> `planMigration(introspected, reprinted)` yields **only** FK statements; deep-equal after FK stripping | `packages/migrator/test/pull-roundtrip.mjs`, reusing `test/pg-harness.mjs` |
| CLI | `resolveBareConnectionString` precedence (`--url` > `DATABASE_URL` > error), overwrite-existing behavior, `--print` emits without writing | `packages/cli/test/pull.mjs` (mirrors `studio-server.mjs` style) |

`normalizeForRoundTrip` is explicit and documented, not incidental: it drops `relations` and
`foreignKeys` (this slice's known lossiness) and canonicalizes the identity-column asymmetry —
`introspect.ts` emits `{autoincrement:true}` with **no** `default`, while `resolve.rs` emits
`{autoincrement:true, default:{kind:"function",name:"autoincrement"}}` for the only syntax
that can express identity. That divergence is inherent to the two producers, not a printer bug.

## Threat Matrix

Applicable — the change adds a CLI subcommand that opens a network connection and writes a
file, but no shell/subprocess, no VCS/PR automation, no executable-file classification, no
routing.

| Row | Status | Behavior / RED test |
|---|---|---|
| Shell / subprocess injection | N/A | No `exec`/`spawn`; `pg` uses bound `$1` params only, and every introspection query is a constant with a single `$1` schema name |
| Path traversal on `--schema` | Applicable | Path is user-supplied and resolved with `resolvePath`, same as every other command; overwrite is the accepted fixed behavior. RED test: `--schema` to a nested non-existent dir creates it and writes exactly there |
| Credential leak into artifact | Applicable | `--url` is **never** written into the schema; `url = env("DATABASE_URL")` always. RED test: pull with `--url postgres://u:p@h/db` -> printed text contains neither `p` nor the host |
| Credential leak into logs | Applicable | Error messages print `(error as Error).message` only; never the DSN. RED test: connection failure output contains no password |
| Executable-file classification | N/A | Output is a `.indigo` data file, never chmod'd |
| VCS/PR automation | N/A | None |

## Migration / Rollout

No migration. Fully additive: new module + new subcommand; no existing behavior changes.
Rollback = revert both commits.

## PR Slicing (review budget 800)

Estimated ~750–900 authored lines total. Chain two PRs:

1. **PR A — printer**: `print.ts` + core export + `print.mjs` (~500–600 lines). Autonomous:
   verified entirely by unit + pure fixture round trip, no DB, no CLI.
2. **PR B — CLI wiring**: `resolveBareConnectionString`, `db pull`, `pull.mjs`,
   `pull-roundtrip.mjs` (~250–300 lines). Targets PR A's branch.

`400-line budget risk: High` for a single PR; `Chained PRs recommended: Yes`.

## Open Questions

- [ ] None blocking. Noted non-blocking limitation: a pulled schema fed to `migrate dev` will
      plan `DROP CONSTRAINT` for every FK (they exist only as comments). The CLI header banner
      must state this explicitly, and `db pull`'s success output should point at it.
