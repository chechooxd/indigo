/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Copy } from 'lucide-react';

interface DdlPanelProps {
  ddlCode: string;
  onCopy: () => void;
}

export function DdlPanel({ ddlCode, onCopy }: DdlPanelProps) {
  return (
    <section className="flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-widest font-sans">
          DDL Definition
        </h3>
        <button
          onClick={onCopy}
          className="text-zinc-400 text-[10px] font-bold flex items-center gap-1.5 hover:text-white hover:underline cursor-pointer"
        >
          <Copy className="w-3 h-3" /> Copy Schema
        </button>
      </div>
      <div className="flex-1 bg-zinc-950 border border-zinc-800 rounded-2xl p-4 font-mono text-[11px] text-zinc-300 leading-relaxed whitespace-pre overflow-x-auto shadow-inner">
        {ddlCode}
      </div>
    </section>
  );
}
