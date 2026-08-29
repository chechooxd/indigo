import { create } from 'zustand';
import type { ResolvedSchema } from '@indigodb/core';
import { Table, RecentSchema, SystemAlert } from '../types';
import { INITIAL_TABLES, INITIAL_SCHEMAS, INITIAL_ALERTS } from '../data/mockData';
import { rowKey } from '../lib/rowKey';

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
}

export const useDataStore = create<DataState>((set) => ({
  schemas: INITIAL_SCHEMAS,
  alerts: INITIAL_ALERTS,
  tables: INITIAL_TABLES,
  resolvedSchema: null,
  setResolvedSchema: (schema) => set({ resolvedSchema: schema }),

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
}));
