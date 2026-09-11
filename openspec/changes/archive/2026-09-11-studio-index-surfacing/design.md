# Design: Surface Real Indexes in the Studio Docs View

## Technical Approach

Adapter-first (proposal "Approach"). Stop the data loss at `resolvedToTables`
(`apps/studio/src/lib/schema-adapter.ts:70-99`), then render only what arrives. The renderer gains
no fallback of its own: every clause is a projection of a field that exists, or is absent.

## Architecture Decisions

### Decision: `Table.indexes` mirrors `ResolvedIndex` structurally

**Choice**: `indexes?: ResolvedIndex[]`, importing the type from `@indigodb/core`; the adapter
assigns `table.indexes` by reference (no per-field copy). Optional, so mock/sample data omits it.
**Alternatives**: a Studio-local `{ columns; unique; name?; type? }`; a required field with `[]`.
**Rationale**: `apps/studio` already type-imports core in this exact file (`schema-adapter.ts:10`)
and in this exact feature (`features/docs/lib/relations.ts:6`, `hooks/useDocBrowser.ts:7`), so
mirroring costs nothing and removes a translation layer that could silently drift from `ir.ts:90-104`
— the drift that caused this bug. Optional matches the existing `realtime`/`primaryKey` convention
(`types.ts:29-34`) and makes "unknown" representable, which `[]` ("verified none") would erase.

### Decision: absent `type` cannot become `USING btree`

**Choice**: one choke point, `usingClause(index: ResolvedIndex)`, taking the **index object** —
not a `type` argument — returning `'' | \`USING ${...}\``. The module contains no `??`/`||` default.
**Alternatives**: an inline ternary at the call site; a helper taking `type`.
**Rationale**: a helper that takes the whole index has no parameter into which a substituted default
can be injected; producing `USING btree` would require mutating IR data. `ir.ts:97-102` canonicalizes
explicit `btree` to absent, so absent is the only state that reaches it.

### Decision: index names are emitted only when declared

**Choice**: `name` verbatim when present; when absent emit `CREATE INDEX ON ...` with no name (valid
Postgres; the server derives one).
**Alternatives**: mirror `indexName()`'s `${table}_${cols}_${idx|key}` formula
(`packages/migrator/src/postgres.ts:179-182`); depend on `@indigodb/migrator`.
**Rationale**: duplicating the formula is avoided-by-care with no drift guard; depending on migrator
pulls `@electric-sql/pglite` (`packages/migrator/package.json:38-42`) into the browser bundle. This
is a display snippet, not a migration. **Named follow-up**: if docs ever need name parity with
`db push`, expose migrator's pure renderers on a browser-safe subpath and consume those.

### Decision: PRIMARY KEY is table-level and never invents `id`

**Choice**: replace per-column inline `PRIMARY KEY` with one table-level
`PRIMARY KEY (cols)` from `table.primaryKey`; if absent/empty, fall back to columns actually flagged
`isPK` (real declared data, column order); if still none, **emit no PRIMARY KEY clause**.
**Alternatives**: keep the inline form; inherit `types.ts:33`'s documented "falls back to `id`".
**Rationale**: inline emits two `PRIMARY KEY`s for a composite PK — invalid SQL; one path can't
forget composites (matches `postgres.ts:208-209`). The `id` fallback is consumer-scoped (row
identity), and inheriting it in a renderer is precisely how this defect started.

## Exact Output

```
CREATE TABLE public.Post (
  id uuid NOT NULL,
  authorId uuid NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX ON public.Post (authorId);
CREATE INDEX post_author_idx ON public.Post USING gin (tags);
CREATE UNIQUE INDEX ON public.Post (email);
```

No indexes (or `indexes` absent): output ends at `);` — zero blank line, zero `CREATE INDEX`,
zero `idx_`. The `-- Create optimized index` comment is **deleted outright**: "optimized" was itself
an unearned claim. One statement per index, IR order preserved; column order preserved.

## Data Flow

    ResolvedSchema.tables[].indexes ──→ resolvedToTables ──→ Table.indexes ──→ generateTableDDL
                                          (was dropped here)

## File Changes

| File | Action | Description |
|---|---|---|
| `apps/studio/src/types.ts` | Modify | Add `indexes?: ResolvedIndex[]` + absence doc comment |
| `apps/studio/src/lib/schema-adapter.ts` | Modify | Pass `indexes: table.indexes` |
| `apps/studio/src/features/docs/lib/ddl-generator.ts` | Modify | Real indexes, `usingClause`, table-level PK |
| `apps/studio/src/features/docs/lib/ddl-generator.test.ts` | Create | First test; vitest, `relations.test.ts` style |

## Testing Strategy

Fixture is `.indigo` source → `parse`+`resolve` → `resolvedToTables` → `generateTableDDL` (precedent:
`features/erd/lib/__tests__/patch-semantics.test.ts:28`). The compiler is **not** mocked; hand-built
`Table` objects only where the row targets renderer-only behaviour.

| # | Scenario combination | Entry | Asserts |
|---|---|---|---|
| 1 | No `@@index`/`@@unique`, single PK `id` | adapter | full-string `toBe`; `not.toContain('CREATE INDEX')`, `not.toContain('idx_')` |
| 2 | `indexes` absent (mock `Table`) | renderer | same as #1; no crash, no clause |
| 3 | One plain index, unnamed, `type` absent | adapter | `CREATE INDEX ON public.T (col)`; `not.toContain('USING')` |
| 4 | `@@unique([email])` | adapter | `CREATE UNIQUE INDEX`, not bare `CREATE INDEX` |
| 5 | Composite `@@index([authorId, createdAt])` | adapter | `(authorId, createdAt)` order preserved |
| 6 | Explicit `type: gin` + named index | adapter | `name USING gin (...)`, name verbatim |
| 7 | Non-`id` single PK (`uuid`) + index on an unrelated column | adapter | `PRIMARY KEY (uuid)`; no `(id)` anywhere |
| 8 | Composite PK `@@id([a, b])` | adapter | exactly one `PRIMARY KEY (a, b)`; no inline PK |
| 9 | PK absent (mock `Table`, no `isPK`) | renderer | zero `PRIMARY KEY`; no invented `id` |
| 10 | Two indexes, one unique one not | adapter | both rendered, declaration order |

**Mutation proof (mandatory).** Re-append the old `ddl-generator.ts:22` string. Row 1's `toBe` must
go red naming the unexpected `CREATE INDEX idx_..._lookup` line — an assertion diff, never a
`TypeError`. Second mutation: change `usingClause` to `index.type ?? 'btree'`; row 3 must go red on
`not.toContain('USING')`.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. Pure in-memory string rendering.

## Migration / Rollout

No migration. Additive and independently revertible (proposal "Rollback Plan"); no existing reader of
`Table.indexes` exists.

## Out of Scope (named, not dropped)

Partial/expression indexes (compiler + migrator); client-side index-awareness; the three other docs
fabrications — `TableHeroBanner.tsx:34`, `ColumnsSpecTable.tsx:51`, `RelationsPanel.tsx:57`.

## Open Questions

- [ ] None blocking. `types.ts:33`'s "falls back to `id`" comment should be narrowed to name its
      consumer scope; flagged for `sdd-tasks`, not required by this design.
