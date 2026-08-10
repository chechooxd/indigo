//! Legality tables shared by `resolve.rs` (emit) and `validate.rs` (reject).
//!
//! `resolve.rs:116` used to accept only `AttributeValue::String` for
//! `onDelete`, silently discarding the idiomatic bare-identifier form
//! (`AttributeValue::Reference`) that the parser actually produces for
//! `onDelete: Cascade`. Extracting the domain here — instead of leaving it
//! implicit inside the resolver — makes that kind of accept/reject
//! divergence structurally impossible: both passes read the same table.
//!
//! Phase 3 (`fix-compiler-correctness`) extends this module with the
//! attribute whitelist/arity/argtype table consumed by `validate.rs`. It is
//! DERIVED from what `resolve.rs`/`validate.rs` consume
//! (`resolve.rs:19,23,27,63,64,67,79,113,237,238`, `validate.rs:49,68,90`),
//! not invented. Anything outside it — `@@id`, `@updatedAt`, `@@ignore`, an
//! unknown `@relation` named arg — compiled silently before Phase 3 and is
//! now a hard `ValidationError` (see `release-notes.md`).

use crate::ast::AttributeValue;

/// Referential actions accepted for `onDelete` / `onUpdate`
/// (`@relation(onDelete: ..., onUpdate: ...)`), PascalCase, case-sensitive —
/// Prisma's vocabulary. Paired with the exact SQL-ready text the compiler
/// hands to `packages/migrator`, which interpolates it verbatim into
/// executed DDL (`migrate.ts:88`, `postgres.ts:136`) with no translation of
/// its own. `Cascade`/`Restrict` survive naive-uppercase passthrough only
/// because SQL keywords are case-insensitive; `SetNull`, `SetDefault` and
/// `NoAction` do NOT — they need the two-word spelling or the migrator
/// would emit invalid SQL.
pub const REFERENTIAL_ACTIONS: [(&str, &str); 5] = [
    ("Cascade", "CASCADE"),
    ("Restrict", "RESTRICT"),
    ("SetNull", "SET NULL"),
    ("SetDefault", "SET DEFAULT"),
    ("NoAction", "NO ACTION"),
];

/// Maps a schema-spelled referential action (e.g. `"Cascade"`) to its
/// SQL-ready text (e.g. `"CASCADE"`). `None` for anything outside the
/// domain — resolving an invalid value into the IR is a Phase 3 validation
/// error (`validate.rs`), not this function's job; this function only ever
/// hands out members of the closed, SQL-valid set.
pub fn action_sql(name: &str) -> Option<&'static str> {
    REFERENTIAL_ACTIONS.iter().find(|(schema_name, _)| *schema_name == name).map(|(_, sql)| *sql)
}

/// Which kind of AST node an attribute is declared on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttributeTarget {
    Field,
    Model,
    EnumValue,
}

/// Arity/argument-shape contract for a recognized attribute. `Default` and
/// `Relation` need bespoke checks that `validate.rs` implements directly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArgShape {
    /// No arguments (`@id`, `@unique`, `@@realtime`).
    None,
    /// Exactly one positional string (`@map("x")`, `@note("x")`).
    OneString,
    /// Exactly one positional reference array (`@@index([a, b])`).
    OneReferenceArray,
    /// Literal type must match the field's scalar type; generator calls and
    /// enum-typed bare references are always accepted.
    Default,
    /// Named args only, keys checked against `RELATION_ARG_KEYS`.
    Relation,
}

/// `(target, attribute name, shape)` — every attribute recognized anywhere
/// in the language. Every attribute in `fixtures/*.indigo` is covered.
pub const ATTRIBUTE_RULES: &[(AttributeTarget, &str, ArgShape)] = &[
    (AttributeTarget::Field, "id", ArgShape::None),
    (AttributeTarget::Field, "unique", ArgShape::None),
    (AttributeTarget::Field, "map", ArgShape::OneString),
    (AttributeTarget::Field, "note", ArgShape::OneString),
    (AttributeTarget::Field, "default", ArgShape::Default),
    (AttributeTarget::Field, "relation", ArgShape::Relation),
    (AttributeTarget::Model, "realtime", ArgShape::None),
    (AttributeTarget::Model, "map", ArgShape::OneString),
    (AttributeTarget::Model, "note", ArgShape::OneString),
    (AttributeTarget::Model, "index", ArgShape::OneReferenceArray),
    (AttributeTarget::Model, "unique", ArgShape::OneReferenceArray),
    (AttributeTarget::EnumValue, "map", ArgShape::OneString),
];

/// `None` means `name` is not recognized on `target` at all.
pub fn attribute_rule(target: AttributeTarget, name: &str) -> Option<ArgShape> {
    ATTRIBUTE_RULES.iter().find(|(t, n, _)| *t == target && *n == name).map(|(.., s)| *s)
}

/// `@relation` named-argument keys. A misspelled key (e.g. `onDlete`) was a
/// silent no-op before this change — the exact failure mode it exists to kill.
pub const RELATION_ARG_KEYS: [&str; 4] = ["fields", "references", "onDelete", "onUpdate"];

/// Generator calls always accepted as a `@default(...)` value, regardless
/// of the field's scalar type (`resolve.rs::resolve_default` passthrough).
pub const DEFAULT_GENERATOR_FUNCTIONS: [&str; 4] = ["autoincrement", "now", "uuid", "cuid"];

/// The only supported `datasource.provider` value — unrelated to
/// `generator.provider` (`"indigodb-client-ts"`), a different AST node.
pub const DATASOURCE_PROVIDER: &str = "postgresql";

/// Whether a `@default` literal matches `scalar_type`. Only judges literal
/// values; generator calls and enum references are handled by the caller.
/// `DateTime`/`Json`/`BigInt`/`Bytes` have no literal syntax yet — only a
/// generator call is a valid default for those types.
pub fn default_literal_matches(scalar_type: &str, value: &AttributeValue) -> bool {
    matches!(
        (scalar_type, value),
        ("String", AttributeValue::String { .. })
            | ("Int" | "Float" | "Decimal", AttributeValue::Number { .. })
            | ("Boolean", AttributeValue::Boolean { .. })
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_domain_value() {
        assert_eq!(action_sql("Cascade"), Some("CASCADE"));
        assert_eq!(action_sql("Restrict"), Some("RESTRICT"));
        assert_eq!(action_sql("SetNull"), Some("SET NULL"));
        assert_eq!(action_sql("SetDefault"), Some("SET DEFAULT"));
        assert_eq!(action_sql("NoAction"), Some("NO ACTION"));
    }

    #[test]
    fn rejects_unknown_and_lowercase_values() {
        assert_eq!(action_sql("Nonsense"), None);
        assert_eq!(action_sql("cascade"), None);
    }

    #[test]
    fn attribute_rule_distinguishes_targets() {
        assert!(attribute_rule(AttributeTarget::Field, "id").is_some());
        assert!(attribute_rule(AttributeTarget::Model, "id").is_none());
        assert!(attribute_rule(AttributeTarget::Model, "index").is_some());
        assert!(attribute_rule(AttributeTarget::EnumValue, "map").is_some());
        assert!(attribute_rule(AttributeTarget::Field, "uniqe").is_none());
    }

    #[test]
    fn default_literal_matches_checks_scalar_type() {
        assert!(default_literal_matches("String", &AttributeValue::String { value: "x".into() }));
        assert!(default_literal_matches("Int", &AttributeValue::Number { value: 1.0 }));
        assert!(!default_literal_matches("Int", &AttributeValue::String { value: "nope".into() }));
    }
}
