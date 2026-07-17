/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { X, Save, RotateCcw } from 'lucide-react';
import { Table } from '../../../../types';

interface RecordInspectorProps {
  activeTable: Table;
  selectedRowIndex: number;
  editEmail: string;
  editRole: string;
  editMetadata: string;

  onClose: () => void;
  onEmailChange: (value: string) => void;
  onRoleChange: (value: string) => void;
  onMetadataChange: (value: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}

export function RecordInspector({
  activeTable,
  selectedRowIndex,
  editEmail,
  editRole,
  editMetadata,
  onClose,
  onEmailChange,
  onRoleChange,
  onMetadataChange,
  onSave,
  onDiscard,
}: RecordInspectorProps) {
  const record = activeTable?.records?.[selectedRowIndex];
  if (!record) return null;

  return (
    <aside className="w-[320px] bg-[#09090b] border-l border-zinc-800/80 flex flex-col shrink-0">
      <div className="p-4 border-b border-zinc-800/80 flex items-center justify-between bg-zinc-950/20">
        <span className="text-[10px] font-extrabold text-zinc-500 uppercase tracking-widest font-sans">
          RECORD INSPECTOR
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
          {/* PRIMARY KEY DISPLAY */}
          <div>
            <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block mb-1">
              ID (PRIMARY KEY)
            </label>
            <div className="bg-zinc-900 p-2.5 rounded-xl border border-zinc-800 font-mono text-xs text-white break-all select-all">
              {record.id || 'GEN_RANDOM_UUID()'}
            </div>
          </div>

          {/* EMAIL FIELD */}
          {record.email !== undefined && (
            <div>
              <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block mb-1">
                EMAIL
              </label>
              <input
                value={editEmail}
                onChange={(e) => onEmailChange(e.target.value)}
                type="text"
                className="w-full bg-zinc-950 border border-zinc-805 rounded-xl p-2.5 text-xs text-white outline-none focus:border-zinc-700 font-mono"
              />
            </div>
          )}

          {/* ROLE PICKER */}
          {record.role !== undefined && (
            <div>
              <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block mb-1">
                ROLE
              </label>
              <select
                value={editRole}
                onChange={(e) => onRoleChange(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-805 rounded-xl p-2.5 text-xs text-white outline-none focus:border-zinc-700"
              >
                <option value="ADMIN">ADMIN</option>
                <option value="USER">USER</option>
                <option value="MODERATOR">MODERATOR</option>
              </select>
            </div>
          )}

          {/* METADATA JSON FIELD */}
          {record.metadata !== undefined && (
            <div>
              <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block mb-1">
                METADATA BLOB (JSON)
              </label>
              <textarea
                value={editMetadata}
                onChange={(e) => onMetadataChange(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-805 rounded-xl p-2.5 text-xs text-zinc-300 font-mono leading-relaxed h-44 outline-none focus:border-zinc-700 resize-none"
                spellCheck={false}
              />
            </div>
          )}
        </div>
      </div>

      <div className="p-4 border-t border-zinc-800/80 bg-[#09090b] flex gap-2">
        <button
          onClick={onDiscard}
          className="flex-1 bg-zinc-900 hover:bg-zinc-850 text-zinc-400 hover:text-white border border-zinc-800 py-2.5 rounded-xl text-xs font-semibold uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>Discard</span>
        </button>
        <button
          onClick={onSave}
          className="flex-1 bg-white hover:bg-zinc-200 text-black py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-md shadow-white/5"
        >
          <Save className="w-3.5 h-3.5" />
          <span>Save Row</span>
        </button>
      </div>
    </aside>
  );
}
