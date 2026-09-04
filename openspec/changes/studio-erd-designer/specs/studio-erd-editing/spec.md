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

### Requirement: Adding a table inserts beside the existing tables without deleting anything

Adding a table from the canvas MUST be expressed as a zero-width insertion:
the patch's start and end offsets are the same anchor, so no existing byte is
ever deleted and every byte on either side of the anchor is copied through
verbatim. The anchor MUST be the end of the LAST table's body (immediately
after its closing `}`), NOT the end of the buffer, so the new table lands
beside the existing tables rather than after a trailing construct such as a
`TableGroup` block. When the current buffer declares no tables at all, there
is no last table to anchor to and the insertion MUST fall back to the end of
the buffer. Because a pure insertion has no existing node to locate, adding
a table MUST NOT ever be refused with `anchor-missing`; the only refusal it
can produce is `parse-failed`, from `applyErdEdit`'s internal fresh parse.

#### Scenario: A new table lands after the last table, not after a trailing TableGroup

- GIVEN a buffer whose last table declaration is followed by a
  `TableGroup "Billing" { ... }` block
- WHEN the user adds a table `Invoice` from the canvas
- THEN the new `Invoice` block is inserted immediately after the last
  table's closing `}`
- AND the `TableGroup` block still follows it, unchanged and in place

#### Scenario: Adding a table leaves every existing byte untouched

- GIVEN a buffer containing `@@allow`, `@@realtime(columns: [...])`, a
  `TableGroup` block, comments, and tab-indented irregular whitespace
- WHEN the user adds a table from the canvas
- THEN the resulting buffer is the original buffer with the new table's
  text spliced in at the anchor and nothing else changed
- AND each of those constructs is byte-identical before and after the edit,
  because the insertion deletes no range at all

#### Scenario: Adding a table to a buffer with no tables yet appends at the end

- GIVEN a buffer that declares no tables, containing only a comment and a
  `TableGroup` block
- WHEN the user adds a table `Invoice` from the canvas
- THEN the edit succeeds
- AND the new `Invoice` block is appended at the end of the buffer, with the
  original text preserved verbatim as its prefix

#### Scenario: Adding a table to an unparseable buffer refuses with parse-failed

- GIVEN the current buffer does not parse
- WHEN the user adds a table from the canvas
- THEN the result is `{ok: false, reason: 'parse-failed', ...}` and the
  buffer is left untouched
- AND the reason is never `anchor-missing`, since an insertion has no
  existing anchor that could go missing

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

### Requirement: Editing a field replaces only the targeted tokens, never the whole declaration

Editing a field from the ERD MUST replace only the tokens the edit actually
changes — the field's name token, its type token, and the single `?`
immediately following the type token — and MUST NOT rewrite the field's
whole declaration line. Every other byte of that line MUST survive the edit
verbatim, including the field's own attributes (`@id`, `@default(...)`,
`@relation(...)`) and the whitespace separating them, and so must every
other field in the same block. When the target table or the target field is
absent from `applyErdEdit`'s internal fresh parse, the edit MUST be refused
as `anchor-missing` with the buffer left untouched.

#### Scenario: Renaming a field changes only its name token

- GIVEN a `Table User { id Int @id; mail String }` block
- WHEN the user renames `mail` to `email` via the ERD
- THEN only the field's name token is rewritten, yielding `email String`
- AND the type token and the rest of the line are byte-unchanged

#### Scenario: Changing a field type changes only its type token

- GIVEN a field `age String` on `User`
- WHEN the user changes its type to `Int`
- THEN the resulting line is `age Int`
- AND the field's name token is byte-unchanged

#### Scenario: Marking a field optional inserts a trailing "?" after the type

- GIVEN a field `bio String` on `User`
- WHEN the user marks it optional
- THEN the resulting line is `bio String?`
- AND no other byte of the line changes

#### Scenario: Clearing an optional removes the trailing "?"

- GIVEN a field `bio String?` on `User`
- WHEN the user clears its optional flag
- THEN the resulting line is `bio String`
- AND no other byte of the line changes

#### Scenario: A field edit leaves sibling fields and everything outside the block byte-unchanged

- GIVEN a buffer with `Table User { id Int @id; mail String }` followed by
  an unrelated `Table Post` block
- WHEN the user renames `mail`, retypes it, and marks it optional in one
  edit
- THEN only that field's line changes
- AND the `id Int @id` line and every byte outside the `User` block are
  byte-identical before and after the edit

#### Scenario: A field edit leaves the edited field's own attributes byte-untouched

- GIVEN a field `authorId Int @relation(fields: [authorId], references: [id])`
  on `Post`, in a block whose other field carries `@id @default(...)`
- WHEN the user renames it, retypes it, and marks it optional in one edit
- THEN the `@relation(...)` attribute on that same line is byte-identical
  before and after the edit, because only the name and type tokens (and the
  inserted `?`) were replaced
- AND the sibling field's `@id @default(...)` attributes are byte-identical
  too

#### Scenario: Editing a field absent from the fresh parse refuses with anchor-missing

- GIVEN the target field is not present in `applyErdEdit`'s internal fresh
  parse of `currentText`
- WHEN the user edits it via the ERD
- THEN the result is `{ok: false, reason: 'anchor-missing', ...}` and the
  buffer is left untouched

### Requirement: Deleting a field removes exactly its own line, leaving no residue

Deleting a field from the ERD MUST remove that field's entire line — its
leading indentation through its trailing newline — and nothing else. No
blank or indentation-only line MUST survive the deletion, and the lines
immediately before and after the deleted field MUST be byte-identical
before and after the edit. When the target table or field is absent from
`applyErdEdit`'s internal fresh parse, the deletion MUST be refused as
`anchor-missing` with the buffer left untouched.

#### Scenario: Deleting a field removes exactly its own line

- GIVEN a `Table User` block containing a field `mail String`
- WHEN the user deletes `mail` from the ERD
- THEN the `mail String` line is gone from the buffer
- AND every other line of the block is byte-unchanged

#### Scenario: Deleting the middle field of three leaves no blank or indentation-only residue

- GIVEN a block whose body is three consecutive field lines
- WHEN the user deletes the middle one
- THEN the first and last field lines are exactly intact and now adjacent
- AND no blank line and no indentation-only line is left where the deleted
  field was

#### Scenario: Deleting a field absent from the fresh parse refuses with anchor-missing

- GIVEN the target field is not present in `applyErdEdit`'s internal fresh
  parse of `currentText`
- WHEN the user deletes it via the ERD
- THEN the result is `{ok: false, reason: 'anchor-missing', ...}` and the
  buffer is left untouched

### Requirement: Every ERD edit affordance is gated on one shared writability flag

Every affordance that can author an `ErdEdit` — the per-table rename and
delete controls, the per-field edit/delete and add-field controls, AND the
canvas toolbar's add-table button — MUST be disabled, with a stated reason,
whenever the schema cannot be persisted: either the session has no writable
`schemaPath` (`schemaWritable` is `false`) or the server is in global
read-only mode. All of them MUST derive that state from the SAME computed
flag and reason, so no affordance can drift out of the gate on its own. A
gated affordance MUST surface its reason in place of its action label, and
MUST apply no edit when activated.

#### Scenario: Every affordance, including the toolbar add-table button, is disabled in read-only mode

- GIVEN the server reports global read-only mode
- WHEN the ERD canvas renders
- THEN the per-table and per-field affordances are disabled and carry the
  read-only reason
- AND the toolbar's add-table button is disabled and carries the same
  reason in place of its action label
- AND activating it applies no edit to the buffer

#### Scenario: Every affordance, including the toolbar add-table button, is disabled when the schema is not writable

- GIVEN `schemaWritable` is `false` and the server is not read-only
- WHEN the ERD canvas renders
- THEN every edit affordance, the toolbar's add-table button included, is
  disabled and carries the not-writable reason
- AND activating the add-table button applies no edit to the buffer

#### Scenario: Affordances are enabled in a writable, non-read-only session

- GIVEN `schemaWritable` is `true` and the server is not read-only
- WHEN the ERD canvas renders
- THEN the edit affordances are enabled and carry their action labels
</content>
