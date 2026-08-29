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

describe('useTableData — filter', () => {
  beforeEach(() => {
    resetTables();
  });

  it('filters records by the search query across all fields', () => {
    const { result } = renderHook(() => useTableData());

    act(() => {
      result.current.setRecordSearchQuery('gmail');
    });

    // Only the gmail.com row ('sarah.j@gmail.com' -> 'Sarah Jenkins') matches.
    expect(result.current.filteredRecords).toHaveLength(1);
    expect(result.current.filteredRecords[0].full_name).toBe('Sarah Jenkins');
  });

  it('returns the store\'s own records array by reference when unfiltered (no defensive copy needed)', () => {
    const { result } = renderHook(() => useTableData());

    const storeRecords = useDataStore.getState().tables[0].records;
    expect(result.current.filteredRecords).toBe(storeRecords);
  });

  it('resets hiddenColumns when the active table changes', () => {
    const { result } = renderHook(() => useTableData());

    act(() => {
      result.current.toggleColumnVisibility('email');
    });
    expect(result.current.hiddenColumns.has('email')).toBe(true);

    act(() => {
      result.current.setActiveTableIndex(1);
    });

    expect(result.current.hiddenColumns.size).toBe(0);
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

  it('does not expose sort/cycleSort/compareRows fields — sorting was removed, not hidden', () => {
    const { result } = renderHook(() => useTableData());

    expect('sort' in result.current).toBe(false);
    expect('cycleSort' in result.current).toBe(false);
  });
});
