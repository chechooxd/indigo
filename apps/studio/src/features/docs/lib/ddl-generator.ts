/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Table } from '../../../types';

/** Renders a display-only `CREATE TABLE` DDL snippet for a table (doc view). */
export function generateTableDDL(table: Table): string {
  let code = `CREATE TABLE ${table.schema}.${table.name} (\n`;
  table.columns.forEach((col, idx) => {
    let line = `  ${col.name} ${col.type.toLowerCase()}`;
    if (col.isPK) line += ' PRIMARY KEY';
    if (col.isNN) line += ' NOT NULL';
    if (col.isUQ) line += ' UNIQUE';
    if (col.defaultValue) line += ` DEFAULT ${col.defaultValue}`;

    const isLast = idx === table.columns.length - 1;
    line += isLast ? '' : ',';
    code += line + '\n';
  });
  code += `);\n\n-- Create optimized index\nCREATE INDEX idx_${table.name}_lookup ON ${table.name}(id);`;
  return code;
}
