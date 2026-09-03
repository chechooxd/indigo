# Studio ERD Editing Specification

## Purpose

The Studio ERD canvas MUST let a user create/rename/delete tables, add/edit/
delete fields, and draw relations directly on the diagram, with every edit
expressed as a minimal, span-anchored text patch on the `.indigo` source
buffer rather than a regenerated file — so any construct the ERD does not
model (`@@allow`, `@@realtime(columns:)`, `TableGroup`, comments, user
formatting) is left byte-unchanged by construction. Patches accumulate in
one in-memory dirty buffer; persistence to disk happens only through an
explicit Save, reusing `PUT /api/schema/source` from `studio-schema-write`.

## Requirements

### Requirement: Every ERD edit produces a minimal, span-anchored text patch

Node create/rename/delete, field add/edit/delete, and relation-drawing edits
MUST each be expressed as an `ErdEdit` and applied through
`applyErdEdit(currentText, edit)`, the single entry point exposed by the
patch module. `applyErdEdit` MUST call `parse_with_spans` (via
`ast-source-spans`'s `parseWithSpans`) internally against `currentText` to
locate the target node's span in the `SpanIndex` side channel, and replace
only the minimal substring needed, never regenerating the file via the
printer. The resulting buffer MUST be applied to the same client-side dirty
buffer that Monaco edits also apply to, so ERD edits and manual text edits
compose.

#### Scenario: Adding a field inserts one line without touching the rest of the table

- GIVEN a `Table User { id Int @id }` block
- WHEN the user adds a field `email String` via the ERD
- THEN the resulting buffer contains a new `email String` line inside the
  `User` block
- AND every byte outside that block, and the `id Int @id` line itself, is
  unchanged

#### Scenario: A construct the ERD does not model survives an unrelated edit untouched

- GIVEN a schema containing a `TableGroup "Billing" { color = "#fff" ... }`
  block and an `@@allow` rule on an unrelated table
- WHEN the user renames a field on a third, unrelated table via the ERD
- THEN the `TableGroup` block and the `@@allow` rule are byte-identical
  before and after the edit

### Requirement: Deleting a referenced table is refused, naming the referencing tables and fields

Deleting a table from the canvas MUST be refused when any other table in the
current buffer has a relation field (`@relation(...)`) pointing at it. The
refusal MUST be surfaced to the user with a message that names every
referencing table and the specific referencing field(s) on each — a generic
"cannot delete" message does not satisfy this requirement. No patch MUST be
applied to the buffer when the deletion is refused.

#### Scenario: Deleting a table referenced by one other table is refused with names

- GIVEN tables `User` and `Post`, where `Post.authorId` carries
  `@relation(fields: [authorId], references: [id])` pointing at `User`
- WHEN the user attempts to delete `User` from the canvas
- THEN the deletion is refused
- AND the refusal message contains the literal table name `Post` and the
  literal field name `authorId`
- AND the in-memory buffer is unchanged — no patch was applied

#### Scenario: Deleting a table referenced by multiple tables names all of them

- GIVEN `User` is referenced by `Post.authorId` and by `Comment.userId`
- WHEN the user attempts to delete `User`
- THEN the refusal message names both `Post`/`authorId` and
  `Comment`/`userId`

#### Scenario: Deleting an unreferenced table succeeds

- GIVEN a table `Tag` with no other table's relation field pointing at it
- WHEN the user deletes `Tag` from the canvas
- THEN the patch removes the `Tag` block from the buffer
- AND no refusal is shown

### Requirement: A stale span is unrepresentable — the patch module never holds one across an edit

The patch module MUST expose exactly one entry point for applying an ERD
edit, `applyErdEdit(currentText, edit)`, which parses `currentText` and
computes and applies the patch in the same synchronous call. The module
MUST NOT export any function that returns a span, a span index, or any
other value a caller could cache and later replay against a different
buffer — there is no representable value for "a span from an earlier
buffer" to become stale. If `applyErdEdit`'s internal fresh parse fails, or
the edit's anchor (table/field name) is absent from that fresh parse, it
MUST return `{ok: false, reason: 'parse-failed' | 'anchor-missing', ...}`
and the buffer MUST be left untouched — never applied against positions
computed from a prior call.

#### Scenario: The patch module's export surface excludes any span-returning function

- GIVEN the compiled patch module (`apps/studio/src/features/erd/lib/patch.ts`)
- WHEN its exported keys are inspected
- THEN the only edit-applying export is `applyErdEdit`, and no export
  returns a `SpanIndex`, a span, or any value from which a caller could
  reconstruct and later replay a stale position

#### Scenario: A manual Monaco edit above a node invalidates a pending ERD edit

- GIVEN the ERD is about to call `applyErdEdit` with an edit that adds a
  field to `Post`
- WHEN the user types two new lines into Monaco above the `Post` block
  (shifting every subsequent line number) before that call happens, so
  `applyErdEdit` receives the post-edit `currentText`
- THEN `applyErdEdit`'s internal fresh parse locates `Post` at its current
  (shifted) position and applies the patch there — there is no stale span
  to detect, because no span from before the Monaco edit was ever held

#### Scenario: A missing anchor after an intervening edit refuses the patch

- GIVEN the ERD is about to call `applyErdEdit` with an edit targeting a
  field on `Post`
- WHEN `Post` (or the target field) was removed by an intervening edit
  before this call, so it is absent from `applyErdEdit`'s internal fresh
  parse of `currentText`
- THEN the result is `{ok: false, reason: 'anchor-missing', ...}` and the
  buffer is returned untouched

#### Scenario: An unchanged buffer applies the patch normally

- GIVEN no edit occurred between the ERD deciding to act and calling
  `applyErdEdit`
- WHEN `applyErdEdit(currentText, edit)` is called
- THEN its internal fresh parse locates the target node in `currentText`
  and the patch is applied

#### Scenario: A stale span blocks the delete-refusal check itself, not only the patch

- GIVEN the ERD is about to delete `User`, and a concurrent Monaco edit has
  shifted line numbers since the referencing-table scan for the delete
  refusal was last rendered in the UI
- WHEN the ERD calls `applyErdEdit` with the `deleteTable` edit
- THEN the referenced-table check inside `applyErdEdit` is computed from
  `resolve(schema)` over the fresh parse of the current `currentText` — not
  from any span or scan result held from before the Monaco edit — so the
  user is never told a deletion is safe (or unsafe) based on positions that
  no longer match the current buffer

### Requirement: Edits accumulate in one dirty buffer; Save is a single explicit action

ERD-authored edits and manual Monaco edits MUST accumulate in the same
client-side dirty buffer without persisting to disk. Persistence MUST occur
only when the user explicitly triggers Save, which submits the complete
accumulated buffer through `PUT /api/schema/source`, following the same
version/staleness/validation contract `studio-schema-write` already defines.

#### Scenario: Multiple ERD edits before Save produce one write

- GIVEN the user adds a table, renames a field, and deletes an unreferenced
  table, all via the ERD, without clicking Save between actions
- WHEN the user then clicks Save once
- THEN exactly one `PUT /api/schema/source` request is sent, containing all
  three accumulated edits
- AND no request was sent after any individual ERD action before that Save

#### Scenario: Closing without Save discards accumulated ERD edits

- GIVEN the user made ERD edits without saving
- WHEN the user reloads the Studio tab without clicking Save
- THEN the on-disk `.indigo` file reflects none of the discarded edits

### Requirement: Renaming a table rewrites only its own declaration (non-goal: relation propagation)

Renaming a table from the ERD MUST rewrite only that table's own name at its
declaration site. It MUST NOT rewrite any other table's `@relation(...)`
attributes that reference the old name — propagating a rename into
referencing relations is explicitly OUT OF SCOPE for node CRUD and is
deferred to relation-drawing behavior. A renamed table with existing
incoming relations therefore leaves those relations referencing the old
name until relation-drawing tooling (or a manual edit) updates them.

#### Scenario: Renaming a referenced table does not touch the referencing table's relation

- GIVEN `Post.authorId` carries `@relation(...)` referencing `User`
- WHEN the user renames `User` to `Author` via the ERD
- THEN the buffer's `User`/`Author` declaration is renamed
- AND `Post`'s `@relation(...)` attribute is byte-unchanged, still naming
  the pre-rename identifier — this is expected, not a defect, per this
  requirement's stated non-goal
</content>
