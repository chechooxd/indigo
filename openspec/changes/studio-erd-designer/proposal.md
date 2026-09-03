# Proposal: ERD becomes a designer

## Intent

The Studio ERD is a one-way viewer: it renders the schema but cannot change it, and node
positions are reseeded from a formula on every reload. Users who want to add a table, rename a
field, or draw a relation must hand-edit `.indigo` text. `studio-schema-write-back` shipped the
write path; `schema-printer-fidelity` closed the four silent printer drops (verified:
`normalizeForRoundTrip` in `packages/core/test/print.mjs` is down to one documented exclusion —
index re-bucketing). The remaining gap is the editing surface itself.

## Scope

### In Scope
- AST source spans plumbed from `parser.rs` through serde/WASM into `@indigodb/ast`.
- Node CRUD: create/rename/delete a table from the canvas.
- Field CRUD: add/edit/delete a field row inline on a node.
- Relation drawing: connect two field handles to author `@relation(...)`.
- Node position persistence via sidecar `schema.layout.json` with its own versioned route.

### Out of Scope
- Enum, `datasource`, `@@allow`, `@@realtime`, `TableGroup` authoring from the canvas.
- Migration generation triggered by ERD edits (`migrate dev` stays a separate action).
- Multi-user concurrent editing beyond the existing content-hash staleness check.
- Undo/redo history beyond the Monaco buffer's own.

## Capabilities

### New Capabilities
- `ast-source-spans`: every `Model`/`Field`/`Attribute`/`Schema` AST node carries 1-based
  line/column/end_line/end_column, preserved across the WASM JSON boundary.
- `studio-erd-editing`: ERD-authored node, field, and relation edits produce a minimal text patch
  on the source buffer, persisted through the existing `PUT /api/schema/source`.
- `studio-layout-persistence`: sidecar `schema.layout.json` storing node x/y, with atomic write
  and content-hash staleness.

### Modified Capabilities
- `studio-readonly-mode`: the new layout route is a mutating surface and MUST be gated by the same
  read-only refusal and `schemaWritable` reporting as the schema write route.

## Approach

**Edit strategy: Option B — targeted text edits on the source buffer** (fixed by the orchestrator
over A/regenerate and C/hybrid). Whatever the ERD does not understand stays untouched *by
construction* — the same property that made literal-sentinel substitution correct in
`studio-schema-write-back`. Option A's safety would depend on a printer-gap checklist whose
completeness cannot be proven; four gaps sat undetected for weeks. The cost is span plumbing:
`crates/indigo-compiler/src/parser.rs` already computes per-token line/column/end_line/end_column
(used only for `ParseErrorDetail`, ~`:444-447`) and discards it before AST construction. Plumbing
it through is a Rust + WASM + serde + `@indigodb/ast` change carrying the `build:wasm`,
freshness-guard and golden-snapshot ceremony. It is the largest single line-count contributor.

**Position storage: sidecar `schema.layout.json`** (chosen by the user over a Postgres table and
`localStorage`), reusing the atomic-write + content-hash staleness shape from
`studio-schema-write-back`. Stated honestly: this does **not** literally satisfy the roadmap exit
criterion *"Nothing in the UI mutates state that is not persisted to Postgres."* The accepted
argument is that node x/y is view layout, not schema semantics, and binding it to a DB instance
would lose the diagram on a DB switch. The tension is real and is being accepted, not resolved.

## Delivery slicing (auto-chain, stacked-to-main, 800-line budget)

Combined scope exceeds the review budget, so this ships as stacked PRs. Each slice is
independently reviewable and independently green (`pnpm build && pnpm lint && pnpm test`).

| # | Slice | Depends on | Independently valuable |
|---|---|---|---|
| 1 | `ast-source-spans` — Rust spans → serde → WASM → `@indigodb/ast` | — | Yes: better diagnostics, editor navigation |
| 2 | `studio-layout-persistence` — sidecar route + canvas wiring | — (parallel to 1) | Yes: positions survive reload today |
| 3 | Node CRUD (create/rename/delete table) | 1 | Yes |
| 4 | Field CRUD (add/edit/delete field) | 1, 3 (shared patch helpers) | Yes |
| 5 | Relation drawing (`@relation(...)` authoring) | 1, 4 | Yes |

Slice 2 is parallelizable; slice 1 gates 3, 4 and 5.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `crates/indigo-compiler/src/parser.rs`, `ast.rs` | Modified | Retain per-token spans through AST construction |
| `packages/compiler` | Modified | WASM rebuild, freshness guard, golden snapshots |
| `packages/ast/src/index.ts` | Modified | Span fields on `Model`/`Field`/`Attribute`/`Schema` |
| `packages/cli/src/studio-server.ts` | Modified | Layout GET/PUT route, read-only gate, audit op |
| `apps/studio/src/features/erd/*` | Modified | Canvas edit affordances, patch builder |
| `apps/studio/src/features/erd/TableNode.tsx` | Modified | Enable connection handles (currently `isConnectable={false}` scaffolding) |

## Repo constraints this change must respect

- ESM-only pnpm + Turborepo monorepo; a cross-package type change needs the dependency rebuilt
  before dependents see it.
- Test suites import compiled `dist/`, not `src/`. Mutation-testing evidence MUST rebuild the
  package first (`pnpm --filter <pkg> build`) or a mutation silently appears not to bite.
- `pnpm clean && pnpm build` does **not** purge stale `dist/` (Turbo restores it wholesale). Use
  `--force`.
- **Strict TDD is on.** Every requirement needs a test proven to fail via an actual mutation, and
  every negative control must sit **on** the boundary it defends — not near it, not on a dead path.
- No CI. `.githooks/pre-push` runs build/lint/test locally; `pnpm ci:local` for a clean-clone check.
- Studio lint is `tsc -b --noEmit`; the `-b` is load-bearing and must not be dropped.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Span plumbing underestimated (cross-language, rebuild/freshness/snapshot ceremony) | High | Its own slice (#1), landed and green before any ERD slice starts |
| A text patch corrupts constructs the ERD does not model | Med | Patches are span-anchored and additive; pre-write `parse`+`resolve` gate already refuses `422` |
| Spans drift from source after an unrelated buffer edit | Med | Re-parse before patching; patch against the exact buffer the spans came from, else refuse |
| Sidecar layout diverges from the schema (table renamed/deleted) | Med | Layout keyed by table name; unknown keys ignored, missing keys fall back to the seed formula |
| `TableNode.tsx` disabled handles are scaffolding, not a working seam | Med | Re-read at design time against the chosen interaction model (exploration risk 5) |
| Layout sidecar does not satisfy the roadmap's Postgres exit criterion | Accepted | Stated explicitly above; revisit if layout must become multi-user |

## Rollback Plan

Each slice is a separate stacked PR, so rollback is `git revert` of that slice's merge commit,
newest first. Slice 1 (spans) is additive — reverting it requires reverting 3/4/5 first and
rebuilding the WASM artifact (`pnpm --filter @indigodb/compiler build:wasm`, then
`pnpm clean && pnpm build --force`). Slice 2 is fully independent: reverting it leaves the ERD
viewer working with formula-seeded positions. A deleted `schema.layout.json` degrades to seeded
positions, never to a broken canvas.

## Dependencies

- `schema-printer-fidelity` — **done**, archived at
  `openspec/changes/archive/2026-09-02-schema-printer-fidelity/`, merged at `049b729`.
- `studio-schema-write-back` — **done**, supplies `PUT /api/schema/source`, staleness, atomic
  write, read-only gate, audit op.

## Success Criteria

- [ ] A user can add a table, add/edit/delete a field, and draw a relation from the ERD, and the
      `.indigo` file on disk reflects exactly those edits.
- [ ] Constructs the ERD does not model (`@@allow`, `@@realtime(columns:)`, `TableGroup`, comments,
      user formatting) are byte-unchanged after an ERD edit to the same file — proven by test.
- [ ] Node positions survive a full reload and a Studio restart.
- [ ] Every mutating ERD action is refused with a stated reason in read-only mode.
- [ ] Each of the five slices is independently green and under the 800-line review budget.
- [ ] Every requirement's test has a recorded mutation that made it fail, run against rebuilt
      `dist/`.
