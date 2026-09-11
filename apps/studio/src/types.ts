/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ResolvedIndex } from '@indigodb/core';

export interface TableColumn {
  name: string;
  /** Physical column name (`ResolvedColumn.dbName`: `@map` override, else
   * `name`). Absent on mock/sample data, which never declares a mapping —
   * in that case the physical name IS the field name by definition (no
   * override exists to diverge from), so renderers fall back to `name`.
   * That fallback mirrors `ResolvedColumn.dbName`'s own "else name" rule
   * (`ir.ts:29`); it is not a fabricated value. Any renderer that emits a
   * physical identifier (e.g. the docs DDL view) MUST use this field
   * (falling back to `name` only when absent), never `name` directly —
   * `name` may diverge from the real column when `@map` is used. */
  dbName?: string;
  type: string;
  defaultValue?: string;
  isPK: boolean;
  isNN: boolean; // Not Null
  isUQ: boolean; // Unique
  description?: string;
  /** Whether `type` names an enum rather than a built-in scalar. Absent
   * (falsy) on mock/sample data. */
  isEnum?: boolean;
  /** Declared enum values, present only when `isEnum` is true. */
  enumValues?: string[];
  /** Whether the column is database-generated (`@default(autoincrement())`
   * or any other generator function, e.g. `now()`/`uuid()`), and therefore
   * read-only in the editor / excluded from write payloads. Absent (falsy)
   * on mock/sample data. */
  isGenerated?: boolean;
}

export interface Table {
  name: string;
  schema: string;
  /** Whether the table emits realtime change events (`@@realtime`). Absent
   * or `false` on mock/sample data and tables without `@@realtime`. */
  realtime?: boolean;
  /** Primary key column names, in `ResolvedTable.primaryKey` order.
   * Composite-safe. Absent on mock/sample data. This is a consumer/row-identity
   * fallback scope only (e.g. the record editor defaulting to `id` for a key) —
   * it is NOT license for a renderer to invent a `PRIMARY KEY (id)` clause when
   * this field is absent; the docs DDL renderer emits no PRIMARY KEY clause at
   * all in that case (see `features/docs/lib/ddl-generator.ts`). */
  primaryKey?: string[];
  /** Secondary indexes / composite uniques, mirrored structurally from
   * `ResolvedTable.indexes` (`@indigodb/core`). Optional and undefaulted —
   * absent means "unknown" (mock/sample data never populated this), distinct
   * from `[]` ("verified none"), matching the `realtime`/`primaryKey`
   * convention above. */
  indexes?: ResolvedIndex[];
  columns: TableColumn[];
  // Mock rows hold heterogeneous values keyed by column name; callers access
  // arbitrary keys (e.g. row.email, row.id) directly, so values are untyped.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  records: Record<string, any>[];
}

export interface RecentSchema {
  id: string;
  name: string;
  tablesCount: number;
  type: 'PostgreSQL' | 'MySQL' | 'BigQuery' | 'SQLite';
  lastModified: string;
  isActive: boolean;
}

export interface SystemAlert {
  id: string;
  type: 'warning' | 'success' | 'info';
  title: string;
  message: string;
  timestamp: string;
}

export type ViewTab = 'home' | 'editor' | 'studio' | 'docs' | 'settings';
