/**
 * React Flow custom node: a database table card (dbdiagram-style).
 *
 * Each field row carries four invisible handles (source/target × left/right) so
 * relations can attach at the exact field, on whichever side faces the related
 * table. The handles are non-interactive (edges are built programmatically from
 * the schema, not drawn by the user).
 */

import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { TableProperties } from 'lucide-react';
import { NODE_WIDTH, type TableRFNode } from '../lib/build-graph';

const rowHandleStyle: React.CSSProperties = {
  width: 1,
  height: 1,
  minWidth: 1,
  minHeight: 1,
  background: 'transparent',
  border: 'none',
  opacity: 0,
};

export default function TableNode({ data, selected }: NodeProps<TableRFNode>) {
  const fields = data.fields ?? [];

  return (
    <div
      className={`bg-zinc-900 rounded-lg shadow-xl border flex flex-col font-mono text-sm overflow-hidden ${
        selected ? 'border-indigo-500 ring-2 ring-indigo-500/50' : 'border-zinc-700/50'
      }`}
      style={{ width: NODE_WIDTH, boxShadow: '0 10px 40px -10px rgba(0,0,0,0.5)' }}
    >
      {/* Header */}
      <div
        className="px-4 py-2 flex items-center justify-between"
        style={{ backgroundColor: data.color }}
      >
        <div className="flex items-center gap-2">
          <TableProperties size={16} className="text-zinc-900" />
          <span className="font-bold text-zinc-900">{data.name}</span>
        </div>
      </div>

      {/* Fields */}
      <div className="py-1.5 divide-y divide-zinc-900/40 font-mono text-[11px]">
        {fields.map((field, idx) => (
          <div
            key={idx}
            className="relative flex justify-between px-4 py-1.5 text-zinc-300 hover:bg-zinc-800/50 transition-colors"
          >
            {/* Field-level connection points (invisible) */}
            <Handle id={`s-l-${idx}`} type="source" position={Position.Left} isConnectable={false} style={rowHandleStyle} />
            <Handle id={`t-l-${idx}`} type="target" position={Position.Left} isConnectable={false} style={rowHandleStyle} />
            <Handle id={`s-r-${idx}`} type="source" position={Position.Right} isConnectable={false} style={rowHandleStyle} />
            <Handle id={`t-r-${idx}`} type="target" position={Position.Right} isConnectable={false} style={rowHandleStyle} />

            <span className={`flex items-center gap-1 ${field.isPk ? 'font-semibold text-white' : ''}`}>
              {field.isPk && '🔑 '}
              {field.isUnique && '⚡ '}
              {field.relation && '🔗 '}
              {!field.isPk && !field.isUnique && !field.relation && <span className="pl-3.5" />}
              {field.name}
            </span>
            <span className="text-zinc-500">
              {field.type}
              {field.isNullable ? '?' : ''}
            </span>
          </div>
        ))}
        {fields.length === 0 && (
          <div className="p-3 text-center text-zinc-500 text-[10px] italic">No fields defined</div>
        )}
      </div>
    </div>
  );
}
