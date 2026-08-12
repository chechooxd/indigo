//! Property test: `parse_source` (lexer + parser, pre-resolution) must never
//! panic on adversarial, `.indigo`-shaped input. A WASM panic aborts the
//! shared WASM instance for every consumer (Studio, CLI, migrator) so this
//! is an isolated safety net, not a correctness assertion — `parse_source`
//! may legitimately return `Err`, it must simply never abort.
//!
//! Scoped to `parse_source` only: `resolve`/`validate` panic-safety is out
//! of scope for this test (see design.md's scope boundary).

use proptest::prelude::*;

use indigo_compiler::parse_source;

/// ~46 fixed atoms biased toward `.indigo` keywords, punctuation and common
/// attribute/type names, so generated input exercises parser recovery paths
/// beyond an immediate lexer failure, not uniformly random bytes.
const ATOMS: &[&str] = &[
    // keywords / block introducers
    "Table", "enum", "datasource", "generator", "TableGroup",
    // punctuation
    "{", "}", "[", "]", "(", ")", ",", ":", "=", "?",
    // field attributes
    "@id", "@unique", "@map", "@note", "@default", "@relation", "@updatedAt",
    // model attributes
    "@@id", "@@map", "@@index", "@@unique", "@@realtime", "@@ignore",
    // scalar type names
    "String", "Int", "Float", "Boolean", "DateTime", "Json", "BigInt", "Bytes", "Decimal",
    // relation-arg identifiers / referential actions
    "fields", "references", "onDelete", "onUpdate", "Cascade", "env",
    // lexer edge-case bait
    "//", "~", "\\", "\"",
];

fn atom() -> impl Strategy<Value = String> {
    proptest::sample::select(ATOMS).prop_map(String::from)
}

fn identifier() -> impl Strategy<Value = String> {
    "[A-Za-z_][A-Za-z0-9_]{0,7}"
}

/// A quoted string containing escape-sequence bait (both recognized and
/// unrecognized escapes), to keep the lexer's escape-decoding path reachable.
fn quoted_string() -> impl Strategy<Value = String> {
    "[a-zA-Z0-9 \\\\\"nrtq]{0,12}".prop_map(|body| format!("\"{body}\""))
}

fn number() -> impl Strategy<Value = String> {
    any::<i32>().prop_map(|n| n.to_string())
}

fn token() -> impl Strategy<Value = String> {
    prop_oneof![
        8 => atom(),
        3 => identifier(),
        2 => quoted_string(),
        1 => number(),
    ]
}

fn separator() -> impl Strategy<Value = &'static str> {
    proptest::sample::select(&[" ", "\n", "  ", ""][..])
}

fn indigo_source() -> impl Strategy<Value = String> {
    proptest::collection::vec((token(), separator()), 1..=40)
        .prop_map(|parts| parts.into_iter().map(|(t, s)| format!("{t}{s}")).collect())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, ..ProptestConfig::default() })]

    /// `parse_source` must return a `Result` (Ok or a clean Err) for any
    /// generated `.indigo`-shaped input — never panic/abort/unwind.
    #[test]
    fn parse_source_never_panics(src in indigo_source()) {
        let _ = parse_source(&src);
    }
}
