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
    let one_ref_array = matches!(attr.args.as_slice(), [a] if a.name.is_empty() && matches!(a.value, AttributeValue::Array { .. }));
    let complaint = match shape {
        ArgShape::None if !attr.args.is_empty() => Some("takes no arguments"),
        ArgShape::OneString if !one_string => Some("requires exactly one string argument"),
        ArgShape::OneReferenceArray if !one_ref_array => Some("requires exactly one array argument"),
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

fn validate_attributes(errors: &mut Vec<ValidationError>, schema: &Schema, enum_names: &HashSet<&str>) {
    for model in &schema.models {
        for field in &model.fields {
            let location = loc("field", format!("{}.{}", model.name, field.name));
            for attr in &field.attributes {
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
    for arg in &attr.args {
        let message = if arg.name.is_empty() {
            Some(format!(
                "Attribute \"@relation\" on {location} does not accept positional arguments; use named arguments ({known})."
            ))
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
