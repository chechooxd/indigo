//! Resolver — line-by-line port of `packages/core/src/resolve.ts`.
//!
//! Produces the `ResolvedSchema` IR from a parsed `Schema`. Behavior must
//! deep-equal the TS implementation (the parity harness is the referee);
//! notable quirks preserved:
//! - `realtime` is `Some(true)` or absent, never `Some(false)`;
//! - `ForeignKey.name` is never emitted; `ResolvedIndex.name`/`.indexType`
//!   are emitted only when the schema declares an explicit `name:`/`type:`
//!   on `@@index`/`@@unique` — an omitted `name:` stays `None` (the
//!   auto-derived `${table}_${cols}_${suffix}` fallback remains a
//!   migrator-side concern), and `type: btree` canonicalizes to `None`;
//! - a singular inverse-side relation without a FK is always `OneToOne`;
//! - unknown `@relation` refs fall back to the raw name (`.get(r) ?? r`);
//! - scalar/enum list fields become plain columns (list-ness dropped);
//! - `datasource` is the first datasource block only.

use std::collections::HashMap;

use crate::ast::*;
use crate::ir::*;

/// `pub(crate)`: `validate.rs::validate_index_args` also needs the physical
/// table name to replicate `migrate.ts::indexName`'s derived-name formula
/// for collision detection (design decision #6).
pub(crate) fn table_db_name(model: &Model) -> String {
    first_string(get_attr(&model.attributes, "map")).unwrap_or_else(|| model.name.clone())
}

/// `pub(crate)`: see `table_db_name`.
pub(crate) fn field_db_name(field: &Field) -> String {
    first_string(get_attr(&field.attributes, "map")).unwrap_or_else(|| field.name.clone())
}

fn resolve_default(field: &Field) -> Option<ResolvedDefault> {
    let attr = get_attr(&field.attributes, "default")?;
    let value = attr.args.iter().find(|a| a.name.is_empty()).map(|a| &a.value)?;

    match value {
        AttributeValue::String { value } => Some(ResolvedDefault::Value {
            value: LiteralValue::String(value.clone()),
        }),
        AttributeValue::Number { value } => Some(ResolvedDefault::Value {
            value: LiteralValue::Number(*value),
        }),
        AttributeValue::Boolean { value } => Some(ResolvedDefault::Value {
            value: LiteralValue::Boolean(*value),
        }),
        AttributeValue::Function { name, .. } => {
            Some(ResolvedDefault::Function { name: name.clone() })
        }
        // e.g. `@default(USER)` for an enum member.
        AttributeValue::Reference { value } => Some(ResolvedDefault::Value {
            value: LiteralValue::String(value.clone()),
        }),
        AttributeValue::Array { .. } => None,
        // `@default` never carries a path or comparison; only `@@allow`
        // accepts those (validated in `validate.rs`).
        AttributeValue::Path { .. } | AttributeValue::Comparison { .. } => None,
    }
}

/// Formats a `@db.X(...)` numeric argument for the IR. `AttributeValue::Number`
/// is `f64`, but every native-type argument in the language (`VarChar(255)`,
/// `Numeric(10, 2)`) is logically an integer — CRITICAL: bare `f64::to_string()`
/// would silently corrupt the IR (`"255.0"` instead of `"255"`), producing
/// invalid DDL downstream. Integral values format via `i64`; anything else
/// (should not occur post-validation) falls back to the raw `f64` text
/// (design decision #6).
fn format_native_type_arg(value: f64) -> String {
    if value.fract() == 0.0 && value.is_finite() {
        (value as i64).to_string()
    } else {
        value.to_string()
    }
}

/// Populates `ResolvedColumn.native_type` from a validated `@db.X` attribute.
/// Only ever called with an attribute that already passed `validate.rs`'s
/// compatibility matrix — an unrecognized name or incompatible scalar is a
/// hard validation error upstream, never silently dropped here.
fn resolve_native_type(field: &Field) -> Option<ResolvedNativeType> {
    let attr = field
        .attributes
        .iter()
        .find(|a| a.namespace.as_deref() == Some("db"))?;
    let args = attr
        .args
        .iter()
        .filter_map(|a| match &a.value {
            AttributeValue::Number { value } => Some(format_native_type_arg(*value)),
            _ => None,
        })
        .collect();
    Some(ResolvedNativeType { name: attr.name.clone(), args })
}

fn resolve_column(field: &Field, is_enum: bool) -> ResolvedColumn {
    let default = resolve_default(field);
    let autoincrement = matches!(
        &default,
        Some(ResolvedDefault::Function { name }) if name == "autoincrement"
    );
    ResolvedColumn {
        name: field.name.clone(),
        db_name: field_db_name(field),
        column_type: field.field_type.name.clone(),
        is_enum,
        list: field.field_type.list,
        nullable: field.field_type.optional,
        is_pk: has_attr(&field.attributes, "id"),
        unique: has_attr(&field.attributes, "unique"),
        autoincrement,
        default,
        note: first_string(get_attr(&field.attributes, "note")),
        native_type: resolve_native_type(field),
    }
}

/// Extracts a schema-spelled referential action from either its bare-identifier
/// form (`AttributeValue::Reference`, e.g. `onDelete: Cascade`) or its quoted
/// form (`AttributeValue::String`, e.g. `onDelete: "Cascade"`), then maps it
/// through `rules::action_sql`. Anything outside the closed domain resolves
/// to `None` — an invalid value is a validation error, not a resolved one.
fn resolve_action(value: Option<&AttributeValue>) -> Option<String> {
    let raw = match value {
        Some(AttributeValue::String { value }) => value.as_str(),
        Some(AttributeValue::Reference { value }) => value.as_str(),
        _ => return None,
    };
    crate::rules::action_sql(raw).map(str::to_string)
}

fn first_array_refs(attr: &Attribute) -> Vec<String> {
    let value = attr.args.iter().find(|a| a.name.is_empty()).map(|a| &a.value);
    as_reference_list(value)
}

/// Extracts `@@index`/`@@unique`'s `type:` argument (bare identifier OR
/// quoted string, decision #2) and maps it through `rules::index_method`.
/// An explicit `type: btree` canonicalizes to `None` (decision #4) so it
/// never falsely diffs against an implicit btree index; anything outside
/// the closed method set is `None` here too — an invalid value is a
/// `validate.rs` diagnostic, not this function's job.
fn resolve_index_type(attr: &Attribute) -> Option<IndexMethod> {
    let raw = match attr.args.iter().find(|a| a.name == "type").map(|a| &a.value) {
        Some(AttributeValue::Reference { value }) | Some(AttributeValue::String { value }) => {
            Some(value.as_str())
        }
        _ => None,
    }?;
    match crate::rules::index_method(raw)? {
        IndexMethod::Btree => None,
        method => Some(method),
    }
}

fn resolve_indexes(model: &Model, field_to_db: &HashMap<String, String>) -> Vec<ResolvedIndex> {
    let mut indexes = Vec::new();
    for attr in &model.attributes {
        if attr.name != "index" && attr.name != "unique" {
            continue;
        }
        let columns: Vec<String> = first_array_refs(attr)
            .into_iter()
            .map(|c| field_to_db.get(&c).cloned().unwrap_or(c))
            .collect();
        let r#where = match attr.args.iter().find(|a| a.name == "where").map(|a| &a.value) {
            Some(AttributeValue::String { value }) if !value.trim().is_empty() => {
                Some(value.trim().to_string())
            }
            _ => None,
        };
        let expression = match attr.args.iter().find(|a| a.name == "expression").map(|a| &a.value) {
            Some(AttributeValue::String { value }) if !value.trim().is_empty() => {
                Some(value.trim().to_string())
            }
            _ => None,
        };
        if columns.is_empty() && expression.is_none() {
            continue;
        }
        // Only an EXPLICIT `name:` is emitted here — omitted names stay
        // `None` (unchanged from before this change) so the auto-derived
        // `${table}_${cols}_${suffix}` formula remains a migrator-side
        // concern (`postgres.ts`/`migrate.ts`'s `index.name ?? derived`),
        // keeping fixtures 01-15's unnamed indexes byte-identical.
        let name = match attr.args.iter().find(|a| a.name == "name").map(|a| &a.value) {
            Some(AttributeValue::String { value }) => Some(value.clone()),
            _ => None,
        };
        indexes.push(ResolvedIndex {
            columns,
            unique: attr.name == "unique",
            name,
            index_type: resolve_index_type(attr),
            r#where,
            expression,
        });
    }
    indexes
}

fn resolve_relations(
    model: &Model,
    model_db_names: &HashMap<String, String>,
    field_db_names_by_model: &HashMap<String, HashMap<String, String>>,
) -> (Vec<ResolvedRelation>, Vec<ForeignKey>) {
    let mut relations = Vec::new();
    let mut foreign_keys = Vec::new();
    let local_field_db = &field_db_names_by_model[&model.name];

    for field in &model.fields {
        if is_scalar(&field.field_type.name) {
            continue;
        }
        // Skip enum-typed fields — those are columns, handled elsewhere.
        if !model_db_names.contains_key(&field.field_type.name) {
            continue;
        }

        let target_model = field.field_type.name.clone();
        let rel_attr = get_attr(&field.attributes, "relation");
        let relation_name = as_string(positional_arg(rel_attr, 0).map(|a| &a.value));
        let local_refs = as_reference_list(named_arg(rel_attr, "fields"));
        let target_refs = as_reference_list(named_arg(rel_attr, "references"));
        let on_delete = resolve_action(named_arg(rel_attr, "onDelete"));
        let on_update = resolve_action(named_arg(rel_attr, "onUpdate"));

        let holds_fk = !local_refs.is_empty();
        let fk_columns: Vec<String> = local_refs
            .iter()
            .map(|r| local_field_db.get(r).cloned().unwrap_or_else(|| r.clone()))
            .collect();
        let target_field_db = field_db_names_by_model.get(&target_model);
        let ref_columns: Vec<String> = target_refs
            .iter()
            .map(|r| {
                target_field_db
                    .and_then(|m| m.get(r).cloned())
                    .unwrap_or_else(|| r.clone())
            })
            .collect();

        // Cardinality: a list field is one-to-many; a singular FK-holding
        // field is one-to-one when the FK column is unique, else one-to-many.
        let relation_type = if field.field_type.list {
            RelationType::OneToMany
        } else if holds_fk {
            let fk_unique = local_refs.iter().any(|r| {
                model
                    .fields
                    .iter()
                    .find(|mf| &mf.name == r)
                    .map(|f| has_attr(&f.attributes, "unique"))
                    .unwrap_or(false)
            });
            if fk_unique { RelationType::OneToOne } else { RelationType::OneToMany }
        } else {
            RelationType::OneToOne
        };

        relations.push(ResolvedRelation {
            name: field.name.clone(),
            target_model: target_model.clone(),
            relation_type,
            list: field.field_type.list,
            optional: field.field_type.optional,
            fk_columns: fk_columns.clone(),
            ref_columns: ref_columns.clone(),
            relation_name,
            inverse: None,
        });

        if holds_fk && !ref_columns.is_empty() {
            foreign_keys.push(ForeignKey {
                columns: fk_columns,
                ref_table: model_db_names
                    .get(&target_model)
                    .cloned()
                    .unwrap_or(target_model),
                ref_columns,
                name: None,
                on_delete,
                on_update,
            });
        }
    }

    (relations, foreign_keys)
}

/// Extracts the action name(s) from `@@allow`'s first positional argument —
/// a bare reference (`read`) or a reference/string array (`[create, update]`)
/// — mirroring `validate.rs::allow_action_names`. By the time `resolve` runs
/// the schema already passed validation, so any other shape (already
/// reported there) simply resolves to no rules for this attribute.
fn allow_action_names(value: &AttributeValue) -> Vec<String> {
    match value {
        AttributeValue::Reference { value } => vec![value.clone()],
        AttributeValue::Array { values } => values
            .iter()
            .filter_map(|v| match v {
                AttributeValue::Reference { value } | AttributeValue::String { value } => {
                    Some(value.clone())
                }
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_allow_action(name: &str) -> Option<AllowAction> {
    match name {
        "create" => Some(AllowAction::Create),
        "read" => Some(AllowAction::Read),
        "update" => Some(AllowAction::Update),
        "delete" => Some(AllowAction::Delete),
        _ => None,
    }
}

/// Expands one accepted action name (canonical or `write`/`all` alias) to
/// its canonical action set, in declaration order (design decision #6).
/// Mirrors `validate.rs::canonical_actions_for`; unrecognized names (already
/// reported by `validate.rs`) yield no actions.
fn canonical_allow_actions_for(name: &str) -> Vec<AllowAction> {
    if let Some(action) = parse_allow_action(name) {
        return vec![action];
    }
    crate::rules::ALLOW_ALIASES
        .iter()
        .find(|(alias, _)| *alias == name)
        .map(|(_, expanded)| expanded.iter().filter_map(|a| parse_allow_action(a)).collect())
        .unwrap_or_default()
}

/// Resolves one side of a validated `@@allow` equality condition into its
/// IR operand. `this.<field>` resolves to the physical `dbName` (design
/// decision #7); `auth.<claim>` resolves to a `Claim`; literals pass through
/// unchanged. Any other shape cannot occur post-validation.
fn resolve_allow_operand(value: &AttributeValue, field_to_db: &HashMap<String, String>) -> AllowOperand {
    match value {
        AttributeValue::Path { segments } if segments.len() == 2 && segments[0] == "this" => {
            AllowOperand::Field {
                name: field_to_db.get(&segments[1]).cloned().unwrap_or_else(|| segments[1].clone()),
            }
        }
        AttributeValue::Path { segments } if segments.len() == 2 && segments[0] == "auth" => {
            AllowOperand::Claim { name: segments[1].clone() }
        }
        AttributeValue::String { value } => AllowOperand::String { value: value.clone() },
        AttributeValue::Number { value } => AllowOperand::Number { value: *value },
        AttributeValue::Boolean { value } => AllowOperand::Boolean { value: *value },
        // Anything else is a `validate.rs` diagnostic, never reached on a
        // schema that compiled successfully.
        _ => AllowOperand::String { value: String::new() },
    }
}

/// Resolves every `@@allow` attribute on a model into `ResolvedTable.allow`:
/// alias expansion (`write`/`all`) into canonical actions, operand
/// resolution to physical `dbName`, declaration order preserved across both
/// multiple `@@allow` attributes and multiple actions within one attribute
/// (design decision #6). `None` when the model declares no `@@allow`.
fn resolve_allow_rules(model: &Model, field_to_db: &HashMap<String, String>) -> Option<Vec<AllowRule>> {
    let mut rules_out: Vec<AllowRule> = Vec::new();

    for attr in &model.attributes {
        if attr.namespace.is_some() || attr.name != "allow" {
            continue;
        }
        let positional: Vec<&AttributeArg> = attr.args.iter().filter(|a| a.name.is_empty()).collect();
        if positional.len() != 2 {
            continue; // invalid arity — already a validate.rs diagnostic.
        }
        let AttributeValue::Comparison { left, right, .. } = &positional[1].value else {
            continue; // non-comparison condition — already a diagnostic.
        };
        let left_op = resolve_allow_operand(left, field_to_db);
        let right_op = resolve_allow_operand(right, field_to_db);

        for name in allow_action_names(&positional[0].value) {
            for action in canonical_allow_actions_for(&name) {
                rules_out.push(AllowRule { action, left: left_op.clone(), right: right_op.clone() });
            }
        }
    }

    if rules_out.is_empty() { None } else { Some(rules_out) }
}

/// Resolves `@@realtime(columns: [...])` into physical `dbName`s, in
/// declaration order (`realtime-column-projection` design decision 2/3).
/// `None` when `@@realtime` carries no `columns` argument at all — bare
/// `@@realtime` must stay byte-identical to today (RCP-1). `Some(vec![])`
/// is a distinct, valid state (RCP-7: `columns: []` is present-and-empty,
/// never omitted) — the empty-list path here needs no special case, since a
/// present-but-empty AST array resolves to an empty `Vec` naturally.
fn resolve_realtime_columns(model: &Model, field_to_db: &HashMap<String, String>) -> Option<Vec<String>> {
    let attr = get_attr(&model.attributes, "realtime")?;
    let value = named_arg(Some(attr), "columns")?;
    let names = as_reference_list(Some(value));
    Some(names.iter().map(|name| field_to_db.get(name).cloned().unwrap_or_else(|| name.clone())).collect())
}

pub fn resolve(schema: &Schema) -> ResolvedSchema {
    let enum_names: std::collections::HashSet<&str> =
        schema.enums.iter().map(|e| e.name.as_str()).collect();
    let mut model_db_names: HashMap<String, String> = HashMap::new();
    let mut field_db_names_by_model: HashMap<String, HashMap<String, String>> = HashMap::new();

    // Pass 1: physical name maps for cross-model FK references.
    for model in &schema.models {
        model_db_names.insert(model.name.clone(), table_db_name(model));
        let mut field_map = HashMap::new();
        for field in &model.fields {
            field_map.insert(field.name.clone(), field_db_name(field));
        }
        field_db_names_by_model.insert(model.name.clone(), field_map);
    }

    // Table group membership: each table inherits its group's color.
    let mut group_by_table: HashMap<&str, (&str, Option<&str>)> = HashMap::new();
    for group in &schema.table_groups {
        for table_name in &group.tables {
            group_by_table.insert(table_name, (&group.name, group.color.as_deref()));
        }
    }

    // Pass 2: build tables.
    let mut tables: Vec<ResolvedTable> = Vec::with_capacity(schema.models.len());
    for model in &schema.models {
        let field_to_db = &field_db_names_by_model[&model.name];

        let mut columns = Vec::new();
        let mut primary_key = Vec::new();
        for field in &model.fields {
            let is_scalar_type = is_scalar(&field.field_type.name);
            let is_enum_type = enum_names.contains(field.field_type.name.as_str());
            if !is_scalar_type && !is_enum_type {
                continue; // relation field, not a column
            }
            let column = resolve_column(field, is_enum_type);
            if column.is_pk {
                primary_key.push(column.db_name.clone());
            }
            columns.push(column);
        }

        let (relations, foreign_keys) =
            resolve_relations(model, &model_db_names, &field_db_names_by_model);

        let group = group_by_table.get(model.name.as_str());

        tables.push(ResolvedTable {
            name: model.name.clone(),
            db_name: model_db_names[&model.name].clone(),
            columns,
            primary_key,
            foreign_keys,
            indexes: resolve_indexes(model, field_to_db),
            relations,
            note: first_string(get_attr(&model.attributes, "note")),
            realtime: if has_attr(&model.attributes, "realtime") { Some(true) } else { None },
            color: group.and_then(|(_, c)| c.map(str::to_string)),
            group: group.map(|(name, _)| name.to_string()),
            allow: resolve_allow_rules(model, field_to_db),
            realtime_columns: resolve_realtime_columns(model, field_to_db),
        });
    }

    // Pass 3: cross-model relation pairing — populate each inverse side with
    // its counterpart's FK/reference columns and flag it `inverse: Some(true)`.
    pair_relations(&mut tables);

    ResolvedSchema {
        tables,
        table_groups: schema
            .table_groups
            .iter()
            .map(|g| ResolvedTableGroup {
                name: g.name.clone(),
                color: g.color.clone(),
                tables: g.tables.clone(),
            })
            .collect(),
        enums: schema
            .enums
            .iter()
            .map(|e| ResolvedEnum {
                name: e.name.clone(),
                values: e.values.iter().map(|v| v.name.clone()).collect(),
                members: e
                    .values
                    .iter()
                    .map(|v| ResolvedEnumMember {
                        name: v.name.clone(),
                        db_name: first_string(get_attr(&v.attributes, "map"))
                            .unwrap_or_else(|| v.name.clone()),
                    })
                    .collect(),
            })
            .collect(),
        datasource: schema.datasources.first().cloned(),
    }
}

/// A read-only projection of one relation field, used to compute pairing
/// writes without holding a live borrow into `tables` (see design.md's
/// "two-phase" decision: restructuring into a flat re-attached relation list
/// was rejected because it would disturb serde field order — the JSON
/// contract).
struct RelRef {
    table_idx: usize,
    rel_idx: usize,
    source: String,
    target: String,
    name: Option<String>,
    holds_fk: bool,
    fk_columns: Vec<String>,
    ref_columns: Vec<String>,
}

/// Cross-model relation pairing (design.md's "Pairing Algorithm"), per
/// unordered model pair `{A, B}` (self-relations: `A == B`; a field is never
/// its own inverse since holder/inverse partitioning is by distinct relation
/// field, never the same one):
///
/// 1. name-match: each named FK-holder pairs with the inverse carrying the
///    same name (0 or >1 candidates → left unresolved; validate.rs surfaces
///    the diagnostic, `resolve` never errors).
/// 2. implicit: remaining STRICTLY UNNAMED candidates pair iff exactly one
///    unnamed FK-holder and at most one unnamed inverse remain — naming
///    stays opt-in, so a named-but-unmatched holder must never silently fall
///    back to an implicit match (relation-identity spec: "Named relation
///    with no matching counterpart name").
///
/// Writes apply only to inverse sides (empty `fkColumns`); an FK-holder is
/// never overwritten.
fn pair_relations(tables: &mut [ResolvedTable]) {
    let mut all: Vec<RelRef> = Vec::new();
    for (ti, table) in tables.iter().enumerate() {
        for (ri, rel) in table.relations.iter().enumerate() {
            all.push(RelRef {
                table_idx: ti,
                rel_idx: ri,
                source: table.name.clone(),
                target: rel.target_model.clone(),
                name: rel.relation_name.clone(),
                holds_fk: !rel.fk_columns.is_empty(),
                fk_columns: rel.fk_columns.clone(),
                ref_columns: rel.ref_columns.clone(),
            });
        }
    }

    let mut groups: HashMap<(String, String), Vec<usize>> = HashMap::new();
    for (i, rel) in all.iter().enumerate() {
        let mut pair = [rel.source.clone(), rel.target.clone()];
        pair.sort();
        groups.entry((pair[0].clone(), pair[1].clone())).or_default().push(i);
    }

    let mut writes: Vec<(usize, usize, Vec<String>, Vec<String>)> = Vec::new();

    for indices in groups.values() {
        let holder_idxs: Vec<usize> = indices.iter().copied().filter(|&i| all[i].holds_fk).collect();
        let inverse_idxs: Vec<usize> = indices.iter().copied().filter(|&i| !all[i].holds_fk).collect();

        let mut consumed_holders: std::collections::HashSet<usize> = std::collections::HashSet::new();
        let mut consumed_inverses: std::collections::HashSet<usize> = std::collections::HashSet::new();

        // Phase 1: name-match.
        for &hi in &holder_idxs {
            let Some(name) = all[hi].name.clone() else { continue };
            let matches: Vec<usize> =
                inverse_idxs.iter().copied().filter(|&ii| all[ii].name.as_deref() == Some(name.as_str())).collect();
            if matches.len() == 1 {
                let ii = matches[0];
                consumed_holders.insert(hi);
                consumed_inverses.insert(ii);
                writes.push((all[ii].table_idx, all[ii].rel_idx, all[hi].fk_columns.clone(), all[hi].ref_columns.clone()));
            }
        }

        // Phase 2: implicit — only strictly-unnamed remaining candidates.
        let remaining_unnamed_holders: Vec<usize> = holder_idxs
            .iter()
            .copied()
            .filter(|i| !consumed_holders.contains(i) && all[*i].name.is_none())
            .collect();
        let remaining_unnamed_inverses: Vec<usize> = inverse_idxs
            .iter()
            .copied()
            .filter(|i| !consumed_inverses.contains(i) && all[*i].name.is_none())
            .collect();

        if remaining_unnamed_holders.len() == 1 && remaining_unnamed_inverses.len() <= 1 {
            if let Some(&ii) = remaining_unnamed_inverses.first() {
                let hi = remaining_unnamed_holders[0];
                writes.push((all[ii].table_idx, all[ii].rel_idx, all[hi].fk_columns.clone(), all[hi].ref_columns.clone()));
            }
        }
    }

    for (ti, ri, fk_columns, ref_columns) in writes {
        let rel = &mut tables[ti].relations[ri];
        rel.fk_columns = fk_columns;
        rel.ref_columns = ref_columns;
        rel.inverse = Some(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolve_source(source: &str) -> ResolvedSchema {
        let schema = crate::parse_source(source).expect("source should parse without errors");
        resolve(&schema)
    }

    fn native_type_of<'a>(resolved: &'a ResolvedSchema, table: &str, column: &str) -> Option<&'a ResolvedNativeType> {
        resolved
            .tables
            .iter()
            .find(|t| t.name == table)
            .and_then(|t| t.columns.iter().find(|c| c.name == column))
            .and_then(|c| c.native_type.as_ref())
    }

    #[test]
    fn one_arg_native_type_stringifies_integrally_not_as_f64() {
        // CRITICAL: `AttributeValue::Number(255.0)` must resolve to `"255"`,
        // never `"255.0"` — bare `f64::to_string()` would silently corrupt
        // the IR and produce invalid DDL downstream (design decision #6).
        let resolved = resolve_source(
            r#"
Table User {
  id  String @id
  bio String @db.VarChar(255)
}
"#,
        );
        let nt = native_type_of(&resolved, "User", "bio").expect("bio has a native type");
        assert_eq!(nt.name, "VarChar");
        assert_eq!(nt.args, vec!["255".to_string()]);
        assert!(!nt.args.contains(&"255.0".to_string()));
    }

    #[test]
    fn two_arg_native_type_resolves_both_args_integrally() {
        let resolved = resolve_source(
            r#"
Table User {
  id    String  @id
  price Decimal @db.Numeric(10, 2)
}
"#,
        );
        let nt = native_type_of(&resolved, "User", "price").expect("price has a native type");
        assert_eq!(nt.name, "Numeric");
        assert_eq!(nt.args, vec!["10".to_string(), "2".to_string()]);
    }

    #[test]
    fn zero_arg_native_type_resolves_to_empty_args() {
        let resolved = resolve_source(
            r#"
Table User {
  id String @id @db.Uuid
}
"#,
        );
        let nt = native_type_of(&resolved, "User", "id").expect("id has a native type");
        assert_eq!(nt.name, "Uuid");
        assert!(nt.args.is_empty());
    }

    #[test]
    fn column_without_native_type_leaves_it_absent() {
        let resolved = resolve_source(
            r#"
Table User {
  id   String @id
  name String
}
"#,
        );
        assert!(native_type_of(&resolved, "User", "name").is_none());
    }

    fn index_of<'a>(resolved: &'a ResolvedSchema, table: &str, columns: &[&str]) -> &'a ResolvedIndex {
        resolved
            .tables
            .iter()
            .find(|t| t.name == table)
            .expect("table exists")
            .indexes
            .iter()
            .find(|i| i.columns == columns)
            .expect("index exists")
    }

    #[test]
    fn explicit_index_name_is_honoured() {
        let resolved = resolve_source(
            r#"
Table User {
  id    String @id
  email String
  @@index([email], name: "custom_email_idx")
}
"#,
        );
        let idx = index_of(&resolved, "User", &["email"]);
        assert_eq!(idx.name.as_deref(), Some("custom_email_idx"));
    }

    #[test]
    fn omitted_index_name_resolves_to_none() {
        // Name derivation (`${table}_${cols}_idx`) stays a migrator-side
        // concern (`postgres.ts`/`migrate.ts`'s `index.name ?? derived`
        // fallback) — resolve.rs only ever emits an EXPLICIT `name:`, so
        // fixtures 01-15's pre-existing unnamed `@@index`/`@@unique`
        // attributes stay byte-identical (no new `name` key appears).
        let resolved = resolve_source(
            r#"
Table User {
  id    String @id
  email String
  @@index([email])
}
"#,
        );
        let idx = index_of(&resolved, "User", &["email"]);
        assert_eq!(idx.name, None);
    }

    #[test]
    fn bare_identifier_index_type_is_resolved() {
        let resolved = resolve_source(
            r#"
Table User {
  id    String @id
  email String
  @@index([email], type: gin)
}
"#,
        );
        let idx = index_of(&resolved, "User", &["email"]);
        assert_eq!(idx.index_type, Some(IndexMethod::Gin));
    }

    #[test]
    fn quoted_string_index_type_is_resolved() {
        let resolved = resolve_source(
            r#"
Table User {
  id    String @id
  email String
  @@index([email], type: "gist")
}
"#,
        );
        let idx = index_of(&resolved, "User", &["email"]);
        assert_eq!(idx.index_type, Some(IndexMethod::Gist));
    }

    #[test]
    fn explicit_btree_index_type_canonicalizes_to_none() {
        let resolved = resolve_source(
            r#"
Table User {
  id    String @id
  email String
  @@index([email], type: btree)
}
"#,
        );
        let idx = index_of(&resolved, "User", &["email"]);
        assert_eq!(idx.index_type, None);
    }

    #[test]
    fn omitted_index_type_resolves_to_none() {
        let resolved = resolve_source(
            r#"
Table User {
  id    String @id
  email String
  @@index([email])
}
"#,
        );
        let idx = index_of(&resolved, "User", &["email"]);
        assert_eq!(idx.index_type, None);
    }

    fn allow_of<'a>(resolved: &'a ResolvedSchema, table: &str) -> Option<&'a Vec<AllowRule>> {
        resolved.tables.iter().find(|t| t.name == table).and_then(|t| t.allow.as_ref())
    }

    #[test]
    fn allow_write_and_all_expand_in_declaration_order_with_dbname_operand() {
        let resolved = resolve_source(
            r#"
Table Post {
  id      String @id
  ownerId Int @map("owner_id")
  @@allow(write, auth.userId == this.ownerId)
  @@allow(all, auth.userId == this.ownerId)
}
"#,
        );
        let allow = allow_of(&resolved, "Post").expect("allow rules resolved");
        let actions: Vec<AllowAction> = allow.iter().map(|r| r.action).collect();
        assert_eq!(
            actions,
            vec![
                AllowAction::Create,
                AllowAction::Update,
                AllowAction::Delete,
                AllowAction::Create,
                AllowAction::Read,
                AllowAction::Update,
                AllowAction::Delete,
            ]
        );
        for rule in allow {
            match &rule.left {
                AllowOperand::Claim { name } => assert_eq!(name, "userId"),
                other => panic!("expected claim operand, got {other:?}"),
            }
            // Physical dbName (`@map("owner_id")`), not the logical field name.
            match &rule.right {
                AllowOperand::Field { name } => assert_eq!(name, "owner_id"),
                other => panic!("expected field operand carrying dbName, got {other:?}"),
            }
        }
    }

    #[test]
    fn allow_array_and_bare_action_expand_without_duplication() {
        let resolved = resolve_source(
            r#"
Table Comment {
  id      String @id
  ownerId Int
  @@allow([create, update], auth.userId == this.ownerId)
  @@allow(read, auth.userId == this.ownerId)
}
"#,
        );
        let allow = allow_of(&resolved, "Comment").expect("allow rules resolved");
        let actions: Vec<AllowAction> = allow.iter().map(|r| r.action).collect();
        assert_eq!(actions, vec![AllowAction::Create, AllowAction::Update, AllowAction::Read]);
    }

    #[test]
    fn allow_multiple_rules_on_one_action_preserve_declaration_order_as_distinct_entries() {
        let resolved = resolve_source(
            r#"
Table Article {
  id       String  @id
  ownerId  Int
  isPublic Boolean
  @@allow(read, auth.userId == this.ownerId)
  @@allow(read, this.isPublic == true)
}
"#,
        );
        let allow = allow_of(&resolved, "Article").expect("allow rules resolved");
        assert_eq!(allow.len(), 2);
        assert_eq!(allow[0].action, AllowAction::Read);
        assert_eq!(allow[1].action, AllowAction::Read);
        match &allow[0].right {
            AllowOperand::Field { name } => assert_eq!(name, "ownerId"),
            other => panic!("expected field operand, got {other:?}"),
        }
        match &allow[1].left {
            AllowOperand::Field { name } => assert_eq!(name, "isPublic"),
            other => panic!("expected field operand, got {other:?}"),
        }
        match &allow[1].right {
            AllowOperand::Boolean { value } => assert!(*value),
            other => panic!("expected boolean literal operand, got {other:?}"),
        }
    }

    #[test]
    fn model_without_allow_has_no_allow_field() {
        let resolved = resolve_source(
            r#"
Table User {
  id String @id
}
"#,
        );
        let table = resolved.tables.iter().find(|t| t.name == "User").expect("table exists");
        assert!(table.allow.is_none());
    }

    // ─── @@realtime(columns:…) (realtime-column-projection PR 1) ────────────

    #[test]
    fn realtime_columns_resolve_to_physical_names_in_declaration_order() {
        // RCP-2/RCP-4: `columns: [id, email]` resolves to physical dbNames,
        // in declaration order, excluding any unlisted field.
        let resolved = resolve_source(
            r#"
Table User {
  id String @id
  email String
  passwordHash String
  @@realtime(columns: [id, email])
}
"#,
        );
        let table = resolved.tables.iter().find(|t| t.name == "User").expect("table exists");
        assert_eq!(table.realtime_columns.as_deref(), Some(&["id".to_string(), "email".to_string()][..]));
    }

    #[test]
    fn realtime_columns_use_mapped_physical_names() {
        // DX-2: a `@map`ped listed field yields its physical name, not the
        // schema-level field name.
        let resolved = resolve_source(
            r#"
Table User {
  id String @id
  email String @map("email_address")
  @@realtime(columns: [id, email])
}
"#,
        );
        let table = resolved.tables.iter().find(|t| t.name == "User").expect("table exists");
        assert_eq!(
            table.realtime_columns.as_deref(),
            Some(&["id".to_string(), "email_address".to_string()][..])
        );
    }

    #[test]
    fn bare_realtime_has_no_column_allowlist() {
        // RCP-1: bare @@realtime must not populate realtime_columns at all.
        let resolved = resolve_source(
            r#"
Table User {
  id String @id
  @@realtime
}
"#,
        );
        let table = resolved.tables.iter().find(|t| t.name == "User").expect("table exists");
        assert!(table.realtime_columns.is_none());
    }

    #[test]
    fn empty_realtime_columns_list_resolves_to_present_and_empty() {
        // RCP-7: `columns: []` must resolve to `Some(vec![])`, never `None`
        // — present-and-empty is the identity-only signal.
        let resolved = resolve_source(
            r#"
Table User {
  id String @id
  @@realtime(columns: [])
}
"#,
        );
        let table = resolved.tables.iter().find(|t| t.name == "User").expect("table exists");
        assert_eq!(table.realtime_columns, Some(vec![]));
    }
}
