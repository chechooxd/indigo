/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useLiveTable } from '../hooks/useLiveTable';
import { useDataStore } from '../../../../store/useDataStore';
import { INITIAL_TABLES } from '../../../../data/mockData';
import type { RealtimeTransport, TransportHandlers, LiveStatus } from '@indigodb/client/realtime';

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

  it('a wake frame refetches only after the debounce window elapses', async () => {
    const transport = new FakeTransport();
    const fetchRows = vi.fn().mockResolvedValue({ columns: [], rows: [{ id: 1 }] });

    renderHook(() => useLiveTable('users', true, { transport, fetchRows, debounceMs: 50 }));

    act(() => transport.lastHandlers.onOpen(false));

    act(() => transport.lastHandlers.onWake?.());
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

  it('a burst of 5 wake frames within the debounce window produces exactly one refetch', async () => {
    const transport = new FakeTransport();
    const fetchRows = vi.fn().mockResolvedValue({ columns: [], rows: [] });

    renderHook(() => useLiveTable('users', true, { transport, fetchRows, debounceMs: 50 }));
    act(() => transport.lastHandlers.onOpen(false));

    act(() => {
      for (let i = 0; i < 5; i++) transport.lastHandlers.onWake?.();
    });

    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });

    expect(fetchRows).toHaveBeenCalledTimes(1);
  });

  it('a wake arriving mid-flight produces exactly one follow-up refetch, never overlapping', async () => {
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

    act(() => transport.lastHandlers.onWake?.());
    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });
    expect(fetchRows).toHaveBeenCalledTimes(1);

    // Mid-flight: another frame arrives while the first refetch is pending.
    act(() => transport.lastHandlers.onWake?.());
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

    act(() => transport.lastHandlers.onWake?.());
    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });

    expect(fetchRows).toHaveBeenCalledWith('users');
    expect(result.current.status).toBe('live');
  });

  describe('SLV-1/SLV-2 — realtime unavailable (503)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('SLV-1: badge reads error, never a transient live, when the realtime route responds 503 — real SseTransport over a stubbed fetch', async () => {
      // No `deps.transport` here on purpose: the hook must build its own
      // real `SseTransport`, and the ONLY thing under test is whether that
      // real transport correctly turns a 503 into onError. An injected
      // FakeTransport that calls onError directly would assume the very
      // behaviour SLV-1 exists to verify.
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        body: null,
      } as Response);
      vi.stubGlobal('fetch', fetchMock);

      // Every status the hook ever reports, in order — not just the final
      // read. A badge that flashes 'live' before settling on 'error' has
      // still told the operator something false, and only recording the
      // last value would hide that.
      const statusHistory: (LiveStatus | null)[] = [];
      function useTracked() {
        const r = useLiveTable('users', true, {});
        statusHistory.push(r.status);
        return r;
      }

      const { result, unmount } = renderHook(() => useTracked());

      // Flush the microtask chain the real transport runs through:
      // fetch() -> !res.ok -> throw -> catch -> onError -> setStatus.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalled();
      expect(result.current.status).toBe('error');
      expect(statusHistory).not.toContain('live');

      // Tear the subscription down now, before any backoff-driven retry —
      // fake timers are active for this suite and are never advanced here,
      // so nothing would fire regardless, but unmounting explicitly aborts
      // the real transport rather than relying on that as an accident.
      unmount();
    });

    it('SLV-2: with status === error, fetchTableRows still resolves and updateTableRecords still lands rows', async () => {
      const transport = new FakeTransport();
      const fetchRows = vi.fn().mockResolvedValue({ columns: [], rows: [{ id: 1 }] });

      const { result } = renderHook(() =>
        useLiveTable('users', true, { transport, fetchRows, debounceMs: 50 }),
      );
      act(() => transport.lastHandlers.onOpen(false));
      act(() => transport.lastHandlers.onError(new Error('boom')));
      expect(result.current.status).toBe('error');

      act(() => transport.lastHandlers.onWake?.());
      await act(async () => {
        vi.advanceTimersByTime(50);
        await Promise.resolve();
      });

      expect(fetchRows).toHaveBeenCalledWith('users');
      const stored = useDataStore.getState().tables.find((t) => t.name.toLowerCase() === 'users');
      expect(stored?.records).toEqual([{ id: 1 }]);
      // The error status is scoped to the badge — it never gates data fetching.
      expect(result.current.status).toBe('error');
    });
  });

  describe('re-based onto RealtimeConnectionManager (studio-live-view, tasks 6.2/6.3)', () => {
    it('joining a table another consumer already holds open reports live immediately, with exactly one connection opened (T39/T40)', () => {
      const transport = new FakeTransport();
      const fetchRows = vi.fn().mockResolvedValue({ columns: [], rows: [] });

      // First consumer opens the channel and the transport reports live.
      const first = renderHook(() => useLiveTable('users', true, { transport, fetchRows }));
      act(() => transport.lastHandlers.onOpen(false));
      expect(first.result.current.status).toBe('live');

      // Second consumer subscribes to the SAME already-open channel (same
      // transport instance — the shared manager keys on transport identity).
      const second = renderHook(() => useLiveTable('users', true, { transport, fetchRows }));

      // No further connect() call — one shared connection, not a private
      // transport per hook instance — and the late joiner is told "live"
      // synchronously, without waiting for a reconnect event.
      expect(transport.connectCalls).toHaveLength(1);
      expect(second.result.current.status).toBe('live');
    });

    it('the RealtimeConnectionManager-bypass rationale and its private-transport code path are gone from source (T40)', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const filePath = path.resolve(process.cwd(), 'src/features/studio/browser/hooks/useLiveTable.ts');
      const src = fs.readFileSync(filePath, 'utf-8');

      // The bypass RATIONALE (why the manager was avoided) must be gone —
      // referencing RealtimeConnectionManager positively (it is now used)
      // is fine; the "it swallows the first onOpen" justification is not.
      expect(src).not.toMatch(/swallow/i);
      expect(src).not.toMatch(/ONE LAYER BELOW/);
      // The private-transport code path (an unconditional direct
      // `SseTransport` construction bypassing the shared binding) must be
      // gone too — the only allowed constructor call is through
      // `browserTransport()`.
      expect(src).not.toMatch(/new SseTransport\(/);
    });
  });
});
