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
import { render, waitFor, act, fireEvent, screen } from '@testing-library/react';
import type { Node, NodeChange } from '@xyflow/react';
import type { ReactNode } from 'react';
import type { TableNodeData } from '../lib/build-graph';

const { capturedRef } = vi.hoisted(() => ({
  capturedRef: {
    onNodesChange: undefined as ((changes: NodeChange[]) => void) | undefined,
    nodes: undefined as Node[] | undefined,
  },
}));

vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  return {
    ...actual,
    ReactFlow: (props: {
      onNodesChange?: (changes: NodeChange[]) => void;
      nodes?: Node[];
      children?: ReactNode;
    }) => {
      capturedRef.onNodesChange = props.onNodesChange;
      capturedRef.nodes = props.nodes;
      // Renders `children` (unlike PR2's original bare-div stub) so
      // `<Panel>`'s toolbar buttons — including "Agregar tabla" — mount and
      // are clickable from this test.
      return <div data-testid="react-flow-stub">{props.children}</div>;
    },
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    Panel: (props: { children?: ReactNode }) => <div>{props.children}</div>,
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

// `applyErdEdit` (`../lib/patch`) internally calls `parseWithSpans`, which
// pulls in the real WASM compiler — unavailable in this jsdom/Vitest
// environment (see `patch.test.ts`'s own header comment). Stubbed here so
// this file only exercises `ERDCanvas`'s OWN wiring: does it call
// `applyErdEdit` with the right arguments, and does it forward an `ok`
// result's `text` to `onDslChange`.
vi.mock('../lib/patch', () => ({
  applyErdEdit: vi.fn(),
}));

import { fetchLayout, saveLayout } from '../../../lib/api';
import { applyErdEdit } from '../lib/patch';
import { useAuthStore } from '../../../store/useAuthStore';
import { ReactFlowProvider } from '@xyflow/react';
import ERDCanvas from '../ERDCanvas';
import type { CanvasNode } from '../../../types/erd.types';

const PARSED_NODES: CanvasNode[] = [{ id: 'User', name: 'User', x: 0, y: 0, color: '#000', fields: [] }];

async function renderCanvas(
  options: {
    dslCode?: string;
    onDslChange?: (next: string) => void;
    parsedNodes?: CanvasNode[];
  } = {},
) {
  vi.mocked(fetchLayout).mockResolvedValue({ positions: {}, version: 'v1' });
  render(
    <ReactFlowProvider>
      <ERDCanvas
        parsedNodes={options.parsedNodes ?? PARSED_NODES}
        links={[]}
        tableGroups={[]}
        hiddenTables={new Set()}
        isSidebarOpen={false}
        onToggleSidebar={() => {}}
        dslCode={options.dslCode ?? 'Table User {\n  id Int @id\n}\n'}
        onDslChange={options.onDslChange ?? (() => {})}
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

describe('ERDCanvas — add-table affordance wiring', () => {
  beforeEach(() => {
    vi.mocked(fetchLayout).mockReset();
    vi.mocked(applyErdEdit).mockReset();
    capturedRef.onNodesChange = undefined;
  });

  it('clicking "Agregar tabla" calls applyErdEdit with the current buffer and a name that does not collide with an existing table', async () => {
    const currentText = 'Table User {\n  id Int @id\n}\n';
    vi.mocked(applyErdEdit).mockReturnValue({ ok: true, text: 'PATCHED_TEXT' });
    const onDslChange = vi.fn();

    await renderCanvas({ dslCode: currentText, onDslChange });

    fireEvent.click(screen.getByTitle('Agregar tabla'));

    expect(applyErdEdit).toHaveBeenCalledTimes(1);
    expect(applyErdEdit).toHaveBeenCalledWith(currentText, { kind: 'addTable', name: 'NewTable' });
  });

  it('an ok result is forwarded to onDslChange with the patched text', async () => {
    vi.mocked(applyErdEdit).mockReturnValue({ ok: true, text: 'PATCHED_TEXT' });
    const onDslChange = vi.fn();

    await renderCanvas({ onDslChange });

    fireEvent.click(screen.getByTitle('Agregar tabla'));

    expect(onDslChange).toHaveBeenCalledTimes(1);
    expect(onDslChange).toHaveBeenCalledWith('PATCHED_TEXT');
  });

  it('a refused (not ok) result is NOT forwarded to onDslChange — the buffer stays untouched', async () => {
    vi.mocked(applyErdEdit).mockReturnValue({
      ok: false,
      reason: 'parse-failed',
      message: 'boom',
    });
    const onDslChange = vi.fn();

    await renderCanvas({ onDslChange });

    fireEvent.click(screen.getByTitle('Agregar tabla'));

    expect(onDslChange).not.toHaveBeenCalled();
  });

  it('picks NewTable1 when a table already named NewTable is in the currently-parsed nodes', async () => {
    vi.mocked(applyErdEdit).mockReturnValue({ ok: true, text: 'PATCHED_TEXT' });
    const parsedNodes: CanvasNode[] = [
      ...PARSED_NODES,
      { id: 'NewTable', name: 'NewTable', x: 0, y: 0, color: '#000', fields: [] },
    ];

    await renderCanvas({ parsedNodes });

    fireEvent.click(screen.getByTitle('Agregar tabla'));

    expect(applyErdEdit).toHaveBeenCalledWith(expect.any(String), {
      kind: 'addTable',
      name: 'NewTable1',
    });
  });
});

/**
 * `<ReactFlow>` is stubbed to a bare `children`-passthrough (see the header
 * comment), so `nodeTypes`/`TableNode` never actually mounts here —
 * `capturedRef.nodes` captures the exact `nodes` prop `ERDCanvas` computed
 * and would have handed to `TableNode` via `data`, so these tests exercise
 * `ERDCanvas`'s OWN `toTableNode`/`buildEditAffordances` wiring: does the
 * per-node `data.onRename`/`data.onDelete` closure call `applyErdEdit` with
 * the right edit, and does `data.editDisabled` reflect `schemaWritable`/
 * `readOnly` — without a separate `TableNode`-mounting harness.
 */
describe('ERDCanvas — rename/delete affordance wiring', () => {
  function findTableNodeData(id: string): TableNodeData {
    const node = capturedRef.nodes?.find(n => n.id === id);
    if (!node) throw new Error(`table node "${id}" not found in captured nodes`);
    return node.data as TableNodeData;
  }

  beforeEach(() => {
    vi.mocked(fetchLayout).mockReset();
    vi.mocked(applyErdEdit).mockReset();
    capturedRef.onNodesChange = undefined;
    capturedRef.nodes = undefined;
    useAuthStore.setState({ schemaWritable: true, readOnly: false });
  });

  it('renaming a table calls applyErdEdit with renameTable and forwards an ok result', async () => {
    vi.mocked(applyErdEdit).mockReturnValue({ ok: true, text: 'PATCHED_TEXT' });
    const onDslChange = vi.fn();
    const currentText = 'Table User {\n  id Int @id\n}\n';

    await renderCanvas({ dslCode: currentText, onDslChange });

    act(() => {
      findTableNodeData('User').onRename?.('Account');
    });

    expect(applyErdEdit).toHaveBeenCalledWith(currentText, {
      kind: 'renameTable',
      from: 'User',
      to: 'Account',
    });
    expect(onDslChange).toHaveBeenCalledWith('PATCHED_TEXT');
  });

  it('deleting a referenced table surfaces the refusal message and does NOT call onDslChange', async () => {
    vi.mocked(applyErdEdit).mockReturnValue({
      ok: false,
      reason: 'referenced',
      message: 'Cannot delete "User": referenced by Post.authorId.',
    });
    const onDslChange = vi.fn();

    await renderCanvas({ onDslChange });

    act(() => {
      findTableNodeData('User').onDelete?.('User');
    });

    expect(applyErdEdit).toHaveBeenCalledWith(expect.any(String), {
      kind: 'deleteTable',
      name: 'User',
    });
    expect(onDslChange).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Cannot delete "User": referenced by Post.authorId.',
      ),
    );
  });

  it('deleting an unreferenced table forwards the ok result to onDslChange', async () => {
    vi.mocked(applyErdEdit).mockReturnValue({ ok: true, text: 'PATCHED_TEXT' });
    const onDslChange = vi.fn();

    await renderCanvas({ onDslChange });

    act(() => {
      findTableNodeData('User').onDelete?.('User');
    });

    expect(onDslChange).toHaveBeenCalledWith('PATCHED_TEXT');
  });

  it('the edit affordances render disabled, with a stated reason, when schemaWritable is false — no applyErdEdit call is possible', async () => {
    useAuthStore.setState({ schemaWritable: false, readOnly: false });
    const onDslChange = vi.fn();

    await renderCanvas({ onDslChange });

    const data = findTableNodeData('User');
    expect(data.editDisabled).toBe(true);
    expect(data.editDisabledReason).toMatch(/not writable/i);
  });

  it('the edit affordances render disabled, with a stated reason, when the server is read-only (mutation: enable regardless of schemaWritable/readOnly)', async () => {
    useAuthStore.setState({ schemaWritable: true, readOnly: true });
    const onDslChange = vi.fn();

    await renderCanvas({ onDslChange });

    const data = findTableNodeData('User');
    expect(data.editDisabled).toBe(true);
    expect(data.editDisabledReason).toMatch(/read-only/i);
  });

  it('the edit affordances render enabled when schemaWritable is true and the server is not read-only', async () => {
    const onDslChange = vi.fn();

    await renderCanvas({ onDslChange });

    const data = findTableNodeData('User');
    expect(data.editDisabled).toBe(false);
  });
});
