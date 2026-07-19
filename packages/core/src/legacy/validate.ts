/**
 * @indigodb/core — Validator
 *
 * Semantic checks over a parsed `.indigo` schema, run before resolution or
 * codegen. Returns a list of errors (empty === valid) rather than throwing,
 * so callers can surface all problems at once.
 */

import type { Schema, Field } from "@indigodb/ast";
import { SCALAR_TYPES } from "@indigodb/ast";
import type { ValidationError } from "../ir.js";
import { getAttr, namedArg, asReferenceList } from "../attributes.js";

export function validate(schema: Schema): ValidationError[] {
  const errors: ValidationError[] = [];
  const enumNames = new Set(schema.enums.map((e) => e.name));
  const modelNames = new Set(schema.models.map((m) => m.name));

  // Duplicate model names.
  const seenModels = new Set<string>();
  for (const model of schema.models) {
    if (seenModels.has(model.name)) {
      errors.push({ message: `Duplicate model "${model.name}".`, model: model.name });
    }
    seenModels.add(model.name);
  }

  for (const model of schema.models) {
    const fieldNames = new Set(model.fields.map((f) => f.name));
    let pkCount = 0;

    for (const field of model.fields) {
      const typeName = field.type.name;
      const isScalar = SCALAR_TYPES.has(typeName);
      const isEnum = enumNames.has(typeName);
      const isModel = modelNames.has(typeName);

      if (!isScalar && !isEnum && !isModel) {
        errors.push({
          message: `Unknown type "${typeName}" on field "${field.name}".`,
          model: model.name,
          field: field.name,
        });
      }

      if (getAttr(field.attributes, "id")) pkCount++;

      // Validate @relation references point at real local + target fields.
      if (isModel) {
        validateRelation(errors, schema, model.name, field, typeName, enumNames);
      }
    }

    if (pkCount === 0 && model.fields.length > 0) {
      errors.push({
        message: `Model "${model.name}" has no @id primary key.`,
        model: model.name,
      });
    }

    // @@realtime needs a PK: the notify trigger and client refetch key on it.
    if (getAttr(model.attributes, "realtime") && pkCount === 0) {
      errors.push({
        message: `Model "${model.name}" is @@realtime but has no @id primary key.`,
        model: model.name,
      });
    }
    // Reference fieldNames so the set is not flagged unused if checks evolve.
    void fieldNames;
  }

  return errors;
}

function validateRelation(
  errors: ValidationError[],
  schema: Schema,
  modelName: string,
  field: Field,
  targetModel: string,
  _enumNames: Set<string>,
): void {
  const relAttr = getAttr(field.attributes, "relation");
  if (!relAttr) return; // inverse side without @relation is allowed

  const localRefs = asReferenceList(namedArg(relAttr, "fields"));
  const targetRefs = asReferenceList(namedArg(relAttr, "references"));

  const localModel = schema.models.find((m) => m.name === modelName)!;
  for (const ref of localRefs) {
    if (!localModel.fields.some((f) => f.name === ref)) {
      errors.push({
        message: `@relation(fields:) references unknown local field "${ref}".`,
        model: modelName,
        field: field.name,
      });
    }
  }

  const target = schema.models.find((m) => m.name === targetModel);
  for (const ref of targetRefs) {
    if (target && !target.fields.some((f) => f.name === ref)) {
      errors.push({
        message: `@relation(references:) points at unknown field "${ref}" on "${targetModel}".`,
        model: modelName,
        field: field.name,
      });
    }
  }
}
