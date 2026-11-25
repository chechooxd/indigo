/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import type { ResolvedIndex } from '@indigodb/core';
import type { Table, TableColumn } from '../../../types';

/**
 * Resolves the physical identifier for a column: `TableColumn.dbName` when
 * present, else `name`. `table.primaryKey` and `table.indexes` are always
 * physical (`ResolvedTable`/`ResolvedIndex`, `ir.ts:194,91`), so column
 * lines MUST render the same physical identifier or a `PRIMARY KEY`/
 * `CREATE INDEX` clause references a column that never appears in the
 * `CREATE TABLE` body — invalid SQL. Falling back to `name` when `dbName`
 * is absent (mock/sample data) is not a fabrication: it mirrors
 * `ResolvedColumn.dbName`'s own "`@map` override, else `name`" rule
 * (`ir.ts:29`) for data that never declared a mapping in the first place.
 */
function physicalName(col: TableColumn): string {
  return col.dbName ?? col.name;
}

/**
 * Renders the `USING <method>` clause for an index, or `''` when absent.
 *
 * Takes the index OBJECT (not a bare `type` argument) so no parameter exists
 * into which a substituted default (e.g. `?? 'btree'`) could be injected.
 * `ir.ts` canonicalizes an explicit `type: btree` to absent, so "absent" is
 * the only state that ever reaches this function for a btree index — it
 * must render nothing, never a fabricated `USING btree`.
 */
function usingClause(index: ResolvedIndex): string {
  return index.type ? `USING ${index.type} ` : '';
}

/** Renders one `CREATE INDEX` / `CREATE UNIQUE INDEX` statement. */
function indexStatement(table: Table, index: ResolvedIndex): string {
  const keyword = index.unique ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX';
  const name = index.name ? `${index.name} ` : '';
  const using = usingClause(index);
  const target = index.expression ?? index.columns.join(', ');
  const where = index.where ? ` WHERE ${index.where}` : '';
  return `${keyword} ${name}ON ${table.schema}.${table.name} ${using}(${target})${where};`;
}

/**
 * Resolves the columns that make up the table-level `PRIMARY KEY` clause.
 *
 * `table.primaryKey` is the real, resolved source of truth. It only falls
 * back to columns actually flagged `isPK` (real declared data, column
 * order) when `primaryKey` itself is absent — never to a hardcoded `id`.
 * When neither is present, the caller emits no `PRIMARY KEY` clause at all.
 */
function primaryKeyColumns(table: Table): string[] {
  if (table.primaryKey && table.primaryKey.length > 0) return table.primaryKey;
  return table.columns.filter((col) => col.isPK).map(physicalName);
}

/** Renders a display-only `CREATE TABLE` DDL snippet for a table (doc view). */
export function generateTableDDL(table: Table): string {
  const pkColumns = primaryKeyColumns(table);

  const columnLines = table.columns.map((col) => {
    let line = `  ${physicalName(col)} ${col.type.toLowerCase()}`;
    if (col.isNN) line += ' NOT NULL';
    if (col.isUQ) line += ' UNIQUE';
    if (col.defaultValue) line += ` DEFAULT ${col.defaultValue}`;
    return line;
  });

  if (pkColumns.length > 0) {
    columnLines.push(`  PRIMARY KEY (${pkColumns.join(', ')})`);
  }

  let code = `CREATE TABLE ${table.schema}.${table.name} (\n`;
  code += columnLines.join(',\n');
  code += '\n);';

  const indexes = table.indexes ?? [];
  if (indexes.length > 0) {
    code += '\n\n';
    code += indexes.map((index) => indexStatement(table, index)).join('\n');
  }

  return code;
}
