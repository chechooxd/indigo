//! Task 1.11: Rust-vs-WASM span agreement.
//!
//! The exact same literal source is parsed here directly through
//! `parse_source_with_spans` (native Rust, calling `parser.rs`'s
//! span-collection logic directly) and, independently, through
//! `packages/compiler/test/parity.mjs`'s
//! `"spans: Rust-vs-WASM agreement fixture"` block (`parseSchemaWithSpans()`
//! from Node, over the compiled WASM artifact). Both assert the identical
//! literal `start`/`end`/`line`/`column`/`endLine`/`endColumn` values below
//! — deliberately duplicated rather than shared, so a divergence between the
//! native and wasm32 codegen paths (or a future change to only one offset
//! calculation site) fails on whichever side stops matching, without either
//! test needing to invoke `cargo` from Node (this repo's TS-only devs never
//! need the Rust toolchain — see `crates/CLAUDE.md`).
//!
//! Values recorded here were read once from the real compiled output
//! (`parseSchemaWithSpans` against this exact source) — not hand-derived —
//! and must be updated in both places together if the span algorithm
//! intentionally changes.

use indigo_compiler::parse_source_with_spans;

const SOURCE: &str = "Table User {\n  id Int @id\n  name String @unique\n}\n";

#[test]
fn model_and_field_spans_match_the_recorded_wasm_boundary_values() {
    let (_schema, spans) = parse_source_with_spans(SOURCE).expect("fixture should parse");
    assert_eq!(spans.models.len(), 1);
    let model = &spans.models[0];
    assert_eq!(model.name, "User");

    assert_eq!((model.decl.start, model.decl.end), (0, 49));
    assert_eq!((model.decl.line, model.decl.column), (1, 1));
    assert_eq!((model.decl.end_line, model.decl.end_column), (4, 2));

    assert_eq!((model.name_token.start, model.name_token.end), (6, 10));
    assert_eq!((model.body_open.start, model.body_open.end), (11, 12));
    assert_eq!((model.body_close.start, model.body_close.end), (48, 49));

    assert_eq!(model.fields.len(), 2);

    let id_field = &model.fields[0];
    assert_eq!(id_field.name, "id");
    assert_eq!((id_field.decl.start, id_field.decl.end), (15, 25));
    assert_eq!((id_field.decl.line, id_field.decl.column), (2, 3));
    assert_eq!((id_field.decl.end_line, id_field.decl.end_column), (2, 13));
    assert_eq!((id_field.name_token.start, id_field.name_token.end), (15, 17));
    assert_eq!((id_field.type_token.start, id_field.type_token.end), (18, 21));
    assert_eq!(id_field.attributes.len(), 1);
    assert_eq!(id_field.attributes[0].name, "id");
    assert_eq!(
        (id_field.attributes[0].span.start, id_field.attributes[0].span.end),
        (22, 25)
    );

    let name_field = &model.fields[1];
    assert_eq!(name_field.name, "name");
    assert_eq!((name_field.decl.start, name_field.decl.end), (28, 47));
    assert_eq!((name_field.decl.line, name_field.decl.column), (3, 3));
    assert_eq!((name_field.decl.end_line, name_field.decl.end_column), (3, 22));
    assert_eq!((name_field.name_token.start, name_field.name_token.end), (28, 32));
    assert_eq!((name_field.type_token.start, name_field.type_token.end), (33, 39));
    assert_eq!(name_field.attributes.len(), 1);
    assert_eq!(name_field.attributes[0].name, "unique");
    assert_eq!(
        (name_field.attributes[0].span.start, name_field.attributes[0].span.end),
        (40, 47)
    );
}
