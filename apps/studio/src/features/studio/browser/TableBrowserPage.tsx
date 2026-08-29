/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { RefreshCw, Search, Plus, Check, Circle, Filter, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';

import { useTableData } from './hooks/useTableData';
import { useLiveTable } from './hooks/useLiveTable';
import { useCreateTableForm } from './hooks/useCreateTableForm';
import { useRecordEditor } from './hooks/useRecordEditor';
import { TableList } from './components/TableList';
import { CreateTableModal } from './components/CreateTableModal';
import { RecordInspector } from './components/RecordInspector';
import { SampleDataBanner } from './components/SampleDataBanner';
import { LiveStatusBadge } from './components/LiveStatusBadge';
import { isBackendAvailable, fetchTableRows, updateRow, createRow } from '../../../lib/api';
import { rowKey, pkValues } from '../../../lib/rowKey';
import { resolveWidget } from './components/widgets/registry';

const READ_ONLY_TITLE = "Row editing isn't available yet — this build is read-only.";
const REFRESH_DISABLED_TITLE = 'Refresh needs a connected database — this build is showing sample data.';
import { useDataStore } from '../../../store/useDataStore';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from '../../../components/ui/dropdown-menu';

export default function TableBrowserPage() {
  const updateTableRecords = useDataStore((s) => s.updateTableRecords);
  const updateTableRow = useDataStore((s) => s.updateTableRow);
  const addTableRow = useDataStore((s) => s.addTableRow);
  const {
    tables,
    filteredTables,
    filteredRecords,
    activeTable,
    activeTableIndex,
    tableFilterQuery,
    recordSearchQuery,
    isStructureView,
    hiddenColumns,
    visibleColumns,
    sort,
    setActiveTableIndex,
    setTableFilterQuery,
    setRecordSearchQuery,
    setIsStructureView,
    toggleColumnVisibility,
    cycleSort,
  } = useTableData();

  const createForm = useCreateTableForm();

  const editor = useRecordEditor();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [isRefreshing, setIsRefreshing] = useState(false);

  // Live view: subscribe to the active table's realtime SSE stream, if any.
  // `null` status means inert (no backend, or the table isn't `@@realtime`
  // -eligible) — the badge stays hidden entirely (studio-ui-honesty).
  const { status: liveStatus } = useLiveTable(
    activeTable?.name,
    isBackendAvailable() && activeTable?.realtime === true,
  );

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
  // connected. With no backend there is nothing to refetch from, so the
  // control is disabled outright instead of being a silent no-op.
  const refreshActiveTable = async () => {
    if (!isBackendAvailable() || !activeTable) return;
    setIsRefreshing(true);
    try {
      const result = await fetchTableRows(activeTable.name);
      if (result) updateTableRecords(activeTable.name, result.rows);
    } finally {
      setIsRefreshing(false);
    }
  };

  // Default/repair the selection whenever the active table's identity or
  // record set changes: keep the current key if it still resolves to a row
  // in this table, otherwise fall back to the first row (or none).
  useEffect(() => {
    if (!activeTable || editor.mode === 'create') return;
    const keys = activeTable.records.map((r) => rowKey(activeTable, r));
    if (!editor.selectedRowKey || !keys.includes(editor.selectedRowKey)) {
      editor.setSelectedRowKey(keys[0] ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTable, activeTableIndex, editor.mode]);

  // Sync the edit buffer whenever the selected row (or the table it belongs
  // to) changes. Skipped while creating: `startCreate` already seeded the
  // buffer, and `selectedRowKey` is deliberately `null` during creation.
  useEffect(() => {
    if (!activeTable || editor.mode === 'create') return;
    const row = activeTable.records.find((r) => rowKey(activeTable, r) === editor.selectedRowKey) ?? null;
    editor.loadRow(activeTable, row);
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.selectedRowKey, activeTable, editor.mode]);

  const selectedRecord = activeTable?.records?.find(
    (r) => rowKey(activeTable, r) === editor.selectedRowKey,
  );

  const handleDiscard = () => {
    editor.discard();
    setSaveError(null);
  };

  const handleAddRecord = () => {
    if (!activeTable || !isBackendAvailable()) return;
    editor.startCreate(activeTable);
    setSaveError(null);
  };

  const handleCancelCreate = () => {
    editor.cancelCreate();
    setSaveError(null);
  };

  const handleSave = async () => {
    if (!activeTable || !selectedRecord || !isBackendAvailable()) return;
    setSaveError(null);

    const patch: Record<string, unknown> = {};
    for (const column of editor.dirtyColumns) {
      const col = activeTable.columns.find((c) => c.name === column);
      if (!col) continue;
      if (editor.nulls[column]) {
        patch[column] = null;
        continue;
      }
      const parsed = resolveWidget(col).parse(editor.draft[column] ?? '', col);
      if (!parsed.ok) {
        setSaveError(parsed.error ?? `${column} is invalid`);
        return;
      }
      patch[column] = parsed.value;
    }
    if (Object.keys(patch).length === 0) return;

    const pkColumns = activeTable.columns.filter((c) => c.isPK).map((c) => c.name);
    const pkVals = pkValues(activeTable, selectedRecord);
    const pk = Object.fromEntries(pkColumns.map((name, i) => [name, pkVals[i]]));

    setSaving(true);
    try {
      const persisted = await updateRow(activeTable.name, pk, patch);
      updateTableRow(activeTable.name, editor.selectedRowKey as string, persisted);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateRecord = async () => {
    if (!activeTable || !isBackendAvailable()) return;
    setSaveError(null);

    // Every non-generated column is submitted — unlike an UPDATE patch,
    // an INSERT has no prior baseline to diff against. A generated
    // primary key column is never sent: the database owns its value.
    const values: Record<string, unknown> = {};
    for (const column of activeTable.columns) {
      if (column.isGenerated) continue;
      if (editor.nulls[column.name]) {
        values[column.name] = null;
        continue;
      }
      const parsed = resolveWidget(column).parse(editor.draft[column.name] ?? '', column);
      if (!parsed.ok) {
        setSaveError(parsed.error ?? `${column.name} is invalid`);
        return;
      }
      values[column.name] = parsed.value;
    }

    setSaving(true);
    try {
      const persisted = await createRow(activeTable.name, values);
      addTableRow(activeTable.name, persisted);
      editor.cancelCreate();
      const key = rowKey(activeTable, persisted);
      if (key) editor.setSelectedRowKey(key);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Create failed');
    } finally {
      setSaving(false);
    }
  };

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
        onSelectTable={(idx) => { setActiveTableIndex(idx); editor.setSelectedRowKey(null); }}
        onOpenCreateModal={createForm.handleOpenCreateModal}
      />

      {/* Main Workspace Area */}
      <section className="flex-1 flex flex-col bg-[#09090b] overflow-hidden">
        <SampleDataBanner />
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
            <button
              onClick={() => { void refreshActiveTable(); }}
              disabled={!isBackendAvailable() || isRefreshing}
              title={!isBackendAvailable() ? REFRESH_DISABLED_TITLE : undefined}
              className="flex items-center gap-1.5 text-zinc-400 hover:text-white cursor-pointer transition-colors px-2.5 py-1 hover:bg-zinc-900 rounded-xl text-xs disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-zinc-400 disabled:hover:bg-transparent"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} /><span>Refresh</span>
            </button>
            <LiveStatusBadge status={liveStatus} />
          </div>
          <div className="flex items-center gap-3">
            <div className="flex bg-zinc-950 rounded-xl p-0.5 border border-zinc-800 text-xs font-semibold">
              <button onClick={() => setIsStructureView(false)} className={`px-3 py-1 rounded-lg cursor-pointer transition-all ${!isStructureView ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>Data Grid</button>
              <button onClick={() => setIsStructureView(true)} className={`px-3 py-1 rounded-lg cursor-pointer transition-all ${isStructureView ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>Structure Specs</button>
            </div>
            <button
              onClick={handleAddRecord}
              disabled={!isBackendAvailable() || !activeTable}
              title={!isBackendAvailable() ? READ_ONLY_TITLE : undefined}
              className="bg-white text-black px-3.5 py-1.5 rounded-xl text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 transition-all shadow-md shadow-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus className="w-3.5 h-3.5" /><span>Add Record</span>
            </button>
          </div>
        </div>

        {/* Grid Navigation / Controls */}
        <div className="h-10 bg-zinc-950/40 border-b border-zinc-800/60 flex items-center px-4 gap-6 shrink-0">
          {!isStructureView && (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Filter columns"
                className="flex items-center gap-1.5 text-zinc-400 hover:text-white cursor-pointer transition-colors px-2.5 py-1 hover:bg-zinc-900 rounded-xl text-xs"
              >
                <Filter className="w-3.5 h-3.5" /><span>Filter Columns</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {activeTable?.columns.map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col.name}
                    checked={!hiddenColumns.has(col.name)}
                    onCheckedChange={() => toggleColumnVisibility(col.name)}
                  >
                    {col.name}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
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
                  {visibleColumns.map((col) => {
                    const isSorted = sort?.column === col.name;
                    const SortIcon = isSorted ? (sort?.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
                    return (
                      <th
                        key={col.name}
                        onClick={() => cycleSort(col.name)}
                        className="px-4 py-3 border-r border-zinc-800 min-w-[120px] cursor-pointer select-none hover:bg-zinc-900/40 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="text-zinc-500 uppercase tracking-wider">{col.name}</span>
                          <div className="flex items-center gap-1">
                            {col.isPK && <span className="text-[9px] text-zinc-400 font-semibold border border-zinc-800 px-1.5 py-0.2 rounded">PK</span>}
                            <SortIcon className={`w-3 h-3 ${isSorted ? 'text-white' : 'text-zinc-600'}`} />
                          </div>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/40">
                {filteredRecords.length === 0 ? (
                  <tr><td colSpan={visibleColumns.length + 1} className="p-12 text-center text-zinc-500 italic font-sans text-xs">No matching records found. Clear filters or add new rows.</td></tr>
                ) : (
                  filteredRecords.map((row, idx) => {
                    const key = activeTable ? rowKey(activeTable, row) : null;
                    const isSelected = key !== null && editor.selectedRowKey === key;
                    return (
                      <tr key={key ?? idx} onClick={() => editor.setSelectedRowKey(key)} className={`transition-colors cursor-pointer ${isSelected ? 'bg-zinc-900/30 border-y border-zinc-800 font-semibold' : 'hover:bg-zinc-900/10'}`}>
                        <td className="px-3 py-2.5 border-r border-zinc-800"><input className="rounded bg-zinc-950 border-zinc-800 text-white focus:ring-0" type="checkbox" checked={isSelected} onChange={() => editor.setSelectedRowKey(key)} /></td>
                        {visibleColumns.map((col) => {
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
      {editor.detailsPanelOpen && activeTable && (selectedRecord || editor.mode === 'create') && (
        <RecordInspector
          activeTable={activeTable}
          record={selectedRecord ?? {}}
          draft={editor.draft}
          nulls={editor.nulls}
          dirtyColumns={editor.dirtyColumns}
          isDirty={editor.isDirty}
          mode={editor.mode}
          canSave={isBackendAvailable()}
          disabledTitle={READ_ONLY_TITLE}
          saving={saving}
          error={saveError}
          onFieldChange={editor.setField}
          onNullToggle={editor.setNull}
          onSave={() => { void (editor.mode === 'create' ? handleCreateRecord() : handleSave()); }}
          onDiscard={editor.mode === 'create' ? handleCancelCreate : handleDiscard}
          onClose={() => editor.setDetailsPanelOpen(false)}
        />
      )}

      {/* Create Table Modal */}
      <CreateTableModal
        isOpen={createForm.isCreateModalOpen}
        newTableName={createForm.newTableName}
        newTableSchema={createForm.newTableSchema}
        newTableColumns={createForm.newTableColumns}
        onClose={createForm.handleCloseCreateModal}
        onTableNameChange={createForm.setNewTableName}
        onTableSchemaChange={createForm.setNewTableSchema}
        onAddColumn={createForm.handleAddColumn}
        onRemoveColumn={createForm.handleRemoveColumn}
        onUpdateColumn={createForm.handleUpdateColumn}
        onSubmit={createForm.handleCreateTableSubmit}
      />
    </div>
  );
}
