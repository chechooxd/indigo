/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import type { TableColumn } from '../../../types';

interface ColumnsSpecTableProps {
  columns: TableColumn[];
}

export function ColumnsSpecTable({ columns }: ColumnsSpecTableProps) {
  return (
    <section>
      <h2 className="text-xs font-bold text-zinc-400 mb-4 uppercase tracking-widest font-sans flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-400"></span>
        <span>Columns Specification</span>
      </h2>
      <div className="border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl">
        <table className="w-full text-left text-xs font-sans">
          <thead className="bg-zinc-950 text-zinc-400 border-b border-zinc-800 font-semibold">
            <tr>
              <th className="p-3">Column Name</th>
              <th className="p-3">Type</th>
              <th className="p-3">Constraints</th>
              <th className="p-3">Default Value</th>
              <th className="p-3">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900 text-zinc-300">
            {columns.map((col) => (
              <tr key={col.name} className="hover:bg-zinc-950/40 transition-colors">
                <td className="p-3 font-mono font-bold text-zinc-100">{col.name}</td>
                <td className="p-3">
                  <span className="bg-zinc-900 text-zinc-400 border border-zinc-800/80 px-1.5 py-0.5 rounded-md font-mono text-[10px]">
                    {col.type}
                  </span>
                </td>
                <td className="p-3 font-semibold text-xs">
                  <div className="flex gap-1">
                    {col.isPK && <span className="bg-zinc-900 border border-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded text-[9px]">PK</span>}
                    {col.isNN && <span className="bg-zinc-900/40 border border-zinc-900 text-zinc-500 px-1.5 py-0.5 rounded text-[9px]">NN</span>}
                    {col.isUQ && <span className="bg-zinc-900 border border-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded text-[9px]">UQ</span>}
                  </div>
                </td>
                <td className="p-3 text-zinc-500 font-mono text-[11px] italic">
                  {col.defaultValue || '-'}
                </td>
                <td className="p-3 text-zinc-400 max-w-xs text-[11px] leading-relaxed">
                  {col.description || 'Database engine system column value.'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
