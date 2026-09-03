/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import { ReactFlowProvider } from '@xyflow/react';
import { PanelLeft, PanelRight, Columns } from 'lucide-react';
import { INITIAL_DSL_CODE } from '../../data/mockData';
import { registerIndigoLanguage } from '../../lib/monaco-indigo';
import { fetchSchemaSource, saveSchemaSource } from '../../lib/api';
import { useAuthStore } from '../../store/useAuthStore';

import { useERDParser } from './hooks/useERDParser';
import { usePanelLayout } from './hooks/usePanelLayout';
import ERDCanvas from './ERDCanvas';
import ERDSidebar from './components/ERDSidebar';
import { DslEditorToolbar } from './components/DslEditorToolbar';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import type { Diagnostic } from './lib/diagnostics';

/** A refusal that gets its own banner, distinct from the diagnostics panel
 * (422, handled via `saveDiagnostics` below) and from success (a toast). */
type SaveBanner =
  | { kind: 'stale' }
  | { kind: 'error'; message: string };

const TOAST_DURATION_MS = 3000;

export default function ERDDesignerPage() {
  const [dslCode, setDslCode] = useState<string>(INITIAL_DSL_CODE);
  const [savedSource, setSavedSource] = useState<string>(INITIAL_DSL_CODE);
  const [version, setVersion] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveBanner, setSaveBanner] = useState<SaveBanner | null>(null);
  const [saveDiagnostics, setSaveDiagnostics] = useState<Diagnostic[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [preReloadBuffer, setPreReloadBuffer] = useState<string | null>(null);

  const schemaWritable = useAuthStore((s) => s.schemaWritable);
  const dirty = dslCode !== savedSource;

  // Under `indigodb studio`, load the project's real schema.indigo source.
  useEffect(() => {
    fetchSchemaSource().then((result) => {
      if (result) {
        setDslCode(result.source);
        setSavedSource(result.source);
        setVersion(result.version);
      }
    });
  }, []);

  useEffect(() => {
    if (!toastMessage) return;
    const timer = setTimeout(() => setToastMessage(null), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [toastMessage]);

  const [hiddenTables, setHiddenTables] = useState<Set<string>>(new Set());
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);
  const [sidebarSearch, setSidebarSearch] = useState<string>('');
  const [groupBy, setGroupBy] = useState<'schema' | 'group'>('schema');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const { layout, setLayout, editorWidth, startResize } = usePanelLayout();
  const { nodes, links, tableGroups, diagnostics: parseDiagnostics } = useERDParser(dslCode);

  // Combined for display: live parse/validate diagnostics plus, if the last
  // save attempt was refused as 422, the server's diagnostics translated
  // back to buffer-relative coordinates by `saveSchemaSource`'s caller.
  const diagnostics = useMemo(
    () => [...parseDiagnostics, ...saveDiagnostics],
    [parseDiagnostics, saveDiagnostics],
  );

  const handleDslChange = useCallback((value: string) => {
    setDslCode(value);
    // A fresh edit invalidates the last save refusal's context.
    setSaveDiagnostics([]);
    setSaveBanner(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (version === null) return;
    setSaving(true);
    const result = await saveSchemaSource(dslCode, version);
    setSaving(false);

    if (result.ok) {
      setSavedSource(dslCode);
      setVersion(result.version);
      setSaveBanner(null);
      setSaveDiagnostics([]);
      setToastMessage('Schema saved.');
      return;
    }

    if (result.status === 409) {
      setSaveBanner({ kind: 'stale' });
      return;
    }

    if (result.status === 422) {
      const translated: Diagnostic[] = [
        ...(result.parseErrors ?? []).map((e) => ({
          source: 'parse' as const,
          message: e.message,
          line: e.line,
          column: e.column,
          endLine: e.endLine,
          endColumn: e.endColumn,
        })),
        ...(result.validationErrors ?? []).map((e) => ({
          source: 'validate' as const,
          message: e.message,
        })),
      ];
      setSaveDiagnostics(translated);
      return;
    }

    setSaveBanner({ kind: 'error', message: result.error });
  }, [dslCode, version]);

  const handleReload = useCallback(async () => {
    const result = await fetchSchemaSource();
    if (result) {
      setPreReloadBuffer(dslCode);
      setDslCode(result.source);
      setSavedSource(result.source);
      setVersion(result.version);
      setSaveBanner(null);
      setSaveDiagnostics([]);
    }
  }, [dslCode]);

  const handleUndoReload = useCallback(() => {
    if (preReloadBuffer !== null) {
      setDslCode(preReloadBuffer);
      setPreReloadBuffer(null);
    }
  }, [preReloadBuffer]);

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
          title="Editor only"
        >
          <PanelLeft size={16} />
        </button>
        <button
          onClick={() => setLayout('both')}
          className={`p-1.5 rounded cursor-pointer ${layout === 'both' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
          title="Split view"
        >
          <Columns size={16} />
        </button>
        <button
          onClick={() => setLayout('canvas')}
          className={`p-1.5 rounded cursor-pointer ${layout === 'canvas' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
          title="Canvas only"
        >
          <PanelRight size={16} />
        </button>
      </div>

      {toastMessage && (
        <div
          role="status"
          className="absolute top-4 right-4 z-50 px-3 py-2 rounded-lg bg-emerald-900/80 border border-emerald-700 text-emerald-200 text-xs font-medium shadow-xl"
        >
          {toastMessage}
        </div>
      )}

      {layout !== 'canvas' && (
        <section
          className="h-full bg-[#09090b] flex flex-col shrink-0 relative"
          style={{ width: layout === 'editor' ? '100%' : `${editorWidth}%` }}
        >
          <div className="h-10 border-b border-zinc-800 flex items-center px-4 justify-between bg-zinc-950/20">
            <span className="text-[10px] font-extrabold text-zinc-500 uppercase tracking-widest font-mono">
              INDIGODSL V1.0
            </span>
            <DslEditorToolbar
              dslCode={dslCode}
              dirty={dirty}
              schemaWritable={schemaWritable}
              saving={saving}
              onSave={handleSave}
            />
          </div>

          {saveBanner && (
            <div
              role="alert"
              className="px-4 py-2 bg-amber-950/40 border-b border-amber-900/60 text-[11px] text-amber-300 font-mono flex items-center gap-3"
            >
              {saveBanner.kind === 'stale' ? (
                <>
                  <span className="flex-1">
                    The file changed on disk since you loaded it. Your edits are kept — choose
                    Reload to see the latest version.
                  </span>
                  <button
                    onClick={handleReload}
                    className="underline hover:text-amber-100 cursor-pointer shrink-0"
                  >
                    Reload from disk
                  </button>
                </>
              ) : (
                <span className="flex-1">{saveBanner.message}</span>
              )}
            </div>
          )}

          {preReloadBuffer !== null && (
            <div
              role="status"
              className="px-4 py-2 bg-zinc-900/60 border-b border-zinc-800 text-[11px] text-zinc-400 font-mono flex items-center gap-3"
            >
              <span className="flex-1">Buffer replaced by Reload — your prior edits are kept.</span>
              <button
                onClick={handleUndoReload}
                className="underline hover:text-zinc-100 cursor-pointer shrink-0"
              >
                Undo reload
              </button>
            </div>
          )}

          <div className="flex-1 w-full h-full relative">
            <Editor
              height="100%"
              language="indigo"
              theme="indigo-dark"
              value={dslCode}
              onChange={(value) => handleDslChange(value || '')}
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

          <DiagnosticsPanel diagnostics={diagnostics} />
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
              dslCode={dslCode}
              onDslChange={handleDslChange}
            />
          </ReactFlowProvider>
        </section>
      )}
    </div>
  );
}
