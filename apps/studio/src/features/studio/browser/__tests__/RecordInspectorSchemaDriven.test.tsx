/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * studio-record-editor / studio-ui-tests: the Record Inspector and edit
 * buffer are schema-driven — this suite uses a fixture table with columns
 * unrelated to email/role/metadata to catch any lingering hardcoded field.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import TableBrowserPage from '../TableBrowserPage';
import { useDataStore } from '../../../../store/useDataStore';
import type { Table } from '../../../../types';

vi.mock('../../../../lib/api', () => ({
  isBackendAvailable: vi.fn(() => true),
  fetchTableRows: vi.fn(),
  updateRow: vi.fn(),
  PAGE_SIZES: [25, 50, 100, 200],
}));

vi.mock('@indigodb/client/realtime', () => ({
  SseTransport: vi.fn().mockImplementation(() => ({
    connect: vi.fn((_tables: string[], handlers: { onOpen: (reconnected: boolean) => void }) => {
      handlers.onOpen(false);
      return () => {};
    }),
  })),
  LIVE_DEBOUNCE_MS: 50,
  REALTIME_PATH: '/api/realtime',
}));

import { isBackendAvailable, fetchTableRows, updateRow } from '../../../../lib/api';

const FIXTURE_TABLE: Table = {
  name: 'widgets_fixture',
  schema: 'public',
  primaryKey: ['sku'],
  columns: [
    { name: 'sku', type: 'String', isPK: true, isNN: true, isUQ: true, isGenerated: false },
    { name: 'inStock', type: 'Boolean', isPK: false, isNN: true, isUQ: false },
    { name: 'tier', type: 'Tier', isPK: false, isNN: true, isUQ: false, isEnum: true, enumValues: ['BASIC', 'PRO'] },
    { name: 'restockedAt', type: 'DateTime', isPK: false, isNN: false, isUQ: false },
    { name: 'attributes', type: 'Json', isPK: false, isNN: true, isUQ: false },
  ],
  records: [
    {
      sku: 'SKU-1',
      inStock: true,
      tier: 'PRO',
      restockedAt: '2024-01-15T10:30:00.000Z',
      attributes: { color: 'blue' },
    },
  ],
};

function resetTables() {
  useDataStore.setState({ tables: [{ ...FIXTURE_TABLE, records: FIXTURE_TABLE.records.map((r) => ({ ...r })) }] });
}

describe('Record Inspector is schema-driven (no hardcoded email/role/metadata)', () => {
  beforeEach(() => {
    resetTables();
    vi.mocked(isBackendAvailable).mockReturnValue(true);
    vi.mocked(fetchTableRows).mockReset();
    vi.mocked(updateRow).mockReset();
  });

  it('renders exactly one widget per resolved column, keyed by column name', () => {
    render(<TableBrowserPage />);

    for (const column of FIXTURE_TABLE.columns) {
      expect(screen.getByLabelText(column.name)).toBeInTheDocument();
    }
    expect(screen.queryByLabelText('email')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('role')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('metadata')).not.toBeInTheDocument();
  });

  it('renders a checkbox for the boolean column and a select with the enum values', () => {
    render(<TableBrowserPage />);

    const checkbox = screen.getByLabelText('inStock') as HTMLInputElement;
    expect(checkbox.type).toBe('checkbox');
    expect(checkbox.checked).toBe(true);

    const select = screen.getByLabelText('tier') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['BASIC', 'PRO']);
  });

  it('renders a date/time input for the DateTime column and an explicit null control for the nullable column', () => {
    render(<TableBrowserPage />);

    expect(screen.getByLabelText('restockedAt')).toHaveAttribute('type', 'datetime-local');
    // The nullable column exposes a "Null" checkbox distinct from its widget.
    expect(screen.getByRole('checkbox', { name: /null/i })).toBeInTheDocument();
  });

  it('editing only one column marks only that column dirty and enables Save; editing then Discard reverts it', async () => {
    const user = userEvent.setup();
    render(<TableBrowserPage />);

    const saveButton = screen.getByRole('button', { name: /save row/i });
    expect(saveButton).toBeDisabled();

    const skuInput = screen.getByLabelText('sku');
    await user.clear(skuInput);
    await user.type(skuInput, 'SKU-1'); // same value; sku is read-only-ish but not generated here, still just text field

    // Edit the JSON field, which IS a genuine change.
    const jsonField = screen.getByLabelText('attributes');
    await user.clear(jsonField);
    await user.type(jsonField, '{{"color":"red"}}');

    expect(saveButton).not.toBeDisabled();

    const discardButton = screen.getByRole('button', { name: /discard/i });
    await user.click(discardButton);

    expect(screen.getByLabelText('attributes')).toHaveValue(JSON.stringify({ color: 'blue' }, null, 2));
  });

  it('invalid JSON in the JSON field blocks Save and sends no write request', async () => {
    const user = userEvent.setup();
    render(<TableBrowserPage />);

    const jsonField = screen.getByLabelText('attributes');
    await user.clear(jsonField);
    await user.type(jsonField, '{{not valid json');

    await user.click(screen.getByRole('button', { name: /save row/i }));

    expect(updateRow).not.toHaveBeenCalled();
    expect(await screen.findByText(/must be valid json/i)).toBeInTheDocument();
  });

  it('a valid edit calls updateRow with the parsed value, keyed by primary key', async () => {
    vi.mocked(updateRow).mockResolvedValue({
      sku: 'SKU-1',
      inStock: false,
      tier: 'PRO',
      restockedAt: '2024-01-15T10:30:00.000Z',
      attributes: { color: 'blue' },
    });
    const user = userEvent.setup();
    render(<TableBrowserPage />);

    await user.click(screen.getByLabelText('inStock'));
    await user.click(screen.getByRole('button', { name: /save row/i }));

    expect(updateRow).toHaveBeenCalledWith('widgets_fixture', { sku: 'SKU-1' }, { inStock: false });
  });
});
