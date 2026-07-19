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
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub on_delete: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ResolvedIndex {
    pub columns: Vec<String>,
    pub unique: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
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
    pub fk_columns: Vec<String>,
    pub ref_columns: Vec<String>,
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
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ResolvedEnum {
    pub name: String,
    pub values: Vec<String>,
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
