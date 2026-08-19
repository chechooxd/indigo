/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { RefreshCw, Folder, ChevronRight, Database } from 'lucide-react';
import type { Table } from '../../../../types';

const REFRESH_DISABLED_TITLE = 'Refresh needs a connected database — this build is showing sample data.';

interface SchemaBrowserPanelProps {
  tables: Table[];
  selectedTable: string;
  onSelectTable: (tableName: string) => void;
  canRefresh: boolean;
  onRefresh: () => Promise<void>;
}

export function SchemaBrowserPanel({ tables, selectedTable, onSelectTable, canRefresh, onRefresh }: SchemaBrowserPanelProps) {
  const [expandedFolder, setExpandedFolder] = useState<boolean>(true);

  return (
    <aside className="w-64 border-r border-zinc-800 bg-[#09090b] flex flex-col shrink-0">
      <div className="p-4 border-b border-zinc-800 flex justify-between items-center bg-zinc-950/20">
        <span className="text-[10px] font-extrabold text-zinc-500 uppercase tracking-wider font-sans">
          SCHEMA BROWSER
        </span>
        <button
          onClick={onRefresh}
          disabled={!canRefresh}
          title={!canRefresh ? REFRESH_DISABLED_TITLE : undefined}
          aria-label="Refresh schema"
          className="p-1.5 hover:text-white text-zinc-500 hover:bg-zinc-900 rounded-xl transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 custom-scrollbar">
        <div className="space-y-1">
          {/* Schema folder node */}
          <div
            onClick={() => setExpandedFolder(!expandedFolder)}
            className="flex items-center gap-1.5 px-2.5 py-2 text-zinc-400 hover:bg-zinc-900 rounded-xl cursor-pointer transition-colors"
          >
            <ChevronRight className={`w-3.5 h-3.5 transition-transform ${expandedFolder ? 'rotate-90' : ''}`} />
            <Folder className="w-4 h-4 text-zinc-500" />
            <span className="text-xs font-semibold">schemas</span>
          </div>

          {expandedFolder && (
            <div className="pl-3.5 space-y-1 border-l border-zinc-900 ml-4 py-1">
              {tables.map((t) => {
                const isSelected = selectedTable === t.name;
                return (
                  <div key={t.name} className="space-y-1">
                    <div
                      onClick={() => onSelectTable(t.name)}
                      className={`flex items-center gap-2 px-2.5 py-1.5 rounded-xl cursor-pointer transition-all ${
                        isSelected ? 'bg-zinc-900 text-white font-semibold' : 'text-zinc-500 hover:text-white hover:bg-zinc-900/60'
                      }`}
                    >
                      <Database className="w-3.5 h-3.5 shrink-0" />
                      <span className="text-xs font-mono truncate">{t.schema}.{t.name}</span>
                    </div>

                    {/* Render columns on selective expansion */}
                    {isSelected && (
                      <div className="pl-4 space-y-1 border-l border-zinc-800 ml-3.5 py-1.5">
                        {t.columns.map((col) => (
                          <div key={col.name} className="flex items-center justify-between text-[10px] font-mono pr-2 py-0.5">
                            <span className="text-zinc-400">{col.name}</span>
                            <span className="text-zinc-600 truncate max-w-[70px]" title={col.type}>
                              {col.type.toLowerCase()}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
