/**
 * @indigodb/core — Resolver
 *
 * Transforms a parsed `.indigo` `Schema` AST into the normalized relational
 * `ResolvedSchema` IR: physical tables/columns, primary keys, foreign keys,
 * indexes, relation fields and doc/diagram metadata.
 */

import type {
  Schema,
  Model,
  Field,
  Attribute,
  AttributeValue,
} from "@indigodb/ast";
import { SCALAR_TYPES, RelationType } from "@indigodb/ast";
import type {
  ResolvedSchema,
  ResolvedTable,
  ResolvedTableGroup,
  ResolvedColumn,
  ResolvedDefault,
  ForeignKey,
  ResolvedIndex,
  ResolvedRelation,
} from "../ir.js";
import {
  getAttr,
  hasAttr,
  namedArg,
  asString,
  asReferenceList,
  firstString,
} from "../attributes.js";

/** Physical name of a model (`@@map` override, else model name). */
function tableDbName(model: Model): string {
  return firstString(getAttr(model.attributes, "map")) ?? model.name;
}

/** Physical name of a field (`@map` override, else field name). */
function fieldDbName(field: Field): string {
  return firstString(getAttr(field.attributes, "map")) ?? field.name;
}

/** Resolves a `@default(...)` attribute into a ResolvedDefault. */
function resolveDefault(field: Field): ResolvedDefault | undefined {
  const attr = getAttr(field.attributes, "default");
  if (!attr) return undefined;
  const value: AttributeValue | undefined = attr.args.find(
    (a) => a.name === "",
  )?.value;
  if (!value) return undefined;

  switch (value.kind) {
    case "string":
      return { kind: "value", value: value.value };
    case "number":
      return { kind: "value", value: value.value };
    case "boolean":
      return { kind: "value", value: value.value };
    case "function":
      return { kind: "function", name: value.name };
    case "reference":
      // e.g. `@default(USER)` for an enum member.
      return { kind: "value", value: value.value };
    default:
      return undefined;
  }
}

/** Builds a physical column from a scalar or enum field. */
function resolveColumn(field: Field, isEnum: boolean): ResolvedColumn {
  const def = resolveDefault(field);
  return {
    name: field.name,
    dbName: fieldDbName(field),
    type: field.type.name,
    isEnum,
    nullable: field.type.optional,
    isPk: hasAttr(field.attributes, "id"),
    unique: hasAttr(field.attributes, "unique"),
    autoincrement: def?.kind === "function" && def.name === "autoincrement",
    default: def,
    note: firstString(getAttr(field.attributes, "note")),
  };
}

/** Reads block-level `@@index` / `@@unique` into ResolvedIndex entries. */
function resolveIndexes(
  model: Model,
  fieldToDb: Map<string, string>,
): ResolvedIndex[] {
  const indexes: ResolvedIndex[] = [];
  for (const attr of model.attributes) {
    if (attr.name !== "index" && attr.name !== "unique") continue;
    const cols = firstArrayRefs(attr).map((c) => fieldToDb.get(c) ?? c);
    if (cols.length === 0) continue;
    indexes.push({ columns: cols, unique: attr.name === "unique" });
  }
  return indexes;
}

/** First positional array argument as a list of references (`@@index([a, b])`). */
function firstArrayRefs(attr: Attribute): string[] {
  const value = attr.args.find((a) => a.name === "")?.value;
  return asReferenceList(value);
}

/**
 * Resolves relation fields (fields whose type is another model) into relation
 * metadata and, for the FK-holding side, a ForeignKey.
 */
function resolveRelations(
  model: Model,
  modelDbNames: Map<string, string>,
  fieldDbNamesByModel: Map<string, Map<string, string>>,
): { relations: ResolvedRelation[]; foreignKeys: ForeignKey[] } {
  const relations: ResolvedRelation[] = [];
  const foreignKeys: ForeignKey[] = [];
  const localFieldDb = fieldDbNamesByModel.get(model.name)!;

  for (const field of model.fields) {
    if (SCALAR_TYPES.has(field.type.name)) continue;
    // Skip enum-typed fields — those are columns, handled elsewhere.
    if (!modelDbNames.has(field.type.name)) continue;

    const targetModel = field.type.name;
    const relAttr = getAttr(field.attributes, "relation");
    const localRefs = asReferenceList(namedArg(relAttr, "fields"));
    const targetRefs = asReferenceList(namedArg(relAttr, "references"));
    const onDelete = asString(namedArg(relAttr, "onDelete"));

    const holdsFk = localRefs.length > 0;
    const fkColumns = localRefs.map((r) => localFieldDb.get(r) ?? r);
    const targetFieldDb = fieldDbNamesByModel.get(targetModel);
    const refColumns = targetRefs.map((r) => targetFieldDb?.get(r) ?? r);

    // Cardinality: a list field is one-to-many; a singular FK-holding field is
    // one-to-one when the FK column is unique, otherwise many-to-one (modeled
    // as OneToMany from the referenced side's perspective).
    let type: RelationType;
    if (field.type.list) {
      type = RelationType.OneToMany;
    } else if (holdsFk) {
      const fkUnique = localRefs.some((r) => {
        const f = model.fields.find((mf) => mf.name === r);
        return f ? hasAttr(f.attributes, "unique") : false;
      });
      type = fkUnique ? RelationType.OneToOne : RelationType.OneToMany;
    } else {
      type = RelationType.OneToOne;
    }

    relations.push({
      name: field.name,
      targetModel,
      type,
      list: field.type.list,
      optional: field.type.optional,
      fkColumns,
      refColumns,
    });

    if (holdsFk && refColumns.length > 0) {
      foreignKeys.push({
        columns: fkColumns,
        refTable: modelDbNames.get(targetModel) ?? targetModel,
        refColumns,
        onDelete: onDelete ?? undefined,
      });
    }
  }

  return { relations, foreignKeys };
}

/** Resolves a parsed schema into the relational IR. */
export function resolve(schema: Schema): ResolvedSchema {
  const enumNames = new Set(schema.enums.map((e) => e.name));
  const modelDbNames = new Map<string, string>();
  const fieldDbNamesByModel = new Map<string, Map<string, string>>();

  // Pass 1: physical name maps, needed to resolve cross-model FK references.
  for (const model of schema.models) {
    modelDbNames.set(model.name, tableDbName(model));
    const fieldMap = new Map<string, string>();
    for (const field of model.fields) fieldMap.set(field.name, fieldDbName(field));
    fieldDbNamesByModel.set(model.name, fieldMap);
  }

  // Table group membership: each table inherits its containing group's color.
  const groupByTable = new Map<string, { name: string; color?: string }>();
  for (const g of schema.tableGroups) {
    for (const tableName of g.tables) {
      groupByTable.set(tableName, { name: g.name, color: g.color });
    }
  }

  // Pass 2: build tables.
  const tables: ResolvedTable[] = schema.models.map((model) => {
    const fieldToDb = fieldDbNamesByModel.get(model.name)!;

    const columns: ResolvedColumn[] = [];
    const primaryKey: string[] = [];
    for (const field of model.fields) {
      const isScalar = SCALAR_TYPES.has(field.type.name);
      const isEnum = enumNames.has(field.type.name);
      if (!isScalar && !isEnum) continue; // relation field, not a column
      if (field.type.list && !isScalar && !isEnum) continue;
      const col = resolveColumn(field, isEnum);
      columns.push(col);
      if (col.isPk) primaryKey.push(col.dbName);
    }

    const { relations, foreignKeys } = resolveRelations(
      model,
      modelDbNames,
      fieldDbNamesByModel,
    );

    const group = groupByTable.get(model.name);

    return {
      name: model.name,
      dbName: modelDbNames.get(model.name)!,
      columns,
      primaryKey,
      foreignKeys,
      indexes: resolveIndexes(model, fieldToDb),
      relations,
      note: firstString(getAttr(model.attributes, "note")),
      realtime: hasAttr(model.attributes, "realtime") || undefined,
      color: group?.color,
      group: group?.name,
    };
  });

  const tableGroups: ResolvedTableGroup[] = schema.tableGroups.map((g) => ({
    name: g.name,
    color: g.color,
    tables: g.tables,
  }));

  return {
    tables,
    tableGroups,
    enums: schema.enums.map((e) => ({
      name: e.name,
      values: e.values.map((v) => v.name),
    })),
    datasource: schema.datasources[0],
  };
}
