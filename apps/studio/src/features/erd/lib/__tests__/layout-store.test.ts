/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { seedPosition, resolvePositions, createLayoutAutosave } from '../layout-store';

describe('resolvePositions', () => {
  it('falls back to the seed formula for a table missing from the layout file', () => {
    const resolved = resolvePositions(['User', 'Tag'], { User: { x: 500, y: 600 } });

    expect(resolved.User).toEqual({ x: 500, y: 600 });
    expect(resolved.Tag).toEqual(seedPosition(1));
  });

  it('ignores a stale layout key for a table that no longer exists, without crashing', () => {
    const resolved = resolvePositions(['User'], {
      User: { x: 10, y: 20 },
      OldTable: { x: 999, y: 999 },
    });

    expect(Object.keys(resolved)).toEqual(['User']);
    expect(resolved.User).toEqual({ x: 10, y: 20 });
  });

  it('resolves every table to the seed formula against an empty layout file', () => {
    const resolved = resolvePositions(['A', 'B', 'C', 'D'], {});

    expect(resolved).toEqual({
      A: seedPosition(0),
      B: seedPosition(1),
      C: seedPosition(2),
      D: seedPosition(3),
    });
  });
});

describe('createLayoutAutosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not call save before the debounce window elapses', () => {
    const save = vi.fn().mockResolvedValue({ ok: true, version: 'v2' });
    const autosave = createLayoutAutosave(save, () => 'v1', () => {}, 500);

    autosave.schedule({ User: { x: 1, y: 2 } });
    vi.advanceTimersByTime(499);

    expect(save).not.toHaveBeenCalled();
  });

  it('calls save with the latest scheduled positions once the debounce window elapses', () => {
    const save = vi.fn().mockResolvedValue({ ok: true, version: 'v2' });
    const autosave = createLayoutAutosave(save, () => 'v1', () => {}, 500);

    autosave.schedule({ User: { x: 1, y: 2 } });
    autosave.schedule({ User: { x: 9, y: 9 } }); // supersedes the first schedule
    vi.advanceTimersByTime(500);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ User: { x: 9, y: 9 } }, 'v1');
  });

  it('flush() sends a pending save immediately, without waiting for the debounce window (unmount guarantee)', () => {
    const save = vi.fn().mockResolvedValue({ ok: true, version: 'v2' });
    const autosave = createLayoutAutosave(save, () => 'v1', () => {}, 500);

    autosave.schedule({ User: { x: 1, y: 2 } });
    autosave.flush();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ User: { x: 1, y: 2 } }, 'v1');

    // The debounce timer must also be cancelled by flush() — advancing past
    // the window afterward must not fire a second, duplicate save.
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flush() with no pending save is a no-op (does not call save)', () => {
    const save = vi.fn().mockResolvedValue({ ok: true, version: 'v2' });
    const autosave = createLayoutAutosave(save, () => 'v1', () => {}, 500);

    autosave.flush();

    expect(save).not.toHaveBeenCalled();
  });

  it('cancel() drops a pending save and prevents the debounce timer from firing it', () => {
    const save = vi.fn().mockResolvedValue({ ok: true, version: 'v2' });
    const autosave = createLayoutAutosave(save, () => 'v1', () => {}, 500);

    autosave.schedule({ User: { x: 1, y: 2 } });
    autosave.cancel();
    vi.advanceTimersByTime(1000);

    expect(save).not.toHaveBeenCalled();
  });

  it('onSaved is invoked with the server-returned version after a successful debounced save', async () => {
    const save = vi.fn().mockResolvedValue({ ok: true, version: 'v2' });
    const onSaved = vi.fn();
    const autosave = createLayoutAutosave(save, () => 'v1', onSaved, 500);

    autosave.schedule({ User: { x: 1, y: 2 } });
    vi.advanceTimersByTime(500);
    await vi.runAllTimersAsync();

    expect(onSaved).toHaveBeenCalledWith('v2');
  });
});
