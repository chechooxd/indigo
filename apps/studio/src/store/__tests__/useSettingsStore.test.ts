/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('useSettingsStore', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('defaults safeUpdates to false', async () => {
    const { useSettingsStore } = await import('../useSettingsStore');
    expect(useSettingsStore.getState().safeUpdates).toBe(false);
  });

  it('setSafeUpdates updates the store', async () => {
    const { useSettingsStore } = await import('../useSettingsStore');
    useSettingsStore.getState().setSafeUpdates(true);
    expect(useSettingsStore.getState().safeUpdates).toBe(true);
  });

  it('resets to false on a new session (a fresh module instance never inherits a prior enabled value)', async () => {
    // Simulate "session 1": enable Safe Updates.
    const session1 = await import('../useSettingsStore');
    session1.useSettingsStore.getState().setSafeUpdates(true);
    expect(session1.useSettingsStore.getState().safeUpdates).toBe(true);

    // Simulate "session 2" (a reload): a fresh module instance, with no
    // persistence layer reading anything back from the prior session.
    vi.resetModules();
    const session2 = await import('../useSettingsStore');
    expect(session2.useSettingsStore.getState().safeUpdates).toBe(false);
  });

  it('never reads from or writes to localStorage (session-local only, not persisted)', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem');

    const { useSettingsStore } = await import('../useSettingsStore');
    useSettingsStore.getState().setSafeUpdates(true);
    useSettingsStore.getState().setSafeUpdates(false);

    expect(setItemSpy).not.toHaveBeenCalled();
    expect(getItemSpy).not.toHaveBeenCalled();

    setItemSpy.mockRestore();
    getItemSpy.mockRestore();
  });
});
