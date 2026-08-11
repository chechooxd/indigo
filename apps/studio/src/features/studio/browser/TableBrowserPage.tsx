/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect } from 'react';
import { RefreshCw, Search, Plus, Check, Circle } from 'lucide-react';

import { useTableData } from './hooks/useTableData';
import { useCreateTableForm } from './hooks/useCreateTableForm';
import { useRecordEditor } from './hooks/useRecordEditor';
import { TableList } from './components/TableList';
import { CreateTableModal } from './components/CreateTableModal';
import { RecordInspector } from './components/RecordInspector';
import { isBackendAvailable, fetchTableRows } from '../../../lib/api';
import { useDataStore } from '../../../store/useDataStore';

export default function TableBrowserPage() {
  const updateTableRecords = useDataStore((s) => s.updateTableRecords);
  const {
    tables,
    filteredTables,
    filteredRecords,
    activeTable,
    activeTableIndex,
    tableFilterQuery,
    recordSearchQuery,
    isStructureView,
    setActiveTableIndex,
    setTableFilterQuery,
    setRecordSearchQuery,
    setIsStructureView,
  } = useTableData();

  const createForm = useCreateTableForm();

  const editor = useRecordEditor(activeTableIndex);

  // Under the studio backend, load real rows for the active table on demand.
  useEffect(() => {
    if (!isBackendAvailable() || !activeTable) return;
    if (activeTable.records.length > 0) return;
    let cancelled = false;
    fetchTableRows(activeTable.name).then((result) => {
      if (!cancelled && result) updateTableRecords(activeTable.name, result.rows);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTable?.name]);

  // Manual refresh: re-fetch the active table's rows when a backend is
  // connected. With no backend there is nothing to refetch from, so this is
  // an honest no-op rather than a fabricated confirmation.
  const handleRefresh = async () => {
    if (!isBackendAvailable() || !activeTable) return;
    const result = await fetchTableRows(activeTable.name);
    if (result) updateTableRecords(activeTable.name, result.rows);
  };

  // Sync edit buffers whenever the active row or active table changes
  useEffect(() => {
    if (activeTable?.records?.[editor.selectedRowIndex]) {
      const row = activeTable.records[editor.selectedRowIndex];
      editor.setEditEmail(row.email || '');
      editor.setEditRole(row.role || 'USER');
      editor.setEditMetadata(row.metadata || '{}');
    } else {
      editor.setEditEmail('');
      editor.setEditRole('USER');
      editor.setEditMetadata('{}');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.selectedRowIndex, activeTableIndex, activeTable]);

  return (
    <div id="table-browser-container" className="flex-1 flex overflow-hidden">
      {/* Studio Left Sidebar */}
      <TableList
        allTablesCount={tables.length}
        filteredTables={filteredTables}
        activeTableName={activeTable?.name ?? ''}
        allTables={tables}
        tableFilterQuery={tableFilterQuery}
        onTableFilterChange={setTableFilterQuery}
        onSelectTable={(idx) => { setActiveTableIndex(idx); editor.setSelectedRowIndex(0); }}
        onOpenCreateModal={createForm.handleOpenCreateModal}
      />

      {/* Main Workspace Area */}
      <section className="flex-1 flex flex-col bg-[#09090b] overflow-hidden">
        {/* Contextual Toolbar */}
        <div className="h-[48px] bg-[#09090b] border-b border-zinc-800/80 flex items-center justify-between px-4 shrink-0">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest font-mono">MODEL</span>
              <span className="text-sm font-bold text-white flex items-center gap-2">
                <span className="font-mono text-zinc-300">{activeTable?.schema}.{activeTable?.name}</span>
              </span>
            </div>
            <div className="h-4 w-px bg-zinc-800" />
            <button onClick={() => { void handleRefresh(); }} className="flex items-center gap-1.5 text-zinc-400 hover:text-white cursor-pointer transition-colors px-2.5 py-1 hover:bg-zinc-900 rounded-xl text-xs">
              <RefreshCw className="w-3.5 h-3.5" /><span>Refresh</span>
            </button>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex bg-zinc-950 rounded-xl p-0.5 border border-zinc-800 text-xs font-semibold">
              <button onClick={() => setIsStructureView(false)} className={`px-3 py-1 rounded-lg cursor-pointer transition-all ${!isStructureView ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>Data Grid</button>
              <button onClick={() => setIsStructureView(true)} className={`px-3 py-1 rounded-lg cursor-pointer transition-all ${isStructureView ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>Structure Specs</button>
            </div>
            <button onClick={() => editor.handleAddRecord(activeTable)} className="bg-white hover:bg-zinc-200 text-black px-3.5 py-1.5 rounded-xl text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 transition-all cursor-pointer shadow-md shadow-white/5">
              <Plus className="w-3.5 h-3.5" /><span>Add Record</span>
            </button>
          </div>
        </div>

        {/* Grid Navigation / Controls */}
        <div className="h-10 bg-zinc-950/40 border-b border-zinc-800/60 flex items-center px-4 gap-6 shrink-0">
          <div className="ml-auto">
            <div className="w-48 h-7 bg-[#09090b] border border-zinc-805 rounded-xl flex items-center px-2.5">
              <Search className="w-3 h-3 text-zinc-500" />
              <input value={recordSearchQuery} onChange={(e) => setRecordSearchQuery(e.target.value)} className="bg-transparent border-none focus:ring-0 text-[10px] w-full py-0 pl-1.5 outline-none text-white placeholder-zinc-600" placeholder="Search active records..." type="text" />
            </div>
          </div>
        </div>

        {/* Content Box */}
        <div className="flex-1 overflow-auto custom-scrollbar bg-[#09090b] relative">
          {isStructureView ? (
            <div className="p-6 max-w-4xl">
              <h3 className="text-sm font-bold text-white mb-4">Column Specifications for "{activeTable?.name}"</h3>
              <div className="border border-zinc-800 rounded-2xl overflow-hidden bg-zinc-900/20">
                <table className="w-full text-left text-xs font-mono">
                  <thead className="bg-zinc-950 border-b border-zinc-800 text-zinc-400">
                    <tr>
                      <th className="p-3.5">Column Name</th><th className="p-3.5">Data Type</th><th className="p-3.5">Constraints</th><th className="p-3.5">Default Value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/50 text-zinc-200">
                    {activeTable?.columns.map((col) => (
                      <tr key={col.name} className="hover:bg-zinc-900/30 transition-colors">
                        <td className="p-3.5 font-semibold text-white">{col.name}</td>
                        <td className="p-3.5 text-zinc-400">{col.type}</td>
                        <td className="p-3.5"><div className="flex gap-1.5">{col.isPK && <span className="bg-zinc-800 text-white text-[9px] px-1.5 py-0.5 rounded-lg border border-zinc-700 font-bold uppercase">PK</span>}{col.isNN && <span className="bg-zinc-900 text-zinc-500 text-[9px] px-1.5 py-0.5 rounded-lg border border-zinc-800 font-bold uppercase">NOT NULL</span>}{col.isUQ && <span className="bg-zinc-900 text-zinc-400 text-[9px] px-1.5 py-0.5 rounded-lg border border-zinc-800 font-bold uppercase">UQ</span>}</div></td>
                        <td className="p-3.5 text-zinc-600 italic">{col.defaultValue || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <table className="w-full border-collapse text-left font-mono text-xs">
              <thead className="sticky top-0 z-20 bg-zinc-950 border-b border-zinc-800">
                <tr>
                  <th className="w-10 px-3 py-2 border-r border-zinc-800"><input className="rounded bg-zinc-950 border-zinc-800 focus:ring-0 text-white" type="checkbox" readOnly checked /></th>
                  {activeTable?.columns.map((col) => (
                    <th key={col.name} className="px-4 py-3 border-r border-zinc-800 min-w-[120px]">
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-500 uppercase tracking-wider">{col.name}</span>
                        {col.isPK && <span className="text-[9px] text-zinc-400 font-semibold border border-zinc-800 px-1.5 py-0.2 rounded">PK</span>}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/40">
                {filteredRecords.length === 0 ? (
                  <tr><td colSpan={(activeTable?.columns.length ?? 0) + 1} className="p-12 text-center text-zinc-500 italic font-sans text-xs">No matching records found. Clear filters or add new rows.</td></tr>
                ) : (
                  filteredRecords.map((row, idx) => {
                    const isSelected = editor.selectedRowIndex === idx;
                    return (
                      <tr key={row.id || idx} onClick={() => editor.setSelectedRowIndex(idx)} className={`transition-colors cursor-pointer ${isSelected ? 'bg-zinc-900/30 border-y border-zinc-800 font-semibold' : 'hover:bg-zinc-900/10'}`}>
                        <td className="px-3 py-2.5 border-r border-zinc-800"><input className="rounded bg-zinc-950 border-zinc-800 text-white focus:ring-0" type="checkbox" checked={isSelected} onChange={() => editor.setSelectedRowIndex(idx)} /></td>
                        {activeTable?.columns.map((col) => {
                          const rawValue = row[col.name];
                          return (
                            <td key={col.name} className="px-4 py-2.5 border-r border-zinc-800/60 text-zinc-300 max-w-xs truncate">
                              {col.name === 'role' && rawValue ? (<span className="text-[9px] px-2 py-0.5 rounded-lg border bg-zinc-900 text-zinc-300 border-zinc-800 font-semibold">{rawValue}</span>)
                                : col.name === 'verified' ? (rawValue ? <Check className="w-4 h-4 text-white stroke-[2.5]" /> : <Circle className="w-4 h-4 text-zinc-700 stroke-[2.5]" />)
                                : rawValue !== undefined && rawValue !== null ? String(rawValue)
                                : <span className="text-zinc-600 italic">Null</span>}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="h-10 bg-[#09090b] border-t border-zinc-800/80 flex items-center justify-between px-4 shrink-0 text-xs text-zinc-500 font-sans font-medium">
          <span>Showing {filteredRecords.length} of {activeTable?.records?.length ?? 0} rows</span>
        </div>
      </section>

      {/* Right Sidebar: Record Inspector */}
      {editor.detailsPanelOpen && activeTable?.records?.[editor.selectedRowIndex] && (
        <RecordInspector
          activeTable={activeTable}
          selectedRowIndex={editor.selectedRowIndex}
          editEmail={editor.editEmail}
          editRole={editor.editRole}
          editMetadata={editor.editMetadata}
          onClose={() => editor.setDetailsPanelOpen(false)}
          onEmailChange={editor.setEditEmail}
          onRoleChange={editor.setEditRole}
          onMetadataChange={editor.setEditMetadata}
          onSave={() => editor.handleSaveChanges(activeTable)}
          onDiscard={() => editor.handleDiscardChanges(activeTable)}
        />
      )}

      {/* Create Table Modal */}
      <CreateTableModal
        isOpen={createForm.isCreateModalOpen}
        newTableName={createForm.newTableName}
        newTableSchema={createForm.newTableSchema}
        newTableColumns={createForm.newTableColumns}
        allTables={tables}
        onClose={createForm.handleCloseCreateModal}
        onTableNameChange={createForm.setNewTableName}
        onTableSchemaChange={createForm.setNewTableSchema}
        onAddColumn={createForm.handleAddColumn}
        onRemoveColumn={createForm.handleRemoveColumn}
        onUpdateColumn={createForm.handleUpdateColumn}
        onSubmit={createForm.handleCreateTableSubmit}
        onSuccess={(newIndex) => { setActiveTableIndex(newIndex); editor.setSelectedRowIndex(0); }}
      />
    </div>
  );
}
