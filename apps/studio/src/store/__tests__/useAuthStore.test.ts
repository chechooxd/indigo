/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/api', () => ({
  fetchAuthStatus: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
}));

import { fetchAuthStatus, login, logout } from '../../lib/api';
import { useAuthStore } from '../useAuthStore';

describe('useAuthStore', () => {
  beforeEach(() => {
    useAuthStore.setState({
      authRequired: false,
      authenticated: true,
      loginError: null,
      queryTimeoutMs: 30000,
      queryRowCap: 1000,
    });
    vi.mocked(fetchAuthStatus).mockReset();
    vi.mocked(login).mockReset();
    vi.mocked(logout).mockReset();
  });

  it('defaults to no gate (authRequired: false, authenticated: true) before any status check', () => {
    expect(useAuthStore.getState().authRequired).toBe(false);
    expect(useAuthStore.getState().authenticated).toBe(true);
  });

  it('checkStatus adopts the server-reported authRequired/authenticated values', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue({
      authRequired: true,
      authenticated: false,
      readOnly: false,
      queryTimeoutMs: 30000,
      queryRowCap: 1000,
    });

    await useAuthStore.getState().checkStatus();

    expect(useAuthStore.getState().authRequired).toBe(true);
    expect(useAuthStore.getState().authenticated).toBe(false);
  });

  it('checkStatus adopts the server-reported readOnly value', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue({
      authRequired: false,
      authenticated: true,
      readOnly: true,
      queryTimeoutMs: 30000,
      queryRowCap: 1000,
    });

    await useAuthStore.getState().checkStatus();

    expect(useAuthStore.getState().readOnly).toBe(true);
  });

  it('checkStatus adopts the server-reported queryTimeoutMs/queryRowCap values', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue({
      authRequired: false,
      authenticated: true,
      readOnly: false,
      queryTimeoutMs: 9000,
      queryRowCap: 250,
    });

    await useAuthStore.getState().checkStatus();

    expect(useAuthStore.getState().queryTimeoutMs).toBe(9000);
    expect(useAuthStore.getState().queryRowCap).toBe(250);
  });

  it('checkStatus leaves queryTimeoutMs/queryRowCap at their fallback defaults when the probe fails soft (standalone, no backend)', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue(null);

    await expect(useAuthStore.getState().checkStatus()).resolves.not.toThrow();

    expect(useAuthStore.getState().queryTimeoutMs).toBe(30000);
    expect(useAuthStore.getState().queryRowCap).toBe(1000);
  });

  it('checkStatus leaves state untouched when the status probe fails soft (null)', async () => {
    vi.mocked(fetchAuthStatus).mockResolvedValue(null);

    await useAuthStore.getState().checkStatus();

    expect(useAuthStore.getState().authRequired).toBe(false);
    expect(useAuthStore.getState().authenticated).toBe(true);
  });

  it('a successful login sets authenticated true and clears any prior error', async () => {
    useAuthStore.setState({ authRequired: true, authenticated: false, loginError: 'Invalid password' });
    vi.mocked(login).mockResolvedValue({ ok: true });

    const result = await useAuthStore.getState().login('correct-password');

    expect(result).toBe(true);
    expect(useAuthStore.getState().authenticated).toBe(true);
    expect(useAuthStore.getState().loginError).toBeNull();
  });

  it('a failed login keeps authenticated false and records the server error message', async () => {
    useAuthStore.setState({ authRequired: true, authenticated: false, loginError: null });
    vi.mocked(login).mockResolvedValue({ ok: false, error: 'Invalid password' });

    const result = await useAuthStore.getState().login('wrong-password');

    expect(result).toBe(false);
    expect(useAuthStore.getState().authenticated).toBe(false);
    expect(useAuthStore.getState().loginError).toBe('Invalid password');
  });

  it('logout calls the API and resets authenticated to false', async () => {
    useAuthStore.setState({ authRequired: true, authenticated: true, loginError: null });
    vi.mocked(logout).mockResolvedValue(undefined);

    await useAuthStore.getState().logout();

    expect(logout).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().authenticated).toBe(false);
  });

  it('handleUnauthorized (401 backstop) forces the gate back to the login screen', () => {
    useAuthStore.setState({ authRequired: false, authenticated: true, loginError: null });

    useAuthStore.getState().handleUnauthorized();

    expect(useAuthStore.getState().authRequired).toBe(true);
    expect(useAuthStore.getState().authenticated).toBe(false);
  });
});
