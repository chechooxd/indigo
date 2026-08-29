/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import LoginScreen from '../LoginScreen';
import { useAuthStore } from '../../../store/useAuthStore';

describe('LoginScreen', () => {
  beforeEach(() => {
    useAuthStore.setState({ authRequired: true, authenticated: false, loginError: null });
  });

  it('submits the entered password to the login action', async () => {
    const loginSpy = vi.spyOn(useAuthStore.getState(), 'login').mockResolvedValue(true);
    const user = userEvent.setup();

    render(<LoginScreen />);

    await user.type(screen.getByLabelText('auth.login.password_label'), 'my-password');
    await user.click(screen.getByRole('button', { name: 'auth.login.submit' }));

    expect(loginSpy).toHaveBeenCalledWith('my-password');

    loginSpy.mockRestore();
  });

  it('shows an inline "Invalid password" error and stays on the login screen after a failed login', async () => {
    vi.spyOn(useAuthStore.getState(), 'login').mockImplementation(async () => {
      useAuthStore.setState({ loginError: 'Invalid password' });
      return false;
    });
    const user = userEvent.setup();

    render(<LoginScreen />);

    await user.type(screen.getByLabelText('auth.login.password_label'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'auth.login.submit' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid password');
    expect(screen.getByLabelText('auth.login.password_label')).toBeInTheDocument();
  });
});
