# Proposal: `.indigo` Schema Printer + `indigodb db pull`

## Intent

This is the **second and final** introspection change needed to close the Phase 3 epic "Introspection — `indigodb db pull`" at its user-facing surface. The first change (`shadow-replay-diff`, archived) delivered `introspectResolvedSchema` as an **internal primitive with zero `.indigo`-printing capability**.

There is **no AST-to-`.indigo`-text printer anywhere in the repo**. The parser only goes `.indigo` text → AST. This is new code in a **new forward direction**, not a reuse of existing machinery. Without it, `introspectResolvedSchema` is unreachable by users and the epic delivers nothing.

## Scope

### In Scope
- New printer: `ResolvedSchema`/AST → `.indigo` source text — tables, columns (type, nullability, defaults, `@db.*` native-type overrides, `@id`, `@unique`), enums (incl. member `@map` where distinguishable), `@@index`/`@@unique` (with `name:` / `type:` args), composite primary keys, `@@realtime`.
- **Raw** foreign keys emitted structurally (plain scalar columns + captured FK constraint data) — explicitly **not** ergonomic `@relation(...)` field syntax.
- `indigodb db pull` CLI command: schema-independent connection resolution (`--url` flag or `DATABASE_URL` from `.env`), introspect, print, write `schema.indigo` (or `--schema` path).

### Out of Scope
- **Relation-field synthesis** (`@relation(...)`, field naming heuristics, cardinality inference, many-to-many join-table collapsing) — the ambiguous, heuristic-laden sub-problem; needs its own change.
- `@note` on tables/columns, `TableGroup`/color/group metadata (not physically recoverable from `pg_catalog`).
- `datasource` block synthesis beyond values supplied via CLI input.

### Documented Limitation (deliberate, not patched)
`introspectResolvedSchema` **throws** on unmappable PostgreSQL types and expression indexes. `db pull` inherits this: against a real enterprise catalog using features outside IndigoDB's vocabulary it **fails loudly** rather than emitting a wrong/partial schema. Same "throw, never guess" invariant as the prerequisite change.

## Capabilities

### New Capabilities
- `schema-printing`: deterministic `ResolvedSchema` → `.indigo` text emission and its formatting contract.
- `db-pull-command`: CLI command surface, connection resolution without a pre-existing schema, file write/overwrite behavior.

### Modified Capabilities
- None. `schema-introspection` requirements are unchanged; this change consumes it.

## Approach

Exploration Option B. Printer lives in a package that already owns the IR contract (`@indigodb/core` or a sibling), pure and I/O-free: input IR, output string. Verified by **round-trip**: `parse(print(resolved))` → `resolve` must equal the input IR for the covered subset. CLI layer stays thin — connect, introspect, print, write. New bare-connection helper in `packages/cli/src/util.ts` (existing `resolveConnectionString`/`loadSchema` assume a schema file exists and cannot be reused as-is).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/core/src/` (printer module) | New | IR → `.indigo` text printer |
| `packages/cli/src/index.ts` | Modified | Register `db pull` |
| `packages/cli/src/util.ts` | Modified | Schema-independent connection resolution |
| `packages/migrator/src/introspect.ts` | Read-only | Consumed unchanged |
| `openspec/specs/` | New | Two new capability specs |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Printed output doesn't re-parse | Med | Round-trip test is the acceptance gate |
| Raw-FK output looks "unfinished" to users | Med | Document explicitly in command output + spec; relations are a named follow-up |
| Loud throw on enterprise catalogs reads as a bug | Med | Actionable error naming the unsupported type/index; documented limitation |
| Scope creep into relation inference | High | Named non-goal in spec and tasks |

## Rollback Plan

Fully additive. Revert by removing the printer module, the `db pull` registration, and the connection helper; `introspectResolvedSchema` and all existing commands are untouched. No migrations, no schema-format change, no generated-artifact change.

## Dependencies

- `introspectResolvedSchema` (`packages/migrator/src/introspect.ts`) — already shipped.
- `@indigodb/parser` — used only by round-trip tests.
- A reachable PostgreSQL for integration tests (existing test infra).

## Success Criteria

- [ ] `indigodb db pull --url <dsn>` writes a `schema.indigo` that `parse` + `resolve` accept.
- [ ] Round-trip: `resolve(parse(print(ir)))` equals `ir` for the in-scope subset.
- [ ] Enums, native-type overrides, named/typed indexes, composite PKs, `@@realtime`, raw FKs all appear in output.
- [ ] Unsupported type/expression index produces a clear, actionable failure — never silent partial output.
- [ ] Relation-field synthesis is documented as a named non-goal with a follow-up change referenced.

## Proposal question round (auto mode — no interactive round held)

Assumptions taken; flag any that are wrong before spec:
1. Raw FK output is acceptable as a shipped intermediate user experience (not held back until relations land).
2. `db pull` overwrites an existing `schema.indigo` by default; no merge/preserve-hand-edits behavior in this slice.
3. Printer output style (ordering, spacing) is deterministic and defined by us, not required to match any hand-written formatting.
4. `--url` and `DATABASE_URL` are the only two connection inputs; no interactive prompt.
