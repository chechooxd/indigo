/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface TableColumn {
  name: string;
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
   * Composite-safe. Absent on mock/sample data (falls back to `id`). */
  primaryKey?: string[];
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
