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
});
