/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * Covers `TableNode.tsx`'s per-field `Handle`s (design D7, task 6.3/6.4):
 * edit mode (`data.handlesConnectable: true`) must reveal enlarged,
 * interactive handles; view/read-only mode must leave them non-interactive
 * at their original 1×1/`opacity: 0` hit area. Mounted through the REAL
 * `@xyflow/react` `ReactFlow` (not stubbed, unlike `ERDCanvas.test.tsx`) so
 * `Handle`'s native `isConnectable` prop and its `connectable` CSS class are
 * genuinely exercised, not re-implemented by this test.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ReactFlow, ReactFlowProvider, type NodeTypes } from '@xyflow/react';
import TableNode from '../TableNode';
import type { TableRFNode } from '../../lib/build-graph';

const nodeTypes: NodeTypes = { table: TableNode };

function buildNode(handlesConnectable: boolean | undefined): TableRFNode {
  return {
    id: 'User',
    type: 'table',
    position: { x: 0, y: 0 },
    data: {
      name: 'User',
      fields: [
        { name: 'id', type: 'Int', isPk: true, isUnique: false, isNullable: false },
      ],
      handlesConnectable,
    },
  };
}

function renderTableNode(node: TableRFNode) {
  return render(
    <ReactFlowProvider>
      <div style={{ width: 400, height: 400 }}>
        <ReactFlow nodes={[node]} edges={[]} nodeTypes={nodeTypes} />
      </div>
    </ReactFlowProvider>,
  );
}

function handleEls(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.react-flow__handle'));
}

describe('TableNode — field handles (D7)', () => {
  it('edit mode (handlesConnectable: true) renders connectable handles with an enlarged hit area', () => {
    const { container } = renderTableNode(buildNode(true));

    const handles = handleEls(container);
    expect(handles.length).toBe(4); // s-l, t-l, s-r, t-r for the single field row

    for (const handle of handles) {
      expect(handle.classList.contains('connectable')).toBe(true);
      // Enlarged from the view-mode 1px hit area.
      expect(handle.style.width).not.toBe('1px');
    }
  });

  it('RED/mutation: view mode (handlesConnectable absent) leaves handles non-interactive at the original 1×1 hit area', () => {
    const { container } = renderTableNode(buildNode(undefined));

    const handles = handleEls(container);
    expect(handles.length).toBe(4);

    for (const handle of handles) {
      expect(handle.classList.contains('connectable')).toBe(false);
      expect(handle.style.width).toBe('1px');
      expect(handle.style.opacity).toBe('0');
    }
  });

  it('read-only-equivalent mode (handlesConnectable: false) also leaves handles non-interactive', () => {
    const { container } = renderTableNode(buildNode(false));

    const handles = handleEls(container);
    for (const handle of handles) {
      expect(handle.classList.contains('connectable')).toBe(false);
    }
  });
});
