/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';

// `@indigodb/core` pulls in the real WASM compiler, unavailable in this
// jsdom/Vitest environment (see `app/__tests__/App.test.tsx`).
vi.mock('@indigodb/core', () => {
  class IndigoParseError extends Error {
    constructor(
      message: string,
      public readonly errors: Array<{
        message: string;
        line?: number;
        column?: number;
        endLine?: number;
        endColumn?: number;
      }>,
    ) {
      super(message);
      this.name = 'IndigoParseError';
    }
  }
  return {
    parse: vi.fn().mockReturnValue({}),
    resolve: vi.fn().mockReturnValue({ tables: [], refs: [], tableGroups: [], enums: [] }),
    validate: vi.fn().mockReturnValue([]),
    IndigoParseError,
  };
});

// The real Monaco editor cannot run in jsdom; stand in with a plain
// controlled textarea that exercises the same `value`/`onChange` contract.
vi.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange?: (value: string | undefined) => void;
  }) => (
    <textarea
      data-testid="dsl-editor"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

// The ERD canvas and sidebar pull in @xyflow/react's full rendering stack —
// irrelevant to the save/diagnostics wiring under test here. The stub
// exposes a single button wired to the real `onDslChange` prop, so a test
// can simulate an ERD-authored edit (e.g. `applyErdEdit`'s result already
// forwarded by `ERDCanvas`, covered on its own in `ERDCanvas.test.tsx`)
// reaching this page's shared dirty-buffer state, exactly like a manual
// Monaco edit does.
vi.mock('../ERDCanvas', () => ({
  __esModule: true,
  default: ({ onDslChange }: { onDslChange: (next: string) => void }) => (
    <div data-testid="erd-canvas">
      <button onClick={() => onDslChange('ERD_EDIT_1')}>simulate ERD edit 1</button>
      <button onClick={() => onDslChange('ERD_EDIT_2')}>simulate ERD edit 2</button>
    </div>
  ),
}));
vi.mock('../components/ERDSidebar', () => ({
  __esModule: true,
  default: () => <div data-testid="erd-sidebar" />,
}));

vi.mock('../../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/api')>('../../../lib/api');
  return {
    ...actual,
    fetchSchemaSource: vi.fn(),
    saveSchemaSource: vi.fn(),
    saveLayout: vi.fn(),
  };
});

import { fetchSchemaSource, saveSchemaSource, saveLayout } from '../../../lib/api';
import { useAuthStore } from '../../../store/useAuthStore';
import { parse, IndigoParseError } from '@indigodb/core';
import ERDDesignerPage from '../ERDDesignerPage';

const ORIGINAL_SOURCE = 'model Foo {\n  id Int @id\n}';

async function renderReady() {
  vi.mocked(fetchSchemaSource).mockResolvedValue({ source: ORIGINAL_SOURCE, version: 'v1' });
  render(<ERDDesignerPage />);
  await waitFor(() =>
    expect((screen.getByTestId('dsl-editor') as HTMLTextAreaElement).value).toBe(ORIGINAL_SOURCE),
  );
}

async function editBuffer(newText: string) {
  const editor = screen.getByTestId('dsl-editor') as HTMLTextAreaElement;
  await act(async () => {
    fireEvent.change(editor, { target: { value: newText } });
  });
}

describe('ERDDesignerPage — save flow', () => {
  beforeEach(() => {
    useAuthStore.setState({ schemaWritable: true });
    vi.mocked(fetchSchemaSource).mockReset();
    vi.mocked(saveSchemaSource).mockReset();
    vi.mocked(saveLayout).mockReset();
  });

  it('SD-5: a 409 preserves the buffer and shows the conflict banner', async () => {
    await renderReady();
    vi.mocked(saveSchemaSource).mockResolvedValue({ ok: false, status: 409, error: 'stale' });

    await editBuffer(ORIGINAL_SOURCE + '\nmodel Bar {}');

    const saveButton = screen.getByRole('button', { name: /save/i });
    await act(async () => {
      saveButton.click();
    });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/changed on disk|conflict|stale/i));

    expect((screen.getByTestId('dsl-editor') as HTMLTextAreaElement).value).toBe(
      ORIGINAL_SOURCE + '\nmodel Bar {}',
    );
  });

  it('SD-6: Reload replaces the buffer and version; Undo reload restores the original buffer', async () => {
    await renderReady();
    vi.mocked(saveSchemaSource).mockResolvedValue({ ok: false, status: 409, error: 'stale' });

    const editedBuffer = ORIGINAL_SOURCE + '\nmodel Bar {}';
    await editBuffer(editedBuffer);

    await act(async () => {
      screen.getByRole('button', { name: /save/i }).click();
    });
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    const diskText = 'model FromDisk {}';
    vi.mocked(fetchSchemaSource).mockResolvedValue({ source: diskText, version: 'v2' });

    await act(async () => {
      screen.getByRole('button', { name: /reload/i }).click();
    });

    await waitFor(() =>
      expect((screen.getByTestId('dsl-editor') as HTMLTextAreaElement).value).toBe(diskText),
    );

    await act(async () => {
      screen.getByRole('button', { name: /undo reload/i }).click();
    });

    expect((screen.getByTestId('dsl-editor') as HTMLTextAreaElement).value).toBe(editedBuffer);
  });

  it('SD-7: a 422 shows zero success toasts, one diagnostics panel entry, and dirty stays true', async () => {
    await renderReady();
    vi.mocked(saveSchemaSource).mockResolvedValue({
      ok: false,
      status: 422,
      error: 'invalid',
      parseErrors: [{ message: 'Unexpected token', line: 2, column: 1, endLine: 2, endColumn: 5 }],
    });

    await editBuffer(ORIGINAL_SOURCE + '\nbroken');

    await act(async () => {
      screen.getByRole('button', { name: /save/i }).click();
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    expect(screen.queryByText(/schema saved/i)).not.toBeInTheDocument();
    expect(screen.getByRole('alert').children).toHaveLength(1);
    expect(screen.getByRole('button', { name: /save/i })).toBeEnabled();
  });

  it('a successful save shows a toast and clears the dirty flag', async () => {
    await renderReady();
    vi.mocked(saveSchemaSource).mockResolvedValue({ ok: true, version: 'v2' });

    await editBuffer(ORIGINAL_SOURCE + '\nmodel Bar {}');

    await act(async () => {
      screen.getByRole('button', { name: /save/i }).click();
    });

    await waitFor(() => expect(screen.getByText(/schema saved/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('a schema Save does not implicitly write layout (saveLayout / PUT /api/schema/layout untouched)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await renderReady();
    vi.mocked(saveSchemaSource).mockResolvedValue({ ok: true, version: 'v2' });

    await editBuffer(ORIGINAL_SOURCE + '\nmodel Bar {}');

    await act(async () => {
      screen.getByRole('button', { name: /save/i }).click();
    });

    await waitFor(() => expect(screen.getByText(/schema saved/i)).toBeInTheDocument());

    expect(saveLayout).not.toHaveBeenCalled();
    expect(
      fetchSpy.mock.calls.some(([input, init]) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
        return url.includes('/api/schema/layout') && (init?.method ?? '').toUpperCase() === 'PUT';
      }),
    ).toBe(false);

    fetchSpy.mockRestore();
  });

  it('a parse failure is visible on screen via the diagnostics panel, not only console', async () => {
    await renderReady();

    vi.mocked(parse).mockImplementation(() => {
      throw new IndigoParseError('Parse errors found in .indigo schema', [
        { message: 'Unexpected token', line: 3, column: 1, endLine: 3, endColumn: 2 },
      ]);
    });

    await editBuffer('model Broken {');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/unexpected token/i));
  });
});

/**
 * `ERDCanvas` is stubbed (see the mock above) to a button wired to the real
 * `onDslChange` prop — simulating a patch `applyErdEdit` already produced
 * (covered on its own in `ERDCanvas.test.tsx`) reaching this page's shared
 * dirty buffer exactly like a manual Monaco edit does (Phase 4, tasks
 * 4.10–4.14).
 */
describe('ERDDesignerPage — ERD-authored edits share the dirty buffer with Save', () => {
  beforeEach(() => {
    useAuthStore.setState({ schemaWritable: true, readOnly: false });
    vi.mocked(fetchSchemaSource).mockReset();
    vi.mocked(saveSchemaSource).mockReset();
    vi.mocked(saveLayout).mockReset();
    // A prior describe block's parse-failure test leaves `parse` mocked to
    // throw — reset back to the default success return so this block's
    // diagnostics panel starts empty (no leftover `role="alert"` node).
    vi.mocked(parse).mockReset();
    vi.mocked(parse).mockReturnValue({} as never);
  });

  it('multiple ERD edits before Save accumulate into exactly one PUT /api/schema/source, and none before Save', async () => {
    await renderReady();
    vi.mocked(saveSchemaSource).mockResolvedValue({ ok: true, version: 'v2' });

    await act(async () => {
      screen.getByText('simulate ERD edit 1').click();
    });
    expect(saveSchemaSource).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByText('simulate ERD edit 2').click();
    });
    expect(saveSchemaSource).not.toHaveBeenCalled();
    expect((screen.getByTestId('dsl-editor') as HTMLTextAreaElement).value).toBe('ERD_EDIT_2');

    await act(async () => {
      screen.getByRole('button', { name: /save/i }).click();
    });

    await waitFor(() => expect(screen.getByText(/schema saved/i)).toBeInTheDocument());
    expect(saveSchemaSource).toHaveBeenCalledTimes(1);
    expect(saveSchemaSource).toHaveBeenCalledWith('ERD_EDIT_2', 'v1');
  });

  it('reload (a fresh mount) without Save discards the accumulated ERD edit — on-disk file reflects none', async () => {
    vi.mocked(fetchSchemaSource).mockResolvedValue({ source: ORIGINAL_SOURCE, version: 'v1' });
    const first = render(<ERDDesignerPage />);
    await waitFor(() =>
      expect((screen.getByTestId('dsl-editor') as HTMLTextAreaElement).value).toBe(ORIGINAL_SOURCE),
    );

    await act(async () => {
      screen.getByText('simulate ERD edit 1').click();
    });
    expect((screen.getByTestId('dsl-editor') as HTMLTextAreaElement).value).toBe('ERD_EDIT_1');

    first.unmount();
    render(<ERDDesignerPage />);

    await waitFor(() =>
      expect((screen.getByTestId('dsl-editor') as HTMLTextAreaElement).value).toBe(ORIGINAL_SOURCE),
    );
    // The only path from buffer to disk is `saveSchemaSource` — it was
    // never called, so the on-disk file was never touched by the discarded
    // edit.
    expect(saveSchemaSource).not.toHaveBeenCalled();
  });

  it('a 422 after an ERD-authored patch keeps the buffer, shows diagnostics, and shows no success toast', async () => {
    await renderReady();
    vi.mocked(saveSchemaSource).mockResolvedValue({
      ok: false,
      status: 422,
      error: 'invalid',
      parseErrors: [{ message: 'Unexpected token', line: 1, column: 1, endLine: 1, endColumn: 2 }],
    });

    await act(async () => {
      screen.getByText('simulate ERD edit 1').click();
    });

    await act(async () => {
      screen.getByRole('button', { name: /save/i }).click();
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByText(/schema saved/i)).not.toBeInTheDocument();
    expect((screen.getByTestId('dsl-editor') as HTMLTextAreaElement).value).toBe('ERD_EDIT_1');
  });

  it('a read-only session refuses Save with a banner and never calls saveSchemaSource — no PUT is sent', async () => {
    useAuthStore.setState({ schemaWritable: true, readOnly: true });
    await renderReady();

    await act(async () => {
      screen.getByText('simulate ERD edit 1').click();
    });

    await act(async () => {
      screen.getByRole('button', { name: /save/i }).click();
    });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/read-only/i));
    expect(saveSchemaSource).not.toHaveBeenCalled();
  });
});
