/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { ReactFlowProvider } from '@xyflow/react';
import { Copy, History, PanelLeft, PanelRight, Columns } from 'lucide-react';
import { INITIAL_DSL_CODE } from '../../data/mockData';
import { registerIndigoLanguage } from '../../lib/monaco-indigo';
import { fetchSchemaSource } from '../../lib/api';

import { useERDParser } from './hooks/useERDParser';
import { usePanelLayout } from './hooks/usePanelLayout';
import ERDCanvas from './ERDCanvas';
import ERDSidebar from './components/ERDSidebar';

export default function ERDDesignerPage() {
  const [dslCode, setDslCode] = useState<string>(INITIAL_DSL_CODE);

  // Under `indigodb studio`, load the project's real schema.indigo source.
  useEffect(() => {
    fetchSchemaSource().then((source) => {
      if (source) setDslCode(source);
    });
  }, []);

  const [hiddenTables, setHiddenTables] = useState<Set<string>>(new Set());
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);
  const [sidebarSearch, setSidebarSearch] = useState<string>('');
  const [groupBy, setGroupBy] = useState<'schema' | 'group'>('schema');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const { layout, setLayout, editorWidth, startResize } = usePanelLayout();
  const { nodes, links, tableGroups } = useERDParser(dslCode);

  const handleCopyCode = () => {
    navigator.clipboard.writeText(dslCode);
    alert('Código copiado al portapapeles');
  };

  const toggleFolder = (folderName: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderName)) next.delete(folderName);
      else next.add(folderName);
      return next;
    });
  };

  const toggleTableVisibility = (tableName: string) => {
    setHiddenTables(prev => {
      const next = new Set(prev);
      if (next.has(tableName)) next.delete(tableName);
      else next.add(tableName);
      return next;
    });
  };

  const sidebarData = useMemo(() => {
    const data: Record<string, string[]> = {};
    const searchLower = sidebarSearch.toLowerCase();
    if (groupBy === 'schema') {
      const matchNodes = nodes.filter(n => n.name.toLowerCase().includes(searchLower));
      data['public (default)'] = matchNodes.map(n => n.name);
    } else {
      tableGroups.forEach(g => {
        const matchingTables = g.tables.filter(t => t.toLowerCase().includes(searchLower) || g.name.toLowerCase().includes(searchLower));
        if (matchingTables.length > 0) data[g.name] = matchingTables;
      });
      const groupedTableNames = new Set(tableGroups.flatMap(g => g.tables));
      const ungrouped = nodes.filter(n => !groupedTableNames.has(n.name) && n.name.toLowerCase().includes(searchLower));
      if (ungrouped.length > 0) data['Ungrouped'] = ungrouped.map(n => n.name);
    }
    return data;
  }, [nodes, tableGroups, groupBy, sidebarSearch]);

  return (
    <div id="erd-designer-workbench" className="flex-1 flex overflow-hidden bg-[#09090b] relative">
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex bg-zinc-900 border border-zinc-800 p-1 rounded-lg shadow-xl">
        <button
          onClick={() => setLayout('editor')}
          className={`p-1.5 rounded cursor-pointer ${layout === 'editor' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
          title="Solo editor"
        >
          <PanelLeft size={16} />
        </button>
        <button
          onClick={() => setLayout('both')}
          className={`p-1.5 rounded cursor-pointer ${layout === 'both' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
          title="Dividir vista"
        >
          <Columns size={16} />
        </button>
        <button
          onClick={() => setLayout('canvas')}
          className={`p-1.5 rounded cursor-pointer ${layout === 'canvas' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
          title="Solo lienzo"
        >
          <PanelRight size={16} />
        </button>
      </div>

      {layout !== 'canvas' && (
        <section
          className="h-full bg-[#09090b] flex flex-col shrink-0 relative"
          style={{ width: layout === 'editor' ? '100%' : `${editorWidth}%` }}
        >
          <div className="h-10 border-b border-zinc-800 flex items-center px-4 justify-between bg-zinc-950/20">
            <span className="text-[10px] font-extrabold text-zinc-500 uppercase tracking-widest font-mono">
              INDIGODSL V1.0
            </span>
            <div className="flex gap-2">
              <button
                onClick={handleCopyCode}
                className="p-1.5 hover:bg-zinc-900 rounded-xl text-zinc-500 hover:text-white transition-colors cursor-pointer"
                title="Copy DSL script"
              >
                <Copy className="w-4 h-4" />
              </button>
              <button
                onClick={() => alert('Loading script backup history...')}
                className="p-1.5 hover:bg-zinc-900 rounded-xl text-zinc-500 hover:text-white transition-colors cursor-pointer"
                title="View revision log"
              >
                <History className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex-1 w-full h-full relative">
            <Editor
              height="100%"
              language="indigo"
              theme="indigo-dark"
              value={dslCode}
              onChange={(value) => setDslCode(value || '')}
              beforeMount={registerIndigoLanguage}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                padding: { top: 16, bottom: 16 },
                lineHeight: 24,
                scrollBeyondLastLine: false,
                roundedSelection: false,
                renderLineHighlight: 'all',
                scrollbar: {
                  vertical: 'visible',
                  horizontal: 'visible',
                  verticalScrollbarSize: 10,
                  horizontalScrollbarSize: 10,
                },
              }}
              loading={
                <div className="w-full h-full flex items-center justify-center text-zinc-500 font-mono text-xs">
                  Loading editor...
                </div>
              }
            />
          </div>
        </section>
      )}

      {layout === 'both' && (
        <div
          className="w-1 bg-zinc-800 hover:bg-indigo-500 cursor-col-resize z-30 transition-colors"
          onMouseDown={(e) => {
            e.preventDefault();
            startResize();
          }}
        />
      )}

      {layout !== 'editor' && (
        <section
          className="flex-1 h-full relative overflow-hidden"
          style={{ width: layout === 'canvas' ? '100%' : `${100 - editorWidth}%`, backgroundColor: '#09090b' }}
        >
          <ERDSidebar
            isOpen={isSidebarOpen}
            sidebarData={sidebarData}
            hiddenTables={hiddenTables}
            expandedFolders={expandedFolders}
            sidebarSearch={sidebarSearch}
            groupBy={groupBy}
            onClose={() => setIsSidebarOpen(false)}
            onSearchChange={setSidebarSearch}
            onGroupByChange={setGroupBy}
            onToggleFolder={toggleFolder}
            onToggleVisibility={toggleTableVisibility}
          />

          <ReactFlowProvider>
            <ERDCanvas
              parsedNodes={nodes}
              links={links}
              tableGroups={tableGroups}
              hiddenTables={hiddenTables}
              isSidebarOpen={isSidebarOpen}
              onToggleSidebar={() => setIsSidebarOpen(o => !o)}
            />
          </ReactFlowProvider>
        </section>
      )}
    </div>
  );
}
