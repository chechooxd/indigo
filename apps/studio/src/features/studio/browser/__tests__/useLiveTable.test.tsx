/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useLiveTable } from '../hooks/useLiveTable';
import { useDataStore } from '../../../../store/useDataStore';
import { INITIAL_TABLES } from '../../../../data/mockData';
import type { RealtimeTransport, TransportHandlers } from '@indigodb/client/realtime';

/** Captures the handlers a `connect()` call was given, and exposes a fake
 * `unsubscribe`/`connect` call count so tests can assert subscription
 * lifecycle without a real SSE stream. */
class FakeTransport implements RealtimeTransport {
  connectCalls: { tables: string[]; handlers: TransportHandlers }[] = [];
  unsubscribeCalls = 0;

  connect(tables: string[], handlers: TransportHandlers): () => void {
    this.connectCalls.push({ tables, handlers });
    return () => {
      this.unsubscribeCalls++;
    };
  }

  get lastHandlers(): TransportHandlers {
    const last = this.connectCalls[this.connectCalls.length - 1];
    if (!last) throw new Error('connect() was never called');
    return last.handlers;
  }
}

function resetTables() {
  useDataStore.setState({
    tables: INITIAL_TABLES.map((t) => ({ ...t, records: t.records.map((r) => ({ ...r })) })),
  });
}

describe('useLiveTable', () => {
  beforeEach(() => {
    resetTables();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens exactly one subscription for a realtime-eligible table with a backend', () => {
    const transport = new FakeTransport();
    const fetchRows = vi.fn().mockResolvedValue({ columns: [], rows: [] });

    renderHook(() => useLiveTable('users', true, { transport, fetchRows }));

    expect(transport.connectCalls).toHaveLength(1);
    expect(transport.connectCalls[0].tables).toEqual(['users']);
  });

  it('opens no subscription when disabled (non-realtime table or no backend)', () => {
    const transport = new FakeTransport();
    const fetchRows = vi.fn();

    const { result } = renderHook(() => useLiveTable('users', false, { transport, fetchRows }));

    expect(transport.connectCalls).toHaveLength(0);
    expect(result.current.status).toBeNull();
  });

  it('opens no subscription with an undefined table name', () => {
    const transport = new FakeTransport();
    const fetchRows = vi.fn();

    const { result } = renderHook(() => useLiveTable(undefined, true, { transport, fetchRows }));

    expect(transport.connectCalls).toHaveLength(0);
    expect(result.current.status).toBeNull();
  });

  it('a change frame refetches only after the debounce window elapses', async () => {
    const transport = new FakeTransport();
    const fetchRows = vi.fn().mockResolvedValue({ columns: [], rows: [{ id: 1 }] });

    renderHook(() => useLiveTable('users', true, { transport, fetchRows, debounceMs: 50 }));

    act(() => transport.lastHandlers.onOpen(false));

    act(() => transport.lastHandlers.onEvent({} as never));
    expect(fetchRows).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });

    expect(fetchRows).toHaveBeenCalledWith('users');
  });

  it('a wake frame follows the identical debounced refetch path', async () => {
    const transport = new FakeTransport();
    const fetchRows = vi.fn().mockResolvedValue({ columns: [], rows: [] });

    renderHook(() => useLiveTable('users', true, { transport, fetchRows, debounceMs: 50 }));
    act(() => transport.lastHandlers.onOpen(false));

    act(() => transport.lastHandlers.onWake?.());

    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });

    expect(fetchRows).toHaveBeenCalledTimes(1);
  });

  it('a burst of 5 frames within the debounce window produces exactly one refetch', async () => {
    const transport = new FakeTransport();
    const fetchRows = vi.fn().mockResolvedValue({ columns: [], rows: [] });

    renderHook(() => useLiveTable('users', true, { transport, fetchRows, debounceMs: 50 }));
    act(() => transport.lastHandlers.onOpen(false));

    act(() => {
      for (let i = 0; i < 5; i++) transport.lastHandlers.onEvent({} as never);
    });

    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });

    expect(fetchRows).toHaveBeenCalledTimes(1);
  });

  it('a frame arriving mid-flight produces exactly one follow-up refetch, never overlapping', async () => {
    const transport = new FakeTransport();
    let resolveFirst: (v: { columns: string[]; rows: unknown[] }) => void = () => {};
    const fetchRows = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ columns: [], rows: [] });

    renderHook(() => useLiveTable('users', true, { transport, fetchRows, debounceMs: 50 }));
    act(() => transport.lastHandlers.onOpen(false));

    act(() => transport.lastHandlers.onEvent({} as never));
    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });
    expect(fetchRows).toHaveBeenCalledTimes(1);

    // Mid-flight: another frame arrives while the first refetch is pending.
    act(() => transport.lastHandlers.onEvent({} as never));
    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });
    // Still just the one in-flight call — the follow-up is coalesced, not
    // started concurrently.
    expect(fetchRows).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({ columns: [], rows: [] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchRows).toHaveBeenCalledTimes(2);
  });

  it('status sequence goes connecting -> live', () => {
    const transport = new FakeTransport();
    const fetchRows = vi.fn().mockResolvedValue({ columns: [], rows: [] });

    const { result } = renderHook(() => useLiveTable('users', true, { transport, fetchRows }));

    expect(result.current.status).toBe('connecting');

    act(() => transport.lastHandlers.onOpen(false));

    expect(result.current.status).toBe('live');
  });

  it('reconnect (onOpen(true)) returns to live and triggers one immediate refetch bypassing debounce', () => {
    const transport = new FakeTransport();
    const fetchRows = vi.fn().mockResolvedValue({ columns: [], rows: [] });

    renderHook(() => useLiveTable('users', true, { transport, fetchRows, debounceMs: 50 }));
    act(() => transport.lastHandlers.onOpen(false));
    fetchRows.mockClear();

    act(() => transport.lastHandlers.onOpen(true));

    // No timer advance needed — reconnect refetches immediately.
    expect(fetchRows).toHaveBeenCalledTimes(1);
  });

  it('onError sets error without tearing down, and a later onOpen recovers to live', () => {
    const transport = new FakeTransport();
    const fetchRows = vi.fn().mockResolvedValue({ columns: [], rows: [] });

    const { result } = renderHook(() => useLiveTable('users', true, { transport, fetchRows }));
    act(() => transport.lastHandlers.onOpen(false));

    act(() => transport.lastHandlers.onError(new Error('boom')));
    expect(result.current.status).toBe('error');
    expect(transport.unsubscribeCalls).toBe(0);

    act(() => transport.lastHandlers.onOpen(true));
    expect(result.current.status).toBe('live');
  });

  it('switching tableName tears down the old subscription and opens exactly one new one', () => {
    const transport = new FakeTransport();
    const fetchRows = vi.fn().mockResolvedValue({ columns: [], rows: [] });

    const { rerender } = renderHook(({ table }) => useLiveTable(table, true, { transport, fetchRows }), {
      initialProps: { table: 'users' },
    });

    expect(transport.connectCalls).toHaveLength(1);

    rerender({ table: 'posts' });

    expect(transport.unsubscribeCalls).toBe(1);
    expect(transport.connectCalls).toHaveLength(2);
    expect(transport.connectCalls[1].tables).toEqual(['posts']);
  });

  it('unmounting tears down the subscription', () => {
    const transport = new FakeTransport();
    const fetchRows = vi.fn().mockResolvedValue({ columns: [], rows: [] });

    const { unmount } = renderHook(() => useLiveTable('users', true, { transport, fetchRows }));

    expect(transport.unsubscribeCalls).toBe(0);
    unmount();
    expect(transport.unsubscribeCalls).toBe(1);
  });

  it('fetchRows returning null leaves rows/status unchanged', async () => {
    const transport = new FakeTransport();
    const fetchRows = vi.fn().mockResolvedValue(null);

    const { result } = renderHook(() => useLiveTable('users', true, { transport, fetchRows, debounceMs: 50 }));
    act(() => transport.lastHandlers.onOpen(false));

    act(() => transport.lastHandlers.onEvent({} as never));
    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });

    expect(fetchRows).toHaveBeenCalledWith('users');
    expect(result.current.status).toBe('live');
  });
});
