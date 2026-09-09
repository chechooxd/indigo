# Apply Progress: ERD becomes a designer — Phase 7

## Scope of this batch

Phase 7 only (`## Phase 7: addRelation emits a relation the compiler resolves`, tasks
7.1–7.12), plus resolving task **6.7** from Phase 6. Phases 1–6 landed and were verified
independently in earlier batches and are not re-applied here.

**Mode**: Strict TDD.
**Delivery**: `single-pr` (session preflight 2026-09-08).
**Review budget**: 400 lines — **BREACHED, see the correction below.**

## Review-budget correction (2026-09-08, raised by verify)

This file originally claimed the diff was "≈250 lines — under the 400-line review budget".
**That was wrong, and verify caught it.** Measured with `git diff --numstat`:

| Scope | Changed lines |
|-------|---------------|
| Modified code under `apps/studio` | 408 (+361 / −47) |
| New `patch-semantics.test.ts` | 165 |
| **Code total** | **573** |
| Modified `openspec/` artifacts | 410 |
| New `apply-progress.md` | 160 |
| **Everything** | **1143** |

So the code alone is ~1.4× the 400-line budget, and the estimate undercounted it by well over
half. An estimate that is only ever compared against itself is not a budget; recording the
miss here is the point. The three extra tests verify asked for (both-`@id` tie, absent
`toField`, empty-strip fallback) landed after that measurement and are included above.
**Focused test command**: `pnpm --filter @indigodb/studio exec vitest run src/features/erd`

## How this batch started: task 6.7 was actually run

6.7 — the manual E2E — had sat open across every prior batch with the note "no interactive
browser session was available to the executing agent". This batch had one, so it was run:
`indigodb studio` against a scratch project and a real Postgres (a throwaway
`indigo_erd_e2e` database, dropped afterwards), driven through Chrome.

**The persistence half passed**, and it is worth recording exactly what that proved, because
several of these are design decisions from earlier changes being exercised for the first time
outside a test:

- Per-request schema read (PR #1a of `studio-schema-write-back`) picks up an on-disk edit with
  **no server restart** — verified by editing the file underneath a running Studio.
- Save round-trips the `datasource` block back **intact**, with `env("DATABASE_URL")` — the
  redaction trap (`GET` serves the block replaced by a sentinel line) is correctly avoided.
- An `enum`, a `@note`, a `@map` and a leading comment were all byte-unchanged across an
  add-table and a relation edit — the targeted-patch claim holds against constructs the ERD
  does not model.
- Layout autosaves to the `schema.layout.json` sidecar on drag-end, **separately** from the
  explicit schema Save: an unsaved schema edit was correctly discarded on reload while the
  node position persisted.
- Positions and schema both survive a reload.

**The relation half failed**, which is what produced Phase 7.

Two of 6.7's own steps could not be driven by automation at all: `TableNode.tsx` names tables
and fields through `window.prompt()` (5 call sites), and a native modal dialog freezes the
CDP-driven session — the tab had to be closed to recover. That, and not "no browser was
available", is the real reason this task never got run. Add-field was exercised through the
editor buffer instead; the finding below came from the canvas path, which needs no prompt.

## The defect

Drawing a relation emitted `@relation(fields: [...], references: [...])` appended to the
**scalar** foreign-key field:

```
id Int @id @default(autoincrement()) @relation(fields: [id], references: [authorId])
```

Fed back through the real compiler, on **both** drag directions:

| Form | parse + resolve | foreignKeys |
|------|-----------------|-------------|
| ERD-authored (either direction) | OK — no error, no diagnostic | `[]` |
| Correct (`author User @relation(...)`, a field typed as the model) | OK | `[{columns:["author_id"], refTable:"User", refColumns:["id"]}]` |

No FK in the IR → no DDL from `migrate` → no edge on the canvas that drew it. Confirmed
visually: after Save and reload, no edge is rendered between the two nodes.

Also found: the drag direction decided which side got the attribute. React Flow's
`source`/`target` follow whichever handle the user grabbed first, so `from`/`to` arrived
swapped roughly half the time and the relation came out backwards — pointing a primary key at
a scalar.

## Why every existing test was green

`patch.test.ts` mocks `@indigodb/core` wholesale — it has to, because jsdom cannot host the
WASM compiler. Every assertion in that file is therefore a **string comparison on emitted
text**. Phase 6's tests assert that `onConnect` calls `applyErdEdit` with the right arguments
(6.6) and that the text anchor is not off by one (6.2, which did catch a real off-by-one).
Nothing fed the resulting text back through the compiler. The patch's mechanics were verified;
its meaning never was.

The spec is where this actually started. The Phase 6 requirement was titled *"Drawing a
relation between two fields appends a `@relation` attribute on the source field"* and its
scenarios spelled out the inert line as the expected result. The implementation and its tests
were faithful to a spec that was wrong about the language — so no amount of care inside
Phase 6 would have caught it.

## Completed Tasks (Phase 7)

- [x] 7.1 RED — new `patch-semantics.test.ts` (`// @vitest-environment node`, real
      `@indigodb/core`), asserting on the resolved IR rather than on text. 4/4 failed before
      the fix, each on its own `expect` (`foreignKeys` `[]` vs expected, and `ok:true` vs an
      expected refusal) — no crash-only failures.
- [x] 7.2 GREEN — `addRelation` inserts a new field typed as the referenced model, after the
      FK field's declaration, matching that line's indentation.
- [x] 7.3 GREEN — FK side derived from `@id` on the counterpart field, read off the span
      index's own `attributes`, not from the drag direction. Ties (both `@id`) keep the
      gesture's direction.
- [x] 7.4 RED — both directions produce a byte-identical buffer.
- [x] 7.5 GREEN + RED — neither side `@id` refuses as `not-a-primary-key`, naming both
      endpoints, instead of emitting something inert. New `reason` added to `ErdEditResult`.
- [x] 7.6 GREEN — both endpoints resolved against the fresh parse. `to`/`toField` used to be
      interpolated blind, so a relation could name a table that does not exist.
- [x] 7.7 GREEN — naming: FK field minus trailing `Id`/`_id`, else the referenced model
      lower-cased, suffixed `_2`, `_3`, … on collision.
- [x] 7.8 — `patch.test.ts`'s span mock populated attribute names. It had `attributes: []`
      with a comment stating no edit kind read them; `addRelation` now does, and leaving the
      stub would have routed every `addRelation` test into the `not-a-primary-key` refusal —
      a green suite asserting nothing.
- [x] 7.9 — `src/test/setup.ts` guarded so a node-environment test file does not crash in
      setup. The original comment explained that a `typeof window` guard narrows the DOM
      globals to `never` under `tsc`; the `hasDom` const tests a separately-typed expression,
      which satisfies both `tsc` and the runtime.
- [x] 7.10 — spec requirement rewritten with the resolve-to-a-foreign-key obligation, the
      FK-side rule, the refusal, the naming rule, and five scenarios each mapped to a test.
      The delete-refusal scenario's GIVEN was also corrected: it encoded the same inert form,
      and since that guard reads `resolve(schema)`'s foreign keys, it was never protecting
      against ERD-authored relations at all.
- [x] 7.11 — Standing obligation gains clause 4 (a real-compiler semantic test per new
      `ErdEdit` kind).
- [x] 7.12 — mutation proof, both reverted with a clean `git diff`:

| Mutation | Result |
|----------|--------|
| Append `@relation` to the scalar (reintroduce the shipped defect) | **8 tests fail** — 3 semantic + 5 text, each on its own assertion |
| `toIsPk = true` (always trust the drag direction) | **4 tests fail** — both reverse-direction tests and both refusal tests |

## 7.13 — the fix confirmed end to end in a browser

This was first recorded as "blocked on a human", and that was wrong. `window.prompt()` gates
the *naming* steps (add table, rename table, add field); relation drawing is a handle-to-handle
drag through `onConnect` and opens no dialog at all. With the two tables prepared in the file,
the step is fully automatable — the same mistaken assumption is what kept 6.7 open for six
batches.

Run against a real browser and a real Postgres, dragging from `Post.authorId` toward
`User.id` — deliberately the direction that previously produced the backwards, inert form:

| Check | Result |
|-------|--------|
| Emitted line | `author User @relation(fields: [authorId], references: [id])`, inside `Post` |
| FK side | `Post` — correct, despite the drag direction |
| Canvas | edge rendered between the two nodes; `authorId` gained its link icon |
| `authorId Int    @map("author_id")` | byte-unchanged |
| `enum`, `@note`, leading comment | byte-unchanged |
| `db push --print` | `ALTER TABLE "Post" ADD CONSTRAINT "Post_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "User" ("id");` |
| Save + reload | relation and edge both restored from the file |

The DDL line is the one that actually closes this: before the fix the same gesture produced a
buffer that planned no constraint at all.

## Known cosmetic gap, not fixed here

The inserted line is not column-aligned with its siblings (`author User @relation(...)` next to
`authorId Int    @map(...)`). The patch module deliberately never reformats — that is the
property that keeps `TableGroup`, `@@allow` and user formatting byte-safe — so alignment would
have to come from a formatter (`indigodb format`, Phase 6 of the roadmap), not from here.

## Verification run

- `pnpm build --force` — 11/11 tasks, 0 cached, exit 0.
- `pnpm lint` — 21/21 tasks, exit 0. (`tsc -b` caught a `never[]` annotation left over from
  7.8; `tsc --noEmit` without `-b` would not have.)
- `pnpm test` — exit 0. `@indigodb/studio` 251 passed / 29 files; workspace pack-contents
  guard green across all 11 packages.
