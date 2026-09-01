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
use crate::ir::IndexMethod;

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
    /// No arguments (`@id`, `@unique`).
    None,
    /// Exactly one positional string (`@map("x")`, `@note("x")`).
    OneString,
    /// Exactly one positional reference array, plus optional named `name`/
    /// `type` args (`@@index([a, b], name: "x", type: gin)`). Replaces
    /// `OneReferenceArray` — `@@index`/`@@unique` were its only users
    /// (design decision #1); the "requires exactly one array argument"
    /// message is preserved verbatim for parity.
    Index,
    /// Literal type must match the field's scalar type; generator calls and
    /// enum-typed bare references are always accepted.
    Default,
    /// Named args only, keys checked against `RELATION_ARG_KEYS`.
    Relation,
    /// `@@allow(action, condition)`: positional 0 is a bare reference
    /// (`read`) or a reference array (`[create, update]`); positional 1 is
    /// a single equality `Comparison`. No named args. `validate.rs` owns
    /// the deep checks (action vocabulary, claim vocabulary, path shape);
    /// this shape only gates arity + the coarse argument kind.
    Allow,
    /// `@@realtime` / `@@realtime(columns: [a, b])`: zero positional
    /// arguments, plus an optional named `columns` argument whose value is a
    /// reference array (`realtime-column-projection` design decision #1).
    /// A *named-only* optional argument is the only shape where adding an
    /// argument cannot alter the bare zero-arg form — a misspelled key
    /// (`cols:`) is a hard error rather than a silent no-op. `validate.rs`
    /// owns the deep checks (field existence, scalar-ness, duplicates);
    /// this shape only gates arity + the coarse argument kind.
    Realtime,
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
    (AttributeTarget::Model, "realtime", ArgShape::Realtime),
    (AttributeTarget::Model, "map", ArgShape::OneString),
    (AttributeTarget::Model, "note", ArgShape::OneString),
    (AttributeTarget::Model, "index", ArgShape::Index),
    (AttributeTarget::Model, "unique", ArgShape::Index),
    (AttributeTarget::Model, "allow", ArgShape::Allow),
    (AttributeTarget::EnumValue, "map", ArgShape::OneString),
];

/// Closed `@@allow` action vocabulary, 1:1 with INSERT/SELECT/UPDATE/DELETE
/// (proposal Scope; design Interfaces).
pub const ALLOW_ACTIONS: [&str; 4] = ["create", "read", "update", "delete"];

/// Sugar actions that expand to their canonical set at resolve time
/// (design decision 6): `write` = create/update/delete, `all` = every
/// action, both in declaration order.
pub const ALLOW_ALIASES: [(&str, &[&str]); 2] =
    [("write", &["create", "update", "delete"]), ("all", &ALLOW_ACTIONS)];

/// Closed `auth.<claim>` vocabulary — `auth.userId` only in this slice
/// (design decision 9 / proposal resolved question 6). Any other claim is a
/// hard, located compiler error.
pub const AUTH_CLAIMS: [&str; 1] = ["userId"];

/// The single Postgres `current_setting` key `auth.userId` binds to, set by
/// `$auth({ userId })` via `set_config('app.user_id', $1, true)` (design
/// decision 15).
pub const AUTH_SETTING: &str = "app.user_id";

/// `None` means `name` is not recognized on `target` at all.
pub fn attribute_rule(target: AttributeTarget, name: &str) -> Option<ArgShape> {
    ATTRIBUTE_RULES.iter().find(|(t, n, _)| *t == target && *n == name).map(|(.., s)| *s)
}

/// `@relation` named-argument keys. A misspelled key (e.g. `onDlete`) was a
/// silent no-op before this change — the exact failure mode it exists to kill.
pub const RELATION_ARG_KEYS: [&str; 4] = ["fields", "references", "onDelete", "onUpdate"];

/// `@@index`/`@@unique` named-argument keys (design decision #1/#3).
pub const INDEX_ARG_KEYS: [&str; 2] = ["name", "type"];

/// `@@realtime` named-argument keys (`realtime-column-projection` design
/// decision #1). `columns` is exclusive to `@@realtime`: it is absent from
/// `INDEX_ARG_KEYS`/`RELATION_ARG_KEYS`, so `@@index([a], columns: [b])`
/// already errors via the existing closed-key machinery.
pub const REALTIME_ARG_KEYS: [&str; 1] = ["columns"];

/// Closed set of Postgres index access methods accepted by `type:`
/// (proposal open assumption #1 — no `brin`/`spgist` yet).
pub const INDEX_METHODS: [&str; 4] = ["btree", "gin", "gist", "hash"];

/// `NAMEDATALEN` — Postgres silently truncates identifiers longer than this,
/// which would break a later `DROP`/`RENAME` round-trip keyed on the full
/// name (design decision #10).
pub const MAX_IDENTIFIER_BYTES: usize = 63;

/// Maps a schema-spelled index method (lowercase bare identifier or quoted
/// string, e.g. `"gin"`) to its `IndexMethod` variant. `None` for anything
/// outside the closed set — resolving an invalid value is a validation
/// error (`validate.rs`), not this function's job.
pub fn index_method(name: &str) -> Option<IndexMethod> {
    match name {
        "btree" => Some(IndexMethod::Btree),
        "gin" => Some(IndexMethod::Gin),
        "gist" => Some(IndexMethod::Gist),
        "hash" => Some(IndexMethod::Hash),
        _ => None,
    }
}

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

/// Argument-shape contract for a native type's positional args — every
/// argument in a `@db.X(...)` call is an integral number (`VarChar(255)`,
/// `Numeric(10, 2)`); no string/bool/reference args exist in this domain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeTypeArity {
    /// No arguments (`@db.Uuid`).
    Zero,
    /// Exactly one integral argument (`@db.VarChar(255)`).
    One,
    /// Zero OR exactly two integral arguments (`@db.Numeric` / `@db.Numeric(10, 2)`).
    ZeroOrTwo,
}

/// `(native type name, valid scalar types, arity)` — the PR B compatibility
/// matrix (design.md's "Compatibility Matrix"), checked by `validate.rs`
/// from `validate_attributes` before the existing bare-name `attribute_rule`
/// lookup. Lives next to `ATTRIBUTE_RULES`, same shape/lookup pattern.
pub const NATIVE_TYPE_RULES: &[(&str, &[&str], NativeTypeArity)] = &[
    ("VarChar", &["String"], NativeTypeArity::One),
    ("Uuid", &["String"], NativeTypeArity::Zero),
    ("Numeric", &["Decimal", "Float"], NativeTypeArity::ZeroOrTwo),
];

/// `None` means `name` is not a recognized native type at all (e.g. `@db.Foo`).
pub fn native_type_rule(name: &str) -> Option<(&'static [&'static str], NativeTypeArity)> {
    NATIVE_TYPE_RULES.iter().find(|(n, ..)| *n == name).map(|(_, scalars, arity)| (*scalars, *arity))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_type_rule_matches_the_compatibility_matrix() {
        let (scalars, arity) = native_type_rule("VarChar").expect("VarChar is a known native type");
        assert_eq!(scalars, &["String"]);
        assert_eq!(arity, NativeTypeArity::One);

        let (scalars, arity) = native_type_rule("Uuid").expect("Uuid is a known native type");
        assert_eq!(scalars, &["String"]);
        assert_eq!(arity, NativeTypeArity::Zero);

        let (scalars, arity) = native_type_rule("Numeric").expect("Numeric is a known native type");
        assert_eq!(scalars, &["Decimal", "Float"]);
        assert_eq!(arity, NativeTypeArity::ZeroOrTwo);
    }

    #[test]
    fn native_type_rule_rejects_unknown_names() {
        assert_eq!(native_type_rule("Foo"), None);
    }

    #[test]
    fn index_method_accepts_every_closed_spelling() {
        use crate::ir::IndexMethod;
        assert_eq!(index_method("btree"), Some(IndexMethod::Btree));
        assert_eq!(index_method("gin"), Some(IndexMethod::Gin));
        assert_eq!(index_method("gist"), Some(IndexMethod::Gist));
        assert_eq!(index_method("hash"), Some(IndexMethod::Hash));
    }

    #[test]
    fn index_method_rejects_unknown_and_uppercase_spellings() {
        assert_eq!(index_method("brin"), None);
        assert_eq!(index_method("GIN"), None);
        assert_eq!(index_method(""), None);
    }

    #[test]
    fn arg_shape_index_replaces_one_reference_array_for_index_and_unique() {
        // @@index/@@unique were OneReferenceArray's only users; ArgShape::Index
        // must now be what attribute_rule reports for both.
        assert_eq!(attribute_rule(AttributeTarget::Model, "index"), Some(ArgShape::Index));
        assert_eq!(attribute_rule(AttributeTarget::Model, "unique"), Some(ArgShape::Index));
    }

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

    #[test]
    fn attribute_rules_carries_allow_on_model_with_allow_arg_shape() {
        assert_eq!(attribute_rule(AttributeTarget::Model, "allow"), Some(ArgShape::Allow));
    }

    #[test]
    fn allow_actions_are_the_closed_crud_vocabulary() {
        assert_eq!(ALLOW_ACTIONS, ["create", "read", "update", "delete"]);
    }

    #[test]
    fn allow_aliases_expand_write_and_all() {
        let write = ALLOW_ALIASES.iter().find(|(name, _)| *name == "write").expect("write alias");
        assert_eq!(write.1, &["create", "update", "delete"]);
        let all = ALLOW_ALIASES.iter().find(|(name, _)| *name == "all").expect("all alias");
        assert_eq!(all.1, &ALLOW_ACTIONS);
    }

    #[test]
    fn auth_claims_is_closed_to_user_id() {
        assert_eq!(AUTH_CLAIMS, ["userId"]);
    }

    #[test]
    fn auth_setting_is_app_user_id() {
        assert_eq!(AUTH_SETTING, "app.user_id");
    }
}
