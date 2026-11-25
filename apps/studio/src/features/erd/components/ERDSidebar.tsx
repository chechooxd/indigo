/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import React from 'react';
import {
  Layers,
  X,
  Search,
  ChevronDown,
  ChevronRight,
  FolderTree,
  TableProperties,
  Eye,
  EyeOff,
} from 'lucide-react';

interface ERDSidebarProps {
  isOpen: boolean;
  sidebarData: Record<string, string[]>;
  hiddenTables: Set<string>;
  expandedFolders: Set<string>;
  sidebarSearch: string;
  groupBy: 'schema' | 'group';
  onClose: () => void;
  onSearchChange: (value: string) => void;
  onGroupByChange: (value: 'schema' | 'group') => void;
  onToggleFolder: (folderId: string) => void;
  onToggleVisibility: (tableId: string) => void;
}

export default function ERDSidebar({
  isOpen,
  sidebarData,
  hiddenTables,
  expandedFolders,
  sidebarSearch,
  groupBy,
  onClose,
  onSearchChange,
  onGroupByChange,
  onToggleFolder,
  onToggleVisibility,
}: ERDSidebarProps) {
  if (!isOpen) return null;

  return (
    <div className="absolute right-4 top-4 bottom-4 w-72 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl z-20 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-zinc-800">
        <div className="flex items-center gap-2 text-zinc-100 font-semibold text-sm">
          <Layers size={16} />
          Vistas del diagrama
        </div>
        <button
          onClick={onClose}
          className="text-zinc-400 hover:text-zinc-100 p-1 rounded-md hover:bg-zinc-800 cursor-pointer"
        >
          <X size={16} />
        </button>
      </div>

      {/* Search & group-by controls */}
      <div className="p-3 border-b border-zinc-800 flex flex-col gap-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 text-zinc-500" size={14} />
          <input
            type="text"
            placeholder="Buscar tabla, esquema o grupo"
            className="w-full bg-zinc-950 border border-zinc-800 rounded text-sm text-zinc-100 pl-8 pr-2 py-2 focus:outline-none focus:border-zinc-700"
            value={sidebarSearch}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        <div className="relative">
          <Layers className="absolute left-2.5 top-2.5 text-zinc-500" size={14} />
          <select
            className="w-full bg-zinc-950 border border-zinc-800 rounded text-sm text-zinc-300 pl-8 pr-2 py-2 focus:outline-none appearance-none cursor-pointer"
            value={groupBy}
            onChange={(e) => onGroupByChange(e.target.value as 'schema' | 'group')}
          >
            <option value="schema">Agrupar por: Esquema</option>
            <option value="group">Agrupar por: Grupo de tablas</option>
          </select>
          <ChevronDown className="absolute right-2.5 top-2.5 text-zinc-500 pointer-events-none" size={14} />
        </div>
      </div>

      {/* Folder / table tree */}
      <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
        {Object.entries(sidebarData).map(([folderName, tables]) => {
          if (tables.length === 0) return null;
          const isExpanded = !expandedFolders.has(folderName);
          const visibleCount = tables.filter(t => !hiddenTables.has(t)).length;
          return (
            <div key={folderName} className="mb-2">
              <div
                className="flex items-center justify-between p-2 hover:bg-zinc-800 rounded cursor-pointer text-zinc-300 text-sm group"
                onClick={() => onToggleFolder(folderName)}
              >
                <div className="flex items-center gap-2">
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <FolderTree size={14} className="text-indigo-400" />
                  <span className="font-semibold">{folderName}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs bg-zinc-800 group-hover:bg-zinc-700 px-1.5 py-0.5 rounded text-zinc-400">
                    {visibleCount}/{tables.length}
                  </span>
                </div>
              </div>
              {isExpanded && (
                <div className="ml-6 flex flex-col gap-1 mt-1">
                  {tables.map(table => (
                    <div key={table} className="flex items-center justify-between p-1.5 hover:bg-zinc-800 rounded group">
                      <div className="flex items-center gap-2 text-sm text-zinc-400">
                        <TableProperties size={14} />
                        <span className={hiddenTables.has(table) ? 'opacity-50 line-through' : ''}>{table}</span>
                      </div>
                      <button
                        onClick={() => onToggleVisibility(table)}
                        className="text-zinc-500 hover:text-zinc-200 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                      >
                        {hiddenTables.has(table) ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
