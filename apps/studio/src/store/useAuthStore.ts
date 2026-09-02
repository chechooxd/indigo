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
  /** Whether the server reports global, server-side read-only mode is active. */
  readOnly: boolean;
  /** Resolved startup statement timeout, in ms, from `GET /api/auth/status`; `0` means disabled. */
  queryTimeoutMs: number;
  /** Resolved startup row cap for `POST /api/query`, from the same probe; `0` means disabled. */
  queryRowCap: number;
  /**
   * Resolved startup `--env`/`INDIGODB_ENV` label, verbatim, from the same
   * probe; `null` when unset. Purely informational — never read by any
   * auth/read-only/guardrail decision.
   */
  environment: string | null;
  /**
   * Whether the server has a real `schemaPath` and can accept
   * `PUT /api/schema/source`. Defaults to `false` (Save renders
   * disabled-with-a-reason) until `checkStatus()` confirms otherwise —
   * matching this app's fail-soft posture in standalone dev, where there is
   * no backend and the write route could not work regardless.
   */
  schemaWritable: boolean;
  loginError: string | null;
  /**
   * `true` while the initial `GET /api/auth/status` probe is in flight.
   * `App` uses this to withhold both the app shell and `LoginScreen` until
   * the probe settles, so the permissive default state below never paints
   * even for one frame.
   */
  statusChecking: boolean;
  /**
   * Primary auth detection: probes `GET /api/auth/status` on app load.
   * Fails soft (leaves `authRequired`/`authenticated` untouched) in
   * standalone dev with no backend, matching every other bootstrap call in
   * this app — but always clears `statusChecking` so that fail-soft path
   * still resolves to rendering the app shell.
   */
  checkStatus: () => Promise<void>;
  login: (password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  /** 401 backstop: a mid-session expiry/tamper on any `/api/*` call. */
  handleUnauthorized: () => void;
}

/**
 * Backend startup defaults for the query guardrails (see @indigodb/cli's
 * `resolveQueryTimeoutMs`/`resolveQueryRowCap`). Used here only as the
 * fallback shown before `checkStatus()` resolves, or in standalone dev with
 * no backend — the console's hint should never show `0`/`undefined` as if
 * guardrails were disabled when they are, in fact, simply unprobed yet.
 */
const DEFAULT_QUERY_TIMEOUT_MS = 30000;
const DEFAULT_QUERY_ROW_CAP = 1000;

/**
 * Defaults to "no gate" (`authRequired: false, authenticated: true`) until
 * `checkStatus()` resolves — the same fail-soft posture as the rest of this
 * app's backend-optional design: standalone `pnpm dev` never blinks a login
 * screen at anyone. `statusChecking` starts `true` so `App` withholds any
 * render decision until the probe actually settles.
 */
export const useAuthStore = create<AuthState>((set) => ({
  authRequired: false,
  authenticated: true,
  readOnly: false,
  queryTimeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
  queryRowCap: DEFAULT_QUERY_ROW_CAP,
  environment: null,
  schemaWritable: false,
  loginError: null,
  statusChecking: true,

  checkStatus: async () => {
    const status = await fetchAuthStatus();
    if (status) {
      set({
        authRequired: status.authRequired,
        authenticated: status.authenticated,
        readOnly: status.readOnly,
        queryTimeoutMs: status.queryTimeoutMs,
        queryRowCap: status.queryRowCap,
        environment: status.environment,
        schemaWritable: status.schemaWritable,
      });
    }
    set({ statusChecking: false });
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
