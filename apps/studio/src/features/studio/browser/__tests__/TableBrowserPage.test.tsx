/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import TableBrowserPage from '../TableBrowserPage';
import { useDataStore, defaultTablePageState } from '../../../../store/useDataStore';
import { useSettingsStore } from '../../../../store/useSettingsStore';
import { INITIAL_TABLES } from '../../../../data/mockData';

vi.mock('../../../../lib/api', () => ({
  isBackendAvailable: vi.fn(() => false),
  fetchTableRows: vi.fn(),
  updateRow: vi.fn(),
  createRow: vi.fn(),
  deleteRow: vi.fn(),
  PAGE_SIZES: [25, 50, 100, 200],
}));

// Fake transport: `connect()` synchronously fires `onOpen(false)` so the
// live badge (when mounted) reaches its `live` status without a real SSE
// stream. Real transport/backoff behavior is covered by useLiveTable.test.tsx.
// Partial mock: spread the real module and override only the transport
// factories. A hand-listed replacement has to enumerate every export the
// consuming chain touches, so it breaks each time that module grows — it
// already broke twice during the Studio re-base (first `browserTransport`,
// then `createLiveSubscription`). `importOriginal` keeps the real surface.
vi.mock('@indigodb/client/realtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@indigodb/client/realtime')>();
  const fakeTransport = () => ({
    connect: vi.fn((_tables: string[], handlers: { onOpen: (reconnected: boolean) => void }) => {
      handlers.onOpen(false);
      return () => {};
    }),
  });
  return {
    ...actual,
    SseTransport: vi.fn().mockImplementation(fakeTransport),
    browserTransport: vi.fn(fakeTransport),
  };
});

import { isBackendAvailable, fetchTableRows, createRow, deleteRow, type TablePage } from '../../../../lib/api';

function resetTables() {
  // Deep-clone so per-test store mutations never leak across tests (Zustand
  // stores are module singletons).
  useDataStore.setState({
    tables: INITIAL_TABLES.map((t) => ({ ...t, records: t.records.map((r) => ({ ...r })) })),
    pagination: {},
  });
}

/** Builds a complete `TablePage` response for `fetchTableRows` mocks. */
function mockPage(rows: Record<string, unknown>[], overrides: Partial<TablePage> = {}): TablePage {
  return {
    columns: [],
    rows,
    nextCursor: null,
    prevCursor: null,
    total: rows.length,
    paginated: true,
    ...overrides,
  };
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
    vi.mocked(fetchTableRows).mockResolvedValue(mockPage([{ id: 'refreshed-1' }]));

    const user = userEvent.setup();
    render(<TableBrowserPage />);

    await user.click(screen.getByText('Refresh'));

    expect(alertSpy).not.toHaveBeenCalled();
    expect(fetchTableRows).toHaveBeenCalledWith('users', expect.objectContaining({ limit: 100 }));

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

  describe('pagination (studio-table-pagination)', () => {
    it('renders prev/next pager controls disabled when there is no next/prev cursor', () => {
      render(<TableBrowserPage />);

      expect(screen.getByRole('button', { name: /previous page/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /next page/i })).toBeDisabled();
    });

    it('Next page fetches the following page and updates the pager state', async () => {
      vi.mocked(isBackendAvailable).mockReturnValue(true);
      // Seed pagination state directly, as if a prior page load already
      // happened (mirrors real usage: this mock table's records are
      // pre-populated, so the mount effect's auto-load is a no-op here —
      // see the "already has records" guard in TableBrowserPage).
      useDataStore.setState({
        pagination: { users: { ...defaultTablePageState(), nextCursor: 'cursor-a', total: 2 } },
      });
      const user = userEvent.setup();
      render(<TableBrowserPage />);

      expect(screen.getByRole('button', { name: /next page/i })).not.toBeDisabled();

      vi.mocked(fetchTableRows).mockResolvedValueOnce(
        mockPage([{ id: 'row-2' }], { prevCursor: 'cursor-b', nextCursor: null, total: 2 }),
      );
      await user.click(screen.getByRole('button', { name: /next page/i }));

      expect(fetchTableRows).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ cursor: 'cursor-a', direction: 'forward' }),
      );
      await screen.findByRole('button', { name: /next page/i });
      expect(screen.getByRole('button', { name: /next page/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /previous page/i })).not.toBeDisabled();
    });

    it('page-size selector resets to page one (cursor: null) on change', async () => {
      vi.mocked(isBackendAvailable).mockReturnValue(true);
      useDataStore.setState({
        pagination: { users: { ...defaultTablePageState(), nextCursor: 'cursor-a', total: 2 } },
      });
      const user = userEvent.setup();
      render(<TableBrowserPage />);

      vi.mocked(fetchTableRows).mockResolvedValueOnce(mockPage([{ id: 'row-1' }], { total: 1 }));

      await user.selectOptions(screen.getByLabelText(/rows per page/i), '25');

      expect(fetchTableRows).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ cursor: null, direction: 'forward', limit: 25 }),
      );
    });

    it('shows a PK-less notice instead of a pager when the server reports paginated:false', () => {
      vi.mocked(isBackendAvailable).mockReturnValue(true);
      useDataStore.setState({
        pagination: { users: { ...defaultTablePageState(), paginated: false, total: 1 } },
      });
      render(<TableBrowserPage />);

      expect(screen.getByText(/has no primary key/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /next page/i })).not.toBeInTheDocument();
    });
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

  describe('sort control (studio-ui-honesty: disabled, not removed)', () => {
    it('renders the sort control disabled with SORT_DISABLED_TITLE, and clicking it has no effect', async () => {
      const user = userEvent.setup();
      render(<TableBrowserPage />);

      const sortButton = screen.getByRole('button', { name: /sort by full_name/i });
      expect(sortButton).toBeDisabled();
      expect(sortButton).toHaveAttribute(
        'title',
        'Sorting is disabled: rows are ordered by primary key across all pages. Full-table sort on other columns is not available yet.',
      );

      const recordsBefore = useDataStore.getState().tables[0].records;
      await user.click(sortButton);
      expect(useDataStore.getState().tables[0].records).toBe(recordsBefore);
    });
  });

  it('search alone filters the displayed rows (no sort applied)', async () => {
    const user = userEvent.setup();
    render(<TableBrowserPage />);

    await user.type(screen.getByPlaceholderText('Search active records...'), 'gmail');

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
