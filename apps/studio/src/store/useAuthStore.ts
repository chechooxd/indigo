/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from 'zustand';
import {
  fetchAuthStatus,
  login as apiLogin,
  logout as apiLogout,
  setUnauthorizedHandler,
} from '../lib/api';

interface AuthState {
  /** Whether this Studio instance has a shared password configured. */
  authRequired: boolean;
  /** Whether the current session already holds a valid session cookie. */
  authenticated: boolean;
  loginError: string | null;
  /**
   * Primary auth detection: probes `GET /api/auth/status` on app load.
   * Fails soft (leaves state untouched) in standalone dev with no backend,
   * matching every other bootstrap call in this app.
   */
  checkStatus: () => Promise<void>;
  login: (password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  /** 401 backstop: a mid-session expiry/tamper on any `/api/*` call. */
  handleUnauthorized: () => void;
}

/**
 * Defaults to "no gate" (`authRequired: false, authenticated: true`) until
 * `checkStatus()` resolves — the same fail-soft posture as the rest of this
 * app's backend-optional design: standalone `pnpm dev` never blinks a login
 * screen at anyone.
 */
export const useAuthStore = create<AuthState>((set) => ({
  authRequired: false,
  authenticated: true,
  loginError: null,

  checkStatus: async () => {
    const status = await fetchAuthStatus();
    if (status) {
      set({ authRequired: status.authRequired, authenticated: status.authenticated });
    }
  },

  login: async (password: string) => {
    const result = await apiLogin(password);
    if (result.ok) {
      set({ authenticated: true, loginError: null });
      return true;
    }
    set({ authenticated: false, loginError: result.error ?? 'Invalid password' });
    return false;
  },

  logout: async () => {
    await apiLogout();
    set({ authenticated: false });
  },

  handleUnauthorized: () => set({ authRequired: true, authenticated: false }),
}));

setUnauthorizedHandler(() => useAuthStore.getState().handleUnauthorized());
