/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import type { Table } from '../../../../types';
import type { QueryResult } from '../../../../lib/api';

export type MockQueryOutcome =
  | { ok: true; result: QueryResult }
  | { ok: false; error: string };

/**
 * Minimal standalone-mode SQL simulator: extracts the target table from a
 * `FROM <table>` clause and projects its mock records onto that table's
 * declared columns. Not a real parser — just enough to demo the query
 * console when there's no backend (`indigodb studio`) to run against.
 */
export function executeMockQuery(sql: string, tables: Table[]): MockQueryOutcome {
  const normalizedQuery = sql.trim().toLowerCase();

  const match = normalizedQuery.match(/from\s+([a-zA-Z0-9_]+)/);
  if (!match) {
    return {
      ok: false,
      error: "SQL Syntax Error: Could not determine target table name. Make sure you have a 'FROM <table_name>' clause.",
    };
  }

  const tableName = match[1];
  const targetTable = tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase());

  if (!targetTable) {
    return {
      ok: false,
      error: `Database Error: Relation "${tableName}" does not exist in schema "public" or "billing".`,
    };
  }

  const columns = targetTable.columns.map((c) => c.name);
  const rows = targetTable.records.map((rec) => {
    const rowObj: Record<string, unknown> = {};
    columns.forEach((colName) => {
      rowObj[colName] = rec[colName] !== undefined ? rec[colName] : 'NULL';
    });
    return rowObj;
  });

  // Mock/standalone simulation never caps rows — always untruncated.
  return { ok: true, result: { columns, rows, truncated: false } };
}
