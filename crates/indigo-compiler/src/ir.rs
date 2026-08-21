//! Relational IR — serde mirror of `@indigodb/core`'s `ir.ts`.
//!
//! `ResolvedSchema` is THE contract every TS consumer reads (studio-server
//! serves it over HTTP, migration snapshots persist it). Struct field order
//! follows the object literals in `resolve.ts` and every optional uses
//! `skip_serializing_if` so absent keys match TS `undefined` after
//! `JSON.stringify`.

use serde::{Deserialize, Serialize};

use crate::ast::Datasource;

/// Literal default value: string, number or boolean (untagged like TS).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(untagged)]
pub enum LiteralValue {
    Boolean(bool),
    Number(f64),
    String(String),
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ResolvedDefault {
    Value { value: LiteralValue },
    Function { name: String },
}

/// A `@db.X(args)` override of the physical column type, structured so the
/// migrator (not the compiler) owns SQL-dialect rendering (design decision
/// #5). `args` are already stringified — see `resolve.rs::resolve_column`'s
/// integral-formatting fix for `AttributeValue::Number` (design decision #6).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ResolvedNativeType {
    pub name: String,
    pub args: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedColumn {
    pub name: String,
    pub db_name: String,
    #[serde(rename = "type")]
    pub column_type: String,
    pub is_enum: bool,
    pub nullable: bool,
    pub is_pk: bool,
    pub unique: bool,
    pub autoincrement: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub default: Option<ResolvedDefault>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub note: Option<String>,
    /// Present only when the field carried a validated `@db.X` attribute.
    /// Appended AFTER `note` so pre-existing snapshot key order is untouched.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub native_type: Option<ResolvedNativeType>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    /// SQL-ready text (`"CASCADE"`, `"SET NULL"`, ...) — see `rules::action_sql`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub on_delete: Option<String>,
    /// Resolved into the IR but not yet rendered as DDL by
    /// `packages/migrator` — tracked incompleteness, follow-up:
    /// `fix-migrator-correctness`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub on_update: Option<String>,
}

/// Postgres index access method for `@@index`/`@@unique`'s `type:` argument
/// (design decision #3). `Btree` is kept in the enum so `type: btree` is
/// accepted rather than rejected as "unknown method" — see decision #4 for
/// why it canonicalizes to `None` once `resolve.rs` populates the IR
/// (PR B; deliberately unpopulated in PR A).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IndexMethod {
    Btree,
    Gin,
    Gist,
    Hash,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ResolvedIndex {
    pub columns: Vec<String>,
    pub unique: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    /// Postgres index access method (`@@index`/`@@unique`'s `type:` arg).
    /// Declared LAST (after `name`) and always omitted when absent — an
    /// explicit `type: btree` canonicalizes to `None` in `resolve.rs`
    /// (design decision #4/#5), so pre-existing fixtures 01-15 stay
    /// byte-identical.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none", default)]
    pub index_type: Option<IndexMethod>,
}

/// Serialized as the bare variant name ("OneToOne" etc.), like the TS enum.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub enum RelationType {
    OneToOne,
    OneToMany,
    ManyToMany,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRelation {
    pub name: String,
    pub target_model: String,
    #[serde(rename = "type")]
    pub relation_type: RelationType,
    pub list: bool,
    pub optional: bool,
    /// On an inverse side (`inverse: Some(true)`) these are populated from the
    /// paired counterpart's FK/reference columns, which live on the OTHER
    /// table — not on this relation's own owning table.
    pub fk_columns: Vec<String>,
    pub ref_columns: Vec<String>,
    /// The positional `@relation("Name", ...)` literal, when declared.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub relation_name: Option<String>,
    /// `true` or absent — never `false` (parity with `realtime`). Set by the
    /// cross-model pairing pass on the inverse side of a resolved pair.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub inverse: Option<bool>,
}

/// Canonical `@@allow` action (never the `write`/`all` alias — those are
/// expanded by `resolve.rs` at resolve time, design decision #6). Serialized
/// as the bare lowercase name, matching `rules::ALLOW_ACTIONS`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AllowAction {
    Create,
    Read,
    Update,
    Delete,
}

/// One side of a resolved `@@allow` equality condition. `Field` always
/// carries the physical `dbName` (design decision #7), never the logical
/// field name, so a `@map` rename remaps allow rules for free on the
/// migrator side (`remapPhysicalNames`). No cast text is emitted here — the
/// migrator derives it from the referenced column's SQL type (decision #8).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AllowOperand {
    Field { name: String },
    /// Always `"userId"` in slice 1 — the closed claim vocabulary
    /// (`rules::AUTH_CLAIMS`).
    Claim { name: String },
    String { value: String },
    Number { value: f64 },
    Boolean { value: bool },
}

/// One resolved `@@allow` rule, already expanded from any `write`/`all`
/// alias into a single canonical action. Operand order follows declaration
/// order in the schema — the compiler never normalizes sides.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AllowRule {
    pub action: AllowAction,
    pub left: AllowOperand,
    pub right: AllowOperand,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTable {
    pub name: String,
    pub db_name: String,
    pub columns: Vec<ResolvedColumn>,
    pub primary_key: Vec<String>,
    pub foreign_keys: Vec<ForeignKey>,
    pub indexes: Vec<ResolvedIndex>,
    pub relations: Vec<ResolvedRelation>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub note: Option<String>,
    /// `true` or absent — never `false` (parity with resolve.ts).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub realtime: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub group: Option<String>,
    /// Resolved `@@allow` rules, one entry per canonical action after alias
    /// expansion. Declared LAST and always omitted (not `null`) when the
    /// model has no `@@allow`, so every pre-existing fixture snapshot stays
    /// byte-identical (design.md's IR field-order rule).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub allow: Option<Vec<AllowRule>>,
}

/// A single enum member, name plus its physical (`@map`) label.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedEnumMember {
    pub name: String,
    pub db_name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ResolvedEnum {
    pub name: String,
    pub values: Vec<String>,
    /// Additive alongside `values` — `values` keeps its four existing
    /// consumers (`postgres.ts`, `migrate.ts`, `client.ts`,
    /// `schema-adapter.ts`) untouched. `members` reaches the IR but the
    /// migrator still renders `values` only — tracked incompleteness,
    /// follow-up: `fix-migrator-correctness`.
    pub members: Vec<ResolvedEnumMember>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ResolvedTableGroup {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub color: Option<String>,
    pub tables: Vec<String>,
}

/// Field order matches the return literal in resolve.ts:
/// `{ tables, tableGroups, enums, datasource }`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSchema {
    pub tables: Vec<ResolvedTable>,
    pub table_groups: Vec<ResolvedTableGroup>,
    pub enums: Vec<ResolvedEnum>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub datasource: Option<Datasource>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ValidationError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub field: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(native_type: Option<ResolvedNativeType>) -> ResolvedColumn {
        ResolvedColumn {
            name: "bio".into(),
            db_name: "bio".into(),
            column_type: "String".into(),
            is_enum: false,
            nullable: false,
            is_pk: false,
            unique: false,
            autoincrement: false,
            default: None,
            note: None,
            native_type,
        }
    }

    #[test]
    fn native_type_serializes_after_note_when_present() {
        let c = column(Some(ResolvedNativeType { name: "VarChar".into(), args: vec!["255".into()] }));
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains(r#""nativeType":{"name":"VarChar","args":["255"]}"#));
        // `note` (absent here) is skipped, but `nativeType` must be the LAST
        // key present, per the struct's field order (appended after `note`).
        assert!(json.ends_with(r#""nativeType":{"name":"VarChar","args":["255"]}}"#));
    }

    #[test]
    fn native_type_is_omitted_not_null_when_absent() {
        let c = column(None);
        let json = serde_json::to_string(&c).unwrap();
        assert!(!json.contains("nativeType"));
    }

    #[test]
    fn index_method_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&IndexMethod::Btree).unwrap(), "\"btree\"");
        assert_eq!(serde_json::to_string(&IndexMethod::Gin).unwrap(), "\"gin\"");
        assert_eq!(serde_json::to_string(&IndexMethod::Gist).unwrap(), "\"gist\"");
        assert_eq!(serde_json::to_string(&IndexMethod::Hash).unwrap(), "\"hash\"");
    }

    fn table(allow: Option<Vec<AllowRule>>) -> ResolvedTable {
        ResolvedTable {
            name: "Post".into(),
            db_name: "Post".into(),
            columns: vec![],
            primary_key: vec![],
            foreign_keys: vec![],
            indexes: vec![],
            relations: vec![],
            note: None,
            realtime: None,
            color: None,
            group: Some("Content".into()),
            allow,
        }
    }

    #[test]
    fn allow_is_omitted_not_null_when_absent() {
        let json = serde_json::to_string(&table(None)).unwrap();
        assert!(!json.contains("allow"));
    }

    #[test]
    fn allow_serializes_after_group_when_present() {
        let rule = AllowRule {
            action: AllowAction::Read,
            left: AllowOperand::Claim { name: "userId".into() },
            right: AllowOperand::Field { name: "ownerId".into() },
        };
        let json = serde_json::to_string(&table(Some(vec![rule]))).unwrap();
        assert!(json.contains(r#""group":"Content""#));
        // `allow` must be the LAST key present, declared after `group`.
        assert!(json.ends_with(
            r#""allow":[{"action":"read","left":{"kind":"claim","name":"userId"},"right":{"kind":"field","name":"ownerId"}}]}"#
        ));
    }

    #[test]
    fn allow_action_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&AllowAction::Create).unwrap(), "\"create\"");
        assert_eq!(serde_json::to_string(&AllowAction::Read).unwrap(), "\"read\"");
        assert_eq!(serde_json::to_string(&AllowAction::Update).unwrap(), "\"update\"");
        assert_eq!(serde_json::to_string(&AllowAction::Delete).unwrap(), "\"delete\"");
    }
}
