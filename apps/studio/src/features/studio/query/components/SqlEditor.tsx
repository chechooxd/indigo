/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Play, Sparkles } from 'lucide-react';

interface SqlEditorProps {
  queryCode: string;
  fileLabel: string;
  onChange: (code: string) => void;
  onFormat: () => void;
  onRun: () => void;
}

export function SqlEditor({ queryCode, fileLabel, onChange, onFormat, onRun }: SqlEditorProps) {
  return (
    <div className="h-1/2 flex flex-col border-b border-zinc-800">
      <div className="flex items-center justify-between px-4 h-10 bg-zinc-950/20 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-zinc-600"></span>
          <span className="text-xs font-mono font-medium text-zinc-300">
            {fileLabel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onFormat}
            className="flex items-center gap-1.5 px-3 py-1 text-xs font-semibold text-zinc-400 hover:text-white hover:bg-zinc-900 rounded-xl transition-all cursor-pointer"
            title="Format SQL keywords"
          >
            <Sparkles className="w-3.5 h-3.5 text-zinc-400" />
            <span>Format</span>
          </button>
          <button
            onClick={onRun}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-white text-black font-extrabold rounded-xl hover:bg-zinc-200 active:scale-95 transition-all text-xs cursor-pointer shadow-lg"
          >
            <Play className="w-3 h-3 fill-current" />
            <span>RUN QUERY</span>
          </button>
        </div>
      </div>

      {/* Interactive SQL Area */}
      <div className="flex-1 p-4 font-mono text-sm leading-6 flex flex-col bg-[#09090b]">
        <textarea
          value={queryCode}
          onChange={(e) => onChange(e.target.value)}
          className="w-full flex-1 bg-transparent border-0 focus:ring-0 p-0 text-zinc-200 font-mono text-sm resize-none outline-none leading-relaxed"
          spellCheck="false"
          placeholder="SELECT * FROM users LIMIT 10;"
        />
        <div className="text-[10px] text-zinc-600 flex justify-between font-sans select-none border-t border-zinc-900 pt-2">
          <span>Press RUN QUERY button to trigger active executor.</span>
          <span>PostgreSQL 15 syntax supported</span>
        </div>
      </div>
    </div>
  );
}
