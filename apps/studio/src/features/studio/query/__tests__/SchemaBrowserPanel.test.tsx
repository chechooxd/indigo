/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SchemaBrowserPanel } from '../components/SchemaBrowserPanel';

describe('SchemaBrowserPanel', () => {
  it('honestly disables refresh with a stated reason when there is no backend, and never calls alert', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onRefresh = vi.fn().mockResolvedValue(undefined);

    const user = userEvent.setup();
    render(
      <SchemaBrowserPanel
        tables={[]}
        selectedTable=""
        onSelectTable={vi.fn()}
        canRefresh={false}
        onRefresh={onRefresh}
      />,
    );

    const refreshButton = screen.getByTitle(
      'Refresh needs a connected database — this build is showing sample data.',
    );
    expect(refreshButton).toBeDisabled();

    await user.click(refreshButton);

    expect(alertSpy).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('performs a real refresh when a backend is connected', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onRefresh = vi.fn().mockResolvedValue(undefined);

    const user = userEvent.setup();
    render(
      <SchemaBrowserPanel
        tables={[]}
        selectedTable=""
        onSelectTable={vi.fn()}
        canRefresh
        onRefresh={onRefresh}
      />,
    );

    const refreshButton = screen.getByRole('button', { name: /refresh/i });
    expect(refreshButton).not.toBeDisabled();
    expect(refreshButton).not.toHaveAttribute('title', expect.stringContaining('needs a connected database'));

    await user.click(refreshButton);

    expect(alertSpy).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    alertSpy.mockRestore();
  });
});
