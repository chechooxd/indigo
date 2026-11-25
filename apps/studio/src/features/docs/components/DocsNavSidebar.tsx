/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import React from 'react';
import { Search, Table } from 'lucide-react';
import type { FilteredTable } from '../hooks/useDocBrowser';

interface DocsNavSidebarProps {
  filteredTables: FilteredTable[];
  activeTableName: string;
  filterQuery: string;
  onFilterChange: (query: string) => void;
  onSelectTable: (originalIdx: number) => void;
}

export function DocsNavSidebar({ filteredTables, activeTableName, filterQuery, onFilterChange, onSelectTable }: DocsNavSidebarProps) {
  const coreTables = filteredTables.filter((t) => t.schema === 'public' || t.schema === 'billing');
  const analyticsTables = filteredTables.filter((t) => t.schema === 'analytics');

  return (
    <section className="w-[280px] h-full border-r border-zinc-800 flex flex-col bg-[#09090b] shrink-0">
      <div className="p-4">
        <div className="flex items-center gap-2 text-zinc-400 relative bg-zinc-950/20 rounded-xl border border-zinc-800 px-3 py-2 focus-within:border-zinc-700">
          <Search className="w-4 h-4 text-zinc-600" />
          <input
            value={filterQuery}
            onChange={(e) => onFilterChange(e.target.value)}
            className="bg-transparent border-0 focus:ring-0 text-xs w-full outline-none p-0 text-zinc-200 placeholder-zinc-600"
            placeholder="Search specs & index..."
            type="text"
          />
        </div>
      </div>

      {/* Dynamic Category List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4 custom-scrollbar text-xs">
        <div>
          <div className="px-3 py-1 text-[10px] font-bold text-zinc-500 uppercase tracking-widest font-sans">
            CORE SCHEMAS
          </div>
          <div className="space-y-1 mt-2">
            {coreTables.map((t) => {
              const isSelected = activeTableName === t.name;
              return (
                <button
                  key={t.name}
                  onClick={() => onSelectTable(t.originalIdx)}
                  className={`w-full text-left px-3 py-2 rounded-xl flex items-center gap-2 transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-zinc-900 text-white font-semibold border border-zinc-800'
                      : 'text-zinc-500 hover:text-white hover:bg-zinc-900/60'
                  }`}
                >
                  <Table className="w-3.5 h-3.5 text-zinc-500" />
                  <span className="font-mono">{t.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="px-3 py-1 text-[10px] font-bold text-zinc-500 uppercase tracking-widest font-sans">
            ANALYTICS & AUXILIARY
          </div>
          <div className="space-y-1 mt-2">
            {analyticsTables.map((t) => {
              const isSelected = activeTableName === t.name;
              return (
                <button
                  key={t.name}
                  onClick={() => onSelectTable(t.originalIdx)}
                  className={`w-full text-left px-3 py-2 rounded-xl flex items-center gap-2 transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-zinc-900 text-white font-semibold border border-zinc-800'
                      : 'text-zinc-500 hover:text-white hover:bg-zinc-900/60'
                  }`}
                >
                  <Table className="w-3.5 h-3.5 text-zinc-500" />
                  <span className="font-mono">{t.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
