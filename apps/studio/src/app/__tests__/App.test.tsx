/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from '../App';
import { useAuthStore } from '../../store/useAuthStore';

// App statically imports ERDDesignerPage (even though it's only rendered on
// the 'editor' tab), which pulls in the real WASM compiler via
// `@indigodb/core`'s `parse`/`resolve` — unavailable in this jsdom/Vitest
// environment. Stub the module so importing App doesn't try to load it.
vi.mock('@indigodb/core', () => ({
  parse: vi.fn(),
  resolve: vi.fn(),
  initCompiler: vi.fn(),
}));

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return {
    ...actual,
    fetchSchema: vi.fn().mockResolvedValue(null),
    fetchAuthStatus: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
  };
});

import { fetchAuthStatus, login } from '../../lib/api';

describe('App auth gate', () => {
  beforeEach(() => {
    useAuthStore.setState({ authRequired: false, authenticated: true, loginError: null });
    vi.mocked(fetchAuthStatus).mockReset();
    vi.mocked(login).mockReset();
  });

  it('renders the app shell directly when the status probe reports authRequired: false', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue({ authRequired: false, authenticated: true });

    render(<App />);

    await waitFor(() => expect(document.getElementById('main-sidebar')).toBeInTheDocument());
    expect(screen.queryByLabelText('auth.login.password_label')).not.toBeInTheDocument();
  });

  it('renders the login screen when the status probe reports authRequired: true, authenticated: false', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue({ authRequired: true, authenticated: false });

    render(<App />);

    expect(await screen.findByLabelText('auth.login.password_label')).toBeInTheDocument();
  });

  it('transitions from the login screen to the app shell on a successful login', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue({ authRequired: true, authenticated: false });
    vi.mocked(login).mockResolvedValue({ ok: true });
    const user = userEvent.setup();

    render(<App />);

    await user.type(await screen.findByLabelText('auth.login.password_label'), 'correct-password');
    await user.click(screen.getByRole('button', { name: 'auth.login.submit' }));

    await waitFor(() => expect(document.getElementById('main-sidebar')).toBeInTheDocument());
    expect(screen.queryByLabelText('auth.login.password_label')).not.toBeInTheDocument();
  });
});
