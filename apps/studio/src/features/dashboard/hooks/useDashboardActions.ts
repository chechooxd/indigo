/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import type { MouseEvent } from 'react';
import type { RecentSchema, SystemAlert } from '../../../types';
import { useDataStore } from '../../../store/useDataStore';
import { useNavigationStore } from '../../../store/useNavigationStore';

export interface UseDashboardActionsReturn {
  schemas: RecentSchema[];
  alerts: SystemAlert[];

  quickCreateSchema: () => void;
  goToDesigner: () => void;
  importSchema: () => void;
  goToDataExplorer: () => void;
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
    quickCreateSchema,
    goToDesigner,
    importSchema,
    goToDataExplorer,
    toggleSchemaActive,
    editSchema,
    removeSchema,
    clearAlerts,
  };
}
