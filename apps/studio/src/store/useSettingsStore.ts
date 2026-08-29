/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from 'zustand';

/**
 * `safeUpdates` gates row DELETE (see studio-write-guards spec). Deliberately
 * session-local, in-memory only — no `localStorage`/`persist` middleware, and
 * no read from any storage on init — so a fresh page load (a "new session")
 * always starts with it off, even if a prior session had it enabled. This is
 * a hard safety default: DELETE must never inherit a stale "disabled" guard
 * state from a previous session.
 */
interface SettingsState {
  safeUpdates: boolean;
  setSafeUpdates: (value: boolean) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  safeUpdates: false,
  setSafeUpdates: (value) => set({ safeUpdates: value }),
}));
