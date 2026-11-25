/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import React from 'react';
import { useDocBrowser } from './hooks/useDocBrowser';
import { getRelationLabel, getRelationDetail } from './lib/relations';
import { DocsNavSidebar } from './components/DocsNavSidebar';
import { TableHeroBanner } from './components/TableHeroBanner';
import { ColumnsSpecTable } from './components/ColumnsSpecTable';
import { DdlPanel } from './components/DdlPanel';
import { RelationsPanel } from './components/RelationsPanel';

export default function DocBrowserPage() {
  const {
    activeTable,
    filteredTables,
    activeRelations,
    ddlDefinitionCode,
    docFilterQuery,
    setSelectedTableIdx,
    setDocFilterQuery,
    queryTable,
  } = useDocBrowser();

  const displayRelations = activeRelations.map((rel) => ({
    label: getRelationLabel(rel),
    name: rel.name,
    detail: getRelationDetail(rel),
  }));

  return (
    <div id="docs-workbench" className="flex-1 flex overflow-hidden bg-[#09090b]">
      <DocsNavSidebar
        filteredTables={filteredTables}
        activeTableName={activeTable.name}
        filterQuery={docFilterQuery}
        onFilterChange={setDocFilterQuery}
        onSelectTable={setSelectedTableIdx}
      />

      <article className="flex-1 overflow-y-auto bg-[#09090b] custom-scrollbar pb-12">
        <TableHeroBanner table={activeTable} onQuery={queryTable} />

        <div className="p-8 max-w-4xl mx-auto space-y-10">
          <ColumnsSpecTable columns={activeTable.columns} />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <DdlPanel key={`${activeTable.schema}.${activeTable.name}`} ddlCode={ddlDefinitionCode} />
            <RelationsPanel relations={displayRelations} />
          </div>
        </div>
      </article>
    </div>
  );
}
