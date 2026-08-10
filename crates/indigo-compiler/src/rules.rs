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
//! attribute whitelist/arity/argtype table consumed by `validate.rs`.

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
}
