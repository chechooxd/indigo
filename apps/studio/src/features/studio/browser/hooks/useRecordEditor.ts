/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import type { Table } from '../../../../types';
import { resolveWidget } from '../components/widgets/registry';

export interface EditBuffer {
  draft: Record<string, string>;
  nulls: Record<string, boolean>;
}

export interface UseRecordEditorReturn {
  /** `rowKey(table, row)` of the selected row, or `null` when none is
   * selected. Stable across refetch/sort/pagination, unlike an index. */
  selectedRowKey: string | null;
  detailsPanelOpen: boolean;

  draft: Record<string, string>;
  nulls: Record<string, boolean>;
  /** Columns whose current draft/null state differs from the loaded baseline. */
  dirtyColumns: string[];
  isDirty: boolean;

  setSelectedRowKey: (key: string | null) => void;
  setDetailsPanelOpen: (open: boolean) => void;
  setField: (column: string, value: string) => void;
  setNull: (column: string, isNull: boolean) => void;
  /** Loads `row` into the buffer (also resets the baseline). `row: null`
   * clears the buffer entirely (no row selected). */
  loadRow: (table: Table, row: Record<string, unknown> | null) => void;
  /** Resets the buffer back to the last loaded baseline. */
  discard: () => void;
}

function emptyBuffer(): EditBuffer {
  return { draft: {}, nulls: {} };
}

export function useRecordEditor(): UseRecordEditorReturn {
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [detailsPanelOpen, setDetailsPanelOpen] = useState<boolean>(true);

  const [buffer, setBuffer] = useState<EditBuffer>(emptyBuffer());
  const [baseline, setBaseline] = useState<EditBuffer>(emptyBuffer());

  const loadRow = useCallback((table: Table, row: Record<string, unknown> | null) => {
    if (!row) {
      setBuffer(emptyBuffer());
      setBaseline(emptyBuffer());
      return;
    }
    const draft: Record<string, string> = {};
    const nulls: Record<string, boolean> = {};
    for (const column of table.columns) {
      const rawValue = row[column.name];
      nulls[column.name] = rawValue === null || rawValue === undefined;
      draft[column.name] = resolveWidget(column).toDraft(rawValue);
    }
    const next = { draft, nulls };
    setBuffer(next);
    setBaseline(next);
  }, []);

  const setField = useCallback((column: string, value: string) => {
    setBuffer((prev) => ({ ...prev, draft: { ...prev.draft, [column]: value } }));
  }, []);

  const setNull = useCallback((column: string, isNull: boolean) => {
    setBuffer((prev) => ({ ...prev, nulls: { ...prev.nulls, [column]: isNull } }));
  }, []);

  const discard = useCallback(() => {
    setBuffer(baseline);
  }, [baseline]);

  const dirtyColumns = Object.keys(buffer.draft).filter(
    (column) => buffer.draft[column] !== baseline.draft[column] || buffer.nulls[column] !== baseline.nulls[column],
  );

  return {
    selectedRowKey,
    detailsPanelOpen,
    draft: buffer.draft,
    nulls: buffer.nulls,
    dirtyColumns,
    isDirty: dirtyColumns.length > 0,
    setSelectedRowKey,
    setDetailsPanelOpen,
    setField,
    setNull,
    loadRow,
    discard,
  };
}
