/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import type { Table } from '../types';

/** Unit separator (ASCII 0x1F) — vanishingly unlikely to appear inside a
 * real primary-key value, unlike a printable delimiter such as `:` or `|`. */
const KEY_SEPARATOR = '';

/**
 * The primary-key columns of `table`, in declaration order. Falls back to a
 * column literally named `id` when no column is flagged `isPK` (mock/sample
 * data predates schema-driven primary keys).
 */
function pkColumns(table: Table): string[] {
  const pk = table.columns.filter((c) => c.isPK).map((c) => c.name);
  if (pk.length > 0) return pk;
  return table.columns.some((c) => c.name === 'id') ? ['id'] : [];
}

/**
 * The primary-key values of `row`, in the same order as `pkColumns(table)`.
 * Composite-key-safe: every PK column contributes one entry.
 */
export function pkValues(table: Table, row: Record<string, unknown>): unknown[] {
  return pkColumns(table).map((col) => row[col]);
}

/**
 * A stable string identity for `row` within `table`, built from its primary
 * key value(s). Survives refetch/sort/pagination (unlike a row index), and
 * is composite-key-safe: every PK column's value is joined into one key, so
 * two rows can never collide unless they truly share every PK value.
 *
 * Returns `null` when the table has no primary key column to identify by —
 * callers should treat that as "no stable selection possible".
 */
export function rowKey(table: Table, row: Record<string, unknown>): string | null {
  const cols = pkColumns(table);
  if (cols.length === 0) return null;
  return pkValues(table, row).map((v) => String(v)).join(KEY_SEPARATOR);
}
