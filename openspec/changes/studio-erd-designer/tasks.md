# Tasks: ERD becomes a designer

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~500+450+450+350+450+500 ≈ 2700 across 6 slices — **superseded, see recalibration below** |
| 400-line budget risk | High (per-slice: Medium/Medium/Medium/Low/Medium/Medium) |
| Chained PRs recommended | Yes |
| Suggested split | PR1 ast-source-spans → PR2 studio-layout-persistence (parallel) → PR3 patch engine+addTable → PR4 rename/delete → PR5 field CRUD → PR6 relation drawing |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

### Recalibration after PR1 and PR2 (maintainer decision, 2026-09-03)

The original estimates counted implementation lines only. Under strict TDD the tests are
roughly as large as the code they cover, so every slice lands near double its forecast:

| Slice | Forecast | Actual | Implementation | Tests |
|-------|----------|--------|----------------|-------|
| PR1 `ast-source-spans` | 500 | 794 | — | — |
| PR2 `studio-layout-persistence` | 450 | **1456** | 673 | 783 |

PR2 breached the 800-line cap and needed a maintainer `sdd-attempt reset`. The decision was
to accept it rather than split already-green code — separating a test file from the
implementation it exercises makes review harder, not easier — and to re-forecast the
remaining slices with test lines counted, splitting any that do not fit **before** they are
written.

Revised forecast (≈2× the original, with tests):

| Slice | Revised | Action |
|-------|---------|--------|
| PR3 patch engine + add table | ~950 | **Split at the engine/consumer seam** → PR3a (3.1–3.4, 3.6, 3.8–3.10: `patch.ts`, fixture corpus, staleness + export-surface guards) and PR3b (3.5, 3.7, 3.11–3.13: `addTable` constructor, byte-diff proof, canvas wiring) |
| PR4 rename + delete | ~700 | Fits; keep whole |
| PR5 field CRUD | ~900 | Reassess against PR3a/PR3b actuals before starting |
| PR6 relation drawing | ~1000 | Reassess against PR4/PR5 actuals before starting |

The 800-line cap is deliberately left unchanged. A cap raised to match whatever the work
happens to cost stops being a constraint on reviewer burden and becomes paperwork.

**Correction after PR3a landed:** PR3a came in at **339 lines** (116 implementation + 223
test), not the ~600 the split implied — so the ~950 estimate for the whole of Phase 3 was
itself too pessimistic and the engine/consumer split was probably unnecessary. The revised
numbers for PR4–PR6 are therefore an upper bound, not a prediction: reassess each against
the previous slice's actuals rather than treating this table as settled.

### Reassessment before PR5 (2026-09-03)

The revised table above asked for PR5 and PR6 to be reassessed against actuals rather than
taken as settled. Code lines per slice, excluding `openspec/` and `.atl/`:

| Slice | Tasks | Code lines | Per task |
|-------|-------|-----------|----------|
| PR1 `ast-source-spans` | 12 | 760 | 63 |
| PR2 `studio-layout-persistence` | 21 | 1525 | 73 |
| PR3a patch engine | 8 | 339 | 42 |
| PR3b addTable + wiring | 5 | 238 | 48 |
| PR4 rename + delete | 14 | 600 | 43 |

The three most recent slices sit at 42-48 lines per task and are in the same subsystem PR5
touches. PR5 has 8 tasks, which projects to **~350 lines** — and even at PR2's worst-in-series
rate of 73 it reaches only 584. The ~900 estimate was roughly double the observed cost.

**PR5 keeps whole, no split.** PR6 (7 tasks) is left for its own reassessment, but the same
rate projects it near 300-500, so its ~1000 estimate is likely inflated too. Note the rate is
lower for slices confined to one subsystem: PR1 and PR2 both crossed package boundaries
(Rust/WASM, and the CLI server plus the Studio), which is what made them costlier per task.

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Spans as WASM side-channel, 21 goldens untouched | PR 1 | `cd crates && cargo test`; `pnpm --filter @indigodb/compiler test` | `indigodb studio` diagnostics unaffected | `git revert`; requires slices 3-6 reverted first + `build:wasm` rebuild |
| 2 | Layout sidecar route + gate + canvas wiring | PR 2 | `node packages/cli/test/studio-server*.mjs`; `pnpm --filter @indigodb/studio test` | `indigodb studio`, drag a node, reload | independent revert; ERD degrades to formula-seeded positions |
| 3 | `applyEdits`/`applyErdEdit` + add table | PR 3 | `pnpm --filter @indigodb/studio test -- patch` | `indigodb studio`, add table via canvas | independent revert of `patch.ts` + add-table affordance |
| 4 | Rename/delete table + referenced-table refusal | PR 4 | `pnpm --filter @indigodb/studio test -- patch` | `indigodb studio`, delete referenced table | revert; add-table (PR3) stays intact |
| 5 | Field CRUD | PR 5 | `pnpm --filter @indigodb/studio test -- patch` | `indigodb studio`, add/edit/delete field | revert; node CRUD (PR3/4) stays intact |
| 6 | Relation drawing | PR 6 | `pnpm --filter @indigodb/studio test -- erd` | `indigodb studio`, draw relation end-to-end | revert; field CRUD (PR5) stays intact |

### Standing obligation: every new `ErdEdit` kind (applies to Phase 6 and beyond)

Phase 3 shipped `addTable` spec-silent; the instance was patched, but nothing obliged the
next phase to do better, so Phase 5 shipped `editField`/`deleteField` the same way and verify
raised the same WARNING again. A phase adding an `ErdEdit` kind is **not complete** until, for
each kind it adds:

1. `specs/studio-erd-editing/spec.md` carries a Requirement or Scenario naming that kind;
2. every scenario written for it points at a test that exists — write no scenario you cannot
   name a covering test for;
3. its UI affordance is gated on the shared `editDisabled` flag (`schemaWritable`/`readOnly`)
   in `ERDCanvas.tsx`, not on a second gating path of its own; and
4. **at least one test feeds the emitted buffer back through the REAL compiler and asserts on
   the resolved IR** — added 2026-09-08, after Phase 6 shipped an `addRelation` that emitted
   byte-perfect text meaning nothing. `patch.test.ts` mocks `@indigodb/core` wholesale (it must
   — jsdom cannot host the WASM compiler), so every assertion in it is a string comparison and
   the entire suite is structurally blind to semantics: a patch can satisfy all three clauses
   above and still produce `.indigo` that resolves to zero foreign keys. Clauses 1–3 govern the
   text; only this one governs the meaning. Semantic tests live in `patch-semantics.test.ts`
   (`// @vitest-environment node`, real `@indigodb/core`).

**Strict-TDD reminders:** test suites import compiled `dist/` — rebuild (`pnpm --filter <pkg> build`) before trusting a mutation result; `pnpm clean && pnpm build --force` when Turbo may have restored stale output. Studio lint is `tsc -b --noEmit` — do not drop `-b`.

## Phase 1: `ast-source-spans` (PR 1, depends on: none)

- [x] 1.1 RED `crates/indigo-compiler/src/span.rs`: unit test asserting `SourceSpan` offsets over ASCII fixture `  id Int @id` (mutation: swap start/end)
- [x] 1.2 GREEN: create `span.rs` (`SourceSpan`, `SpanIndex` serde types); `lexer.rs` `Token` gains `start`/`end` from `lexer.span()`
- [x] 1.3 RED: create `fixtures/22-non-ascii.indigo` (`@note("café")` before a target field); Rust test: byte-offset span would slice wrong text (mutation: skip UTF-16 conversion)
- [x] 1.4 GREEN: implement byte→UTF-16 conversion table in `span.rs`; wire into `parser.rs` span collection for `Model`/`Field`/`Attribute`
- [x] 1.5 GREEN: `lib.rs` — add `parse_with_spans` export returning `{ok:{schema,spans}}`/`{errors}`
- [x] 1.6 RED `packages/compiler/test/parity.mjs`: `parse(source)` output byte-identical before/after `parse_with_spans` exists (mutation: leak `span` field onto `parse`'s output)
- [x] 1.7 GREEN: rebuild WASM (`pnpm --filter @indigodb/compiler build:wasm`), refresh `wasm-sources.sha256`, commit artifact
- [x] 1.8 GREEN: `packages/compiler/src/shared.ts`, `index.node.ts`, `index.browser.ts` add `parseSchemaWithSpans` + types; `packages/core/src/index.ts` re-exports `parseWithSpans`
- [x] 1.9 RED `parity.mjs`: `currentText.slice(span.start, span.end)` on `22-non-ascii.indigo` equals target field text (mutation: revert to byte offsets)
- [x] 1.10 GREEN: assert all 21 golden snapshots byte-identical, zero regeneration (diff-directory check)
- [x] 1.11 RED: Rust-vs-WASM span-agreement test — same fixture via `cargo test` and via `parseWithSpans()` from Node, identical values (mutation: change one offset calc site only)
- [x] 1.12 Verify: `pnpm --filter @indigodb/compiler build && pnpm --filter @indigodb/compiler test`; freshness guard green

## Phase 2: `studio-layout-persistence` + read-only gate extension (PR 2, depends on: none, parallel to PR 1)

- [x] 2.1 GREEN: extract `atomicWriteFile(target, text)` from `handleWriteSchemaSource` in `packages/cli/src/studio-server.ts`, reused by both write routes
- [x] 2.2 RED (`node:http` harness): missing `schemaPath` → GET/PUT `/api/schema/layout` both 404 (mutation: drop `schemaPath` check)
- [x] 2.3 GREEN: implement GET/PUT `/api/schema/layout`, sidecar path derived server-side from `schemaPath` only
- [x] 2.4 RED: absent sidecar → GET `{positions:{}, version:null}`; PUT `version:null` on absent → creates; PUT `version:null` on existing → 409 (mutation: skip null-sentinel branch)
- [x] 2.5 GREEN: implement version/staleness contract (D6)
- [x] 2.6 RED: table-driven malformed payload (`x:"1"`, `NaN`, >5000 entries) → 400, nothing written (mutation: drop finite-value check)
- [x] 2.7 GREEN: payload validation, verbatim key storage, no server/client pruning
- [x] 2.8 RED: directory-listing — no leftover temp file after 200 and after 400/409 (mutation: skip cleanup on error path)
- [x] 2.9 GREEN: `GET /api/auth/status` reports `layoutWritable`, gated only on `schemaPath` presence
- [x] 2.10 RED: `readOnly:true` × PUT `/api/schema/layout` → 403, audit line `op:"layout-write"`/`denied`/`read-only`, sidecar unchanged (mutation: omit layout route from `isWriteRoute` set)
- [x] 2.11 GREEN: add `PUT /api/schema/layout` to `isWriteRoute`'s explicit set; implement `buildLayoutAuditEntry` sibling of `buildSchemaAuditEntry`
- [x] 2.12 RED: `readOnly:true` × GET `/api/schema/layout` → 200, reads unaffected (mutation: gate GET too)
- [x] 2.13 RED: `readOnly:true` + `schemaPath` absent → 403 from read-only gate, not 404 (mutation: reorder checks so `schemaPath` check runs first)
- [x] 2.14 GREEN: `apps/studio/src/lib/api.ts` add `fetchLayout`/`saveLayout`
- [x] 2.15 GREEN: create `apps/studio/src/features/erd/lib/layout-store.ts` — fetch on load, 500ms debounced save
- [x] 2.16 RED (vitest): unknown table key in layout file ignored, no crash; missing key falls back to seed formula `40+(idx%3)*320` (mutation: remove fallback branch)
- [x] 2.17 GREEN: wire `ERDCanvas.tsx` to seed from `layout-store`, persist debounced on drag
- [x] 2.18 RED (vitest): debounced autosave flushes on unmount, no dropped final write (mutation: remove flush-on-unmount)
- [x] 2.19 GREEN: implement flush-on-unmount in `layout-store.ts`
- [x] 2.20 RED (vitest, `ERDDesignerPage.test.tsx`): a schema Save does not call `saveLayout` / issue `PUT /api/schema/layout` (mutation: call `saveLayout` from `handleSave`'s success branch — confirmed FAIL, reverted)
- [x] 2.21 RED (vitest + fake timers, `ERDCanvas.test.tsx`): drag-end (`dragging:false`) position change reaches the debounced `saveLayout` via `ERDCanvas`'s own `onNodesChange` → `updatePosition` wiring; an in-flight (`dragging:true`) change does not (mutation: sever `updatePosition(change.id, change.position)` in `onNodesChange` — confirmed FAIL, reverted)

## Phase 3: Patch engine + add table (PR 3, depends on: Phase 1)

- [x] 3.1 GREEN: create `apps/studio/src/features/erd/lib/patch.ts` — `applyEdits(source, edits)` sorts descending by `start`, splices right-to-left
- [x] 3.2 RED (vitest): `applyEdits` with overlapping ranges throws (mutation: remove overlap check)
- [x] 3.3 GREEN: implement overlap-detection throw
- [x] 3.4 GREEN: create combined fixture (`@@allow` + `@@realtime(columns:)` + `TableGroup` + comments + irregular whitespace) — no existing fixture covers this combination
- [x] 3.5 RED: byte-diff after `addTable` against the combined fixture — diff confined to edited span, `@@allow`/`@@realtime`/`TableGroup`/comments untouched (mutation: off-by-one into adjacent construct)
- [x] 3.6 GREEN: implement `applyErdEdit(currentText, edit)` — calls `parseWithSpans(currentText)` internally, locates anchor
- [x] 3.7 GREEN: implement `addTable` edit constructor
- [x] 3.8 RED (vitest): module export-surface test — only `applyErdEdit` applies edits; no export returns a `SpanIndex`/span (D3 enforceability guard; mutation: re-export `parseWithSpans` from `patch.ts`)
- [x] 3.9 RED: fresh-parse failure → `{ok:false, reason:'parse-failed'}`, buffer untouched (mutation: swallow parse error and apply anyway)
- [x] 3.10 RED: target anchor absent from fresh parse → `{ok:false, reason:'anchor-missing'}` (mutation: fall back to a cached position)
- [x] 3.11 RED: unchanged buffer applies `addTable` normally (positive control)
- [x] 3.12 GREEN: wire add-table affordance on `ERDCanvas.tsx` to `applyErdEdit`
- [x] 3.13 Verify: `pnpm --filter @indigodb/studio build` then `vitest run` for `patch.ts` suite against rebuilt `dist`

## Phase 4: Rename + delete table (PR 4, depends on: Phase 3)

- [x] 4.1 GREEN: implement `renameTable` — rewrites only the declaration name (non-goal: relation propagation)
- [x] 4.2 RED (vitest): renaming a referenced table leaves the referencing table's `@relation(...)` byte-unchanged (mutation: also rewrite relation attrs)
- [x] 4.3 GREEN: implement `deleteTable`, refusal computed from `resolve(schema).foreignKeys` filtered by `referencedTable === target` (D5)
- [x] 4.4 RED: delete table referenced by one table → refused, message names table+field, buffer unchanged (mutation: drop field name from message)
- [x] 4.5 RED: delete table referenced by multiple tables → message names every referencing table/field pair (mutation: report only the first match)
- [x] 4.6 RED: delete unreferenced table → succeeds, block removed, no refusal
- [x] 4.7 RED: stale span × delete refusal — target table removed between the UI's last render and the `applyErdEdit` call → `anchor-missing`; refusal is computed from `resolve()` over the fresh parse, never a cached scan (mutation: reuse cached referencing-table list)
- [x] 4.8 GREEN: wire rename/delete affordances on `TableNode.tsx`/`ERDCanvas.tsx`
- [x] 4.9 RED: `schemaWritable:false` × edit affordance disabled with stated reason, no request issued (mutation: enable regardless of `schemaWritable`)
- [x] 4.10 RED: read-only × ERD edit action → refusal surfaced, no PUT sent (extends `ERDDesignerPage.test.tsx`)
- [x] 4.11 GREEN: implement shared dirty-buffer accumulation — ERD edits and manual Monaco edits compose, no auto-persist
- [x] 4.12 RED: add table + rename field + delete unreferenced table, no Save between → one `PUT /api/schema/source` on Save containing all three; no request before it
- [x] 4.13 RED: reload without Save discards accumulated edits — on-disk file reflects none
- [x] 4.14 RED: schema `PUT` → 422 after an ERD-authored patch → buffer kept, diagnostics shown, no success toast (extends `ERDDesignerPage.test.tsx`)

## Phase 5: Field CRUD (PR 5, depends on: Phase 3)

- [x] 5.1 GREEN: implement `addField` edit constructor (insert field line)
- [x] 5.2 RED (vitest): adding a field inserts one new line inside the table block; the `id Int @id` line and everything outside the block is unchanged (byte-diff)
- [x] 5.3 GREEN: implement `editField` edit constructor (name/type/optional)
- [x] 5.4 RED: `editField` changes only the targeted field, rest byte-unchanged (mutation: widen the replacement span by one token)
- [x] 5.5 GREEN: implement `deleteField` edit constructor
- [x] 5.6 RED: `deleteField` removes only the target field line, rest unchanged
- [x] 5.7 GREEN: wire field-row add/edit/delete affordances on `TableNode.tsx` to `applyErdEdit`
- [x] 5.8 RED: field edit affordance disabled under `schemaWritable:false`/read-only, consistent with Phase 4 gating (extends existing tests)

## Phase 6: Relation drawing (PR 6, depends on: Phase 5)

`addRelation` is a new `ErdEdit` kind — the **Standing obligation** above applies to it in
full, and 6.8/6.9 below discharge it.

- [x] 6.1 GREEN: implement `addRelation` edit constructor emitting `@relation(fields:[...], references:[...])` on the target field
- [x] 6.2 RED (vitest): `addRelation` patch inserts the attribute on the correct field only, rest of file byte-unchanged
- [x] 6.3 GREEN: enable connectable handles in edit mode (D7) — flip `isConnectable`, enlarge hit area (currently 1×1/`opacity:0`); `buildEdges`' handle IDs (`s-l-{idx}`) stay unchanged
- [x] 6.4 RED: edit mode reveals enlarged, interactive handles; view/read-only mode leaves them non-interactive (mutation: enable handles regardless of mode)
- [x] 6.5 GREEN: wire `onConnect` on `<ReactFlow>` to call `applyErdEdit` with `addRelation` on a successful connection
- [x] 6.6 RED: `onConnect` between two field handles triggers exactly one `addRelation` call with correct `from`/`fromField`/`to`/`toField`
- [x] 6.7 Manual E2E (recorded): add table → add field → draw relation → Save → reload → positions and schema both persist (`indigodb studio` against a scratch project) — **RUN 2026-09-08** against a real browser + real Postgres. Persistence half **PASSES**: per-request schema read picks up on-disk edits with no restart; Save round-trips the `datasource` block back intact with `env("DATABASE_URL")`; enum/`@note`/`@map`/comments byte-unchanged; layout autosaves to the `schema.layout.json` sidecar on drag-end, separate from the explicit schema Save; positions and schema both survive reload. **Relation half FAILED and produced Phase 7 below.** Two steps could not be driven by automation at all: `TableNode.tsx` names tables and fields through `window.prompt()` (5 sites), and a native modal freezes the CDP session — that, not "no browser was available", is why this task sat open. Add-field was exercised through the editor buffer instead.
- [x] 6.8 Spec: add a Requirement (or Scenarios under an existing one) in
      `specs/studio-erd-editing/spec.md` naming `addRelation`, each scenario mapped to one of
      the tests above
- [x] 6.9 RED: the relation-drawing affordance is gated on the same `editDisabled` flag as
      every other ERD edit affordance (mutation: enable it regardless of
      `schemaWritable`/`readOnly`)

## Phase 7: `addRelation` emits a relation the compiler resolves (PR 7, depends on: Phase 6)

Raised by task 6.7's manual E2E, which is the only reason this was found. Phase 6's
`addRelation` appended `@relation(fields: [...], references: [...])` to the **scalar**
foreign-key field. In `.indigo` that parses and resolves with no error and no diagnostic, and
produces **zero** foreign keys — so the relation was inert end to end: nothing in the IR,
nothing in `migrate`'s DDL, and no edge drawn on the canvas that authored it. Verified against
the real compiler on both drag directions. This is the project's signature failure class (the
`onDelete` golden snapshot, the `result === undefined` nested-write case): something that
silently does nothing, ratified by a green suite.

Delivery: `single-pr` (session preflight). **The ≈250-line estimate written here first was
wrong — the real figure is 573 changed lines of code (408 modified + a 165-line new test
file), ~1.4× the 400-line review budget**; verify caught the miscount. The single-PR shape is
still the right call on its own merits — splitting means landing a known-inert `addRelation`
in one PR and the test proving it inert in another — but it needs an explicit `size:exception`
from the maintainer rather than a claim of fitting under a cap it does not fit under.

**`size:exception` accepted by the maintainer, 2026-09-08** — `delivery_strategy` for this
phase is `exception-ok`. The reason on record: the only honest split would put the spec and
the failing semantic tests in one PR and the implementation in the next, leaving an
intermediate branch whose suite is red on purpose and whose reviewer would be approving a
known-inert `addRelation`. The cap was NOT raised to accommodate the work — it stands at 400
for the next phase.

- [x] 7.1 RED (vitest, node env, REAL compiler): new `patch-semantics.test.ts` asserts
      `addRelation`'s emitted buffer resolves to a real foreign key on the FK-side table.
      Fails before the fix with `foreignKeys: []` — on its own assertion, not by crash.
- [x] 7.2 GREEN: `addRelation` inserts a NEW field typed as the referenced model carrying
      `@relation(...)`, after the FK field's declaration, matching that line's indentation —
      instead of decorating the scalar.
- [x] 7.3 GREEN: the FK side is derived from the schema (which counterpart field carries
      `@id`), never from the drag direction — React Flow's `source`/`target` follow whichever
      handle the user grabbed first, so the same intent arrived with `from`/`to` swapped half
      the time and produced a backwards relation.
- [x] 7.4 RED: both drag directions between the same two fields produce a byte-identical
      buffer (mutation: `toIsPk = true`, i.e. always trust the gesture → fails).
- [x] 7.5 GREEN + RED: a drag where neither field is `@id` is refused as `not-a-primary-key`
      naming both endpoints, rather than emitting text that compiles and means nothing.
- [x] 7.6 GREEN: both endpoints are resolved against the fresh parse — `to`/`toField` used to
      be interpolated into the emitted text unchecked, so a relation could name a table that
      does not exist. Refuses `anchor-missing` now.
- [x] 7.7 GREEN: inserted field name is the FK field minus a trailing `Id`/`_id`
      (`authorId` → `author`), falling back to the referenced model lower-cased, suffixed
      `_2`, `_3`, … on collision with an existing field. RED test covers the collision.
- [x] 7.8 Test-infrastructure fix: `patch.test.ts`'s span mock left `attributes: []` with a
      comment saying no edit kind read them. `addRelation` now does, and leaving the stub
      would have silently routed every `addRelation` test into the `not-a-primary-key`
      refusal — a green suite testing nothing. The mock now populates attribute names.
- [x] 7.9 Test-infrastructure fix: `src/test/setup.ts` unconditionally touched `window`, so
      any node-environment test file crashed in setup before its first assertion. Guarded via
      a separately-typed `hasDom` check that does not narrow the DOM globals to `never` under
      `tsc` — the reason the original comment gave for having no guard at all.
- [x] 7.10 Spec: `specs/studio-erd-editing/spec.md`'s relation Requirement rewritten. The old
      title — "appends a `@relation` attribute on the source field" — mandated the defect, so
      the implementation and its tests were faithful to a spec that was wrong about the
      language. Now carries the resolve-to-a-foreign-key obligation, the FK-side rule, the
      refusal, the naming rule, and five scenarios each mapped to a test.
- [x] 7.11 Standing obligation gains clause 4: every new `ErdEdit` kind needs at least one
      test that feeds the emitted buffer through the real compiler and asserts on the IR.
- [x] 7.12 Mutation proof: reintroducing the shipped defect (append to the scalar) fails 8
      tests; ignoring the `@id` side fails 4. Each failure names its own assertion — no
      crash-only or hang-only failures. Both mutations reverted with a clean `git diff`.
- [x] 7.13 Re-run task 6.7's manual E2E against the fix — **RUN 2026-09-08, PASSES.** The
      earlier "blocked on a human" note was wrong: `window.prompt()` gates the *naming* steps
      (add table, rename, add field), but relation drawing is a handle-to-handle drag through
      `onConnect` and opens no dialog, so preparing the two tables in the file makes this
      fully automatable. Dragging from `Post.authorId` toward `User.id` — the direction that
      previously produced the backwards form — emitted
      `author User @relation(fields: [authorId], references: [id])` on `Post`, the canvas drew
      the edge, `authorId` gained its link icon, and `authorId Int @map("author_id")` stayed
      byte-unchanged. `db push --print` plans
      `ALTER TABLE "Post" ADD CONSTRAINT "Post_author_id_fkey" FOREIGN KEY ("author_id")
      REFERENCES "User" ("id");`. After Save and reload the relation and the edge both come
      back from the file.

### Phase 7 follow-through on the verify report (2026-09-08)

- [x] 7.14 RED: the both-`@id` tie branch (`patch.ts`) — a 1:1 shape where neither side is
      "the FK side" by schema, so the gesture is the only signal left and the code keeps it.
      Flagged untested by verify. Mutation (`toIsPk && !fromIsPk`) fails exactly this test.
- [x] 7.15 RED: `toField` absent from the fresh parse refuses `anchor-missing`. Sibling of the
      absent-table case; verify flagged the branch untested. Mutation (fall back to
      `toModel.fields[0]` instead of refusing) fails exactly this test.
- [x] 7.16 RED: a FK field named literally `Id` strips to the empty string, so the
      `stripped.length > 0` guard is load-bearing rather than redundant with
      `stripped !== foreignKeyFieldName`. Mutation (drop that clause) fails exactly this test.
      The first version of this test asserted a substring that the CORRECT output also
      contains — it would have passed against the bug. Replaced with an exact-line assertion.
- [x] 7.17 Review-budget correction: the ≈250-line claim was wrong; the real figure (573 code
      lines) is recorded in `apply-progress.md` as a miss rather than re-estimated. The
      maintainer's `size:exception` decision that this called for was taken and is recorded
      above under the Phase 7 delivery note.
- [x] 7.18 TDD Cycle Evidence table added to `apply-progress.md`, closing the WARNING carried
      from the first verify report into the re-verification.

### Follow-ups raised by 6.7, deliberately NOT absorbed into this phase

- `TableNode.tsx` drives table/field naming through `window.prompt()` at 5 sites. The proposal
  specified *inline* field editing; a native modal is not inline, is unstyleable, offers no
  type picker or validation, and makes the flow untestable by browser automation. Needs its
  own change.
- ERD table and field delete have **no confirmation** — one click on the trash icon mutates
  the buffer. Recoverable by undo or by not saving (unlike `real-row-crud`, whose DELETE hits
  the database and is gated behind confirm + Safe Updates), but a designer should not lose a
  table to a mis-click.
- The layout sidecar accumulates entries for tables that no longer exist in the schema.
