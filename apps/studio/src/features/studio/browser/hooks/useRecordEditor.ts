/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { useState, useCallback } from 'react';
import type { Table } from '../../../../types';
import { resolveWidget } from '../components/widgets/registry';

export interface EditBuffer {
  draft: Record<string, string>;
  nulls: Record<string, boolean>;
}

/** `'edit'` for an existing selected row, `'create'` for an in-progress new
 * row started via `startCreate`. The Record Inspector's widget rendering is
 * shared by both — only the footer's labels/enablement and the submit
 * handler differ by mode (see `TableBrowserPage`/`RecordInspector`). */
export type RecordEditorMode = 'edit' | 'create';

export interface UseRecordEditorReturn {
  /** `rowKey(table, row)` of the selected row, or `null` when none is
   * selected (including while `mode === 'create'`). Stable across
   * refetch/sort/pagination, unlike an index. */
  selectedRowKey: string | null;
  detailsPanelOpen: boolean;
  mode: RecordEditorMode;

  draft: Record<string, string>;
  nulls: Record<string, boolean>;
  /** Columns whose current draft/null state differs from the loaded baseline. */
  dirtyColumns: string[];
  isDirty: boolean;

  setSelectedRowKey: (key: string | null) => void;
  setDetailsPanelOpen: (open: boolean) => void;
  setField: (column: string, value: string) => void;
  setNull: (column: string, isNull: boolean) => void;
  /** Loads `row` into the buffer (also resets the baseline) and sets
   * `mode` to `'edit'`. `row: null` clears the buffer entirely (no row
   * selected). */
  loadRow: (table: Table, row: Record<string, unknown> | null) => void;
  /** Resets the buffer back to the last loaded baseline. */
  discard: () => void;
  /** Enters `'create'` mode: clears the current row selection and seeds an
   * empty draft — one entry per column, nullable columns default to an
   * explicit NULL, NOT NULL columns default to an empty draft the user must
   * fill in. Reuses the exact same widget rendering as an existing row. */
  startCreate: (table: Table) => void;
  /** Leaves `'create'` mode and clears the buffer, without submitting. */
  cancelCreate: () => void;
}

function emptyBuffer(): EditBuffer {
  return { draft: {}, nulls: {} };
}

export function useRecordEditor(): UseRecordEditorReturn {
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [detailsPanelOpen, setDetailsPanelOpen] = useState<boolean>(true);
  const [mode, setMode] = useState<RecordEditorMode>('edit');

  const [buffer, setBuffer] = useState<EditBuffer>(emptyBuffer());
  const [baseline, setBaseline] = useState<EditBuffer>(emptyBuffer());

  const loadRow = useCallback((table: Table, row: Record<string, unknown> | null) => {
    setMode('edit');
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

  const startCreate = useCallback((table: Table) => {
    const draft: Record<string, string> = {};
    const nulls: Record<string, boolean> = {};
    for (const column of table.columns) {
      if (column.isGenerated) {
        // DB-owned; never submitted, and rendered read-only/empty.
        draft[column.name] = '';
        nulls[column.name] = false;
        continue;
      }
      // Nullable columns default to an explicit NULL (matching how the
      // widget's own "Null" toggle represents "no value yet"); NOT NULL
      // columns default to an empty draft the widget must still validate.
      nulls[column.name] = column.isNN === false;
      draft[column.name] = resolveWidget(column).toDraft(undefined);
    }
    const next = { draft, nulls };
    setBuffer(next);
    setBaseline(next);
    setMode('create');
    setSelectedRowKey(null);
  }, []);

  const cancelCreate = useCallback(() => {
    setMode('edit');
    setBuffer(emptyBuffer());
    setBaseline(emptyBuffer());
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
    mode,
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
    startCreate,
    cancelCreate,
  };
}
