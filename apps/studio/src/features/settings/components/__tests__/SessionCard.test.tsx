/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SessionCard } from '../SessionCard';
import { useAuthStore } from '../../../../store/useAuthStore';

describe('SessionCard', () => {
  beforeEach(() => {
    useAuthStore.setState({ authRequired: true, authenticated: true, loginError: null });
  });

  it('is absent when auth is not configured for this Studio instance (studio-ui-honesty: hidden, not disabled, when inert)', () => {
    useAuthStore.setState({ authRequired: false, authenticated: true, loginError: null });

    render(<SessionCard />);

    expect(screen.queryByRole('button', { name: 'settings.session.logout' })).not.toBeInTheDocument();
  });

  it('logging out calls the logout action and clears the authenticated session', async () => {
    const logoutSpy = vi.spyOn(useAuthStore.getState(), 'logout').mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(<SessionCard />);

    await user.click(screen.getByRole('button', { name: 'settings.session.logout' }));

    expect(logoutSpy).toHaveBeenCalledTimes(1);

    logoutSpy.mockRestore();
  });
});
