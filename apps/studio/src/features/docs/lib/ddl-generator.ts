/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ResolvedIndex } from '@indigodb/core';
import type { Table } from '../../../types';

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
  return `${keyword} ${name}ON ${table.schema}.${table.name} ${using}(${index.columns.join(', ')});`;
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
  return table.columns.filter((col) => col.isPK).map((col) => col.name);
}

/** Renders a display-only `CREATE TABLE` DDL snippet for a table (doc view). */
export function generateTableDDL(table: Table): string {
  const pkColumns = primaryKeyColumns(table);

  const columnLines = table.columns.map((col) => {
    let line = `  ${col.name} ${col.type.toLowerCase()}`;
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
