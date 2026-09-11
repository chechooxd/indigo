/**
 * Adapts the shared `@indigodb/core` `ResolvedSchema` into the Studio's own
 * view models (ERD `IndigoSchema` and the data-browser `Table[]`).
 *
 * This is what unifies the Studio onto the single `.indigo` language: both the
 * in-browser ERD editor and the backend now speak the core dialect, resolved by
 * the same `@indigodb/core` resolver.
 */

import type { ResolvedSchema, ResolvedColumn, ResolvedDefault } from '@indigodb/core';
import type { IndigoSchema, Model, Field } from './parser';
import type { Table, TableColumn } from '../types';

function defaultLabel(def: ResolvedDefault | undefined): string | undefined {
  if (!def) return undefined;
  return def.kind === 'function' ? `${def.name}()` : String(def.value);
}

function toField(col: ResolvedColumn): Field {
  return {
    name: col.name,
    type: col.type,
    isPk: col.isPk,
    isUnique: col.unique,
    isNullable: col.nullable,
    default: defaultLabel(col.default),
  };
}

/** Maps a ResolvedSchema into the ERD's IndigoSchema shape. */
export function resolvedToIndigoSchema(resolved: ResolvedSchema): IndigoSchema {
  const dbNameToModel = new Map(resolved.tables.map((t) => [t.dbName, t.name]));

  const models: Model[] = resolved.tables.map((table) => {
    const fields = table.columns.map(toField);

    // Attach relation metadata onto the FK-holding columns so the ERD draws a
    // link (and the node shows the 🔗 marker) for each foreign key.
    for (const fk of table.foreignKeys) {
      const targetModel = dbNameToModel.get(fk.refTable) ?? fk.refTable;
      for (const localDb of fk.columns) {
        const field = fields.find(
          (f) => f.name === localDb || table.columns.find((c) => c.name === f.name)?.dbName === localDb,
        );
        if (field) {
          field.relation = {
            model: targetModel,
            fields: fk.columns,
            references: fk.refColumns,
          };
        }
      }
    }

    return { name: table.name, color: table.color, fields };
  });

  const enums = resolved.enums.map((e) => ({ name: e.name, values: e.values }));

  const tableGroups = resolved.tableGroups.map((g) => ({
    name: g.name,
    color: g.color,
    tables: g.tables,
  }));

  return { models, enums, refs: [], tableGroups };
}

/** Maps a ResolvedSchema into the data-browser's Table[] (without records). */
export function resolvedToTables(resolved: ResolvedSchema): Table[] {
  const enumsByName = new Map(resolved.enums.map((e) => [e.name, e.values]));

  return resolved.tables.map((table) => {
    const columns: TableColumn[] = table.columns.map((col) => ({
      name: col.name,
      dbName: col.dbName,
      type: col.type,
      defaultValue: defaultLabel(col.default),
      isPK: col.isPk,
      isNN: !col.nullable,
      isUQ: col.unique,
      description: col.note,
      isEnum: col.isEnum,
      enumValues: col.isEnum ? enumsByName.get(col.type) : undefined,
      // Read-only rendering per studio-record-editor only applies to a
      // database-generated PRIMARY KEY (autoincrement, or a generator
      // function default like uuid()/now()) — a non-PK column with a
      // generator default (e.g. createdAt) stays editable.
      isGenerated: col.isPk && (col.autoincrement || col.default?.kind === 'function'),
    }));
    return {
      name: table.name,
      schema: 'public',
      realtime: table.realtime,
      primaryKey: table.primaryKey,
      indexes: table.indexes,
      columns,
      records: [],
    };
  });
}
