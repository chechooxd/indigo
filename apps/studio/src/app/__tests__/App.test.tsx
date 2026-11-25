/**
 * @license
 * SPDX-License-Identifier: MIT
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

import { fetchAuthStatus, fetchSchema, login } from '../../lib/api';

describe('App auth gate', () => {
  beforeEach(() => {
    useAuthStore.setState({
      authRequired: false,
      authenticated: true,
      loginError: null,
      statusChecking: true,
    });
    vi.mocked(fetchAuthStatus).mockReset();
    vi.mocked(fetchSchema).mockClear();
    vi.mocked(login).mockReset();
  });

  it('renders nothing and does not bootstrap the schema while the status probe is pending', async () => {
    let resolveStatus!: (value: { authRequired: boolean; authenticated: boolean; readOnly: boolean; queryTimeoutMs: number; queryRowCap: number; environment: string | null; schemaWritable: boolean; layoutWritable: boolean }) => void;
    vi.mocked(fetchAuthStatus).mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );

    const { container } = render(<App />);

    // While the probe is still in flight, neither the app shell nor
    // LoginScreen should have rendered, and the schema bootstrap fetch
    // (fired only once the app shell mounts) must not have run either.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByLabelText('auth.login.password_label')).not.toBeInTheDocument();
    expect(document.getElementById('main-sidebar')).not.toBeInTheDocument();
    expect(fetchSchema).not.toHaveBeenCalled();

    resolveStatus({ authRequired: false, authenticated: true, readOnly: false, queryTimeoutMs: 30000, queryRowCap: 1000, environment: null, schemaWritable: true, layoutWritable: true });

    await waitFor(() => expect(document.getElementById('main-sidebar')).toBeInTheDocument());
    expect(fetchSchema).toHaveBeenCalled();
  });

  it('renders the app shell directly when the status probe reports authRequired: false', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue({ authRequired: false, authenticated: true, readOnly: false, queryTimeoutMs: 30000, queryRowCap: 1000, environment: null, schemaWritable: true, layoutWritable: true });

    render(<App />);

    await waitFor(() => expect(document.getElementById('main-sidebar')).toBeInTheDocument());
    expect(screen.queryByLabelText('auth.login.password_label')).not.toBeInTheDocument();
  });

  it('renders the login screen when the status probe reports authRequired: true, authenticated: false', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue({ authRequired: true, authenticated: false, readOnly: false, queryTimeoutMs: 30000, queryRowCap: 1000, environment: null, schemaWritable: true, layoutWritable: true });

    render(<App />);

    expect(await screen.findByLabelText('auth.login.password_label')).toBeInTheDocument();
  });

  it('transitions from the login screen to the app shell on a successful login', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue({ authRequired: true, authenticated: false, readOnly: false, queryTimeoutMs: 30000, queryRowCap: 1000, environment: null, schemaWritable: true, layoutWritable: true });
    vi.mocked(login).mockResolvedValue({ ok: true });
    const user = userEvent.setup();

    render(<App />);

    await user.type(await screen.findByLabelText('auth.login.password_label'), 'correct-password');
    await user.click(screen.getByRole('button', { name: 'auth.login.submit' }));

    await waitFor(() => expect(document.getElementById('main-sidebar')).toBeInTheDocument());
    expect(screen.queryByLabelText('auth.login.password_label')).not.toBeInTheDocument();
  });

  it('renders the read-only banner in the app shell when the status probe reports readOnly: true', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue({ authRequired: false, authenticated: true, readOnly: true, queryTimeoutMs: 30000, queryRowCap: 1000, environment: null, schemaWritable: true, layoutWritable: true });

    render(<App />);

    await waitFor(() => expect(document.getElementById('main-sidebar')).toBeInTheDocument());
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('with readOnly:true AND environment set together, role="status" still resolves to a single node (the banner), and the environment badge is also present', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue({
      authRequired: false,
      authenticated: true,
      readOnly: true,
      queryTimeoutMs: 30000,
      queryRowCap: 1000,
      environment: 'production',
      schemaWritable: true, layoutWritable: true,
    });

    render(<App />);

    await waitFor(() => expect(document.getElementById('main-sidebar')).toBeInTheDocument());
    // getByRole throws if more than one "status" node exists — this is the
    // collision regression: EnvironmentBadge must never use role="status".
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByTestId('environment-badge')).toBeInTheDocument();
  });

  it('does not render the read-only banner when the status probe reports readOnly: false', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue({ authRequired: false, authenticated: true, readOnly: false, queryTimeoutMs: 30000, queryRowCap: 1000, environment: null, schemaWritable: true, layoutWritable: true });

    render(<App />);

    await waitFor(() => expect(document.getElementById('main-sidebar')).toBeInTheDocument());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('never renders the read-only banner on the login screen', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue({ authRequired: true, authenticated: false, readOnly: true, queryTimeoutMs: 30000, queryRowCap: 1000, environment: null, schemaWritable: true, layoutWritable: true });

    render(<App />);

    expect(await screen.findByLabelText('auth.login.password_label')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
