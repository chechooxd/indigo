/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import TableBrowserPage from '../TableBrowserPage';
import { useDataStore } from '../../../../store/useDataStore';
import { useSettingsStore } from '../../../../store/useSettingsStore';
import { INITIAL_TABLES } from '../../../../data/mockData';

vi.mock('../../../../lib/api', () => ({
  isBackendAvailable: vi.fn(() => false),
  fetchTableRows: vi.fn(),
  updateRow: vi.fn(),
  createRow: vi.fn(),
  deleteRow: vi.fn(),
}));

// Fake transport: `connect()` synchronously fires `onOpen(false)` so the
// live badge (when mounted) reaches its `live` status without a real SSE
// stream. Real transport/backoff behavior is covered by useLiveTable.test.tsx.
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

import { isBackendAvailable, fetchTableRows, createRow, deleteRow } from '../../../../lib/api';

function resetTables() {
  // Deep-clone so per-test store mutations never leak across tests (Zustand
  // stores are module singletons).
  useDataStore.setState({
    tables: INITIAL_TABLES.map((t) => ({ ...t, records: t.records.map((r) => ({ ...r })) })),
  });
}

describe('TableBrowserPage', () => {
  beforeEach(() => {
    resetTables();
    useSettingsStore.setState({ safeUpdates: false });
    vi.mocked(isBackendAvailable).mockReturnValue(false);
    vi.mocked(fetchTableRows).mockReset();
    vi.mocked(createRow).mockReset();
    vi.mocked(deleteRow).mockReset();
  });

  it('never calls window.alert, and Refresh triggers a real refetch when a backend is connected', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.mocked(isBackendAvailable).mockReturnValue(true);
    vi.mocked(fetchTableRows).mockResolvedValue({ columns: [], rows: [{ id: 'refreshed-1' }] });

    const user = userEvent.setup();
    render(<TableBrowserPage />);

    await user.click(screen.getByText('Refresh'));

    expect(alertSpy).not.toHaveBeenCalled();
    expect(fetchTableRows).toHaveBeenCalledWith('users');

    alertSpy.mockRestore();
  });

  it('is an honest no-op on Refresh when there is no backend', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.mocked(isBackendAvailable).mockReturnValue(false);

    const user = userEvent.setup();
    render(<TableBrowserPage />);

    await user.click(screen.getByText('Refresh'));

    expect(alertSpy).not.toHaveBeenCalled();
    expect(fetchTableRows).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('renders no pager controls', () => {
    render(<TableBrowserPage />);

    expect(screen.queryByText('Jump page')).not.toBeInTheDocument();
    expect(screen.queryByText(/simulated client memory cache/i)).not.toBeInTheDocument();
  });

  it('derives the displayed record count from records.length, not a fabricated figure', () => {
    render(<TableBrowserPage />);

    const usersEntry = screen.getByText('users').closest('div');
    expect(usersEntry).not.toBeNull();
    expect(within(usersEntry as HTMLElement).getByText('4')).toBeInTheDocument();
    expect(screen.queryByText('1.2k')).not.toBeInTheDocument();
  });

  it('toggling a column in the Filter Columns dropdown hides it from header and rows, and restores it on re-toggle', async () => {
    const user = userEvent.setup();
    render(<TableBrowserPage />);

    expect(screen.getByRole('columnheader', { name: /email/i })).toBeInTheDocument();
    expect(screen.getByText('alex@indigodb.io')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /filter columns/i }));
    const emailOption = await screen.findByRole('menuitemcheckbox', { name: /email/i });
    await user.click(emailOption);

    expect(screen.queryByRole('columnheader', { name: /email/i })).not.toBeInTheDocument();
    expect(screen.queryByText('alex@indigodb.io')).not.toBeInTheDocument();

    await user.click(emailOption);

    expect(screen.getByRole('columnheader', { name: /email/i })).toBeInTheDocument();
    expect(screen.getByText('alex@indigodb.io')).toBeInTheDocument();
  });

  it('clicking a column header cycles sort asc -> desc -> unsorted and reorders the displayed rows', async () => {
    const user = userEvent.setup();
    render(<TableBrowserPage />);

    const fullNameHeader = screen.getByRole('columnheader', { name: /full_name/i });

    const cellOrder = () =>
      screen.getAllByRole('row').slice(1).map((row) => row.textContent);

    const originalOrder = cellOrder();

    await user.click(fullNameHeader);
    const ascOrder = cellOrder();
    expect(ascOrder).not.toEqual(originalOrder);

    await user.click(fullNameHeader);
    const descOrder = cellOrder();
    expect(descOrder).not.toEqual(ascOrder);

    await user.click(fullNameHeader);
    expect(cellOrder()).toEqual(originalOrder);
  });

  it('sorting never mutates the Zustand store\'s underlying records array', async () => {
    const user = userEvent.setup();
    render(<TableBrowserPage />);

    const recordsBefore = useDataStore.getState().tables[0].records;
    const namesBefore = recordsBefore.map((r) => r.full_name);

    await user.click(screen.getByRole('columnheader', { name: /full_name/i }));

    const recordsAfter = useDataStore.getState().tables[0].records;

    expect(recordsAfter).toBe(recordsBefore);
    expect(recordsAfter.map((r) => r.full_name)).toEqual(namesBefore);
  });

  it('composes filter and sort: sorts only the search-filtered rows, not the full unfiltered set', async () => {
    const user = userEvent.setup();
    render(<TableBrowserPage />);

    await user.type(screen.getByPlaceholderText('Search active records...'), 'gmail');
    await user.click(screen.getByRole('columnheader', { name: /full_name/i }));

    const dataRows = screen.getAllByRole('row').slice(1);
    expect(dataRows).toHaveLength(1);
    expect(dataRows[0].textContent).toContain('Sarah Jenkins');
  });

  it('disables Add Record with an explanatory title, and clicking it never mutates the store', async () => {
    const user = userEvent.setup();
    render(<TableBrowserPage />);

    const recordsBefore = useDataStore.getState().tables;

    const addRecordButton = screen.getByRole('button', { name: /add record/i });
    expect(addRecordButton).toBeDisabled();
    expect(addRecordButton).toHaveAttribute(
      'title',
      "Row editing isn't available yet — this build is read-only.",
    );

    await user.click(addRecordButton);

    expect(useDataStore.getState().tables).toBe(recordsBefore);
  });

  it('enables Add Record with a backend, and submitting the create form calls createRow and appends the persisted row', async () => {
    vi.mocked(isBackendAvailable).mockReturnValue(true);
    const persistedRow = {
      id: 'new-id',
      email: 'new@example.com',
      full_name: null,
      created_at: '',
      is_active: '',
    };
    vi.mocked(createRow).mockResolvedValue(persistedRow);

    const user = userEvent.setup();
    render(<TableBrowserPage />);

    const addRecordButton = screen.getByRole('button', { name: /add record/i });
    expect(addRecordButton).not.toBeDisabled();
    expect(addRecordButton).not.toHaveAttribute('title');

    await user.click(addRecordButton);

    const createButton = screen.getByRole('button', { name: /create row/i });
    expect(createButton).toBeInTheDocument();

    await user.type(screen.getByLabelText('id'), 'new-id');
    await user.type(screen.getByLabelText('email'), 'new@example.com');
    await user.click(createButton);

    expect(createRow).toHaveBeenCalledWith(
      'users',
      expect.objectContaining({ id: 'new-id', email: 'new@example.com' }),
    );
    expect(useDataStore.getState().tables[0].records).toHaveLength(5);
    expect(useDataStore.getState().tables[0].records.at(-1)).toEqual(persistedRow);
  });

  it('disables Add Record with an explanatory title without a backend even after a prior create form was open', async () => {
    const user = userEvent.setup();
    render(<TableBrowserPage />);

    const recordsBefore = useDataStore.getState().tables;
    const addRecordButton = screen.getByRole('button', { name: /add record/i });
    expect(addRecordButton).toBeDisabled();

    await user.click(addRecordButton);

    expect(useDataStore.getState().tables).toBe(recordsBefore);
    expect(screen.queryByRole('button', { name: /create row/i })).not.toBeInTheDocument();
  });

  it('disables Save with an explanatory title when there is no backend, and clicking never mutates the store', async () => {
    const user = userEvent.setup();
    render(<TableBrowserPage />);

    const recordsBefore = useDataStore.getState().tables;

    const saveButton = screen.getByRole('button', { name: /save row/i });

    expect(saveButton).toBeDisabled();
    expect(saveButton).toHaveAttribute(
      'title',
      "Row editing isn't available yet — this build is read-only.",
    );

    await user.click(saveButton);

    expect(useDataStore.getState().tables).toBe(recordsBefore);
  });

  it('disables Discard with no unsaved changes, and enables it (no backend needed) once a field is edited', async () => {
    const user = userEvent.setup();
    render(<TableBrowserPage />);

    const recordsBefore = useDataStore.getState().tables;
    const discardButton = screen.getByRole('button', { name: /discard/i });
    expect(discardButton).toBeDisabled();

    await user.clear(screen.getByLabelText('email'));
    await user.type(screen.getByLabelText('email'), 'changed@example.com');

    expect(discardButton).not.toBeDisabled();
    await user.click(discardButton);

    expect(screen.getByLabelText('email')).toHaveValue('alex@indigodb.io');
    expect(useDataStore.getState().tables).toBe(recordsBefore);
  });

  it('disables Create Table submit with an explanatory title, and submitting never adds a table', async () => {
    const user = userEvent.setup();
    render(<TableBrowserPage />);

    const tablesBefore = useDataStore.getState().tables;

    await user.click(screen.getByTitle('Create new table'));

    const submitButton = screen.getByRole('button', { name: /^create table$/i });
    expect(submitButton).toBeDisabled();
    expect(submitButton).toHaveAttribute(
      'title',
      "Table creation isn't available yet — this build is read-only.",
    );

    expect(useDataStore.getState().tables).toBe(tablesBefore);
  });

  it('disables Refresh with an explanatory title when there is no backend', () => {
    vi.mocked(isBackendAvailable).mockReturnValue(false);
    render(<TableBrowserPage />);

    const refreshButton = screen.getByRole('button', { name: /refresh/i });
    expect(refreshButton).toBeDisabled();
    expect(refreshButton).toHaveAttribute(
      'title',
      'Refresh needs a connected database — this build is showing sample data.',
    );
  });

  it('enables Refresh (no title) when a backend is connected', () => {
    vi.mocked(isBackendAvailable).mockReturnValue(true);
    render(<TableBrowserPage />);

    const refreshButton = screen.getByRole('button', { name: /refresh/i });
    expect(refreshButton).not.toBeDisabled();
  });

  describe('delete row (studio-write-guards: confirmation + Safe Updates dual gate)', () => {
    it('disables the delete control with an explanatory reason when Safe Updates is enabled', () => {
      vi.mocked(isBackendAvailable).mockReturnValue(true);
      useSettingsStore.setState({ safeUpdates: true });

      render(<TableBrowserPage />);

      const deleteButton = screen.getByRole('button', { name: /delete row/i });
      expect(deleteButton).toBeDisabled();
      expect(deleteButton).toHaveAttribute(
        'title',
        'Deleting is blocked by "Safe Updates". Disable it in Settings › Query Guards to delete rows.',
      );
    });

    it('enables the delete control (no blocking title) when a backend is connected, a row is selected, and Safe Updates is off', () => {
      vi.mocked(isBackendAvailable).mockReturnValue(true);
      useSettingsStore.setState({ safeUpdates: false });

      render(<TableBrowserPage />);

      const deleteButton = screen.getByRole('button', { name: /delete row/i });
      expect(deleteButton).not.toBeDisabled();
      expect(deleteButton).toHaveAttribute('title', 'Delete this row');
    });

    it('confirmed + Safe Updates off: sends the DELETE request for the selected row\'s primary key', async () => {
      vi.mocked(isBackendAvailable).mockReturnValue(true);
      useSettingsStore.setState({ safeUpdates: false });
      vi.mocked(deleteRow).mockResolvedValue(undefined);

      const user = userEvent.setup();
      render(<TableBrowserPage />);

      await user.click(screen.getByRole('button', { name: /delete row/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));

      expect(deleteRow).toHaveBeenCalledTimes(1);
      expect(deleteRow).toHaveBeenCalledWith('users', expect.objectContaining({ id: expect.anything() }));
    });

    it('confirmed + Safe Updates on: the DELETE request is still not sent (dual gate, not either/or)', async () => {
      vi.mocked(isBackendAvailable).mockReturnValue(true);
      useSettingsStore.setState({ safeUpdates: false });

      const user = userEvent.setup();
      render(<TableBrowserPage />);

      // Open the dialog while Safe Updates is off (so the disabled delete
      // control itself doesn't block opening it)...
      await user.click(screen.getByRole('button', { name: /delete row/i }));
      const dialog = await screen.findByRole('dialog');

      // ...then flip Safe Updates on before confirming, proving the dialog's
      // own confirm handler re-reads the store at click time rather than
      // trusting a value captured when it opened.
      act(() => {
        useSettingsStore.setState({ safeUpdates: true });
      });
      await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));

      expect(deleteRow).not.toHaveBeenCalled();
    });

    it('Safe Updates off + declined confirmation: the DELETE request is not sent', async () => {
      vi.mocked(isBackendAvailable).mockReturnValue(true);
      useSettingsStore.setState({ safeUpdates: false });

      const user = userEvent.setup();
      render(<TableBrowserPage />);

      await user.click(screen.getByRole('button', { name: /delete row/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

      expect(deleteRow).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('live status badge (studio-ui-honesty: hidden, not disabled, when inert)', () => {
    it('is absent for a non-realtime table even with a backend connected', () => {
      vi.mocked(isBackendAvailable).mockReturnValue(true);
      // The default 'users' mock table carries no `realtime` flag.
      render(<TableBrowserPage />);

      expect(screen.queryByText(/live/i)).not.toBeInTheDocument();
    });

    it('is absent with no backend connected, even for a realtime-eligible table', () => {
      vi.mocked(isBackendAvailable).mockReturnValue(false);
      useDataStore.setState((state) => ({
        tables: state.tables.map((t, i) => (i === 0 ? { ...t, realtime: true } : t)),
      }));

      render(<TableBrowserPage />);

      expect(screen.queryByText(/live/i)).not.toBeInTheDocument();
    });

    it('is present and shows live status for a realtime-eligible table with a backend connected', () => {
      vi.mocked(isBackendAvailable).mockReturnValue(true);
      useDataStore.setState((state) => ({
        tables: state.tables.map((t, i) => (i === 0 ? { ...t, realtime: true } : t)),
      }));

      render(<TableBrowserPage />);

      expect(screen.getByText(/live/i)).toBeInTheDocument();
    });
  });
});
