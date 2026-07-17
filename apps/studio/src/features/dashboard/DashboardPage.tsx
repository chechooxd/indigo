/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
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
  } = useDashboardActions();

  return (
    <div id="dashboard-view" className="flex-1 overflow-y-auto custom-scrollbar bg-[#09090b] p-8">
      <WelcomeHero schemasCount={schemas.length} onOpenCli={openCli} onQuickCreate={quickCreateSchema} />
      <QuickStartCards onDesigner={goToDesigner} onImport={importSchema} onExplore={goToDataExplorer} />
      <RecentSchemasTable
        schemas={schemas}
        onToggleActive={toggleSchemaActive}
        onEdit={editSchema}
        onRemove={removeSchema}
        onViewAll={viewAllSchemas}
      />
      <AlertsPanel alerts={alerts} onClearAll={clearAlerts} />
    </div>
  );
}
