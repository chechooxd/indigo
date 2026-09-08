/**
 * `useLiveTable` — the `@indigodb/react` binding (design.md D4/D5, tasks.md
 * Phase 5b). A thin `useSyncExternalStore` adapter over
 * `createLiveSubscription()` (`@indigodb/client/realtime`). Owns no rows, no
 * cache, and no fetcher: it exists solely to make `useSyncExternalStore`'s
 * subscribe-identity and snapshot-stability rules hard to get wrong.
 *
 * Two separate `useSyncExternalStore` calls, not one (D4): one returns the
 * primitive's plain STRING status, the other its stable `Error | null`
 * identity. A `getSnapshot` that built a fresh object per call would tear or
 * infinite-loop — `getError()` was built on the primitive side to hand back
 * one stable identity for exactly this reason. Do not wrap either snapshot
 * getter in anything that re-creates an object per read.
 *
 * The primitive is inert until `subscribe()` is actually called — nothing
 * opens a channel or starts a timer during render, in `useMemo`, or at
 * module scope. That is what makes React's own subscribe callback BE the
 * connection lifecycle, and why StrictMode's discarded `useMemo` result
 * leaks nothing (there is nothing open to leak).
 */
import { useCallback, useMemo, useRef } from "react";
import { useSyncExternalStore } from "react";
import {
  createLiveSubscription,
  type LiveSubscription,
  type LiveSubscriptionError,
  type LiveSubscriptionStatus,
  type RealtimeTransport,
} from "@indigodb/client/realtime";

export interface UseLiveTableOptions {
  /** Explicit — no origin-inferring default (design.md D5). Use
   * `browserTransport()` client-side, or pass a Node transport for SSR
   * bootstrapping (never called during the server render itself). */
  transport: RealtimeTransport;
  /** The app's own invalidation callback; NEVER receives rows. */
  onWake?: () => void;
  /** Default `LIVE_DEBOUNCE_MS` (50). `<= 0` disables debouncing. */
  debounceMs?: number;
  /** `false` never constructs the underlying subscription (design.md D4). */
  enabled?: boolean;
}

export interface UseLiveTableResult {
  status: LiveSubscriptionStatus;
  error: LiveSubscriptionError | null;
  retry: () => void;
}

const noop = (): void => {};
function getServerStatus(): LiveSubscriptionStatus {
  return "idle";
}
function getServerError(): LiveSubscriptionError | null {
  return null;
}
function getIdleStatus(): LiveSubscriptionStatus {
  return "idle";
}
function getNullError(): LiveSubscriptionError | null {
  return null;
}

/**
 * `useLiveTable(table, options)` → `{status, error, retry}`. Notifies the
 * app that a table changed; it never fetches, caches, or exposes rows.
 */
export function useLiveTable(table: string | null | undefined, options: UseLiveTableOptions): UseLiveTableResult {
  const { transport, debounceMs, enabled = true } = options;

  // `onWake` goes through a latest-ref so a fresh inline closure per render
  // never invalidates the `useMemo` below or re-subscribes (design.md D4).
  const onWakeRef = useRef(options.onWake);
  onWakeRef.current = options.onWake;

  const active = enabled && table != null;

  const sub = useMemo<LiveSubscription | null>(() => {
    if (!active || table == null) return null;
    return createLiveSubscription({
      table,
      transport,
      debounceMs,
      onWake: () => onWakeRef.current?.(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, table, transport, debounceMs]);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!sub) return noop;
      return sub.subscribe(onChange);
    },
    [sub],
  );

  const getStatus = sub ? sub.getStatus : getIdleStatus;
  const getError = sub ? sub.getError : getNullError;

  const status = useSyncExternalStore(subscribe, getStatus, getServerStatus);
  const error = useSyncExternalStore(subscribe, getError, getServerError);

  const retry = useCallback(() => {
    sub?.retry();
  }, [sub]);

  return { status, error, retry };
}
