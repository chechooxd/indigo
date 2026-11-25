//! Validator — line-by-line port of `packages/core/src/validate.ts`, plus
//! Phase 3's attribute/relation/referential-action/datasource passes (no TS
//! counterpart). Original message strings are part of the parity contract —
//! do not reword; new Phase 3 messages are pinned by `tests/fixtures.rs`.

use std::collections::{HashMap, HashSet};

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

        // @@realtime + @@allow is now accepted (realtime-live-endpoint PR B):
        // the SSE wake-up scoping in packages/realtime/src/engine.ts's
        // dispatch() plus the RLS-enforced GET ?handle&offset read path
        // ship together and jointly make the combination safe.
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
                Some(ArgShape::Allow) => validate_allow(errors, model, attr),
                Some(ArgShape::Realtime) => validate_realtime_columns(errors, model, attr),
                Some(shape) => check_shape(errors, shape, &attr.name, attr, &location, Some(model.name.clone()), None),
            }
        }
        validate_index_args(errors, model);
        validate_allow_policy_names(errors, model);
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

        let positional_is_array = matches!(
            attr.args.iter().find(|a| a.name.is_empty()).map(|a| &a.value),
            Some(AttributeValue::Array { .. })
        );
        if !positional_is_array {
            continue; // `check_shape` already reported the missing array argument.
        }
        let columns = index_columns(model, attr);
        let has_expression_arg = attr.args.iter().any(|a| a.name == "expression");
        let unique = attr.name == "unique";

        // `where:` — optional partial-index SQL predicate.
        if let Some(arg) = attr.args.iter().find(|a| a.name == "where") {
            match &arg.value {
                AttributeValue::String { value } => {
                    if value.trim().is_empty() || value.chars().any(|c| c.is_control()) {
                        errors.push(ValidationError {
                            message: format!(
                                "Invalid {attr_label} \"where\" predicate on model \"{model_name}\". Predicate must be a non-empty string without control characters."
                            ),
                            model: Some(model_name.clone()),
                            field: None,
                        });
                    }
                }
                _ => {
                    errors.push(ValidationError {
                        message: format!(
                            "Attribute \"{attr_label}\" on model \"{model_name}\" requires \"where\" to be a string literal."
                        ),
                        model: Some(model_name.clone()),
                        field: None,
                    });
                }
            }
        }

        // `expression:` — optional expression-index SQL expression list.
        if let Some(arg) = attr.args.iter().find(|a| a.name == "expression") {
            match &arg.value {
                AttributeValue::String { value } => {
                    if value.trim().is_empty() || value.chars().any(|c| c.is_control()) {
                        errors.push(ValidationError {
                            message: format!(
                                "Invalid {attr_label} \"expression\" on model \"{model_name}\". Expression must be a non-empty string without control characters."
                            ),
                            model: Some(model_name.clone()),
                            field: None,
                        });
                    }
                }
                _ => {
                    errors.push(ValidationError {
                        message: format!(
                            "Attribute \"{attr_label}\" on model \"{model_name}\" requires \"expression\" to be a string literal."
                        ),
                        model: Some(model_name.clone()),
                        field: None,
                    });
                }
            }
        }

        // Columns vs expression mutual-exclusivity and non-emptiness.
        if has_expression_arg {
            if !columns.is_empty() {
                errors.push(ValidationError {
                    message: format!(
                        "Attribute \"{attr_label}\" on model \"{model_name}\" cannot specify both columns and \"expression\"; use [] when declaring an expression index."
                    ),
                    model: Some(model_name.clone()),
                    field: None,
                });
            }
        } else if columns.is_empty() {
            errors.push(ValidationError {
                message: format!(
                    "Attribute \"{attr_label}\" on model \"{model_name}\" requires at least one column or an \"expression\" argument."
                ),
                model: Some(model_name.clone()),
                field: None,
            });
            continue;
        }

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

        let has_name_arg = attr.args.iter().any(|a| a.name == "name");
        if has_expression_arg && !has_name_arg {
            errors.push(ValidationError {
                message: format!(
                    "Expression {attr_label} on model \"{model_name}\" requires an explicit \"name\" argument."
                ),
                model: Some(model_name.clone()),
                field: None,
            });
        }

        match explicit_name {
            Some(name) => sources.push(NameSource { name, explicit: true }),
            None if !columns.is_empty() => sources.push(NameSource {
                name: derived_index_name(&table_db_name, &columns, unique),
                explicit: false,
            }),
            None => {}
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

// ─── `@@realtime(columns:…)` (realtime-column-projection PR 1) ──────────────
//
// `rules.rs`'s `ArgShape::Realtime` only gates the coarse arg count (via the
// generic dispatch in `validate_attributes`, mirroring how `Allow` bypasses
// `check_shape`); this function owns the deep diagnostics: unknown/
// non-scalar field references, duplicate entries, and the closed
// `columns:`-only named-key vocabulary. `columns: []` is deliberately valid
// (design decision 5b) — no empty-list diagnostic exists anywhere below.

/// Validates one `@@realtime` attribute's optional `columns:` argument.
/// Bare `@@realtime` (no arguments at all) produces no diagnostic here.
fn validate_realtime_columns(errors: &mut Vec<ValidationError>, model: &Model, attr: &Attribute) {
    let model_name = model.name.clone();

    // Any positional argument, or any named argument other than `columns`,
    // is rejected — `columns` is the only argument `@@realtime` accepts.
    for arg in &attr.args {
        if arg.name != "columns" {
            errors.push(ValidationError {
                message: format!(
                    "Attribute \"@@realtime\" on model \"{model_name}\" accepts only a \"columns:\" argument."
                ),
                model: Some(model_name.clone()),
                field: None,
            });
        }
    }

    let Some(value) = named_arg(Some(attr), "columns") else { return };
    let names = as_reference_list(Some(value));

    let mut seen: HashSet<&str> = HashSet::new();
    for name in &names {
        if !seen.insert(name.as_str()) {
            errors.push(ValidationError {
                message: format!(
                    "Duplicate column \"{name}\" in @@realtime(columns) on model \"{model_name}\"."
                ),
                model: Some(model_name.clone()),
                field: None,
            });
            continue;
        }
        let is_scalar_field = model
            .fields
            .iter()
            .find(|f| &f.name == name)
            .is_some_and(|f| is_scalar(&f.field_type.name) && !f.field_type.list);
        if !is_scalar_field {
            errors.push(ValidationError {
                message: format!(
                    "@@realtime(columns) references unknown or non-scalar field \"{name}\" on model \"{model_name}\"."
                ),
                model: Some(model_name.clone()),
                field: None,
            });
        }
    }
}

// ─── `@@allow` (realtime-rls-allow-rule PR A) ────────────────────────────────
//
// `rules.rs`'s `ArgShape::Allow` only gates coarse shape (handled generically
// by `check_shape` for every other shape); `@@allow` needs deep, structural
// diagnostics (action vocabulary, closed claim vocabulary, path shape, field
// existence/scalar-ness, claim-vs-literal, constant predicate, policy-name
// length) that don't fit `check_shape`'s uniform table, so it gets its own
// pass — mirroring how `Default`/`Relation` already bypass `check_shape`.
// `resolve.rs`/`ir.rs` are deliberately untouched here (PR B).

const ALLOW_ALLOWED_ACTIONS_TEXT: &str = "create, read, update, delete, write, all";

/// Renders any `AttributeValue` for a diagnostic message when it doesn't fit
/// the expected shape (e.g. a number where a path/action was expected).
fn describe_value(value: &AttributeValue) -> String {
    match value {
        AttributeValue::String { value } => format!("\"{value}\""),
        AttributeValue::Number { value } => value.to_string(),
        AttributeValue::Boolean { value } => value.to_string(),
        AttributeValue::Reference { value } => value.clone(),
        AttributeValue::Function { name, .. } => format!("{name}(...)"),
        AttributeValue::Array { .. } => "[...]".to_string(),
        AttributeValue::Path { segments } => segments.join("."),
        AttributeValue::Comparison { .. } => "<comparison>".to_string(),
    }
}

/// `@@allow`'s action argument: a bare reference (`read`) or a reference/
/// string array (`[create, update]`). `None` for anything else (design
/// decision 5 — arrays and bare references already parse, no third grammar).
fn allow_action_names(value: &AttributeValue) -> Option<Vec<String>> {
    match value {
        AttributeValue::Reference { value } => Some(vec![value.clone()]),
        AttributeValue::Array { values } => {
            let mut names = Vec::with_capacity(values.len());
            for v in values {
                match v {
                    AttributeValue::Reference { value } | AttributeValue::String { value } => {
                        names.push(value.clone());
                    }
                    _ => return None,
                }
            }
            Some(names)
        }
        _ => None,
    }
}

/// Expands one accepted action name (canonical or alias) to its canonical
/// set, in declaration order (design decision 6). `None` if `name` isn't a
/// known action at all — callers only use this after `allow_action_names`
/// entries are already known-valid.
fn canonical_actions_for(name: &str) -> Option<Vec<&'static str>> {
    if let Some(action) = rules::ALLOW_ACTIONS.iter().find(|a| **a == name) {
        return Some(vec![*action]);
    }
    rules::ALLOW_ALIASES.iter().find(|(alias, _)| *alias == name).map(|(_, expanded)| expanded.to_vec())
}

enum AllowOperandKind {
    Field,
    Claim,
    Literal,
}

/// Validates one side of a `@@allow` equality condition: it must be a
/// `this.<field>` path to a known scalar (non-list) field, an `auth.userId`
/// path, or a literal. Pushes exactly one diagnostic and returns `None` on
/// any other shape.
fn validate_allow_operand(
    errors: &mut Vec<ValidationError>,
    model: &Model,
    model_name: &str,
    value: &AttributeValue,
) -> Option<AllowOperandKind> {
    let bad_path = |errors: &mut Vec<ValidationError>, rendered: String| {
        errors.push(ValidationError {
            message: format!(
                "Invalid path \"{rendered}\" in @@allow on model \"{model_name}\". Each side must be this.<field>, auth.userId or a literal."
            ),
            model: Some(model_name.to_string()),
            field: None,
        });
    };

    match value {
        AttributeValue::Path { segments } => {
            if segments.len() != 2 {
                bad_path(errors, segments.join("."));
                return None;
            }
            let root = segments[0].as_str();
            let name = segments[1].as_str();
            match root {
                "this" => match model.fields.iter().find(|f| f.name == name) {
                    Some(f) if is_scalar(&f.field_type.name) && !f.field_type.list => Some(AllowOperandKind::Field),
                    _ => {
                        errors.push(ValidationError {
                            message: format!(
                                "@@allow references unknown or non-scalar field \"{name}\" on model \"{model_name}\"."
                            ),
                            model: Some(model_name.to_string()),
                            field: None,
                        });
                        None
                    }
                },
                "auth" => {
                    if rules::AUTH_CLAIMS.contains(&name) {
                        Some(AllowOperandKind::Claim)
                    } else {
                        errors.push(ValidationError {
                            message: format!(
                                "Unknown auth claim \"auth.{name}\" in @@allow on model \"{model_name}\". Only auth.userId is supported."
                            ),
                            model: Some(model_name.to_string()),
                            field: None,
                        });
                        None
                    }
                }
                _ => {
                    bad_path(errors, segments.join("."));
                    None
                }
            }
        }
        AttributeValue::String { .. } | AttributeValue::Number { .. } | AttributeValue::Boolean { .. } => {
            Some(AllowOperandKind::Literal)
        }
        other => {
            bad_path(errors, describe_value(other));
            None
        }
    }
}

/// Deep validation of one `@@allow(action, condition)` attribute: arity,
/// action vocabulary, condition shape/operator, operand shapes, claim-vs-
/// literal, and constant-predicate rejection. Policy-name-length is a
/// separate, cross-attribute pass (`validate_allow_policy_names`) because it
/// depends on every `@@allow` on the model, not just this one.
fn validate_allow(errors: &mut Vec<ValidationError>, model: &Model, attr: &Attribute) {
    let model_name = model.name.clone();

    for arg in &attr.args {
        if !arg.name.is_empty() {
            errors.push(ValidationError {
                message: format!(
                    "Unsupported \"{}\" argument on @@allow on model \"{model_name}\".",
                    arg.name
                ),
                model: Some(model_name.clone()),
                field: None,
            });
        }
    }

    let positional: Vec<&AttributeArg> = attr.args.iter().filter(|a| a.name.is_empty()).collect();
    let arity_error = |errors: &mut Vec<ValidationError>| {
        errors.push(ValidationError {
            message: format!(
                "Attribute \"@@allow\" on model \"{model_name}\" requires an action and a single equality condition."
            ),
            model: Some(model_name.clone()),
            field: None,
        });
    };
    if positional.len() != 2 {
        arity_error(errors);
        return;
    }

    match allow_action_names(&positional[0].value) {
        None => arity_error(errors),
        Some(names) => {
            for name in &names {
                let known = rules::ALLOW_ACTIONS.contains(&name.as_str())
                    || rules::ALLOW_ALIASES.iter().any(|(alias, _)| alias == name);
                if !known {
                    errors.push(ValidationError {
                        message: format!(
                            "Invalid @@allow action \"{name}\" on model \"{model_name}\". Allowed: {ALLOW_ALLOWED_ACTIONS_TEXT}."
                        ),
                        model: Some(model_name.clone()),
                        field: None,
                    });
                }
            }
        }
    }

    match &positional[1].value {
        AttributeValue::Comparison { op, left, right } => {
            if op != "==" {
                errors.push(ValidationError {
                    message: format!(
                        "Unsupported operator \"{op}\" in @@allow on model \"{model_name}\". Only \"==\" is supported."
                    ),
                    model: Some(model_name.clone()),
                    field: None,
                });
                return;
            }
            let left_kind = validate_allow_operand(errors, model, &model_name, left);
            let right_kind = validate_allow_operand(errors, model, &model_name, right);
            let (Some(left_kind), Some(right_kind)) = (left_kind, right_kind) else {
                return;
            };
            match (&left_kind, &right_kind) {
                (AllowOperandKind::Claim, AllowOperandKind::Literal)
                | (AllowOperandKind::Literal, AllowOperandKind::Claim) => {
                    errors.push(ValidationError {
                        message: format!(
                            "auth.userId in @@allow on model \"{model_name}\" must be compared against a this.<field> reference."
                        ),
                        model: Some(model_name.clone()),
                        field: None,
                    });
                }
                (AllowOperandKind::Literal, AllowOperandKind::Literal) => {
                    errors.push(ValidationError {
                        message: format!(
                            "@@allow condition on model \"{model_name}\" references neither a field nor auth.userId."
                        ),
                        model: Some(model_name.clone()),
                        field: None,
                    });
                }
                _ => {}
            }
        }
        _ => arity_error(errors),
    }
}

/// Cross-attribute pass: recomputes each rule's would-be Postgres policy
/// name (`indigo_p_<dbName>_<action>_<ordinal>`, design decision 11) and
/// rejects any model where one exceeds `MAX_IDENTIFIER_BYTES` — Postgres
/// silently truncates rather than erroring, so this is checked at compile
/// time. Only counts rules that already passed arity/action validation;
/// `validate_allow` already reported anything else.
fn validate_allow_policy_names(errors: &mut Vec<ValidationError>, model: &Model) {
    let table_db_name = crate::resolve::table_db_name(model);
    let mut ordinals: HashMap<&'static str, usize> = HashMap::new();
    let mut reported = false;

    for attr in &model.attributes {
        if attr.namespace.is_some() || attr.name != "allow" {
            continue;
        }
        let positional: Vec<&AttributeArg> = attr.args.iter().filter(|a| a.name.is_empty()).collect();
        if positional.len() != 2 {
            continue;
        }
        let Some(action_names) = allow_action_names(&positional[0].value) else { continue };
        for name in &action_names {
            let Some(canonical) = canonical_actions_for(name) else { continue };
            for action in canonical {
                let ordinal = ordinals.entry(action).or_insert(0);
                let policy_name = format!("indigo_p_{table_db_name}_{action}_{ordinal}");
                if !reported && policy_name.len() > rules::MAX_IDENTIFIER_BYTES {
                    errors.push(ValidationError {
                        message: format!(
                            "Generated policy name for model \"{}\" exceeds 63 bytes; shorten the model or @@map name.",
                            model.name
                        ),
                        model: Some(model.name.clone()),
                        field: None,
                    });
                    reported = true;
                }
                *ordinal += 1;
            }
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

    // `HashMap` iteration order is process-random (SipHash), so diagnostics
    // pushed while iterating `groups` directly would reorder nondeterministically
    // across builds/runs — including across WASM rebuilds, which breaks golden
    // snapshot stability. Sort by key first so diagnostic order is deterministic.
    let mut sorted_groups: Vec<(&(String, String), &Vec<Candidate>)> = groups.iter().collect();
    sorted_groups.sort_by(|(a, _), (b, _)| a.cmp(b));

    for ((a, b), candidates) in sorted_groups {
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

    // ─── @@allow (realtime-rls-allow-rule, PR A) ─────────────────────────────

    #[test]
    fn allow_wrong_arity_is_rejected() {
        let errors = validate_source(
            r#"
Table Post {
  id String @id
  ownerId Int
  @@allow(read)
}
"#,
        );
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].model.as_deref(), Some("Post"));
        assert!(errors[0].message.contains("requires an action and a single equality condition"));
    }

    #[test]
    fn allow_non_comparison_condition_is_rejected() {
        let errors = validate_source(
            r#"
Table Post {
  id String @id
  ownerId Int
  @@allow(read, 123)
}
"#,
        );
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("requires an action and a single equality condition"));
    }

    #[test]
    fn allow_unknown_action_is_rejected() {
        let errors = validate_source(
            r#"
Table Post {
  id String @id
  ownerId Int
  @@allow(select, auth.userId == this.ownerId)
}
"#,
        );
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("Invalid @@allow action \"select\""));
    }

    #[test]
    fn allow_unknown_claim_is_rejected() {
        let errors = validate_source(
            r#"
Table Post {
  id String @id
  role String
  @@allow(read, auth.role == this.role)
}
"#,
        );
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("\"auth.role\""));
        assert!(errors[0].message.contains("Only auth.userId is supported"));
    }

    #[test]
    fn allow_bad_path_root_is_rejected() {
        let errors = validate_source(
            r#"
Table Post {
  id String @id
  ownerId Int
  @@allow(read, auth.userId == post.ownerId)
}
"#,
        );
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("Invalid path \"post.ownerId\""));
    }

    #[test]
    fn allow_unknown_or_non_scalar_field_is_rejected() {
        let errors = validate_source(
            r#"
Table Post {
  id String @id
  ownerId Int
  @@allow(read, auth.userId == this.owner)
}
"#,
        );
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("unknown or non-scalar field \"owner\""));
    }

    #[test]
    fn allow_claim_vs_literal_is_rejected() {
        let errors = validate_source(
            r#"
Table Post {
  id String @id
  ownerId Int
  @@allow(read, auth.userId == "42")
}
"#,
        );
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("must be compared against a this.<field> reference"));
    }

    #[test]
    fn allow_constant_predicate_is_rejected() {
        let errors = validate_source(
            r#"
Table Post {
  id String @id
  ownerId Int
  @@allow(read, true == true)
}
"#,
        );
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("references neither a field nor auth.userId"));
    }

    #[test]
    fn allow_policy_name_over_63_bytes_is_rejected() {
        let errors = validate_source(
            r#"
Table Post {
  id String @id
  ownerId Int
  @@map("a_very_long_table_name_that_pushes_the_generated_policy_name_past_the_postgres_limit")
  @@allow(read, auth.userId == this.ownerId)
}
"#,
        );
        assert!(errors.iter().any(|e| e.message.contains("exceeds 63 bytes")), "errors: {errors:?}");
    }

    #[test]
    fn allow_realtime_combination_is_accepted() {
        // `realtime-live-endpoint` PR B: the `@@realtime` + `@@allow`
        // mutual-exclusion guard is lifted. Guard removal and SSE wake-up
        // scoping (packages/realtime/src/engine.ts) ship together — the
        // scoped `{table,op,lsn}` SSE frame plus the RLS-enforced
        // `GET ?handle&offset` read path are jointly what makes the
        // combination safe. No diagnostic naming this conflict should be
        // produced for a model combining both.
        let errors = validate_source(
            r#"
Table Post {
  id String @id
  ownerId Int
  @@realtime
  @@allow(read, auth.userId == this.ownerId)
}
"#,
        );
        assert!(
            !errors.iter().any(|e| e.message.contains("cannot be both @@realtime and @@allow")),
            "expected zero diagnostics naming the @@realtime+@@allow conflict, got: {errors:?}"
        );
    }

    #[test]
    fn allow_bare_single_action_accepted() {
        let errors = validate_source(
            r#"
Table Post {
  id String @id
  ownerId Int
  @@allow(read, auth.userId == this.ownerId)
}
"#,
        );
        assert!(errors.is_empty(), "unexpected diagnostics: {errors:?}");
    }

    #[test]
    fn allow_action_array_accepted() {
        let errors = validate_source(
            r#"
Table Post {
  id String @id
  ownerId Int
  @@allow([create, update], auth.userId == this.ownerId)
}
"#,
        );
        assert!(errors.is_empty(), "unexpected diagnostics: {errors:?}");
    }

    #[test]
    fn allow_field_vs_literal_accepted() {
        let errors = validate_source(
            r#"
Table Post {
  id String @id
  isPublic Boolean
  @@allow(read, this.isPublic == true)
}
"#,
        );
        assert!(errors.is_empty(), "unexpected diagnostics: {errors:?}");
    }

    #[test]
    fn allow_multiple_rules_on_one_action_accepted() {
        let errors = validate_source(
            r#"
Table Post {
  id String @id
  ownerId Int
  isPublic Boolean
  @@allow(read, auth.userId == this.ownerId)
  @@allow(read, this.isPublic == true)
}
"#,
        );
        assert!(errors.is_empty(), "unexpected diagnostics: {errors:?}");
    }

    // ─── @@realtime(columns:…) (realtime-column-projection PR 1) ────────────

    #[test]
    fn realtime_columns_unknown_field_is_rejected() {
        // RCP-5 — a listed column referencing no field on the model.
        let errors = validate_source(
            r#"
Table User {
  id String @id
  email String
  @@realtime(columns: [id, secret])
}
"#,
        );
        assert!(
            errors.iter().any(|e| e.message
                == "@@realtime(columns) references unknown or non-scalar field \"secret\" on model \"User\"."),
            "{errors:?}"
        );
    }

    #[test]
    fn realtime_columns_relation_field_is_rejected() {
        // RCP-5 / DX-1 — a relation (non-scalar) field listed in `columns`
        // shares the same diagnostic class as an unknown field.
        let errors = validate_source(
            r#"
Table Author {
  id String @id
}

Table Post {
  id String @id
  author Author @relation(fields: [authorId], references: [id])
  authorId String
  @@realtime(columns: [id, author])
}
"#,
        );
        assert!(
            errors.iter().any(|e| e.message
                == "@@realtime(columns) references unknown or non-scalar field \"author\" on model \"Post\"."),
            "{errors:?}"
        );
    }

    #[test]
    fn realtime_columns_duplicate_entry_is_rejected() {
        // RCP-6.
        let errors = validate_source(
            r#"
Table User {
  id String @id
  email String
  @@realtime(columns: [email, id, email])
}
"#,
        );
        assert!(
            errors.iter().any(|e| e.message == "Duplicate column \"email\" in @@realtime(columns) on model \"User\"."),
            "{errors:?}"
        );
    }

    #[test]
    fn realtime_unknown_named_key_is_rejected() {
        // DX-3-adjacent — an unknown named key on @@realtime.
        let errors = validate_source(
            r#"
Table User {
  id String @id
  @@realtime(cols: [id])
}
"#,
        );
        assert!(
            errors.iter().any(|e| e.message == "Attribute \"@@realtime\" on model \"User\" accepts only a \"columns:\" argument."),
            "{errors:?}"
        );
    }

    #[test]
    fn realtime_positional_argument_is_rejected() {
        let errors = validate_source(
            r#"
Table User {
  id String @id
  @@realtime([id])
}
"#,
        );
        assert!(
            errors.iter().any(|e| e.message == "Attribute \"@@realtime\" on model \"User\" accepts only a \"columns:\" argument."),
            "{errors:?}"
        );
    }

    #[test]
    fn realtime_bare_attribute_is_still_accepted() {
        // RCP-1 — bare @@realtime, no columns argument, must stay valid.
        let errors = validate_source(
            r#"
Table User {
  id String @id
  email String
  @@realtime
}
"#,
        );
        assert!(errors.is_empty(), "unexpected diagnostics: {errors:?}");
    }

    #[test]
    fn realtime_empty_columns_list_is_accepted() {
        // decision 5b — an empty allowlist is valid, not an error.
        let errors = validate_source(
            r#"
Table User {
  id String @id
  email String
  @@realtime(columns: [])
}
"#,
        );
        assert!(errors.is_empty(), "unexpected diagnostics: {errors:?}");
    }

    #[test]
    fn realtime_columns_on_index_is_rejected_as_unknown_argument() {
        // RCP-3 — `columns` is exclusive to @@realtime; @@index already
        // rejects it via the existing closed-key machinery.
        let errors = validate_source(
            r#"
Table User {
  id String @id
  a  String
  @@index([a], columns: [a])
}
"#,
        );
        assert!(errors.iter().any(|e| e.message.contains("columns")), "{errors:?}");
    }

    #[test]
    fn allow_named_args_are_rejected() {
        let errors = validate_source(
            r#"
Table Post {
  id String @id
  ownerId Int
  @@allow(read, auth.userId == this.ownerId, name: "x")
}
"#,
        );
        assert!(errors.iter().any(|e| e.message.contains("\"name\"")), "errors: {errors:?}");
    }
}
