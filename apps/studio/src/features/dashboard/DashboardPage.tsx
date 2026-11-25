/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import React from 'react';
import { useDashboardActions } from './hooks/useDashboardActions';
import { WelcomeHero } from './components/WelcomeHero';
import { QuickStartCards } from './components/QuickStartCards';
import { RecentSchemasTable } from './components/RecentSchemasTable';
import { AlertsPanel } from './components/AlertsPanel';

export default function DashboardPage() {
  const {
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
  } = useDashboardActions();

  return (
    <div id="dashboard-view" className="flex-1 overflow-y-auto custom-scrollbar bg-[#09090b] p-8">
      <WelcomeHero schemasCount={schemas.length} onQuickCreate={quickCreateSchema} />
      <QuickStartCards onDesigner={goToDesigner} onImport={importSchema} onExplore={goToDataExplorer} />
      <RecentSchemasTable
        schemas={schemas}
        onToggleActive={toggleSchemaActive}
        onEdit={editSchema}
        onRemove={removeSchema}
      />
      <AlertsPanel alerts={alerts} onClearAll={clearAlerts} />
    </div>
  );
}
