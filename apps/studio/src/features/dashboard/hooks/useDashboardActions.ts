/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MouseEvent } from 'react';
import type { RecentSchema, SystemAlert } from '../../../types';
import { useDataStore } from '../../../store/useDataStore';
import { useNavigationStore } from '../../../store/useNavigationStore';

export interface UseDashboardActionsReturn {
  schemas: RecentSchema[];
  alerts: SystemAlert[];

  openCli: () => void;
  quickCreateSchema: () => void;
  goToDesigner: () => void;
  importSchema: () => void;
  goToDataExplorer: () => void;
  viewAllSchemas: () => void;
  toggleSchemaActive: (id: string) => void;
  editSchema: (id: string) => void;
  removeSchema: (id: string, e: MouseEvent) => void;
  clearAlerts: () => void;
}

export function useDashboardActions(): UseDashboardActionsReturn {
  const {
    schemas,
    setSchemas,
    alerts,
    clearAlerts,
    addNewSchema,
    removeSchema: removeSchemaFromStore,
    toggleSchemaActive,
  } = useDataStore();
  const { navigate } = useNavigationStore();

  const openCli = () => {
    alert("Simulating CLI Connection...\n\nIndigoDB-CLI connected successfully on port 3000.\nRun 'indigo help' to see list of valid migration and sync instructions.");
  };

  const quickCreateSchema = () => {
    const name = prompt('Enter a name for your new database schema:', 'new_analytical_dw');
    if (name) {
      addNewSchema(name);
      navigate('editor');
    }
  };

  const goToDesigner = () => navigate('editor');

  const importSchema = () => {
    const ddlInput = prompt('Enter schema title:');
    if (ddlInput) {
      setSchemas((prev) => [
        { id: String(prev.length + 1), name: ddlInput.toLowerCase().replace(/ /g, '_'), tablesCount: 1, type: 'PostgreSQL', lastModified: 'Just imported', isActive: false },
        ...prev,
      ]);
    }
  };

  const goToDataExplorer = () => navigate('studio', 'data');

  const viewAllSchemas = () => {
    alert('Showing all schemas. Active schema is highlighted with an emerald indicator.');
  };

  const editSchema = (id: string) => {
    toggleSchemaActive(id);
    navigate('editor');
  };

  const removeSchema = (id: string, e: MouseEvent) => {
    e.stopPropagation();
    removeSchemaFromStore(id);
  };

  return {
    schemas,
    alerts,
    openCli,
    quickCreateSchema,
    goToDesigner,
    importSchema,
    goToDataExplorer,
    viewAllSchemas,
    toggleSchemaActive,
    editSchema,
    removeSchema,
    clearAlerts,
  };
}
