//! Validator — line-by-line port of `packages/core/src/validate.ts`, plus
//! Phase 3's attribute/relation/referential-action/datasource passes (no TS
//! counterpart). Original message strings are part of the parity contract —
//! do not reword; new Phase 3 messages are pinned by `tests/fixtures.rs`.

use std::collections::HashSet;

use crate::ast::*;
use crate::ir::ValidationError;
use crate::rules;
use crate::rules::{ArgShape, AttributeTarget};

pub fn validate(schema: &Schema) -> Vec<ValidationError> {
    let mut errors = Vec::new();
    let enum_names: HashSet<&str> = schema.enums.iter().map(|e| e.name.as_str()).collect();
    let model_names: HashSet<&str> = schema.models.iter().map(|m| m.name.as_str()).collect();

    validate_attributes(&mut errors, schema, &enum_names);
    validate_implicit_many_to_many(&mut errors, schema, &model_names);
    validate_relation_ambiguity(&mut errors, schema, &model_names);
    validate_datasources(&mut errors, schema);

    // Duplicate model names.
    let mut seen_models: HashSet<&str> = HashSet::new();
    for model in &schema.models {
        if seen_models.contains(model.name.as_str()) {
            errors.push(ValidationError {
                message: format!("Duplicate model \"{}\".", model.name),
                model: Some(model.name.clone()),
                field: None,
            });
        }
        seen_models.insert(&model.name);
    }

    for model in &schema.models {
        let mut pk_count = 0;

        for field in &model.fields {
            let type_name = field.field_type.name.as_str();
            let is_scalar_type = is_scalar(type_name);
            let is_enum_type = enum_names.contains(type_name);
            let is_model_type = model_names.contains(type_name);

            if !is_scalar_type && !is_enum_type && !is_model_type {
                errors.push(ValidationError {
                    message: format!(
                        "Unknown type \"{type_name}\" on field \"{}\".",
                        field.name
                    ),
                    model: Some(model.name.clone()),
                    field: Some(field.name.clone()),
                });
            }

            if get_attr(&field.attributes, "id").is_some() {
                pk_count += 1;
            }

            // Validate @relation references point at real local + target fields.
            if is_model_type {
                validate_relation(&mut errors, schema, model, field, type_name);
            }
        }

        if pk_count == 0 && !model.fields.is_empty() {
            errors.push(ValidationError {
                message: format!("Model \"{}\" has no @id primary key.", model.name),
                model: Some(model.name.clone()),
                field: None,
            });
        }

        // @@realtime needs a PK: the notify trigger and client refetch key on it.
        if get_attr(&model.attributes, "realtime").is_some() && pk_count == 0 {
            errors.push(ValidationError {
                message: format!(
                    "Model \"{}\" is @@realtime but has no @id primary key.",
                    model.name
                ),
                model: Some(model.name.clone()),
                field: None,
            });
        }
    }

    errors
}

fn validate_relation(
    errors: &mut Vec<ValidationError>,
    schema: &Schema,
    model: &Model,
    field: &Field,
    target_model: &str,
) {
    let Some(rel_attr) = get_attr(&field.attributes, "relation") else {
        return; // inverse side without @relation is allowed
    };

    let local_refs = as_reference_list(named_arg(Some(rel_attr), "fields"));
    let target_refs = as_reference_list(named_arg(Some(rel_attr), "references"));

    // TS looks the local model up again by name — first match wins, which
    // matters with duplicate model names; replicate with `find`.
    let local_model = schema
        .models
        .iter()
        .find(|m| m.name == model.name)
        .expect("local model exists");
    for reference in &local_refs {
        if !local_model.fields.iter().any(|f| &f.name == reference) {
            errors.push(ValidationError {
                message: format!(
                    "@relation(fields:) references unknown local field \"{reference}\"."
                ),
                model: Some(model.name.clone()),
                field: Some(field.name.clone()),
            });
        }
    }

    let target = schema.models.iter().find(|m| m.name == target_model);
    for reference in &target_refs {
        if let Some(target) = target {
            if !target.fields.iter().any(|f| &f.name == reference) {
                errors.push(ValidationError {
                    message: format!(
                        "@relation(references:) points at unknown field \"{reference}\" on \"{target_model}\"."
                    ),
                    model: Some(model.name.clone()),
                    field: Some(field.name.clone()),
                });
            }
        }
    }
}

// ─── Attribute whitelist / arity / argument-type (Phase 3) ──────────────────

fn loc(kind: &str, path: String) -> String {
    format!("{kind} \"{path}\"")
}

fn push_unknown(
    errors: &mut Vec<ValidationError>,
    target: AttributeTarget,
    attr_name: &str,
    location: &str,
    model: Option<String>,
    field: Option<String>,
) {
    let (prefix, kind) = match target {
        AttributeTarget::Field => ("@", "field"),
        AttributeTarget::Model => ("@@", "model"),
        AttributeTarget::EnumValue => ("@", "enum value"),
    };
    errors.push(ValidationError {
        message: format!("Unknown {kind} attribute \"{prefix}{attr_name}\" on {location}."),
        model,
        field,
    });
}

/// Checks the `None`/`OneString`/`OneReferenceArray` shapes; `Default`/
/// `Relation` have dedicated functions below.
fn check_shape(
    errors: &mut Vec<ValidationError>,
    shape: ArgShape,
    attr_name: &str,
    attr: &Attribute,
    location: &str,
    model: Option<String>,
    field: Option<String>,
) {
    let one_string = matches!(attr.args.as_slice(), [a] if a.name.is_empty() && matches!(a.value, AttributeValue::String { .. }));
    // `ArgShape::Index`: exactly one positional array argument (`name`/`type`
    // named args are checked separately by `validate_index_args`, not here —
    // this only guards the shape `OneReferenceArray` used to guard).
    let has_one_positional_array = attr
        .args
        .iter()
        .filter(|a| a.name.is_empty())
        .count()
        == 1
        && matches!(
            attr.args.iter().find(|a| a.name.is_empty()).map(|a| &a.value),
            Some(AttributeValue::Array { .. })
        );
    let complaint = match shape {
        ArgShape::None if !attr.args.is_empty() => Some("takes no arguments"),
        ArgShape::OneString if !one_string => Some("requires exactly one string argument"),
        ArgShape::Index if !has_one_positional_array => Some("requires exactly one array argument"),
        _ => None,
    };
    if let Some(complaint) = complaint {
        errors.push(ValidationError {
            message: format!("Attribute \"@{attr_name}\" on {location} {complaint}."),
            model,
            field,
        });
    }
}

/// Namespace admitted for native-type attributes (`@db.VarChar`, `@db.Uuid`,
/// ...). PR A admitted any name under this namespace unconditionally; PR B
/// checks the name/arity/scalar-compatibility matrix (`rules::NATIVE_TYPE_RULES`).
const NATIVE_TYPE_NAMESPACE: &str = "db";

/// Full `@db.X` diagnostics (PR B): unknown native type name, scalar
/// compatibility, and arity — checked via `rules::native_type_rule` before
/// the existing bare-name `attribute_rule` lookup, per design's Data Flow.
fn validate_native_type(
    errors: &mut Vec<ValidationError>,
    model: &Model,
    field: &Field,
    attr: &Attribute,
    location: &str,
    enum_names: &HashSet<&str>,
) {
    let Some((valid_scalars, arity)) = rules::native_type_rule(&attr.name) else {
        let full_name = format!("{NATIVE_TYPE_NAMESPACE}.{}", attr.name);
        push_unknown(errors, AttributeTarget::Field, &full_name, location, Some(model.name.clone()), Some(field.name.clone()));
        return;
    };

    let type_name = field.field_type.name.as_str();
    let is_scalar_type = is_scalar(type_name);
    let is_enum_type = enum_names.contains(type_name);
    if !is_scalar_type || is_enum_type {
        // Covers both an enum-typed field and a relation field (relation
        // field types are never in `SCALAR_TYPES`).
        errors.push(ValidationError {
            message: format!(
                "Native type \"{}\" on {location} is not compatible with type \"{type_name}\".",
                attr.name
            ),
            model: Some(model.name.clone()),
            field: Some(field.name.clone()),
        });
        return;
    }

    if !valid_scalars.contains(&type_name) {
        errors.push(ValidationError {
            message: format!(
                "Native type \"{}\" on {location} is not compatible with scalar type \"{type_name}\".",
                attr.name
            ),
            model: Some(model.name.clone()),
            field: Some(field.name.clone()),
        });
        return;
    }

    let arg_count = attr.args.len();
    let all_integral = attr.args.iter().all(|a| matches!(a.value, AttributeValue::Number { .. }));
    let arity_ok = match arity {
        rules::NativeTypeArity::Zero => arg_count == 0,
        rules::NativeTypeArity::One => arg_count == 1 && all_integral,
        rules::NativeTypeArity::ZeroOrTwo => (arg_count == 0 || arg_count == 2) && all_integral,
    };
    if !arity_ok {
        errors.push(ValidationError {
            message: format!(
                "Native type \"{}\" on {location} has an invalid number of arguments.",
                attr.name
            ),
            model: Some(model.name.clone()),
            field: Some(field.name.clone()),
        });
    }
}

fn validate_attributes(errors: &mut Vec<ValidationError>, schema: &Schema, enum_names: &HashSet<&str>) {
    for model in &schema.models {
        for field in &model.fields {
            let location = loc("field", format!("{}.{}", model.name, field.name));
            for attr in &field.attributes {
                if let Some(namespace) = &attr.namespace {
                    if namespace != NATIVE_TYPE_NAMESPACE {
                        let full_name = format!("{namespace}.{}", attr.name);
                        push_unknown(errors, AttributeTarget::Field, &full_name, &location, Some(model.name.clone()), Some(field.name.clone()));
                        continue;
                    }
                    validate_native_type(errors, model, field, attr, &location, enum_names);
                    continue;
                }
                match rules::attribute_rule(AttributeTarget::Field, &attr.name) {
                    None => push_unknown(errors, AttributeTarget::Field, &attr.name, &location, Some(model.name.clone()), Some(field.name.clone())),
                    Some(ArgShape::Default) => validate_default(errors, model, field, attr, &location, enum_names),
                    Some(ArgShape::Relation) => validate_relation_args(errors, model, field, attr, &location),
                    Some(shape) => check_shape(errors, shape, &attr.name, attr, &location, Some(model.name.clone()), Some(field.name.clone())),
                }
            }
        }
        let location = loc("model", model.name.clone());
        for attr in &model.attributes {
            match rules::attribute_rule(AttributeTarget::Model, &attr.name) {
                None => push_unknown(errors, AttributeTarget::Model, &attr.name, &location, Some(model.name.clone()), None),
                Some(shape) => check_shape(errors, shape, &attr.name, attr, &location, Some(model.name.clone()), None),
            }
        }
        validate_index_args(errors, model);
    }
    for e in &schema.enums {
        for value in &e.values {
            let location = loc("enum value", format!("{}.{}", e.name, value.name));
            for attr in &value.attributes {
                match rules::attribute_rule(AttributeTarget::EnumValue, &attr.name) {
                    None => push_unknown(errors, AttributeTarget::EnumValue, &attr.name, &location, None, None),
                    Some(shape) => check_shape(errors, shape, &attr.name, attr, &location, None, None),
                }
            }
        }
    }
}

// ─── Named/typed indexes (`@@index`/`@@unique` `name:`/`type:`, PR A) ───────

/// One `@@index`/`@@unique` attribute's columns, resolved to physical (db)
/// names the same way `resolve.rs::resolve_indexes` would — needed so
/// derived-name collision detection matches `migrate.ts::indexName`'s
/// formula exactly (design decision #6).
fn index_columns(model: &Model, attr: &Attribute) -> Vec<String> {
    let value = attr.args.iter().find(|a| a.name.is_empty()).map(|a| &a.value);
    as_reference_list(value)
        .into_iter()
        .map(|name| {
            model
                .fields
                .iter()
                .find(|f| f.name == name)
                .map(field_db_name)
                .unwrap_or(name)
        })
        .collect()
}

fn field_db_name(field: &Field) -> String {
    crate::resolve::field_db_name(field)
}

/// `${table}_${cols}_${suffix}` — `migrate.ts::indexName`'s auto-derivation
/// formula, replicated so an explicit `name:` can be checked against it.
fn derived_index_name(table_db_name: &str, columns: &[String], unique: bool) -> String {
    let suffix = if unique { "key" } else { "idx" };
    format!("{table_db_name}_{}_{suffix}", columns.join("_"))
}

/// `${table}_${col}_key` — `postgres.ts::uniqueColIndexName`'s formula for a
/// single-column `@unique` field's implicit index.
fn derived_unique_col_name(table_db_name: &str, col_db_name: &str) -> String {
    format!("{table_db_name}_{col_db_name}_key")
}

/// One name occupying the per-table index-name namespace: either an
/// explicit `name:` argument or an auto-derived name from an unnamed
/// `@@index`/`@@unique`/single-column `@unique` field.
struct NameSource {
    name: String,
    explicit: bool,
}

/// Validates `name:`/`type:` on every `@@index`/`@@unique` attribute of
/// `model`: unknown named-arg keys, method-enum membership, name
/// well-formedness, table-scoped name uniqueness (against other explicit
/// names AND derived names, including derived single-column `@unique` field
/// names — design decision #6), and `@@unique`'s btree-only restriction
/// (decision #7).
fn validate_index_args(errors: &mut Vec<ValidationError>, model: &Model) {
    let known_args = rules::INDEX_ARG_KEYS.join(", ");
    let allowed_methods = rules::INDEX_METHODS.join(", ");
    let table_db_name = crate::resolve::table_db_name(model);
    let mut sources: Vec<NameSource> = Vec::new();

    for attr in &model.attributes {
        if attr.namespace.is_some() || (attr.name != "index" && attr.name != "unique") {
            continue;
        }
        let attr_label = format!("@@{}", attr.name);
        let model_name = model.name.clone();

        // Unknown named-argument keys.
        for arg in &attr.args {
            if !arg.name.is_empty() && !rules::INDEX_ARG_KEYS.contains(&arg.name.as_str()) {
                errors.push(ValidationError {
                    message: format!(
                        "Unknown {attr_label} argument \"{}\" on model \"{model_name}\". Known arguments: {known_args}.",
                        arg.name
                    ),
                    model: Some(model_name.clone()),
                    field: None,
                });
            }
        }

        let columns = index_columns(model, attr);
        if columns.is_empty() {
            continue; // Mirrors resolve_indexes: an attribute with no valid array is skipped.
        }
        let unique = attr.name == "unique";

        // `type:` — dual-form (bare identifier OR quoted string, decision #2).
        if let Some(arg) = attr.args.iter().find(|a| a.name == "type") {
            let raw = match &arg.value {
                AttributeValue::Reference { value } | AttributeValue::String { value } => Some(value.clone()),
                _ => None,
            };
            let Some(raw) = raw else {
                errors.push(ValidationError {
                    message: format!(
                        "Attribute \"{attr_label}\" on model \"{model_name}\" requires \"type\" to be an index method identifier."
                    ),
                    model: Some(model_name.clone()),
                    field: None,
                });
                continue;
            };
            match rules::index_method(&raw) {
                None => {
                    errors.push(ValidationError {
                        message: format!(
                            "Invalid {attr_label} type \"{raw}\" on model \"{model_name}\". Allowed: {allowed_methods}."
                        ),
                        model: Some(model_name.clone()),
                        field: None,
                    });
                }
                Some(method) => {
                    if unique && !matches!(method, crate::ir::IndexMethod::Btree) {
                        errors.push(ValidationError {
                            message: format!(
                                "Attribute \"@@unique\" on model \"{model_name}\" does not support index type \"{raw}\"; unique indexes require btree."
                            ),
                            model: Some(model_name.clone()),
                            field: None,
                        });
                    }
                }
            }
        }

        // `name:` — well-formedness, then queued for the table-scoped
        // uniqueness pass below.
        let explicit_name = match attr.args.iter().find(|a| a.name == "name") {
            None => None,
            Some(arg) => match &arg.value {
                AttributeValue::String { value } => {
                    let is_well_formed = !value.is_empty()
                        && value.len() <= rules::MAX_IDENTIFIER_BYTES
                        && !value.contains('"')
                        && !value.chars().any(|c| c.is_control());
                    if !is_well_formed {
                        errors.push(ValidationError {
                            message: format!(
                                "Invalid index name \"{value}\" on model \"{model_name}\". Index names must be 1-63 characters and must not contain quotes or control characters."
                            ),
                            model: Some(model_name.clone()),
                            field: None,
                        });
                        None
                    } else {
                        Some(value.clone())
                    }
                }
                _ => {
                    errors.push(ValidationError {
                        message: format!(
                            "Attribute \"{attr_label}\" on model \"{model_name}\" requires \"name\" to be a string literal."
                        ),
                        model: Some(model_name.clone()),
                        field: None,
                    });
                    None
                }
            },
        };

        match explicit_name {
            Some(name) => sources.push(NameSource { name, explicit: true }),
            None => sources.push(NameSource { name: derived_index_name(&table_db_name, &columns, unique), explicit: false }),
        }
    }

    // Derived single-column `@unique` field names also occupy the namespace
    // (decision #6) — collected as additional (non-explicit) sources.
    for field in &model.fields {
        if has_attr(&field.attributes, "unique") {
            sources.push(NameSource {
                name: derived_unique_col_name(&table_db_name, &field_db_name(field)),
                explicit: false,
            });
        }
    }

    let mut seen: HashSet<&str> = HashSet::new();
    for source in &sources {
        if !source.explicit || !seen.insert(&source.name) {
            continue;
        }
        let others_same_name = sources.iter().filter(|s| s.name == source.name && !std::ptr::eq(*s, source));
        let mut explicit_collisions = 0usize;
        let mut derived_collision = false;
        for other in others_same_name {
            if other.explicit {
                explicit_collisions += 1;
            } else {
                derived_collision = true;
            }
        }
        if explicit_collisions > 0 {
            errors.push(ValidationError {
                message: format!("Duplicate index name \"{}\" on model \"{}\".", source.name, model.name),
                model: Some(model.name.clone()),
                field: None,
            });
        } else if derived_collision {
            errors.push(ValidationError {
                message: format!(
                    "Index name \"{}\" on model \"{}\" collides with the name derived for another index on the same table.",
                    source.name, model.name
                ),
                model: Some(model.name.clone()),
                field: None,
            });
        }
    }
}

fn validate_default(
    errors: &mut Vec<ValidationError>,
    model: &Model,
    field: &Field,
    attr: &Attribute,
    location: &str,
    enum_names: &HashSet<&str>,
) {
    let Some(value) = positional_arg(Some(attr), 0).map(|a| &a.value) else {
        errors.push(ValidationError {
            message: format!("Attribute \"@default\" on {location} requires exactly one argument."),
            model: Some(model.name.clone()),
            field: Some(field.name.clone()),
        });
        return;
    };
    let valid = match value {
        AttributeValue::Function { name, .. } => rules::DEFAULT_GENERATOR_FUNCTIONS.contains(&name.as_str()),
        AttributeValue::Reference { .. } => enum_names.contains(field.field_type.name.as_str()),
        _ => rules::default_literal_matches(&field.field_type.name, value),
    };
    if !valid {
        errors.push(ValidationError {
            message: format!("Default value for {location} is not valid for type \"{}\".", field.field_type.name),
            model: Some(model.name.clone()),
            field: Some(field.name.clone()),
        });
    }
}

/// Named args whitelisted to `RELATION_ARG_KEYS`; `onDelete`/`onUpdate`
/// checked against `REFERENTIAL_ACTIONS`.
fn validate_relation_args(
    errors: &mut Vec<ValidationError>,
    model: &Model,
    field: &Field,
    attr: &Attribute,
    location: &str,
) {
    let known = rules::RELATION_ARG_KEYS.join(", ");
    let mut positional_seen = 0usize;
    for arg in &attr.args {
        let message = if arg.name.is_empty() {
            positional_seen += 1;
            // Exactly one positional STRING argument (the `@relation("Name", ...)`
            // name) is allowed; a second positional, or a non-string positional,
            // keeps the original rejection message verbatim (parity contract).
            let is_allowed_name = positional_seen == 1 && matches!(arg.value, AttributeValue::String { .. });
            if is_allowed_name {
                None
            } else {
                Some(format!(
                    "Attribute \"@relation\" on {location} does not accept positional arguments; use named arguments ({known})."
                ))
            }
        } else if !rules::RELATION_ARG_KEYS.contains(&arg.name.as_str()) {
            Some(format!("Unknown @relation argument \"{}\" on {location}. Known arguments: {known}.", arg.name))
        } else {
            None
        };
        if let Some(message) = message {
            errors.push(ValidationError { message, model: Some(model.name.clone()), field: Some(field.name.clone()) });
        }
    }
    for key in ["onDelete", "onUpdate"] {
        let Some(value) = named_arg(Some(attr), key) else { continue };
        let raw = match value {
            AttributeValue::String { value } | AttributeValue::Reference { value } => value.clone(),
            other => format!("{other:?}"),
        };
        if rules::action_sql(&raw).is_none() {
            let allowed = rules::REFERENTIAL_ACTIONS.iter().map(|(name, _)| *name).collect::<Vec<_>>().join(", ");
            errors.push(ValidationError {
                message: format!("Invalid {key} value \"{raw}\". Allowed: {allowed}."),
                model: Some(model.name.clone()),
                field: Some(field.name.clone()),
            });
        }
    }
}

// ─── Implicit many-to-many rejection (Phase 3) ───────────────────────────────

/// A list field holding a FK isn't the implicit-many-to-many shape.
fn holds_fk(field: &Field) -> bool {
    !as_reference_list(named_arg(get_attr(&field.attributes, "relation"), "fields")).is_empty()
}

fn validate_implicit_many_to_many(errors: &mut Vec<ValidationError>, schema: &Schema, model_names: &HashSet<&str>) {
    let mut reported: HashSet<(String, String)> = HashSet::new();
    for model in &schema.models {
        for field in &model.fields {
            if !field.field_type.list || !model_names.contains(field.field_type.name.as_str()) || holds_fk(field) {
                continue;
            }
            let target_name = &field.field_type.name;
            let Some(target_model) = schema.models.iter().find(|m| &m.name == target_name) else { continue };
            let has_reciprocal = target_model
                .fields
                .iter()
                .any(|f| f.field_type.list && f.field_type.name == model.name && !holds_fk(f));
            if !has_reciprocal {
                continue;
            }
            let mut pair = [model.name.clone(), target_model.name.clone()];
            pair.sort();
            if reported.insert((pair[0].clone(), pair[1].clone())) {
                errors.push(ValidationError {
                    message: format!(
                        "Implicit many-to-many between \"{}\" and \"{}\" is not supported. Define an explicit join model with two @relation(fields:, references:) legs.",
                        model.name, target_model.name
                    ),
                    model: Some(model.name.clone()),
                    field: Some(field.name.clone()),
                });
            }
        }
    }
}

// ─── Relation pairing ambiguity (relations-epic) ─────────────────────────────

fn relation_field_name(field: &Field) -> Option<String> {
    as_string(positional_arg(get_attr(&field.attributes, "relation"), 0).map(|a| &a.value))
}

fn relation_field_holds_fk(field: &Field) -> bool {
    !as_reference_list(named_arg(get_attr(&field.attributes, "relation"), "fields")).is_empty()
}

/// A relation field that targets another model, addressed by
/// `(model_idx, field_idx)` into `schema.models`.
#[derive(Clone, Copy)]
struct Candidate {
    model_idx: usize,
    field_idx: usize,
}

/// Mirrors `resolve.rs::pair_relations`'s algorithm (see design.md's "Pairing
/// Algorithm"), but never mutates and only ever produces diagnostics:
///
/// - a named relation field with no counterpart field on the target model
///   declaring the same `@relation("Name")` is always reported, regardless
///   of how many sibling relations exist between the two models;
/// - after name-matching removes deterministic pairs, if the remaining
///   (unconsumed) candidates leave 2+ on one side and 1+ on the other, the
///   pair set is ambiguous — deduplicated once per unordered `{A, B}`.
fn validate_relation_ambiguity(errors: &mut Vec<ValidationError>, schema: &Schema, model_names: &HashSet<&str>) {
    let mut groups: std::collections::HashMap<(String, String), Vec<Candidate>> = std::collections::HashMap::new();
    for (mi, model) in schema.models.iter().enumerate() {
        for (fi, field) in model.fields.iter().enumerate() {
            if !model_names.contains(field.field_type.name.as_str()) {
                continue;
            }
            let mut pair = [model.name.clone(), field.field_type.name.clone()];
            pair.sort();
            groups.entry((pair[0].clone(), pair[1].clone())).or_default().push(Candidate { model_idx: mi, field_idx: fi });
        }
    }

    let field_of = |c: Candidate| -> (&Model, &Field) {
        let m = &schema.models[c.model_idx];
        (m, &m.fields[c.field_idx])
    };
    let is_counterpart_of = |c: Candidate, other: Candidate, name: &str| -> bool {
        let (model, field) = field_of(c);
        let (other_model, other_field) = field_of(other);
        other_field.field_type.name == model.name
            && other_model.name == field.field_type.name
            && relation_field_name(other_field).as_deref() == Some(name)
    };

    let mut reported_ambiguous: HashSet<(String, String)> = HashSet::new();

    for ((a, b), candidates) in &groups {
        // Named relation with no counterpart declaring the same name: always
        // reported, independent of the ambiguity threshold below.
        for &c in candidates {
            let (model, field) = field_of(c);
            let Some(name) = relation_field_name(field) else { continue };
            let has_counterpart =
                candidates.iter().any(|&other| !(other.model_idx == c.model_idx && other.field_idx == c.field_idx) && is_counterpart_of(c, other, &name));
            if !has_counterpart {
                errors.push(ValidationError {
                    message: format!(
                        "@relation(\"{name}\") on \"{}.{}\" has no counterpart field on \"{}\" declaring @relation(\"{name}\").",
                        model.name, field.name, field.field_type.name
                    ),
                    model: Some(model.name.clone()),
                    field: Some(field.name.clone()),
                });
            }
        }

        // Name-match consumption (mirrors resolve.rs's pairing phase 1).
        let mut consumed: HashSet<(usize, usize)> = HashSet::new();
        for &c in candidates {
            let (_, field) = field_of(c);
            let Some(name) = relation_field_name(field) else { continue };
            let matches: Vec<Candidate> =
                candidates.iter().copied().filter(|&other| !(other.model_idx == c.model_idx && other.field_idx == c.field_idx) && is_counterpart_of(c, other, &name)).collect();
            if matches.len() == 1 {
                consumed.insert((c.model_idx, c.field_idx));
                consumed.insert((matches[0].model_idx, matches[0].field_idx));
            }
        }

        let remaining: Vec<Candidate> = candidates.iter().copied().filter(|c| !consumed.contains(&(c.model_idx, c.field_idx))).collect();
        let remaining_fk = remaining.iter().filter(|&&c| relation_field_holds_fk(field_of(c).1)).count();
        let remaining_inverse = remaining.len() - remaining_fk;

        let ambiguous = (remaining_fk >= 2 && remaining_inverse >= 1) || (remaining_inverse >= 2 && remaining_fk >= 1);
        if ambiguous && reported_ambiguous.insert((a.clone(), b.clone())) {
            errors.push(ValidationError {
                message: format!(
                    "Ambiguous relation between \"{a}\" and \"{b}\": multiple relation fields target the same model. Disambiguate with @relation(\"Name\", ...) on both sides."
                ),
                model: None,
                field: None,
            });
        }
    }
}

// ─── Datasource validation (Phase 3) ─────────────────────────────────────────

/// `datasource.provider` accepts only `postgresql`; `generator.provider`
/// (e.g. `"indigodb-client-ts"`) is a different AST node, untouched here.
fn validate_datasources(errors: &mut Vec<ValidationError>, schema: &Schema) {
    if schema.datasources.len() > 1 {
        let names: Vec<&str> = schema.datasources.iter().map(|d| d.name.as_str()).collect();
        errors.push(ValidationError {
            message: format!(
                "Multiple datasource blocks found ({}). Only one datasource block is supported.",
                names.join(", ")
            ),
            model: None,
            field: None,
        });
    }
    for ds in &schema.datasources {
        if ds.provider != rules::DATASOURCE_PROVIDER {
            errors.push(ValidationError {
                message: format!(
                    "Unsupported datasource provider \"{}\". \"{}\" is the only supported provider.",
                    ds.provider,
                    rules::DATASOURCE_PROVIDER
                ),
                model: None,
                field: None,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn validate_source(source: &str) -> Vec<ValidationError> {
        let schema = crate::parse_source(source).expect("source should parse without errors");
        validate(&schema)
    }

    #[test]
    fn db_namespace_recognized_names_on_compatible_scalars_are_admitted() {
        // PR B checks the full compatibility matrix — every recognized
        // native type on a compatible scalar, zero-or-required-arity args,
        // must pass with no diagnostic.
        let errors = validate_source(
            r#"
Table User {
  id     String  @id
  bio    String  @db.VarChar(255)
  code   String  @db.Uuid
  price  Float   @db.Numeric(10, 2)
  amount Decimal @db.Numeric
}
"#,
        );
        assert!(errors.is_empty(), "unexpected diagnostics: {errors:?}");
    }

    #[test]
    fn db_namespace_unknown_name_is_rejected() {
        // Spec `attribute-validation`: "Unknown native type name".
        let errors = validate_source(
            r#"
Table User {
  id String @id
  bio String @db.Foo
}
"#,
        );
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].model.as_deref(), Some("User"));
        assert_eq!(errors[0].field.as_deref(), Some("bio"));
        assert!(errors[0].message.contains("db.Foo"), "{}", errors[0].message);
    }

    #[test]
    fn db_namespace_scalar_mismatch_is_rejected() {
        // Spec `attribute-validation`: "Native type on an incompatible
        // scalar" — `count Int @db.VarChar(255)`.
        let errors = validate_source(
            r#"
Table User {
  id String @id
  count Int @db.VarChar(255)
}
"#,
        );
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].model.as_deref(), Some("User"));
        assert_eq!(errors[0].field.as_deref(), Some("count"));
        assert!(errors[0].message.contains("VarChar"), "{}", errors[0].message);
        assert!(errors[0].message.contains("Int"), "{}", errors[0].message);
    }

    #[test]
    fn db_namespace_compatible_scalar_produces_no_diagnostic() {
        // Spec `attribute-validation`: "Native type on a compatible scalar".
        let errors = validate_source(
            r#"
Table User {
  id String @id @db.Uuid
}
"#,
        );
        assert!(errors.is_empty(), "unexpected diagnostics: {errors:?}");
    }

    #[test]
    fn db_namespace_arity_mismatches_are_rejected() {
        let errors = validate_source(
            r#"
Table User {
  id String @id
  bio String @db.VarChar
  addr String @db.VarChar(255, 10)
  code String @db.Uuid(1)
  price Float @db.Numeric(10)
}
"#,
        );
        assert_eq!(errors.len(), 4, "{errors:?}");
        assert!(errors.iter().all(|e| e.model.as_deref() == Some("User")));
    }

    #[test]
    fn db_namespace_on_enum_or_relation_field_is_rejected() {
        let errors = validate_source(
            r#"
Table User {
  id     String @id
  status Status @db.Uuid
  posts  Post[]
}

Table Post {
  id     String @id
  author User   @relation(fields: [authorId], references: [id])
  authorId String
  owner  User   @db.VarChar(255)
}

enum Status {
  ACTIVE
  INACTIVE
}
"#,
        );
        assert!(errors.iter().any(|e| e.field.as_deref() == Some("status")), "{errors:?}");
        assert!(errors.iter().any(|e| e.field.as_deref() == Some("owner")), "{errors:?}");
    }

    // ─── Named/typed indexes (PR A) ──────────────────────────────────────────

    #[test]
    fn index_explicit_name_and_type_are_accepted_without_diagnostics() {
        let errors = validate_source(
            r#"
Table User {
  id   String @id
  a    String
  b    String
  @@index([a, b], name: "custom_idx", type: gin)
}
"#,
        );
        assert!(errors.is_empty(), "unexpected diagnostics: {errors:?}");
    }

    #[test]
    fn index_explicit_type_btree_is_accepted_like_omitted_type() {
        // A4.2 — `type: btree` is a no-op acceptance-wise in PR A (canonicalizing
        // to `None` is resolve.rs's job in PR B).
        let errors = validate_source(
            r#"
Table User {
  id String @id
  a  String
  @@index([a], type: btree)
}
"#,
        );
        assert!(errors.is_empty(), "unexpected diagnostics: {errors:?}");
    }

    #[test]
    fn index_unknown_type_is_rejected() {
        let errors = validate_source(
            r#"
Table User {
  id String @id
  a  String
  @@index([a], type: brin)
}
"#,
        );
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert_eq!(errors[0].model.as_deref(), Some("User"));
        assert!(errors[0].message.contains("brin"), "{}", errors[0].message);
        assert!(errors[0].message.contains("Allowed: btree, gin, gist, hash"), "{}", errors[0].message);
    }

    #[test]
    fn index_unknown_named_argument_is_rejected() {
        let errors = validate_source(
            r#"
Table User {
  id String @id
  a  String
  @@index([a], method: "gin")
}
"#,
        );
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].message.contains("method"), "{}", errors[0].message);
        assert!(errors[0].message.contains("Known arguments: name, type"), "{}", errors[0].message);
    }

    #[test]
    fn index_type_wrong_value_kind_is_rejected() {
        let errors = validate_source(
            r#"
Table User {
  id String @id
  a  String
  @@index([a], type: 1)
}
"#,
        );
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].message.contains("\"type\""), "{}", errors[0].message);
        assert!(errors[0].message.contains("index method identifier"), "{}", errors[0].message);
    }

    #[test]
    fn index_name_wrong_value_kind_is_rejected() {
        let errors = validate_source(
            r#"
Table User {
  id String @id
  a  String
  @@index([a], name: gin)
}
"#,
        );
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].message.contains("\"name\""), "{}", errors[0].message);
        assert!(errors[0].message.contains("string literal"), "{}", errors[0].message);
    }

    #[test]
    fn index_empty_name_literal_is_rejected() {
        let errors = validate_source(
            r#"
Table User {
  id String @id
  a  String
  @@index([a], name: "")
}
"#,
        );
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].message.contains("1-63 characters"), "{}", errors[0].message);
    }

    #[test]
    fn index_name_too_long_is_rejected() {
        let long_name = "x".repeat(64);
        let errors = validate_source(&format!(
            r#"
Table User {{
  id String @id
  a  String
  @@index([a], name: "{long_name}")
}}
"#
        ));
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].message.contains("1-63 characters"), "{}", errors[0].message);
    }

    #[test]
    fn index_duplicate_explicit_name_is_rejected() {
        let errors = validate_source(
            r#"
Table User {
  id String @id
  a  String
  b  String
  @@index([a], name: "dup_idx")
  @@index([b], name: "dup_idx")
}
"#,
        );
        assert!(errors.iter().any(|e| e.message.contains("Duplicate index name \"dup_idx\"")), "{errors:?}");
    }

    #[test]
    fn index_explicit_name_colliding_with_derived_name_is_rejected() {
        // User_a_idx is what @@index([a]) (no explicit name) derives to.
        let errors = validate_source(
            r#"
Table User {
  id String @id
  a  String
  b  String
  @@index([a])
  @@index([b], name: "User_a_idx")
}
"#,
        );
        assert!(
            errors.iter().any(|e| e.message.contains("User_a_idx") && e.message.contains("collides with the name derived for another index")),
            "{errors:?}"
        );
    }

    #[test]
    fn index_explicit_name_colliding_with_derived_single_column_unique_field_name_is_rejected() {
        // User_email_key is what `email String @unique` derives to.
        let errors = validate_source(
            r#"
Table User {
  id    String @id
  email String @unique
  a     String
  @@index([a], name: "User_email_key")
}
"#,
        );
        assert!(
            errors.iter().any(|e| e.message.contains("User_email_key") && e.message.contains("collides with the name derived for another index")),
            "{errors:?}"
        );
    }

    #[test]
    fn unique_rejects_non_btree_type() {
        let errors = validate_source(
            r#"
Table User {
  id String @id
  a  String
  @@unique([a], type: gin)
}
"#,
        );
        assert!(
            errors.iter().any(|e| e.message.contains("@@unique") && e.message.contains("gin") && e.message.contains("require btree")),
            "{errors:?}"
        );
    }

    #[test]
    fn unique_accepts_explicit_btree_type() {
        let errors = validate_source(
            r#"
Table User {
  id String @id
  a  String
  @@unique([a], type: btree)
}
"#,
        );
        assert!(errors.is_empty(), "unexpected diagnostics: {errors:?}");
    }

    #[test]
    fn non_db_namespace_is_rejected_like_an_unknown_attribute() {
        let errors = validate_source(
            r#"
Table User {
  id String @id
  bio String @orm.hint
}
"#,
        );
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].model.as_deref(), Some("User"));
        assert_eq!(errors[0].field.as_deref(), Some("bio"));
        assert!(errors[0].message.contains("orm.hint"));
    }
}
