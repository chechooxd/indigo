/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';

export interface DisplayRelation {
  label: string;
  name: string;
  detail: string;
}

interface RelationsPanelProps {
  relations: DisplayRelation[];
  recordCount: number;
}

export function RelationsPanel({ relations, recordCount }: RelationsPanelProps) {
  return (
    <section className="flex flex-col justify-between">
      <div>
        <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-widest font-sans mb-3">
          Relational Dependencies
        </h3>
        <div className="space-y-3">
          {relations.length > 0 ? (
            relations.map((rel, i) => (
              <div key={i} className="p-3.5 bg-zinc-950 border border-zinc-800 rounded-2xl flex items-center justify-between hover:border-zinc-700 transition-colors cursor-pointer">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] bg-zinc-900 border border-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded font-bold font-mono">{rel.label}</span>
                  <div>
                    <div className="text-[11px] font-bold text-white font-mono">{rel.name}</div>
                    <div className="text-[9px] text-zinc-500">{rel.detail}</div>
                  </div>
                </div>
                <ArrowRight className="w-3.5 h-3.5 text-zinc-600" />
              </div>
            ))
          ) : (
            <div className="p-6 text-center border border-zinc-900 rounded-2xl text-zinc-600 text-[11px] italic">
              No relationships defined for this table.
            </div>
          )}
        </div>
      </div>

      {/* Table Metrics summary */}
      <div className="p-4 bg-zinc-950 border border-zinc-800 rounded-2xl space-y-2 mt-4 font-sans text-xs">
        <div className="text-white font-bold flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-zinc-400" />
          <span>Metadata Summary</span>
        </div>
        <div className="flex justify-between text-zinc-400">
          <span>Record Count:</span>
          <span className="font-mono text-zinc-200 font-semibold">{recordCount} live rows</span>
        </div>
      </div>
    </section>
  );
}
