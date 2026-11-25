/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import DocBrowserPage from '../DocBrowserPage';
import { useDataStore } from '../../../store/useDataStore';
import type { Table } from '../../../types';

/**
 * Table `A`: three columns, `records.length === 3` — a restored live-row
 * metric would render a non-zero count here, not only the empty-array
 * branch, per design's Testing Strategy.
 */
const TABLE_A: Table = {
  name: 'accounts',
  schema: 'public',
  columns: [
    { name: 'id', type: 'UUID', isPK: true, isNN: true, isUQ: true, description: 'Unique identifier.' },
    { name: 'email', type: 'VARCHAR(255)', isPK: false, isNN: true, isUQ: true, description: 'Login email.' },
  ],
  records: [{ id: '1' }, { id: '2' }, { id: '3' }],
};

/** Table `B`: no rows — exercises the empty branch. */
const TABLE_B: Table = {
  name: 'sessions',
  schema: 'public',
  columns: [
    { name: 'id', type: 'UUID', isPK: true, isNN: true, isUQ: true, description: 'Unique identifier.' },
  ],
  records: [],
};

/**
 * Tables `C`/`D`: SAME name (`events`), different `schema` (`public` vs
 * `billing`). Regression for R3-ddlpanel-key-collision: a `DdlPanel` keyed
 * on `name` alone would not remount between these two, letting a leftover
 * "Copied" confirmation survive a switch to a same-named table in a
 * different schema.
 */
const TABLE_C: Table = {
  name: 'events',
  schema: 'public',
  columns: [
    { name: 'id', type: 'UUID', isPK: true, isNN: true, isUQ: true, description: 'Unique identifier.' },
  ],
  records: [],
};

const TABLE_D: Table = {
  name: 'events',
  schema: 'billing',
  columns: [
    { name: 'id', type: 'UUID', isPK: true, isNN: true, isUQ: true, description: 'Unique identifier.' },
    { name: 'amount', type: 'NUMERIC', isPK: false, isNN: true, isUQ: false, description: 'Billed amount.' },
  ],
  records: [],
};

function seedTables(tables: Table[]) {
  useDataStore.setState({
    tables: tables.map((t) => ({ ...t, records: t.records.map((r) => ({ ...r })) })),
    resolvedSchema: null,
  });
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(writeText) },
    configurable: true,
  });
}

describe('DocBrowserPage', () => {
  beforeEach(() => {
    seedTables([TABLE_A, TABLE_B]);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Copy Schema', () => {
    it('writes the exact DDL, shows inline "Copied", never alerts, and clears', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      stubClipboard(writeText);
      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

      const { container } = render(<DocBrowserPage />);

      const ddlBlock = container.querySelector('.whitespace-pre');
      expect(ddlBlock).not.toBeNull();
      const expectedDdl = ddlBlock!.textContent;

      await act(async () => {
        screen.getByRole('button', { name: 'Copy Schema' }).click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(writeText).toHaveBeenCalledWith(expectedDdl);
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
      expect(alertSpy).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });

      expect(screen.getByRole('button', { name: 'Copy Schema' })).toBeInTheDocument();

      alertSpy.mockRestore();
    });

    it('rejected clipboard write shows no dialog and no false confirmation', async () => {
      stubClipboard(() => Promise.reject(new Error('denied')));
      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

      render(<DocBrowserPage />);

      await act(async () => {
        screen.getByRole('button', { name: 'Copy Schema' }).click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(alertSpy).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();

      alertSpy.mockRestore();
    });

    it('Copied on A, then switching to B shows "Copy Schema" again', async () => {
      stubClipboard(() => Promise.resolve());

      render(<DocBrowserPage />);

      await act(async () => {
        screen.getByRole('button', { name: 'Copy Schema' }).click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();

      const sidebarTarget = screen.getByText('sessions').closest('button');
      expect(sidebarTarget).not.toBeNull();

      await act(async () => {
        sidebarTarget!.click();
      });

      expect(screen.getByRole('button', { name: 'Copy Schema' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
    });

    it('Copied on a table, then switching to a same-named table in a different schema shows "Copy Schema" again', async () => {
      seedTables([TABLE_C, TABLE_D]);
      stubClipboard(() => Promise.resolve());

      render(<DocBrowserPage />);

      await act(async () => {
        screen.getByRole('button', { name: 'Copy Schema' }).click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();

      const sidebarTargets = screen.getAllByText('events').map((el) => el.closest('button'));
      const otherSchemaTarget = sidebarTargets[1];
      expect(otherSchemaTarget).not.toBeNull();

      await act(async () => {
        otherSchemaTarget!.click();
      });

      expect(screen.getByRole('button', { name: 'Copy Schema' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
    });
  });

  describe('static honesty (studio-ui-honesty)', () => {
    it('banner drops the fabricated "cluster branches" sentence and keeps the factual one', () => {
      render(<DocBrowserPage />);

      expect(screen.queryByText(/cluster branch/i)).toBeNull();
      expect(screen.getByText(/Provides unified metadata/)).toBeInTheDocument();
    });

    it('offers no share or reference-link action', () => {
      render(<DocBrowserPage />);

      expect(screen.queryByRole('button', { name: /share/i })).toBeNull();
    });

    it.each([
      ['a table with loaded rows', [TABLE_A, TABLE_B]],
      ['a table with no rows', [TABLE_B, TABLE_A]],
    ] as const)('shows no fabricated live-row metric on %s', (_label, tables) => {
      seedTables([...tables]);
      render(<DocBrowserPage />);

      expect(screen.queryByText(/live rows/i)).toBeNull();
      expect(screen.queryByText(/record count/i)).toBeNull();
      expect(screen.queryByText(/metadata summary/i)).toBeNull();
    });
  });
});
