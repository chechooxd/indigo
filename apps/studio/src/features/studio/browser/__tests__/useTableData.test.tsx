/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useTableData } from '../hooks/useTableData';
import { useDataStore } from '../../../../store/useDataStore';
import { INITIAL_TABLES } from '../../../../data/mockData';

function resetTables() {
  // Deep-clone so per-test store mutations never leak across tests (Zustand
  // stores are module singletons).
  useDataStore.setState({
    tables: INITIAL_TABLES.map((t) => ({ ...t, records: t.records.map((r) => ({ ...r })) })),
  });
}

describe('useTableData — filter + sort', () => {
  beforeEach(() => {
    resetTables();
  });

  it('sorts a copy, never mutating the store\'s original records array', () => {
    const { result } = renderHook(() => useTableData());

    const storeRecordsBefore = useDataStore.getState().tables[0].records;
    const storeRecordsBeforeSnapshot = storeRecordsBefore.map((r) => r.full_name);

    act(() => {
      result.current.cycleSort('full_name');
    });

    const storeRecordsAfter = useDataStore.getState().tables[0].records;

    // Same array reference, same order: the hook must never sort in-place.
    expect(storeRecordsAfter).toBe(storeRecordsBefore);
    expect(storeRecordsAfter.map((r) => r.full_name)).toEqual(storeRecordsBeforeSnapshot);
  });

  it('cycles asc -> desc -> unsorted on repeated cycleSort calls, sorting only the copy', () => {
    const { result } = renderHook(() => useTableData());

    act(() => {
      result.current.cycleSort('full_name');
    });
    expect(result.current.sort).toEqual({ column: 'full_name', direction: 'asc' });
    const ascNames = result.current.filteredRecords.map((r) => r.full_name);
    expect(ascNames).toEqual([...ascNames].sort((a, b) => a.localeCompare(b)));

    act(() => {
      result.current.cycleSort('full_name');
    });
    expect(result.current.sort).toEqual({ column: 'full_name', direction: 'desc' });
    const descNames = result.current.filteredRecords.map((r) => r.full_name);
    expect(descNames).toEqual([...ascNames].reverse());

    act(() => {
      result.current.cycleSort('full_name');
    });
    expect(result.current.sort).toBeNull();
  });

  it('filters before sorting: sort only reorders the already-filtered rows', () => {
    const { result } = renderHook(() => useTableData());

    act(() => {
      result.current.setRecordSearchQuery('gmail');
    });
    act(() => {
      result.current.cycleSort('full_name');
    });

    // Only the gmail.com row ('sarah.j@gmail.com' -> 'Sarah Jenkins') matches
    // the search, so sorting must not resurrect filtered-out rows.
    expect(result.current.filteredRecords).toHaveLength(1);
    expect(result.current.filteredRecords[0].full_name).toBe('Sarah Jenkins');
  });

  it('resets hiddenColumns and sort when the active table changes', () => {
    const { result } = renderHook(() => useTableData());

    act(() => {
      result.current.toggleColumnVisibility('email');
      result.current.cycleSort('full_name');
    });
    expect(result.current.hiddenColumns.has('email')).toBe(true);
    expect(result.current.sort).not.toBeNull();

    act(() => {
      result.current.setActiveTableIndex(1);
    });

    expect(result.current.hiddenColumns.size).toBe(0);
    expect(result.current.sort).toBeNull();
  });

  it('toggleColumnVisibility hides a column from visibleColumns and restores it on re-toggle', () => {
    const { result } = renderHook(() => useTableData());

    expect(result.current.visibleColumns.some((c) => c.name === 'email')).toBe(true);

    act(() => {
      result.current.toggleColumnVisibility('email');
    });
    expect(result.current.visibleColumns.some((c) => c.name === 'email')).toBe(false);

    act(() => {
      result.current.toggleColumnVisibility('email');
    });
    expect(result.current.visibleColumns.some((c) => c.name === 'email')).toBe(true);
  });
});
