import { create } from 'zustand';
import type { ResolvedSchema } from '@indigodb/core';
import { Table, RecentSchema, SystemAlert, ViewTab } from '../types';
import { INITIAL_TABLES, INITIAL_SCHEMAS, INITIAL_ALERTS } from '../data/mockData';

interface StudioState {
  // Theme & Settings
  themeAccent: string;
  setThemeAccent: (theme: string) => void;

  // Navigation State
  activeTab: ViewTab;
  studioSubTab: 'query' | 'data';
  currentCluster: string;
  
  // Navigation Actions
  setActiveTab: (tab: ViewTab) => void;
  setStudioSubTab: (subTab: 'query' | 'data') => void;
  setCurrentCluster: (cluster: string) => void;
  navigate: (tab: ViewTab, subTab?: string) => void;

  // Data State
  schemas: RecentSchema[];
  alerts: SystemAlert[];
  tables: Table[];
  /** The resolved `.indigo` schema (relations/FKs), set when a backend is present. */
  resolvedSchema: ResolvedSchema | null;
  setResolvedSchema: (schema: ResolvedSchema | null) => void;

  // Data Actions
  setSchemas: (schemas: RecentSchema[] | ((prev: RecentSchema[]) => RecentSchema[])) => void;
  setAlerts: (alerts: SystemAlert[] | ((prev: SystemAlert[]) => SystemAlert[])) => void;
  setTables: (tables: Table[] | ((prev: Table[]) => Table[])) => void;
  
  addNewSchema: (name: string) => void;
  removeSchema: (id: string) => void;
  toggleSchemaActive: (id: string) => void;
  clearAlerts: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateTableRecords: (tableName: string, newRecords: Record<string, any>[]) => void;
}

export const useStudioStore = create<StudioState>((set) => ({
  // Theme State
  themeAccent: localStorage.getItem('themeAccent') || 'indigo',
  setThemeAccent: (theme) => {
    localStorage.setItem('themeAccent', theme);
    set({ themeAccent: theme });
  },

  // Initial Navigation State
  activeTab: 'home',
  studioSubTab: 'query',
  currentCluster: 'Production Cluster',

  // Navigation Actions
  setActiveTab: (tab) => set({ activeTab: tab }),
  setStudioSubTab: (subTab) => set({ studioSubTab: subTab }),
  setCurrentCluster: (cluster) => set({ currentCluster: cluster }),
  navigate: (tab, subTab) => set((state) => ({ 
    activeTab: tab, 
    studioSubTab: subTab ? (subTab as 'query' | 'data') : state.studioSubTab 
  })),

  // Initial Data State
  schemas: INITIAL_SCHEMAS,
  alerts: INITIAL_ALERTS,
  tables: INITIAL_TABLES,
  resolvedSchema: null,
  setResolvedSchema: (schema) => set({ resolvedSchema: schema }),

  // Data Actions
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
        activeTab: 'editor'
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
          recordCount: newRecords.length === 4 ? 1200000 : newRecords.length
        };
      }
      return t;
    })
  }))
}));
