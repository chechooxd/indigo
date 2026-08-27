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
}

export interface Table {
  name: string;
  schema: string;
  /** Whether the table emits realtime change events (`@@realtime`). Absent
   * or `false` on mock/sample data and tables without `@@realtime`. */
  realtime?: boolean;
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
