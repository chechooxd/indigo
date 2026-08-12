/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo, useEffect } from 'react';
import { Table, TableColumn } from '../../../../types';
import { useDataStore } from '../../../../store/useDataStore';

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  column: string;
  direction: SortDirection;
}

export interface UseTableDataReturn {
  /** Full list from the store */
  tables: Table[];
  /** Tables filtered by the sidebar search query */
  filteredTables: Table[];
  /** Records of the active table: search-filtered, then sorted (over a copy) */
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
  /** Current column sort, or null when unsorted; resets per table */
  sort: SortState | null;

  // Handlers
  setActiveTableIndex: (index: number) => void;
  setTableFilterQuery: (query: string) => void;
  setRecordSearchQuery: (query: string) => void;
  setIsStructureView: (value: boolean) => void;
  /** Convenience: select a table by its original index and reset the active row */
  handleSelectTable: (originalIndex: number, resetRow: () => void) => void;
  /** Toggle a column's visibility in the Data Grid */
  toggleColumnVisibility: (columnName: string) => void;
  /** Cycle a column's sort state: unsorted -> asc -> desc -> unsorted */
  cycleSort: (columnName: string) => void;
}

// Comparator for the grid's sort: numbers compare numerically, booleans sort
// false < true, everything else falls back to locale-aware string compare.
// Nullish values (null/undefined) always sort last, regardless of direction —
// this is a deliberate choice so "unknown" never masquerades as "smallest".
function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  return String(a).localeCompare(String(b));
}

function compareRows(a: Record<string, unknown>, b: Record<string, unknown>, column: string, direction: SortDirection): number {
  const aVal = a[column];
  const bVal = b[column];
  const aNullish = aVal === null || aVal === undefined;
  const bNullish = bVal === null || bVal === undefined;
  if (aNullish && bNullish) return 0;
  if (aNullish) return 1;
  if (bNullish) return -1;
  const base = compareValues(aVal, bVal);
  return direction === 'asc' ? base : -base;
}

export function useTableData(): UseTableDataReturn {
  const { tables } = useDataStore();

  const [activeTableIndex, setActiveTableIndex] = useState<number>(0);
  const [tableFilterQuery, setTableFilterQuery] = useState<string>('');
  const [recordSearchQuery, setRecordSearchQuery] = useState<string>('');
  const [isStructureView, setIsStructureView] = useState<boolean>(false);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortState | null>(null);

  // Filter/sort view-state is per-table: reset both whenever the active
  // table changes so a hidden column or sort from one table never leaks
  // into another.
  useEffect(() => {
    setHiddenColumns(new Set());
    setSort(null);
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
    const filtered = !recordSearchQuery
      ? activeTable.records
      : activeTable.records.filter(rec =>
          Object.values(rec).some(val =>
            String(val).toLowerCase().includes(recordSearchQuery.toLowerCase()),
          ),
        );
    if (!sort) return filtered;
    // `.slice()` is load-bearing, not stylistic: when recordSearchQuery is
    // empty, `filtered` IS `activeTable.records` by reference, and `.sort()`
    // mutates in place — that would silently corrupt the Zustand store.
    return filtered.slice().sort((a, b) => compareRows(a, b, sort.column, sort.direction));
  }, [activeTable, recordSearchQuery, sort]);

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

  const cycleSort = (columnName: string) => {
    setSort(prev => {
      if (!prev || prev.column !== columnName) return { column: columnName, direction: 'asc' };
      if (prev.direction === 'asc') return { column: columnName, direction: 'desc' };
      return null;
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
    sort,
    setActiveTableIndex,
    setTableFilterQuery,
    setRecordSearchQuery,
    setIsStructureView,
    handleSelectTable,
    toggleColumnVisibility,
    cycleSort,
  };
}
