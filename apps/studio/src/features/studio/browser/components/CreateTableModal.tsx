/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import React from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import { TableColumn } from '../../../../types';

interface CreateTableModalProps {
  isOpen: boolean;
  newTableName: string;
  newTableSchema: string;
  newTableColumns: TableColumn[];

  onClose: () => void;
  onTableNameChange: (name: string) => void;
  onTableSchemaChange: (schema: string) => void;
  onAddColumn: () => void;
  onRemoveColumn: (index: number) => void;
  onUpdateColumn: (index: number, fields: Partial<TableColumn>) => void;
  /** Guarded no-op: table creation has no write backend yet (submit is disabled). */
  onSubmit: (e: React.FormEvent) => void;
}

export function CreateTableModal({
  isOpen,
  newTableName,
  newTableSchema,
  newTableColumns,
  onClose,
  onTableNameChange,
  onTableSchemaChange,
  onAddColumn,
  onRemoveColumn,
  onUpdateColumn,
  onSubmit,
}: CreateTableModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-zinc-950 border border-zinc-800 rounded-3xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-950/40">
          <div>
            <h3 className="text-sm font-bold text-white uppercase tracking-wider font-sans">
              Create New Table
            </h3>
            <p className="text-[11px] text-zinc-500 mt-1 font-sans">
              Specify the name, schema space, columns and constraints.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-white p-1.5 rounded-xl hover:bg-zinc-900 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form
          onSubmit={onSubmit}
          className="flex-1 flex flex-col overflow-hidden"
        >
          <div className="flex-1 p-6 space-y-6 overflow-y-auto custom-scrollbar">
            {/* Meta Properties Row */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block mb-1.5">
                  Table Name
                </label>
                <input
                  type="text"
                  required
                  value={newTableName}
                  onChange={(e) => onTableNameChange(e.target.value)}
                  placeholder="e.g. comments"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-2.5 text-xs text-white outline-none focus:border-zinc-700 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block mb-1.5">
                  Schema
                </label>
                <select
                  value={newTableSchema}
                  onChange={(e) => onTableSchemaChange(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-2.5 text-xs text-white outline-none focus:border-zinc-700 font-mono"
                >
                  <option value="public">public</option>
                  <option value="billing">billing</option>
                  <option value="analytics">analytics</option>
                </select>
              </div>
            </div>

            {/* Columns Builder Area */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block">
                  Columns Definition
                </label>
                <button
                  type="button"
                  onClick={onAddColumn}
                  className="text-[10px] font-bold text-zinc-400 hover:text-white flex items-center gap-1 hover:bg-zinc-900 px-2.5 py-1 rounded-lg border border-zinc-850 transition-all cursor-pointer"
                >
                  <Plus className="w-3 h-3" /> Add Column
                </button>
              </div>

              {/* Column list mapping */}
              <div className="border border-zinc-800 rounded-2xl overflow-hidden bg-zinc-950">
                <table className="w-full text-left text-xs font-mono">
                  <thead className="bg-zinc-900/50 border-b border-zinc-800 text-zinc-500 text-[10px] uppercase">
                    <tr>
                      <th className="p-2.5 w-[30%]">Name</th>
                      <th className="p-2.5 w-[25%]">Type</th>
                      <th className="p-2.5 text-center w-[8%]">PK</th>
                      <th className="p-2.5 text-center w-[8%]">NN</th>
                      <th className="p-2.5 text-center w-[8%]">UQ</th>
                      <th className="p-2.5 w-[15%]">Default</th>
                      <th className="p-2.5 text-center w-[6%]"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                    {newTableColumns.map((col, index) => (
                      <tr key={index} className="hover:bg-zinc-900/10 transition-colors">
                        <td className="p-2">
                          <input
                            type="text"
                            required
                            value={col.name}
                            onChange={(e) => onUpdateColumn(index, { name: e.target.value })}
                            placeholder="col_name"
                            className="w-full bg-zinc-900/50 border border-zinc-800/80 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-zinc-700 font-mono"
                          />
                        </td>
                        <td className="p-2">
                          <select
                            value={col.type}
                            onChange={(e) => onUpdateColumn(index, { type: e.target.value })}
                            className="w-full bg-zinc-900/50 border border-zinc-800/80 rounded-lg px-1.5 py-1.5 text-xs text-white outline-none focus:border-zinc-700 font-mono"
                          >
                            <option value="UUID">UUID</option>
                            <option value="VARCHAR(255)">VARCHAR(255)</option>
                            <option value="VARCHAR(50)">VARCHAR(50)</option>
                            <option value="TEXT">TEXT</option>
                            <option value="INTEGER">INTEGER</option>
                            <option value="SERIAL">SERIAL</option>
                            <option value="BOOLEAN">BOOLEAN</option>
                            <option value="TIMESTAMPTZ">TIMESTAMPTZ</option>
                          </select>
                        </td>
                        <td className="p-2 text-center">
                          <input
                            type="checkbox"
                            checked={col.isPK}
                            onChange={(e) => onUpdateColumn(index, { isPK: e.target.checked })}
                            className="rounded bg-zinc-900 border-zinc-800 text-white focus:ring-0"
                          />
                        </td>
                        <td className="p-2 text-center">
                          <input
                            type="checkbox"
                            checked={col.isNN}
                            onChange={(e) => onUpdateColumn(index, { isNN: e.target.checked })}
                            className="rounded bg-zinc-900 border-zinc-800 text-white focus:ring-0"
                          />
                        </td>
                        <td className="p-2 text-center">
                          <input
                            type="checkbox"
                            checked={col.isUQ}
                            onChange={(e) => onUpdateColumn(index, { isUQ: e.target.checked })}
                            className="rounded bg-zinc-900 border-zinc-800 text-white focus:ring-0"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="text"
                            value={col.defaultValue || ''}
                            onChange={(e) => onUpdateColumn(index, { defaultValue: e.target.value })}
                            placeholder="NULL"
                            className="w-full bg-zinc-900/50 border border-zinc-800/80 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-zinc-700 font-mono"
                          />
                        </td>
                        <td className="p-2 text-center">
                          <button
                            type="button"
                            disabled={newTableColumns.length <= 1}
                            onClick={() => onRemoveColumn(index)}
                            className="text-zinc-600 hover:text-red-400 disabled:opacity-30 disabled:hover:text-zinc-600 p-1 rounded-md hover:bg-zinc-900 transition-colors cursor-pointer"
                            title="Remove column"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Actions Footer */}
          <div className="px-6 py-4 border-t border-zinc-800 flex justify-end gap-3 bg-zinc-950">
            <button
              type="button"
              onClick={onClose}
              className="bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 text-zinc-400 hover:text-white px-4 py-2.5 rounded-xl text-xs font-semibold uppercase tracking-wider transition-all cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled
              title="Table creation isn't available yet — this build is read-only."
              className="bg-white text-black px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider transition-all shadow-md shadow-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Create Table
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
