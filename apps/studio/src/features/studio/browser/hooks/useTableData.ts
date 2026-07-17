/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo } from 'react';
import { Table } from '../../../../types';
import { useDataStore } from '../../../../store/useDataStore';

export interface UseTableDataReturn {
  /** Full list from the store */
  tables: Table[];
  /** Tables filtered by the sidebar search query */
  filteredTables: Table[];
  /** Records of the active table filtered by the record search query */
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

  // Handlers
  setActiveTableIndex: (index: number) => void;
  setTableFilterQuery: (query: string) => void;
  setRecordSearchQuery: (query: string) => void;
  setIsStructureView: (value: boolean) => void;
  /** Convenience: select a table by its original index and reset the active row */
  handleSelectTable: (originalIndex: number, resetRow: () => void) => void;
}

export function useTableData(): UseTableDataReturn {
  const { tables } = useDataStore();

  const [activeTableIndex, setActiveTableIndex] = useState<number>(0);
  const [tableFilterQuery, setTableFilterQuery] = useState<string>('');
  const [recordSearchQuery, setRecordSearchQuery] = useState<string>('');
  const [isStructureView, setIsStructureView] = useState<boolean>(false);

  const activeTable = tables[activeTableIndex] || tables[0];

  const filteredTables = useMemo(
    () => tables.filter(t => t.name.toLowerCase().includes(tableFilterQuery.toLowerCase())),
    [tables, tableFilterQuery],
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

  return {
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
    handleSelectTable,
  };
}
