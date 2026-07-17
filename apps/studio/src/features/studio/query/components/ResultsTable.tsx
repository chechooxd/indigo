/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import type { QueryResult } from '../../../../lib/api';

interface ResultsTableProps {
  results: QueryResult | null;
  errorMsg: string | null;
}

function formatCell(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return value !== null ? String(value) : 'NULL';
}

export function ResultsTable({ results, errorMsg }: ResultsTableProps) {
  return (
    <div className="flex-1 flex flex-col bg-[#09090b] overflow-hidden">
      <div className="flex h-10 bg-zinc-950/20 border-b border-zinc-800 px-4 items-center">
        <button className="px-3 py-1 bg-zinc-900/50 text-white text-xs font-bold font-sans border-b-2 border-white rounded-t-xl">
          Query Output Results
        </button>
      </div>

      <div className="flex-1 overflow-auto custom-scrollbar bg-[#09090b]">
        {errorMsg ? (
          <div className="p-6 flex gap-3 text-red-400 bg-red-950/10 border border-red-900/30 rounded-2xl m-4 h-[calc(100%-32px)]">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <div>
              <h4 className="font-bold text-sm mb-1">Execution Failure</h4>
              <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap">{errorMsg}</pre>
            </div>
          </div>
        ) : results ? (
          <table className="w-full text-left font-mono text-xs border-collapse">
            <thead className="bg-zinc-950 sticky top-0 border-b border-zinc-800 z-10">
              <tr>
                {results.columns.map((col) => (
                  <th key={col} className="p-3 font-semibold uppercase tracking-wider text-zinc-400 border-r border-zinc-900">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {results.rows.length === 0 ? (
                <tr>
                  <td colSpan={results.columns.length} className="p-6 text-center text-zinc-600 italic">
                    No rows returned.
                  </td>
                </tr>
              ) : (
                results.rows.map((row, idx) => (
                  <tr key={idx} className="hover:bg-zinc-900/30 transition-colors">
                    {results.columns.map((col) => (
                      <td key={col} className="p-3 border-r border-zinc-900/60 text-zinc-300">
                        {formatCell(row[col])}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-zinc-600 gap-2">
            <RefreshCw className="w-6 h-6 animate-spin text-zinc-700" />
            <span className="text-xs italic text-zinc-500">Executing transaction rollback checks...</span>
          </div>
        )}
      </div>
    </div>
  );
}
