# Design: ERD becomes a designer

## Technical Approach

The ERD authors **minimal, span-anchored text edits** against the live Monaco buffer and persists
them through the existing `PUT /api/schema/source`. `printSchema` is never used on the write path.
Node positions travel on a separate, versioned sidecar route.

Two structural properties carry the design:

1. **Spans are a side-channel, not AST fields.** A new WASM export `parse_with_spans` returns
   `{schema, spans}`; `parse` and its envelope are untouched, so `@indigodb/ast`, `resolve.rs`,
   `printSchema`, the print round-trip suite and **all 21 golden snapshots in
   `fixtures/snapshots/` stay byte-identical** — no regeneration, no review noise.
2. **Spans never outlive the buffer they came from.** The patch module exposes exactly one
   entry point, `applyErdEdit(currentText, edit)`, which parses `currentText` and computes and
   applies the patch in the same synchronous call. There is no window in which a cached span can
   address a changed buffer.

## Architecture Decisions

### D1 — Span delivery: separate `parse_with_spans` export

| Option | Tradeoff |
|---|---|
| Optional span fields on `Model`/`Field`/`Attribute` | Ergonomic, but changes the serde JSON contract; all 21 AST goldens regenerate; `resolve`/`validate` re-deserialize AST JSON and `print`→re-parse round-trip comparisons gain a field that is meaningfully absent for programmatically built ASTs |
| **Chosen: new `parse_with_spans(source)` WASM export returning `{ok:{schema, spans}}`** | Additive. `parse`, `resolve`, `validate`, `compile` and every snapshot are untouched. Consumers join spans to the AST by index path. Cost: two parse calls if a caller wants both (the ERD wants only one at a time) |

**Rationale**: the AST is a published contract consumed by five packages; spans are needed by one
call site. Widening the contract to serve one consumer buys nothing and forces a 21-file golden
diff into slice 1, exactly the slice the proposal already flagged as the largest.

### D2 — Offsets are UTF-16 code units, not bytes

Rust `logos` gives byte offsets into UTF-8; JavaScript slices strings in UTF-16 code units. A
single non-ASCII character anywhere before an edit point (a `@note("café")`, an accented comment)
would make every later byte offset wrong in the browser. Spans therefore carry `start`/`end` as
**UTF-16 code-unit offsets**, converted in Rust at span-emission time, plus 1-based
`line`/`column`/`endLine`/`endColumn` for diagnostics. A non-ASCII fixture is a required negative
control (see Testing Strategy). Related but out of scope: `LineIndex::position` already computes
`column` as a byte delta, so existing diagnostic columns are wrong on non-ASCII lines — a
pre-existing bug, not introduced or fixed here.

### D3 — Staleness gate: parse-at-patch-time, not a hash comparison

| Option | Tradeoff |
|---|---|
| Cache `{spans, hash}` and compare `hash(currentText)` before patching | Correct, but the cache is the thing that can be misused; correctness depends on every future call site remembering to check |
| **Chosen: the patch module never returns a span index.** `applyErdEdit(currentText, edit)` calls `parseWithSpans(currentText)` internally | A stale span is unrepresentable — there is no value to hold. Parse already runs on every keystroke, so the cost is one extra parse per *edit action*, not per render |

Refusal path: if the fresh parse fails, or the edit's anchor (table/field name) is absent from it,
`applyErdEdit` returns `{ok:false, reason}` and the buffer is untouched. Disk-level staleness stays
where it already is — the `version` content hash on `PUT /api/schema/source`.

**Enforceability, stated honestly**: no typecheck prevents a future contributor from also
exporting `parseWithSpans` and caching it. The guard is (a) a module-boundary test asserting the
patch module's export surface, and (b) review-time constraint recorded in the module header.
This is not a type-level guarantee and must not be described as one.

### D4 — Patch application: ordered non-overlapping replacements

`applyEdits(source, edits: {start,end,text}[])` sorts descending by `start`, **throws** on any
overlap, and splices right-to-left so earlier offsets stay valid. "Untouched by construction" means
precisely: every byte outside the union of the edit ranges is copied verbatim. That is provable by
diffing a fixture containing `@@allow`, `@@realtime(columns:)`, `TableGroup`, comments and
irregular whitespace — not by a printer-gap checklist. The overlap invariant is a **runtime throw
plus a unit test**; no typecheck can express it.

### D5 — Delete refusal is computed from the IR, not from spans

A delete refusal names referencing tables and fields, sourced from `resolve(schema).foreignKeys`
filtered by `referencedTable === target`. Spans locate *where* to cut; the IR decides *whether*.

### D6 — Layout sidecar route

Path is derived server-side from `schemaPath` (`…/schema.indigo` → `…/schema.layout.json`), never
from client input — no traversal surface. Contract:

| Request | Outcome |
|---|---|
| `GET /api/schema/layout` | `200 {positions, version}`; absent file → `200 {positions:{}, version:null}`; no `schemaPath` → `404` |
| `PUT /api/schema/layout {positions, version}` | `200 {version}` · `400` malformed payload · `409` version mismatch (incl. `version:null` when the file exists) · `403` read-only · `404` no `schemaPath` |

`/api/schema/layout` with a non-GET method joins `isWriteRoute`'s **explicit set** (per
`studio-readonly-mode`: the set, not a prefix), so it inherits the 403 and emits one audit line
with `op: "layout-write"`, `outcome: "denied"`, `reason: "read-only"` via a `buildLayoutAuditEntry`
sibling of `buildSchemaAuditEntry`. Payload validation: object of `{x:number, y:number}` with
finite values, entry count capped (5000). The server stores keys **verbatim** and the client never
prunes — pruning during a transient parse failure would destroy layout for tables that momentarily
vanished. Unknown keys are ignored at read; missing keys fall back to the seed formula.

The atomic temp-file + `rename` sequence in `handleWriteSchemaSource` is extracted to one
`atomicWriteFile(target, text)` helper used by both routes — same "exactly one implementation"
discipline as `splitDatasource`.

### D7 — `TableNode.tsx`'s handles ARE a working seam (exploration risk 5, resolved)

The ERD is React Flow (`@xyflow/react`), not the custom SVG canvas the exploration described. Each
field row already renders four real `Handle`s; `isConnectable={false}` is a live React Flow prop,
so relation drawing is enabled by flipping it under an edit-mode flag and adding `onConnect` to
`<ReactFlow>`. The genuine gap is *hit area*: the handles are 1×1 and `opacity: 0`, unusable as
drag targets. Edit mode must enlarge and reveal them; `buildEdges`' handle IDs (`s-l-{idx}`) stay
unchanged so rendering is unaffected.

## Data Flow

    Monaco buffer ──► useERDParser ──► ResolvedSchema ──► ERD nodes/edges
         ▲                                                     │
         │                                              user edit action
         │                                                     ▼
         └── applyErdEdit(currentText, edit) ◄── parseWithSpans(currentText)
                        │  (ok: patched text → setDslCode, dirty)
                        └─ (refused: reason banner, buffer untouched)

    Explicit Save ──► PUT /api/schema/source {source, version}
    Node drag ──► debounce 500ms ──► PUT /api/schema/layout {positions, version}

Layout and schema have **independent versions**; a `409` on one never blocks the other.

## File Changes

| File | Action | Description |
|---|---|---|
| `crates/indigo-compiler/src/lexer.rs` | Modify | `Token` gains `start`/`end` UTF-16 offsets from `lexer.span()` |
| `crates/indigo-compiler/src/span.rs` | Create | `SourceSpan`, `SpanIndex` serde types + byte→UTF-16 conversion table |
| `crates/indigo-compiler/src/parser.rs` | Modify | Collect model/field/attribute spans alongside AST construction |
| `crates/indigo-compiler/src/lib.rs` | Modify | `parse_with_spans` export |
| `packages/compiler/wasm/*`, `wasm-sources.sha256` | Modify | `build:wasm` rebuild (mandatory, freshness-guarded) |
| `packages/compiler/src/shared.ts`, `index.node.ts`, `index.browser.ts` | Modify | `parseSchemaWithSpans` + types |
| `packages/core/src/index.ts` | Modify | Re-export `parseWithSpans` |
| `packages/compiler/test/parity.mjs` | Modify | Span assertions incl. non-ASCII fixture |
| `packages/cli/src/studio-server.ts` | Modify | `/api/schema/layout` GET+PUT, `isWriteRoute` set, `buildLayoutAuditEntry`, `atomicWriteFile` extraction |
| `apps/studio/src/features/erd/lib/patch.ts` | Create | `applyErdEdit`, `applyEdits`, edit constructors |
| `apps/studio/src/features/erd/lib/layout-store.ts` | Create | Layout fetch/debounced save |
| `apps/studio/src/features/erd/ERDCanvas.tsx` | Modify | Seed from layout, persist on drag, `onConnect` |
| `apps/studio/src/features/erd/components/TableNode.tsx` | Modify | Edit affordances, connectable handles in edit mode |
| `apps/studio/src/lib/api.ts` | Modify | `fetchLayout` / `saveLayout` |

## Interfaces / Contracts

```ts
export interface SourceSpan {
  start: number; end: number;            // UTF-16 code-unit offsets, end-exclusive
  line: number; column: number; endLine: number; endColumn: number;  // 1-based
}
export interface FieldSpan {
  name: string; decl: SourceSpan; nameToken: SourceSpan; typeToken: SourceSpan;
  attributes: { name: string; span: SourceSpan }[];
}
export interface ModelSpan {
  name: string; decl: SourceSpan; nameToken: SourceSpan;
  bodyOpen: SourceSpan; bodyClose: SourceSpan;
  fields: FieldSpan[]; attributes: SourceSpan[];
}
export interface SpanIndex { models: ModelSpan[] }   // enums/datasource/generator/TableGroup: no spans — never edited

export type ErdEdit =
  | { kind: 'addTable'; name: string }
  | { kind: 'renameTable'; from: string; to: string }
  | { kind: 'deleteTable'; name: string }
  | { kind: 'addField'; table: string; field: { name: string; type: string; optional?: boolean } }
  | { kind: 'editField'; table: string; field: string; next: { name?: string; type?: string; optional?: boolean } }
  | { kind: 'deleteField'; table: string; field: string }
  | { kind: 'addRelation'; from: string; fromField: string; to: string; toField: string };

export type ErdEditResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'parse-failed' | 'anchor-missing' | 'referenced'; message: string };
```

## Testing Strategy

Strict TDD: every row needs a recorded mutation that made it fail, run **against rebuilt `dist/`**
(`pnpm --filter <pkg> build` first; `pnpm clean && pnpm build --force` when Turbo may replay).
Combination rows are mandatory — a missing combination here becomes an `sdd-verify` failure.

| Layer | Scenario (combination) | Approach |
|---|---|---|
| Rust unit | Span offsets over ASCII fixture | `cargo test` in `crates/` |
| Rust unit | **Non-ASCII source × field span** — UTF-16 vs byte offsets diverge | New `fixtures/22-non-ascii.indigo`; assert `text.slice(start,end) === "fieldName"` in JS, not only in Rust |
| Parity | `parse`/`resolve`/`validate` envelopes and all 21 goldens unchanged after slice 1 | Existing `parity.mjs` must stay green with **zero** snapshot regeneration; freshness guard proves the rebuild |
| Unit (patch) | `applyEdits` overlapping ranges → throws | Direct call; mutation: drop the overlap check |
| Unit (patch) | **Untouched-by-construction**: fixture with `@@allow` + `@@realtime(columns:)` + `TableGroup` + comments + irregular whitespace × each edit kind | Byte-diff the result; assert the diff is confined to the edited span |
| Unit (patch) | **Stale span × delete refusal**: buffer mutated between render and action → `anchor-missing`, text unchanged | Call `applyErdEdit` with a buffer whose target table was removed |
| Unit (patch) | **Delete referenced table** → `referenced`, message names referencing table AND field | Two-table fixture with an FK |
| Unit (patch) | Module export surface excludes `parseWithSpans` (D3 enforceability) | Import the module, assert its keys |
| Server | **Read-only × `PUT /api/schema/layout`** → 403, one audit line `op:"layout-write"`/`denied`/`read-only`, sidecar byte-unchanged | `node:http` harness, as in `studio-server` suites |
| Server | Read-only × `GET /api/schema/layout` → 200 (reads unaffected) | Same harness |
| Server | **Missing `schemaPath` × layout GET and PUT** → both 404; `schemaWritable:false` unchanged in shape | Construct `StudioOptions` from a bare `source` |
| Server | **Absent sidecar × GET** → `{positions:{}, version:null}`; **absent × PUT `version:null`** → creates; **existing × PUT `version:null`** → 409 | Filesystem tmpdir harness |
| Server | Malformed payload (`x:"1"`, `NaN`, over cap) → 400, nothing written | Table-driven |
| Server | Atomic write: no temp file left after 200 **and** after 400/409 | Directory listing assertions (mirrors the schema-write scenarios) |
| Studio unit | **Unknown table key × empty layout file** → ignored, no crash; missing key → seed formula `40+(idx%3)*320` | vitest on `layout-store` + canvas seeding |
| Studio unit | **Schema Save × layout** → a schema Save issues NO `PUT /api/schema/layout`; the two persist independently | vitest + fetch spy, in `ERDDesignerPage.test.tsx` |
| Studio unit | **Node drag × autosave wiring** → drag-end reaches `updatePosition` → `schedule` and the canvas actually issues the debounced `PUT`; unit-testing the debounce alone leaves the wiring uncovered | vitest with fake timers over `ERDCanvas` |
| Studio unit | `schemaWritable:false` × ERD edit affordance → disabled with a stated reason; no request issued | vitest + fetch spy |
| Studio unit | Read-only × ERD edit action → refusal surfaced, no `PUT` | vitest + fetch spy |
| Studio unit | Schema `PUT` → 422 after an ERD-authored patch → buffer kept, diagnostics shown, no success toast | Extends `ERDDesignerPage.test.tsx` |
| E2E (manual, recorded) | Add table → add field → draw relation → Save → reload → positions and schema both persist | `indigodb studio` against a scratch project |

**Not enforceable by any tool — named explicitly, per repo learning:**
1. "Spans never outlive their buffer" is a module-boundary + review constraint (D3), not a
   typecheck. The export-surface test is the only automated bite.
2. "Everything the ERD does not model stays untouched" is proven by fixture diff, not by types;
   a construct absent from the fixture corpus is not covered. Slice 3 must add any construct the
   corpus lacks before claiming the property.
3. Debounced layout autosave dropping a final write on unmount cannot be typechecked; a flush-on-
   unmount test is the guard.

## Threat Matrix

Recorded because the design adds an HTTP route. Every row of `references/threat-matrix.md` is
git/shell-scoped and does not apply:

| Boundary | Applicability |
|---|---|
| Documentation-like paths | N/A — no file-classification or execution decision is made |
| Git repository selection | N/A — no VCS invocation |
| Commit state | N/A |
| Push state | N/A |
| PR commands | N/A — no subprocess, shell, or PR automation |

Route-specific safety, carried into tasks instead: the layout path is derived from server-held
`schemaPath` and never from request data (no traversal); the route joins the explicit
`isWriteRoute` set (not a prefix); the sidecar contains no credentials and the datasource sentinel
machinery is not involved.

## Migration / Rollout

No data migration. A missing or corrupt `schema.layout.json` degrades to formula-seeded positions,
never to a broken canvas. Slice 1 requires `pnpm --filter @indigodb/compiler build:wasm` plus the
committed artifact and refreshed `wasm-sources.sha256`.

## Delivery slicing (correction to the proposal: 6 slices, not 5)

| # | Slice | Depends on | Forecast |
|---|---|---|---|
| 1 | `ast-source-spans` — Rust spans + `parse_with_spans` + TS surface + parity | — | ~500 lines · Medium |
| 2 | `studio-layout-persistence` — route, gate, audit, `atomicWriteFile`, canvas wiring | — (parallel to 1) | ~450 · Medium |
| 3 | Patch engine (`applyEdits`, `applyErdEdit`, edit constructors) + **add table** | 1 | ~450 · Medium |
| 4 | Rename + delete table (incl. referenced-table refusal, IR-sourced) | 3 | ~350 · Low |
| 5 | Field CRUD | 3 | ~450 · Medium |
| 6 | Relation drawing (`onConnect`, connectable handles, `@relation` authoring, rename propagation) | 5 | ~500 · Medium |

The proposal's slice 3 bundled the patch engine with all three node operations; with the
untouched-by-construction fixture corpus and its mutation evidence, that lands near or past 800.
Splitting the engine (3) from rename/delete (4) keeps every slice independently green and inside
budget. Table rename still rewrites only the declaration in slice 4; `@relation` propagation is
deferred to slice 6 as settled.

## Open Questions

- [ ] None blocking. Noted for `sdd-tasks`: this artifact exceeds the skill's 800-word budget
      because the orchestrator required span representation, patch mechanics, the staleness
      mechanism, the route contract, slice boundaries and a combination-covering test table to be
      resolved concretely rather than referenced.
