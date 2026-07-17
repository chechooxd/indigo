/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Search, Plus, Table2 } from 'lucide-react';
import { Table } from '../../../../types';

interface TableListProps {
  /** All tables from the store (used for count badge) */
  allTablesCount: number;
  /** Pre-filtered list of tables to render */
  filteredTables: Table[];
  /** Name of the currently active table */
  activeTableName: string;
  /** Full table list used to resolve the originalIndex for each filtered entry */
  allTables: Table[];
  /** Sidebar filter string */
  tableFilterQuery: string;
  onTableFilterChange: (query: string) => void;
  /** Called with the *original* index (into `allTables`) when a table row is clicked */
  onSelectTable: (originalIndex: number) => void;
  onOpenCreateModal: () => void;
}

export function TableList({
  allTablesCount,
  filteredTables,
  activeTableName,
  allTables,
  tableFilterQuery,
  onTableFilterChange,
  onSelectTable,
  onOpenCreateModal,
}: TableListProps) {
  return (
    <aside className="w-[260px] bg-[#09090b] border-r border-zinc-800/80 flex flex-col shrink-0">
      <div className="p-4 flex items-center justify-between border-b border-zinc-800/80 bg-zinc-950/20">
        <span className="text-[10px] font-extrabold text-zinc-500 uppercase tracking-widest font-sans">
          TABLES ({allTablesCount})
        </span>
        <button
          onClick={onOpenCreateModal}
          className="text-zinc-500 hover:text-white transition-colors p-1.5 hover:bg-zinc-900 rounded-xl cursor-pointer"
          title="Create new table"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Scrollable list of tables */}
      <div className="p-2 space-y-1 overflow-y-auto custom-scrollbar flex-1">
        {filteredTables.map((t) => {
          const isSelected = activeTableName === t.name;
          const originalIndex = allTables.findIndex(item => item.name === t.name);
          return (
            <div
              key={t.name}
              onClick={() => onSelectTable(originalIndex)}
              className={`group flex items-center gap-3 px-3 py-2 rounded-xl cursor-pointer border transition-all ${
                isSelected
                  ? 'bg-zinc-900 text-white border-zinc-800 font-semibold shadow-inner'
                  : 'text-zinc-500 border-transparent hover:text-zinc-300 hover:bg-zinc-900/50'
              }`}
            >
              <Table2 className="w-4 h-4 text-zinc-400 group-hover:text-zinc-200 transition-colors" />
              <span className="text-xs font-mono">{t.name}</span>
              {t.recordCount > 0 && (
                <span className="ml-auto text-[9px] bg-zinc-950 border border-zinc-805/80 px-1.5 py-0.5 rounded-lg font-mono text-zinc-500">
                  {t.recordCount > 1000 ? `${(t.recordCount / 1000).toFixed(1)}k` : t.recordCount}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Table Filter input */}
      <div className="p-4 border-t border-zinc-800/80 bg-zinc-950/20">
        <div className="flex items-center gap-2 text-zinc-500 relative bg-[#09090b] rounded-xl border border-zinc-800 px-2.5 py-1.5 focus-within:border-zinc-700">
          <Search className="w-3.5 h-3.5" />
          <input
            value={tableFilterQuery}
            onChange={(e) => onTableFilterChange(e.target.value)}
            className="bg-transparent border-0 focus:ring-0 text-xs w-full outline-none p-0 text-white placeholder-zinc-600"
            placeholder="Filter table index..."
            type="text"
          />
        </div>
      </div>
    </aside>
  );
}
