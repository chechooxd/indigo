//! AST types — serde mirror of `@indigodb/ast`.
//!
//! Field order and serde attributes ARE the wire contract: serialized JSON
//! must deep-equal what the TS parser produced (camelCase keys, absent keys
//! for `undefined`). Do not reorder or rename without checking the parity
//! harness.

use serde::{Deserialize, Serialize};

/// Built-in scalar type names (`SCALAR_TYPES` in @indigodb/ast).
pub const SCALAR_TYPES: [&str; 9] = [
    "String", "Int", "Float", "Boolean", "DateTime", "Json", "BigInt", "Bytes", "Decimal",
];

pub fn is_scalar(name: &str) -> bool {
    SCALAR_TYPES.contains(&name)
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AttributeValue {
    String { value: String },
    Number { value: f64 },
    Boolean { value: bool },
    Reference { value: String },
    Function { name: String, args: Vec<AttributeValue> },
    Array { values: Vec<AttributeValue> },
}

impl AttributeValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            AttributeValue::String { value } => Some(value),
            _ => None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AttributeArg {
    /// Empty string for positional arguments (TS convention).
    pub name: String,
    pub value: AttributeValue,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Attribute {
    pub name: String,
    pub args: Vec<AttributeArg>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FieldType {
    pub name: String,
    pub scalar: bool,
    pub list: bool,
    pub optional: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Field {
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: FieldType,
    pub attributes: Vec<Attribute>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Model {
    pub name: String,
    pub fields: Vec<Field>,
    pub attributes: Vec<Attribute>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TableGroup {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub color: Option<String>,
    pub tables: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct EnumValue {
    pub name: String,
    pub attributes: Vec<Attribute>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Enum {
    pub name: String,
    pub values: Vec<EnumValue>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Datasource {
    pub name: String,
    pub provider: String,
    pub url: AttributeValue,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Generator {
    pub name: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub output: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Schema {
    pub datasources: Vec<Datasource>,
    pub generators: Vec<Generator>,
    pub models: Vec<Model>,
    pub enums: Vec<Enum>,
    pub table_groups: Vec<TableGroup>,
}

// ─── Attribute helpers (port of core/attributes.ts, internal) ────────────────

pub fn get_attr<'a>(attributes: &'a [Attribute], name: &str) -> Option<&'a Attribute> {
    attributes.iter().find(|a| a.name == name)
}

pub fn has_attr(attributes: &[Attribute], name: &str) -> bool {
    attributes.iter().any(|a| a.name == name)
}

pub fn positional_arg(attr: Option<&Attribute>, index: usize) -> Option<&AttributeArg> {
    attr?.args.iter().filter(|a| a.name.is_empty()).nth(index)
}

pub fn named_arg<'a>(attr: Option<&'a Attribute>, name: &str) -> Option<&'a AttributeValue> {
    attr?.args.iter().find(|a| a.name == name).map(|a| &a.value)
}

pub fn as_string(value: Option<&AttributeValue>) -> Option<String> {
    value?.as_str().map(|s| s.to_string())
}

/// `[a, b]` (references or strings) → `["a", "b"]`; anything else → `[]`.
pub fn as_reference_list(value: Option<&AttributeValue>) -> Vec<String> {
    let Some(AttributeValue::Array { values }) = value else {
        return Vec::new();
    };
    values
        .iter()
        .filter_map(|v| match v {
            AttributeValue::Reference { value } | AttributeValue::String { value } => {
                Some(value.clone())
            }
            _ => None,
        })
        .collect()
}

/// First positional string of an attribute (`@note("hi")` → `"hi"`).
pub fn first_string(attr: Option<&Attribute>) -> Option<String> {
    as_string(positional_arg(attr, 0).map(|a| &a.value))
}
