/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import type { CanvasNode, ERDTableGroup } from '../../../types/erd.types';

interface ERDGroupBoundsProps {
  group: ERDTableGroup;
  visibleNodes: CanvasNode[];
}

export default function ERDGroupBounds({ group, visibleNodes }: ERDGroupBoundsProps) {
  const groupNodes = visibleNodes.filter(n => group.tables.includes(n.id));
  if (groupNodes.length === 0) return null;

  const padding = 24;
  const minX = Math.min(...groupNodes.map(n => n.x)) - padding;
  const minY = Math.min(...groupNodes.map(n => n.y)) - padding;
  const maxX = Math.max(...groupNodes.map(n => n.x + 256)) + padding;
  // Assuming node height roughly 40px header + 28px per field
  const maxY = Math.max(...groupNodes.map(n => n.y + 40 + (n.fields?.length ?? 0) * 28)) + padding;

  return (
    <div
      className="absolute border-2 border-indigo-500/20 bg-indigo-500/5 rounded-xl pointer-events-none"
      style={{ left: minX, top: minY, width: maxX - minX, height: maxY - minY, zIndex: 0 }}
    >
      <div className="absolute -top-8 left-4 text-indigo-400 font-bold font-mono px-3 py-1 bg-zinc-900 border border-zinc-800 rounded-t-lg shadow-lg">
        {group.name}
      </div>
    </div>
  );
}
