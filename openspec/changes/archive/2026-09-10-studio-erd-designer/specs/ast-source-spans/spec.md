# AST Source Spans Specification

## Purpose

`crates/indigo-compiler` MUST expose a way to locate the exact source text
a `Model`/`Field`/`Attribute` node came from, so downstream consumers
(initially the ERD text-patch builder in `studio-erd-editing`) can slice and
replace precisely that text without re-deriving position by re-parsing or
string-searching. This capability is delivered as a **side channel** — a new
`parse_with_spans(source)` WASM export returning `{schema, spans}` — never
as fields added to the AST nodes themselves. `parse`, `resolve`, `validate`,
`compile`, `@indigodb/ast`, and every fixture in `fixtures/snapshots/` are
untouched by this capability; only `parse_with_spans` and its `spans`
payload are new surface. Spans are scoped to `Model`/`Field`/`Attribute`
declarations inside table blocks — enums, `datasource`, `generator`, and
`TableGroup` blocks carry no spans, since nothing in this change edits them.

## Requirements

### Requirement: `parse_with_spans` delivers spans as a side channel, `parse` stays unchanged

`crates/indigo-compiler` MUST expose a `parse_with_spans(source)` WASM
export that returns `{ok: {schema, spans}}` on success (or the existing
`{errors}` envelope on failure), where `schema` is byte-identical to what
`parse(source)` would return and `spans` is a `SpanIndex` keyed by model
name. The existing `parse` export's signature, return envelope, and output
for any given source MUST be unaffected by the existence of
`parse_with_spans` — no shared internal representation may leak a `span`
field onto `parse`'s output.

#### Scenario: parse_with_spans returns schema and spans together

- GIVEN a fixture `.indigo` file with two models
- WHEN `parse_with_spans(source)` is called from TypeScript
- THEN the result is `{ok: {schema, spans}}`, `schema` matches the AST
  `parse(source)` would produce, and `spans.models` has one entry per model

#### Scenario: parse's output is unaffected by parse_with_spans existing

- GIVEN the same fixture `.indigo` file used by the existing parity suite
- WHEN `parse(source)` is called before and after `parse_with_spans` is
  added to the compiler
- THEN the JSON returned by `parse` is byte-identical in both cases — no
  new field, no reordered key, no schema change

### Requirement: Span offsets are UTF-16 code units, converted in Rust at emission time

`SourceSpan.start`/`SourceSpan.end` MUST be UTF-16 code-unit offsets into
the source string, end-exclusive, even though `logos` (the lexer) yields
UTF-8 byte offsets internally. The conversion from byte offset to UTF-16
offset MUST happen in Rust at span-emission time, so that
`currentText.slice(span.start, span.end)` in JavaScript yields exactly the
node's source text regardless of any non-ASCII character earlier in the
buffer.

#### Scenario: An ASCII field span slices exactly the field's text in JS

- GIVEN the source line `  id Int @id` at a known offset
- WHEN `parse_with_spans` computes the `Field` node's span for `id`
- THEN `currentText.slice(span.start, span.end)` in JavaScript equals
  `id Int @id`

#### Scenario: A non-ASCII character before an edit point does not corrupt a later span

- GIVEN `fixtures/22-non-ascii.indigo`, a fixture containing a non-ASCII
  character (e.g. `@note("café")`) on a line before a target field
  declaration
- WHEN `parse_with_spans` computes the span for a field declared after that
  non-ASCII character, and the resulting `start`/`end` are used to slice the
  source string in JavaScript
- THEN `currentText.slice(span.start, span.end)` equals exactly the target
  field's declaration text — proving the offsets are UTF-16 code units, not
  raw UTF-8 byte offsets (a byte-offset span would slice into the wrong
  character range on this fixture)

### Requirement: Spans carry 1-based line/column bounds for diagnostics, alongside UTF-16 offsets

Every `SourceSpan` MUST also carry 1-based `line`/`column`/`endLine`/
`endColumn`, matching the convention `ParseErrorDetail` already uses.
`endLine`/`endColumn` MUST point one position past the node's last
character (exclusive end), consistent with `end` being exclusive.

#### Scenario: A single-line field declaration has a span covering exactly its text

- GIVEN the source line `  id Int @id` at line 3, column 3
- WHEN `parse_with_spans` computes the field's `nameToken` span
- THEN `span.line == 3` and `span.column == 3`

#### Scenario: A multi-line model declaration spans from its keyword to its closing brace

- GIVEN a `Table` block opening on line 5 and closing `}` on line 12
- WHEN `parse_with_spans` computes the model's `decl` span
- THEN `span.line == 5` and `span.endLine == 12`, covering the entire
  declaration including all field lines

### Requirement: Spans agree between direct Rust parsing and the compiled WASM boundary

The same `.indigo` source, parsed once by a Rust unit test calling
`parser.rs`'s span-collection logic directly and once by
`@indigodb/compiler`'s `parseWithSpans()` from Node, MUST report identical
`start`/`end`/`line`/`column`/`endLine`/`endColumn` values for every
`Model`/`Field`/`Attribute` span.

#### Scenario: Span values match between direct Rust parsing and the WASM boundary

- GIVEN a fixture `.indigo` file
- WHEN it is parsed once by a Rust unit test calling the span-collection
  code directly, and once by `@indigodb/compiler`'s `parseWithSpans()` from
  Node
- THEN every `Model`/`Field`/`Attribute` span in both outputs has identical
  `start`/`end`/`line`/`column`/`endLine`/`endColumn` values

### Requirement: Adding `parse_with_spans` leaves all existing golden snapshots byte-identical

`@indigodb/compiler`'s parity suite MUST continue to pass against all 21
committed snapshots in `fixtures/snapshots/` with **zero snapshot
regeneration** after `parse_with_spans` is added. A snapshot MUST NOT gain a
`span` field, and no existing snapshot's bytes may change, because
`parse_with_spans` is additive surface, not a change to `parse`'s output
shape.

#### Scenario: The parity suite passes unmodified with zero snapshot regeneration

- GIVEN the 21 committed snapshots in `fixtures/snapshots/` as they exist
  before this change
- WHEN `parse_with_spans` is added to the compiler and `packages/compiler`'s
  parity suite is run against the rebuilt WASM artifact
- THEN every snapshot comparison passes without regenerating any snapshot
  file, and diffing the snapshot directory against its pre-change state
  shows zero changed bytes

### Requirement: `parse_with_spans` does not alter parse/resolve/validate outcomes

Adding `parse_with_spans` MUST NOT alter any existing parse error, resolve
error, or validation outcome for any fixture. This is additive data only,
delivered on a new export.

#### Scenario: Existing parity suite passes unmodified except for the new export

- GIVEN `@indigodb/compiler`'s existing golden-snapshot parity suite
- WHEN `parse_with_spans` is added
- THEN every fixture's error/success outcome (pass/fail, diagnostic
  messages, line/column of diagnostics) reported by `parse`/`resolve`/
  `validate`/`compile` is unchanged
