/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo, useEffect } from 'react';
import { Table, TableColumn } from '../../../../types';
import { useDataStore } from '../../../../store/useDataStore';

export interface UseTableDataReturn {
  /** Full list from the store */
  tables: Table[];
  /** Tables filtered by the sidebar search query */
  filteredTables: Table[];
  /** Records of the active table: search-filtered (over a copy) */
  filteredRecords: Table['records'];
  /** The currently active Table object */
  activeTable: Table;
  /** Index inside `tables` of the currently selected table */
  activeTableIndex: number;
  /** Sidebar filter text */
  tableFilterQuery: string;
  /** Record grid search text */
  recordSearchQuery: string;
  /** When true the Structure Specs pane is shown instead of the Data Grid */
  isStructureView: boolean;
  /** Column names hidden from the Data Grid (header + cells); resets per table */
  hiddenColumns: Set<string>;
  /** activeTable.columns minus hiddenColumns, in original order */
  visibleColumns: TableColumn[];

  // Handlers
  setActiveTableIndex: (index: number) => void;
  setTableFilterQuery: (query: string) => void;
  setRecordSearchQuery: (query: string) => void;
  setIsStructureView: (value: boolean) => void;
  /** Convenience: select a table by its original index and reset the active row */
  handleSelectTable: (originalIndex: number, resetRow: () => void) => void;
  /** Toggle a column's visibility in the Data Grid */
  toggleColumnVisibility: (columnName: string) => void;
}

export function useTableData(): UseTableDataReturn {
  const { tables } = useDataStore();

  const [activeTableIndex, setActiveTableIndex] = useState<number>(0);
  const [tableFilterQuery, setTableFilterQuery] = useState<string>('');
  const [recordSearchQuery, setRecordSearchQuery] = useState<string>('');
  const [isStructureView, setIsStructureView] = useState<boolean>(false);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());

  // Filter view-state is per-table: reset whenever the active table changes
  // so a hidden column from one table never leaks into another.
  useEffect(() => {
    setHiddenColumns(new Set());
  }, [activeTableIndex]);

  const activeTable = tables[activeTableIndex] || tables[0];

  const filteredTables = useMemo(
    () => tables.filter(t => t.name.toLowerCase().includes(tableFilterQuery.toLowerCase())),
    [tables, tableFilterQuery],
  );

  const visibleColumns = useMemo(
    () => (activeTable?.columns ?? []).filter(col => !hiddenColumns.has(col.name)),
    [activeTable, hiddenColumns],
  );

  const filteredRecords = useMemo(() => {
    if (!activeTable || !activeTable.records) return [];
    if (!recordSearchQuery) return activeTable.records;
    return activeTable.records.filter(rec =>
      Object.values(rec).some(val =>
        String(val).toLowerCase().includes(recordSearchQuery.toLowerCase()),
      ),
    );
  }, [activeTable, recordSearchQuery]);

  const handleSelectTable = (originalIndex: number, resetRow: () => void) => {
    setActiveTableIndex(originalIndex);
    resetRow();
  };

  const toggleColumnVisibility = (columnName: string) => {
    setHiddenColumns(prev => {
      const next = new Set(prev);
      if (next.has(columnName)) next.delete(columnName);
      else next.add(columnName);
      return next;
    });
  };

  return {
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
    setActiveTableIndex,
    setTableFilterQuery,
    setRecordSearchQuery,
    setIsStructureView,
    handleSelectTable,
    toggleColumnVisibility,
  };
}
