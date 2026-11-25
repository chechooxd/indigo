/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useSettingsStore } from '../../../../store/useSettingsStore';

interface DeleteRecordDialogProps {
  open: boolean;
  tableName: string;
  /** Primary key values identifying the row to delete, keyed by column name. */
  pk: Record<string, unknown>;
  onCancel: () => void;
  /**
   * Called only when the confirm click passes the dual gate: the user
   * explicitly confirmed AND `safeUpdates` is `false` **at the moment of the
   * click**, re-read directly from `useSettingsStore` rather than from any
   * prop captured when the dialog first opened. This is deliberate: the
   * dialog being open must never, on its own, be sufficient to authorize a
   * delete — see the studio-write-guards spec's "both required" scenario.
   * If Safe Updates flips on while the dialog is open, the click is a no-op
   * and no DELETE request is ever sent.
   */
  onConfirm: () => void;
}

export function DeleteRecordDialog({ open, tableName, pk, onCancel, onConfirm }: DeleteRecordDialogProps) {
  if (!open) return null;

  const handleConfirmClick = () => {
    // Re-read at click time — never trust a `safeUpdates` value captured
    // earlier (e.g. via a prop from when the dialog opened, or a closure).
    if (useSettingsStore.getState().safeUpdates) return;
    onConfirm();
  };

  const pkSummary = Object.entries(pk)
    .map(([column, value]) => `${column} = ${JSON.stringify(value)}`)
    .join(', ');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-record-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 font-sans"
    >
      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl p-6 w-[380px] space-y-4 shadow-xl">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-400" />
          <h3 id="delete-record-dialog-title" className="text-sm font-bold text-white">
            Delete row from &quot;{tableName}&quot;?
          </h3>
        </div>
        <p className="text-xs text-zinc-400 font-mono">{pkSummary}</p>
        <p className="text-xs text-zinc-500">This action is permanent and cannot be undone.</p>
        <div className="flex gap-2 justify-end pt-2">
          <button
            onClick={onCancel}
            className="px-3.5 py-2 rounded-xl text-xs font-semibold text-zinc-400 border border-zinc-800 hover:text-white hover:bg-zinc-900 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirmClick}
            className="px-3.5 py-2 rounded-xl text-xs font-bold uppercase tracking-wider bg-red-600 text-white hover:bg-red-500 transition-colors cursor-pointer"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
