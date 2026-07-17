import { create } from 'zustand';
import type { ResolvedSchema } from '@indigodb/core';
import { Table, RecentSchema, SystemAlert } from '../types';
import { INITIAL_TABLES, INITIAL_SCHEMAS, INITIAL_ALERTS } from '../data/mockData';

/**
 * The mock `users` table ships 4 sample rows but its `recordCount` is meant to
 * look like a real production table in the standalone demo — replaced with
 * the real count once a backend/updateTableRecords writes non-mock data.
 */
const MOCK_USERS_DISPLAY_RECORD_COUNT = 1_200_000;

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
          recordCount: newRecords.length === 4 ? MOCK_USERS_DISPLAY_RECORD_COUNT : newRecords.length
        };
      }
      return t;
    })
  }))
}));
