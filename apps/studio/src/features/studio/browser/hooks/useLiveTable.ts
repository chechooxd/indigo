/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Subscribes the active table to the shared realtime connection and
 * triggers a debounced, coalesced refetch on every wake frame
 * (`studio-live-view` spec, design.md `studio-live-view`).
 *
 * Studio has no generated `IndigoClient`, so `.live()` is unreachable by
 * construction (Node-only `pg`/`node:async_hooks`; emitted only for
 * `@@realtime` + `@@allow`; requires an app-supplied `getHandle`). This hook
 * rides the SAME published binding every other consumer uses:
 * `@indigodb/react`'s `useLiveTable` hands back `{status, error, retry}` off
 * a subscription shared per table through `RealtimeConnectionManager`, so a
 * second consumer subscribing to a table another consumer already holds
 * open reports `live` immediately, without opening a second connection or
 * waiting for a reconnect event.
 *
 * The binding is status-only — it never fetches, caches, or exposes rows.
 * This hook layers Studio's own debounced, coalesced `fetchTableRows` call
 * on top, wired through the binding's `onWake` callback (the debounce
 * window itself now lives in the shared primitive, `LIVE_DEBOUNCE_MS`
 * (`@indigodb/client/realtime`); this hook keeps only the in-flight/dirty
 * refetch coalescing, since an in-flight fetch duration is a Studio-side
 * concern the generic primitive has no opinion on).
 *
 * `error` is TRANSIENT and auto-recovering, never terminal in ordinary
 * operation (design decision 6): the underlying transport's own backoff
 * (1s -> 30s) keeps retrying underneath and returns to `live` on its own.
 */

import { useMemo, useRef } from 'react';
import { useLiveTable as useLiveTableBinding } from '@indigodb/react';
import {
  browserTransport,
  REALTIME_PATH,
  type RealtimeTransport,
  type LiveStatus,
} from '@indigodb/client/realtime';

import { fetchTableRows, type QueryResult } from '../../../../lib/api';
import { useDataStore } from '../../../../store/useDataStore';

export interface UseLiveTableDeps {
  /** Test seam — default is a `SseTransport` against the current origin. */
  transport?: RealtimeTransport;
  /** Test seam — default is `fetchTableRows` from `lib/api`. */
  fetchRows?: (name: string) => Promise<QueryResult | null>;
  /** Test seam — default is `LIVE_DEBOUNCE_MS` (50ms), forwarded to the binding. */
  debounceMs?: number;
}

export interface UseLiveTableResult {
  /** `null` when inert: no subscription, no indicator (studio-ui-honesty is
   * encoded here in the type, not in a JSX `disabled` conditional). */
  status: LiveStatus | null;
}

/** Never called — only used to satisfy the binding's required `transport`
 * prop while the subscription is inert (`enabled: false`). */
const INERT_TRANSPORT: RealtimeTransport = {
  connect: () => () => {},
};

/**
 * `null` status ⇒ inert: no subscription, no indicator.
 *
 * `fetchRows` and `updateTableRecords` are read through refs so a fresh
 * closure on every render never re-subscribes the underlying binding.
 */
export function useLiveTable(
  tableName: string | undefined,
  enabled: boolean,
  deps?: UseLiveTableDeps,
): UseLiveTableResult {
  const updateTableRecords = useDataStore((s) => s.updateTableRecords);
  const updateTableRecordsRef = useRef(updateTableRecords);
  updateTableRecordsRef.current = updateTableRecords;

  const fetchRowsFn = deps?.fetchRows ?? fetchTableRows;
  const fetchRowsRef = useRef(fetchRowsFn);
  fetchRowsRef.current = fetchRowsFn;

  const active = enabled && !!tableName;

  const tableRef = useRef(tableName);
  tableRef.current = tableName;

  // Test seam (`deps.transport`) or a lazily-built browser transport —
  // never constructed while inert, mirroring the binding's own inertness
  // rule (design.md D5).
  const transport = useMemo<RealtimeTransport>(() => {
    if (deps?.transport) return deps.transport;
    if (!active) return INERT_TRANSPORT;
    return browserTransport(REALTIME_PATH);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps?.transport, active]);

  // Coalescing refetch state: a frame arriving mid-flight never starts a
  // second concurrent refetch — mark dirty for exactly one follow-up, run
  // from this same refetch's `finally` below. Closure locals, not React
  // state, so no frame causes an extra re-render — only `status`/`error`
  // from the binding do.
  const inFlightRef = useRef(false);
  const dirtyRef = useRef(false);

  const refetchRef = useRef<() => Promise<void>>(async () => {});
  refetchRef.current = async () => {
    const table = tableRef.current;
    if (!table) return;
    if (inFlightRef.current) {
      dirtyRef.current = true;
      return;
    }
    inFlightRef.current = true;
    try {
      const result = await fetchRowsRef.current(table);
      // `null` (decision 7): keep prior rows, no error, no teardown —
      // `api.ts` fails soft by contract; a data-fetch failure is not a
      // subscription-lifecycle failure.
      if (result) updateTableRecordsRef.current(table, result.rows);
    } finally {
      inFlightRef.current = false;
      if (dirtyRef.current) {
        dirtyRef.current = false;
        void refetchRef.current();
      }
    }
  };

  const onWakeRef = useRef(() => {
    void refetchRef.current();
  });

  // A reconnect means events were missed while the connection was down, so
  // the debounce window is deliberately skipped: a wake says "refetch soon",
  // a resync says "you cannot know what you missed, refetch now".
  const onResyncRef = useRef(() => {
    void refetchRef.current();
  });

  const binding = useLiveTableBinding(active ? tableName : null, {
    transport,
    onWake: () => onWakeRef.current(),
    onResync: () => onResyncRef.current(),
    debounceMs: deps?.debounceMs,
    enabled: active,
  });

  const status: LiveStatus | null =
    binding.status === 'connecting' || binding.status === 'live' || binding.status === 'error'
      ? binding.status
      : null;

  return { status };
}
