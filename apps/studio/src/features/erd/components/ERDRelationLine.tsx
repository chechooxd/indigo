/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import type { ConnectionPath } from '../../../types/erd.types';

interface ERDRelationLineProps {
  path: ConnectionPath;
  isActive: boolean;
}

export default function ERDRelationLine({ path, isActive }: ERDRelationLineProps) {
  const sourceLabelX = path.startX + (path.sourceAttachSide === 'right' ? 12 : -12);
  const targetLabelX = path.endX + (path.targetAttachSide === 'right' ? 12 : -12);
  const sourceChar = path.relationType === '1-n' ? '1' : path.relationType === '1-1' ? '1' : '*';
  const targetChar = path.relationType === '1-n' ? '*' : path.relationType === '1-1' ? '1' : '1';
  const midX = (path.startX + path.endX) / 2;
  const midY = (path.startY + path.endY) / 2;
  const color = isActive ? '#818cf8' : '#52525b';
  const labelColor = isActive ? '#818cf8' : '#71717a';

  return (
    <React.Fragment>
      <path
        d={path.d}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        className={isActive ? 'animate-flow' : ''}
      />
      {path.resolvedTargetField && (
        <text x={midX} y={midY - 8} fill={labelColor} fontSize="11" textAnchor="middle" className="font-mono bg-[#09090b]">
          {path.resolvedTargetField}
        </text>
      )}
      <circle cx={path.startX} cy={path.startY} r={3} fill={labelColor} />
      <text x={sourceLabelX} y={path.startY - 8} fill={labelColor} fontSize="12" fontWeight="bold" textAnchor="middle" className="font-mono">
        {sourceChar}
      </text>
      <circle cx={path.endX} cy={path.endY} r={3} fill={labelColor} />
      <text x={targetLabelX} y={path.endY - 8} fill={labelColor} fontSize="12" fontWeight="bold" textAnchor="middle" className="font-mono">
        {targetChar}
      </text>
    </React.Fragment>
  );
}
