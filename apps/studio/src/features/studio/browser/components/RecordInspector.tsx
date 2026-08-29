/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { X, Save, RotateCcw, Plus } from 'lucide-react';
import { Table } from '../../../../types';
import { resolveWidget } from './widgets/registry';
import type { RecordEditorMode } from '../hooks/useRecordEditor';

interface RecordInspectorProps {
  activeTable: Table;
  record: Record<string, unknown>;
  draft: Record<string, string>;
  nulls: Record<string, boolean>;
  dirtyColumns: string[];
  isDirty: boolean;
  /** `'edit'` for an existing row, `'create'` for an in-progress new row.
   * Widget rendering is identical in both modes — only the footer's
   * labels/enablement and the submit semantics differ. */
  mode: RecordEditorMode;
  /** Whether Save/Discard (or Create/Cancel) are wired to a real backend.
   * When false they stay disabled with `disabledTitle` per studio-ui-honesty. */
  canSave: boolean;
  disabledTitle: string;
  saving: boolean;
  /** Validation/server error surfaced from the last save attempt, if any. */
  error: string | null;

  onFieldChange: (column: string, value: string) => void;
  onNullToggle: (column: string, isNull: boolean) => void;
  onSave: () => void;
  onDiscard: () => void;
  onClose: () => void;
}

export function RecordInspector({
  activeTable,
  draft,
  nulls,
  isDirty,
  mode,
  canSave,
  disabledTitle,
  saving,
  error,
  onFieldChange,
  onNullToggle,
  onSave,
  onDiscard,
  onClose,
}: RecordInspectorProps) {
  const isCreating = mode === 'create';
  const saveDisabled = !canSave || saving || (!isCreating && !isDirty);
  const discardDisabled = isCreating ? saving : !isDirty;

  return (
    <aside className="w-[320px] bg-[#09090b] border-l border-zinc-800/80 flex flex-col shrink-0">
      <div className="p-4 border-b border-zinc-800/80 flex items-center justify-between bg-zinc-950/20">
        <span className="text-[10px] font-extrabold text-zinc-500 uppercase tracking-widest font-sans">
          {isCreating ? 'NEW RECORD' : 'RECORD INSPECTOR'}
        </span>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-white p-1.5 rounded-xl hover:bg-zinc-900 transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 space-y-5 overflow-y-auto custom-scrollbar flex-1">
        <div className="space-y-4 font-sans">
          {activeTable.columns.map((column) => {
            const widget = resolveWidget(column);
            const isNull = nulls[column.name] ?? false;
            const readOnly = column.isGenerated === true;
            return (
              <div key={column.name}>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                    {column.name}
                    {column.isPK && <span className="ml-1.5 text-zinc-600">(PK)</span>}
                  </label>
                  {column.isNN === false && !readOnly && (
                    <label className="flex items-center gap-1 text-[9px] text-zinc-500 uppercase tracking-wider cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isNull}
                        onChange={(e) => onNullToggle(column.name, e.target.checked)}
                        className="rounded bg-zinc-950 border-zinc-800 focus:ring-0"
                      />
                      Null
                    </label>
                  )}
                </div>
                {isNull ? (
                  <div className="bg-zinc-900 p-2.5 rounded-xl border border-zinc-800 text-xs text-zinc-500 italic">
                    NULL
                  </div>
                ) : (
                  widget.render({
                    column,
                    value: draft[column.name] ?? '',
                    disabled: readOnly,
                    onChange: (v) => onFieldChange(column.name, v),
                  })
                )}
              </div>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="mx-4 mb-3 p-2.5 rounded-xl border border-red-900/60 bg-red-950/40 text-[11px] text-red-300 font-sans">
          {error}
        </div>
      )}

      <div className="p-4 border-t border-zinc-800/80 bg-[#09090b] flex gap-2">
        <button
          disabled={discardDisabled}
          title={!isCreating && discardDisabled ? 'No unsaved changes to discard.' : undefined}
          onClick={onDiscard}
          className="flex-1 bg-zinc-900 text-zinc-400 border border-zinc-800 py-2.5 rounded-xl text-xs font-semibold uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>{isCreating ? 'Cancel' : 'Discard'}</span>
        </button>
        <button
          disabled={saveDisabled}
          title={!canSave ? disabledTitle : undefined}
          onClick={onSave}
          className="flex-1 bg-white text-black py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 shadow-md shadow-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isCreating ? <Plus className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
          <span>{saving ? (isCreating ? 'Creating…' : 'Saving…') : isCreating ? 'Create Row' : 'Save Row'}</span>
        </button>
      </div>
    </aside>
  );
}
