/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import TableBrowserPage from '../TableBrowserPage';
import { useDataStore } from '../../../../store/useDataStore';
import { INITIAL_TABLES } from '../../../../data/mockData';

vi.mock('../../../../lib/api', () => ({
  isBackendAvailable: vi.fn(() => false),
  fetchTableRows: vi.fn(),
}));

import { isBackendAvailable, fetchTableRows } from '../../../../lib/api';

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
    vi.mocked(isBackendAvailable).mockReturnValue(false);
    vi.mocked(fetchTableRows).mockReset();
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
});
