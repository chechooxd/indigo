//! Validator — line-by-line port of `packages/core/src/validate.ts`.
//!
//! Error message strings are part of the parity contract: the harness
//! deep-equals `ValidationError[]` against the TS output. Do not reword.

use std::collections::HashSet;

use crate::ast::*;
use crate::ir::ValidationError;

pub fn validate(schema: &Schema) -> Vec<ValidationError> {
    let mut errors = Vec::new();
    let enum_names: HashSet<&str> = schema.enums.iter().map(|e| e.name.as_str()).collect();
    let model_names: HashSet<&str> = schema.models.iter().map(|m| m.name.as_str()).collect();

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
