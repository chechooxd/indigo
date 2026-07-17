/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import type { SelectionBox } from '../../../types/erd.types';

interface ERDSelectionBoxProps {
  selectionBox: SelectionBox;
}

export default function ERDSelectionBox({ selectionBox }: ERDSelectionBoxProps) {
  return (
    <div
      className="absolute border border-indigo-500 bg-indigo-500/20 pointer-events-none"
      style={{
        left: Math.min(selectionBox.startX, selectionBox.endX),
        top: Math.min(selectionBox.startY, selectionBox.endY),
        width: Math.abs(selectionBox.endX - selectionBox.startX),
        height: Math.abs(selectionBox.endY - selectionBox.startY),
        zIndex: 50,
      }}
    />
  );
}
