/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { TableProperties } from 'lucide-react';
import type { CanvasNode } from '../../../types/erd.types';

interface ERDTableNodeProps {
  node: CanvasNode;
  isSelected: boolean;
  activeFields: Set<string>;
  onMouseDown: (id: string, e: React.MouseEvent) => void;
}

export default function ERDTableNode({ node, isSelected, activeFields, onMouseDown }: ERDTableNodeProps) {
  return (
    <div
      className={`absolute bg-zinc-900 rounded-lg shadow-xl border flex flex-col font-mono text-sm overflow-hidden ${
        isSelected ? 'border-indigo-500 ring-2 ring-indigo-500/50' : 'border-zinc-700/50'
      }`}
      style={{ left: node.x, top: node.y, width: '256px', boxShadow: '0 10px 40px -10px rgba(0,0,0,0.5)' }}
      onMouseDown={(e) => onMouseDown(node.id, e)}
    >
      {/* Table Header */}
      <div
        className="px-4 py-2 flex items-center justify-between cursor-move"
        style={{ backgroundColor: node.color }}
      >
        <div className="flex items-center gap-2">
          <TableProperties size={16} className="text-zinc-900" />
          <span className="font-bold text-zinc-900">{node.name}</span>
        </div>
      </div>

      {/* Node Column specs */}
      <div className="py-1.5 divide-y divide-zinc-900/40 font-mono text-[11px]">
        {node.fields?.map((field, idx) => {
          const isActive = activeFields.has(`${node.id}.${field.name}`);
          return (
            <div
              key={idx}
              className={`flex justify-between px-4 py-1.5 transition-colors ${
                isActive ? 'bg-indigo-500/20 text-indigo-100' : 'text-zinc-300 hover:bg-zinc-800/50'
              }`}
            >
              <span className={`flex items-center gap-1 ${field.isPk ? 'font-semibold text-white' : ''}`}>
                {field.isPk && '🔑 '}
                {field.isUnique && '⚡ '}
                {field.relation && '🔗 '}
                {!field.isPk && !field.isUnique && !field.relation && <span className="pl-3.5" />}
                {field.name}
              </span>
              <span className="text-zinc-500">{field.type}{field.isNullable ? '?' : ''}</span>
            </div>
          );
        })}
        {(!node.fields || node.fields.length === 0) && (
          <div className="p-3 text-center text-zinc-500 text-[10px] italic">No fields defined</div>
        )}
      </div>
    </div>
  );
}
