import { create } from 'zustand';
import type { ResolvedSchema } from '@indigodb/core';
import { Table, RecentSchema, SystemAlert } from '../types';
import { INITIAL_TABLES, INITIAL_SCHEMAS, INITIAL_ALERTS } from '../data/mockData';
import { rowKey } from '../lib/rowKey';
import type { PageSize } from '../lib/api';

/** Per-table pagination state, keyed by table name. Absent for a table means
 * "not yet loaded a page" — components fall back to sensible defaults
 * (`cursor: null`, `direction: 'forward'`, `pageSize: 100`). */
export interface TablePageState {
  cursor: string | null;
  direction: 'forward' | 'backward';
  pageSize: PageSize;
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  paginated: boolean;
}

export const DEFAULT_PAGE_SIZE: PageSize = 100;

export function defaultTablePageState(): TablePageState {
  return {
    cursor: null,
    direction: 'forward',
    pageSize: DEFAULT_PAGE_SIZE,
    nextCursor: null,
    prevCursor: null,
    total: 0,
    paginated: true,
  };
}

interface DataState {
  schemas: RecentSchema[];
  alerts: SystemAlert[];
  tables: Table[];
  /** The resolved `.indigo` schema (relations/FKs), set when a backend is present. */
  resolvedSchema: ResolvedSchema | null;
  setResolvedSchema: (schema: ResolvedSchema | null) => void;

  setSchemas: (schemas: RecentSchema[] | ((prev: RecentSchema[]) => RecentSchema[])) => void;
  setAlerts: (alerts: SystemAlert[] | ((prev: SystemAlert[]) => SystemAlert[])) => void;
  setTables: (tables: Table[] | ((prev: Table[]) => Table[])) => void;

  /** Adds a new schema and makes it active. Does not change navigation — callers that
   * want to jump to the editor should also call `useNavigationStore().navigate('editor')`. */
  addNewSchema: (name: string) => void;
  removeSchema: (id: string) => void;
  toggleSchemaActive: (id: string) => void;
  clearAlerts: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateTableRecords: (tableName: string, newRecords: Record<string, any>[]) => void;
  /** Merges `patch` into the single row identified by `key` (per `rowKey`)
   * within `tableName`. Used after a successful `updateRow` write so the
   * grid/inspector reflect the persisted value without a full refetch. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateTableRow: (tableName: string, key: string, patch: Record<string, any>) => void;
  /** Appends a newly-persisted row to `tableName`'s records. Used after a
   * successful `createRow` write so the grid reflects the inserted row
   * without a full refetch. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addTableRow: (tableName: string, row: Record<string, any>) => void;
  /** Removes the single row identified by `key` (per `rowKey`) from
   * `tableName`. Used after a successful `deleteRow` write so the grid
   * reflects the removal without a full refetch. */
  removeTableRow: (tableName: string, key: string) => void;

  /** Per-table pagination state (cursor/direction/page size/total/paginated). */
  pagination: Record<string, TablePageState>;
  /** Replaces the pagination "result" fields (nextCursor/prevCursor/total/paginated)
   * for `tableName` after a page fetch, without touching `cursor`/`direction`/`pageSize`
   * (those are set by `setTablePage`/`setPageSize` before the fetch, not after). */
  setTablePageResult: (
    tableName: string,
    result: Pick<TablePageState, 'nextCursor' | 'prevCursor' | 'total' | 'paginated'>,
  ) => void;
  /** Navigates `tableName` to the given cursor/direction (or back to page one
   * when `cursor` is `null`). Does not itself fetch — callers fetch afterward
   * and report the result via `setTablePageResult`. */
  setTablePage: (tableName: string, cursor: string | null, direction: 'forward' | 'backward') => void;
  /** Changes `tableName`'s page size and resets to page one (`cursor: null`,
   * `direction: 'forward'`), per studio-table-pagination's design. */
  setPageSize: (tableName: string, pageSize: PageSize) => void;
}

export const useDataStore = create<DataState>((set) => ({
  schemas: INITIAL_SCHEMAS,
  alerts: INITIAL_ALERTS,
  tables: INITIAL_TABLES,
  resolvedSchema: null,
  setResolvedSchema: (schema) => set({ resolvedSchema: schema }),

  pagination: {},

  setTablePageResult: (tableName, result) => set((state) => {
    const prev = state.pagination[tableName] ?? defaultTablePageState();
    return { pagination: { ...state.pagination, [tableName]: { ...prev, ...result } } };
  }),

  setTablePage: (tableName, cursor, direction) => set((state) => {
    const prev = state.pagination[tableName] ?? defaultTablePageState();
    return { pagination: { ...state.pagination, [tableName]: { ...prev, cursor, direction } } };
  }),

  setPageSize: (tableName, pageSize) => set((state) => {
    const prev = state.pagination[tableName] ?? defaultTablePageState();
    return {
      pagination: {
        ...state.pagination,
        [tableName]: { ...prev, pageSize, cursor: null, direction: 'forward' },
      },
    };
  }),

  setSchemas: (updater) => set((state) => ({
    schemas: typeof updater === 'function' ? updater(state.schemas) : updater
  })),
  setAlerts: (updater) => set((state) => ({
    alerts: typeof updater === 'function' ? updater(state.alerts) : updater
  })),
  setTables: (updater) => set((state) => ({
    tables: typeof updater === 'function' ? updater(state.tables) : updater
  })),

  addNewSchema: (name: string) => {
    const cleanTitle = name.toLowerCase().trim().replace(/ /g, '_');
    set((state) => {
      const newSchema: RecentSchema = {
        id: String(state.schemas.length + 1),
        name: cleanTitle,
        tablesCount: 0,
        type: 'PostgreSQL',
        lastModified: 'Just now',
        isActive: true
      };
      return {
        schemas: [newSchema, ...state.schemas.map(s => ({ ...s, isActive: false }))],
      };
    });
  },

  removeSchema: (id) => set((state) => ({
    schemas: state.schemas.filter(s => s.id !== id)
  })),

  toggleSchemaActive: (id) => set((state) => ({
    schemas: state.schemas.map(s => s.id === id ? { ...s, isActive: !s.isActive } : { ...s, isActive: false })
  })),

  clearAlerts: () => set({ alerts: [] }),

  updateTableRecords: (tableName, newRecords) => set((state) => ({
    tables: state.tables.map(t => {
      if (t.name.toLowerCase() === tableName.toLowerCase()) {
        return {
          ...t,
          records: newRecords,
        };
      }
      return t;
    })
  })),

  updateTableRow: (tableName, key, patch) => set((state) => ({
    tables: state.tables.map(t => {
      if (t.name.toLowerCase() !== tableName.toLowerCase()) return t;
      return {
        ...t,
        records: t.records.map((row) => (rowKey(t, row) === key ? { ...row, ...patch } : row)),
      };
    })
  })),

  addTableRow: (tableName, row) => set((state) => ({
    tables: state.tables.map(t => {
      if (t.name.toLowerCase() !== tableName.toLowerCase()) return t;
      return {
        ...t,
        records: [...t.records, row],
      };
    })
  })),

  removeTableRow: (tableName, key) => set((state) => ({
    tables: state.tables.map(t => {
      if (t.name.toLowerCase() !== tableName.toLowerCase()) return t;
      return {
        ...t,
        records: t.records.filter((row) => rowKey(t, row) !== key),
      };
    })
  })),
}));
