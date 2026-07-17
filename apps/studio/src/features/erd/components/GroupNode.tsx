/**
 * React Flow custom node: a table-group background box (dbdiagram-style).
 *
 * Non-interactive; rendered behind the tables and sized to their bounding box.
 */

import React from 'react';
import { type NodeProps } from '@xyflow/react';
import type { GroupRFNode } from '../lib/build-graph';

export default function GroupNode({ data }: NodeProps<GroupRFNode>) {
  const accent = data.color ?? '#818cf8';
  return (
    <div
      className="rounded-2xl border border-dashed"
      style={{
        width: data.width,
        height: data.height,
        borderColor: `${accent}66`,
        background: `${accent}0d`,
        pointerEvents: 'none',
      }}
    >
      <span
        className="absolute left-3 top-2 text-[11px] font-bold uppercase tracking-widest font-mono"
        style={{ color: accent }}
      >
        {data.label}
      </span>
    </div>
  );
}
