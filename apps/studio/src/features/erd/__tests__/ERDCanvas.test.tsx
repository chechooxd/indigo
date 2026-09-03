/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers `ERDCanvas.tsx`'s drag-end → `updatePosition` → `layout-store`'s
 * debounced `schedule` wiring — the one piece `layout-store.test.ts`'s unit
 * tests structurally cannot reach, since they exercise `createLayoutAutosave`
 * directly without ever going through a real `onNodesChange` callback.
 *
 * `@xyflow/react`'s `ReactFlow` component is stubbed (real pointer-drag
 * simulation in jsdom is impractical — no layout/transform math), but every
 * other piece of `@xyflow/react` this file needs (`ReactFlowProvider`,
 * `useNodesState`, `applyNodeChanges`, `useReactFlow`) is the real
 * implementation. The stub captures the exact `onNodesChange` callback
 * `ERDCanvas` passes to `<ReactFlow>`, and the test invokes it directly with
 * the same `NodePositionChange` shape a real drag-end produces
 * (`type: 'position', dragging: false, position`) — exercising `ERDCanvas`'s
 * own `onNodesChange` handler, not a re-implementation of it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import type { NodeChange } from '@xyflow/react';

const { capturedRef } = vi.hoisted(() => ({
  capturedRef: { onNodesChange: undefined as ((changes: NodeChange[]) => void) | undefined },
}));

vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  return {
    ...actual,
    ReactFlow: (props: { onNodesChange?: (changes: NodeChange[]) => void }) => {
      capturedRef.onNodesChange = props.onNodesChange;
      return <div data-testid="react-flow-stub" />;
    },
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    Panel: () => null,
  };
});

vi.mock('../../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/api')>('../../../lib/api');
  return {
    ...actual,
    fetchLayout: vi.fn(),
    saveLayout: vi.fn(),
  };
});

import { fetchLayout, saveLayout } from '../../../lib/api';
import { ReactFlowProvider } from '@xyflow/react';
import ERDCanvas from '../ERDCanvas';
import type { CanvasNode } from '../../../types/erd.types';

const PARSED_NODES: CanvasNode[] = [{ id: 'User', name: 'User', x: 0, y: 0, color: '#000', fields: [] }];

async function renderCanvas() {
  vi.mocked(fetchLayout).mockResolvedValue({ positions: {}, version: 'v1' });
  render(
    <ReactFlowProvider>
      <ERDCanvas
        parsedNodes={PARSED_NODES}
        links={[]}
        tableGroups={[]}
        hiddenTables={new Set()}
        isSidebarOpen={false}
        onToggleSidebar={() => {}}
      />
    </ReactFlowProvider>,
  );
  await waitFor(() => expect(capturedRef.onNodesChange).toBeDefined());
  // Let the layout-store's fetchLayout() promise resolve so `updatePosition`
  // (invoked below) schedules against a fully-mounted autosave controller.
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ERDCanvas — drag-end autosave wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(fetchLayout).mockReset();
    vi.mocked(saveLayout).mockReset();
    vi.mocked(saveLayout).mockResolvedValue({ ok: true, version: 'v2' });
    capturedRef.onNodesChange = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a drag-end position change reaches the debounced layout autosave (calls saveLayout after 500ms)', async () => {
    await renderCanvas();

    act(() => {
      capturedRef.onNodesChange!([
        { id: 'User', type: 'position', dragging: false, position: { x: 111, y: 222 } },
      ]);
    });

    expect(saveLayout).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(saveLayout).toHaveBeenCalledTimes(1);
    expect(saveLayout).toHaveBeenCalledWith({ User: { x: 111, y: 222 } }, 'v1');
  });

  it('an in-flight drag change (dragging: true) does NOT schedule an autosave', async () => {
    await renderCanvas();

    act(() => {
      capturedRef.onNodesChange!([
        { id: 'User', type: 'position', dragging: true, position: { x: 50, y: 60 } },
      ]);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(saveLayout).not.toHaveBeenCalled();
  });
});
