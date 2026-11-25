/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import React from 'react';
import { Terminal, Database } from 'lucide-react';
import type { Table } from '../../../types';

interface TableHeroBannerProps {
  table: Table;
  onQuery: () => void;
}

export function TableHeroBanner({ table, onQuery }: TableHeroBannerProps) {
  return (
    <div className="relative h-48 w-full border-b border-zinc-800 bg-zinc-950/20 flex flex-col justify-end p-8 overflow-hidden shrink-0">
      <div className="absolute top-0 right-0 p-8 opacity-5">
        <Database className="w-32 h-32 text-zinc-500" />
      </div>

      <div className="relative z-10">
        <div className="flex items-center gap-2 mb-2">
          <span className="bg-zinc-900 border border-zinc-800 text-zinc-300 px-2 py-0.5 rounded-lg text-[10px] font-bold tracking-wider font-mono">
            TABLE
          </span>
          <span className="text-zinc-500 text-xs font-mono">{table.schema}.{table.name}</span>
        </div>
        <h1 className="text-2xl font-extrabold text-white tracking-tight font-sans">
          {table.name}
        </h1>
        <p className="text-zinc-400 mt-2 text-xs font-sans max-w-3xl leading-relaxed">
          Provides unified metadata specifications for the <span className="font-mono font-semibold text-zinc-200">{table.name}</span> entity.
        </p>
      </div>

      <div className="absolute bottom-6 right-8 flex gap-2">
        <button
          onClick={onQuery}
          className="bg-white text-black px-4 py-1.5 rounded-xl text-xs font-extrabold uppercase tracking-wider flex items-center gap-1.5 hover:bg-zinc-200 transition-all cursor-pointer shadow-lg"
        >
          <Terminal className="w-3.5 h-3.5" />
          <span>Query Table</span>
        </button>
      </div>
    </div>
  );
}
