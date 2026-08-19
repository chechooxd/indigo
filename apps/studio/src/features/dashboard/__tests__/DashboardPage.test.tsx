/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import DashboardPage from '../DashboardPage';
import { useNavigationStore } from '../../../store/useNavigationStore';

describe('DashboardPage', () => {
  it('honestly disables "Open CLI" and "View all" instead of faking their effect', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const navigateSpy = vi.spyOn(useNavigationStore.getState(), 'navigate');

    const user = userEvent.setup();
    render(<DashboardPage />);

    const openCliButton = document.querySelector('#btn-open-cli') as HTMLElement;
    expect(openCliButton).toBeDisabled();
    expect(openCliButton).toHaveAttribute(
      'title',
      "Connecting to the CLI isn't available from the browser.",
    );

    const viewAllButton = screen.getByText('dashboard.recent_schemas.view_all');
    expect(viewAllButton).toBeDisabled();
    expect(viewAllButton).toHaveAttribute('title', 'All schemas are already listed here.');

    await user.click(openCliButton);
    await user.click(viewAllButton);

    expect(alertSpy).not.toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();

    alertSpy.mockRestore();
    navigateSpy.mockRestore();
  });
});
