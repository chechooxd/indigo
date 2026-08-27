/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Subscribes the active table to the embedded, unauthenticated realtime SSE
 * stream and triggers a debounced, coalesced refetch on every `change`/`wake`
 * frame (`studio-live-view` spec, design.md `studio-live-view`).
 *
 * Studio has no generated `IndigoClient`, so `.live()` is unreachable by
 * construction (Node-only `pg`/`node:async_hooks`; emitted only for
 * `@@realtime` + `@@allow`; requires an app-supplied `getHandle`). This hook
 * therefore connects ONE LAYER BELOW `.live()`: it imports the same
 * browser-safe `SseTransport` that `.live()` rides on directly (NOT
 * `RealtimeConnectionManager` — its refcounting swallows the first `onOpen`,
 * which is exactly the `connecting -> live` edge this hook needs), and
 * re-implements only `createLiveQuery`'s debounce/coalesce/status core
 * (`packages/client/src/live.ts`), reusing its exported `LIVE_DEBOUNCE_MS`
 * and `LiveStatus` vocabulary. Structure mirrored, code not shared —
 * `createLiveQuery`'s `requireHandle`/`getHandle`/`runScoped` deps are
 * mandatory there and meaningless here (no auth boundary at this layer).
 *
 * `error` is TRANSIENT and auto-recovering, never terminal (design decision
 * 6): `SseTransport`'s own backoff (1s -> 30s) keeps retrying underneath;
 * `onOpen(reconnected)` returns to `live` and fires one immediate refetch
 * bypassing the debounce. There is no manual retry control.
 */

import { useEffect, useRef, useState } from 'react';
import {
  SseTransport,
  LIVE_DEBOUNCE_MS,
  REALTIME_PATH,
  type RealtimeTransport,
} from '@indigodb/client/realtime';
import type { LiveStatus } from '@indigodb/client/realtime';

import { fetchTableRows, type QueryResult } from '../../../../lib/api';
import { useDataStore } from '../../../../store/useDataStore';

export interface UseLiveTableDeps {
  /** Test seam — default is a `SseTransport` against the current origin. */
  transport?: RealtimeTransport;
  /** Test seam — default is `fetchTableRows` from `lib/api`. */
  fetchRows?: (name: string) => Promise<QueryResult | null>;
  /** Test seam — default is `LIVE_DEBOUNCE_MS` (50ms). */
  debounceMs?: number;
}

export interface UseLiveTableResult {
  /** `null` when inert: no subscription, no indicator (studio-ui-honesty is
   * encoded here in the type, not in a JSX `disabled` conditional). */
  status: LiveStatus | null;
}

/**
 * `null` status ⇒ inert: no subscription, no indicator.
 *
 * One `useEffect` keyed on `[tableName, enabled]`. `destroyed`/`inFlight`/
 * `dirty`/`timer` are closure locals (not React state) so no frame causes a
 * re-render — only `status` is state. `fetchRows` and `updateTableRecords`
 * are read through refs so the effect never re-subscribes when the caller
 * passes a fresh closure on every render.
 */
export function useLiveTable(
  tableName: string | undefined,
  enabled: boolean,
  deps?: UseLiveTableDeps,
): UseLiveTableResult {
  const [status, setStatus] = useState<LiveStatus | null>(null);

  const updateTableRecords = useDataStore((s) => s.updateTableRecords);
  const updateTableRecordsRef = useRef(updateTableRecords);
  updateTableRecordsRef.current = updateTableRecords;

  const fetchRowsFn = deps?.fetchRows ?? fetchTableRows;
  const fetchRowsRef = useRef(fetchRowsFn);
  fetchRowsRef.current = fetchRowsFn;

  const transportRef = useRef(deps?.transport);
  transportRef.current = deps?.transport;

  const debounceMs = deps?.debounceMs ?? LIVE_DEBOUNCE_MS;

  useEffect(() => {
    if (!enabled || !tableName) {
      setStatus(null);
      return;
    }

    const table = tableName;
    const transport: RealtimeTransport =
      transportRef.current ?? new SseTransport(window.location.origin, REALTIME_PATH);

    let destroyed = false;
    let inFlight = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    setStatus('connecting');

    const refetch = async (): Promise<void> => {
      if (destroyed) return;
      if (inFlight) {
        // Coalescing: a frame arriving mid-flight never starts a second
        // concurrent refetch — mark dirty for exactly one follow-up, run
        // from this same refetch's `finally` below.
        dirty = true;
        return;
      }
      inFlight = true;
      try {
        const result = await fetchRowsRef.current(table);
        if (destroyed) return;
        // `null` (decision 7): keep prior rows, no error, no teardown —
        // `api.ts` fails soft by contract; a data-fetch failure is not a
        // subscription-lifecycle failure.
        if (result) updateTableRecordsRef.current(table, result.rows);
      } finally {
        inFlight = false;
        if (dirty && !destroyed) {
          dirty = false;
          void refetch();
        }
      }
    };

    const scheduleRefetch = (): void => {
      if (destroyed) return;
      // First-frame-armed fixed window (design decision 5): a timer already
      // pending is never reset/re-armed by a later frame in the same burst.
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void refetch();
      }, debounceMs);
    };

    const unsubscribe = transport.connect([table], {
      onEvent: () => scheduleRefetch(),
      onWake: () => scheduleRefetch(),
      onOpen: (reconnected) => {
        if (destroyed) return;
        setStatus('live');
        if (reconnected) {
          // Bypass the debounce entirely — a reconnected subscriber must
          // not stay silently stale (design decision 6).
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          void refetch();
        }
      },
      onError: () => {
        if (destroyed) return;
        setStatus('error');
      },
    });

    return () => {
      destroyed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      unsubscribe();
    };
  }, [tableName, enabled, debounceMs]);

  return { status };
}
