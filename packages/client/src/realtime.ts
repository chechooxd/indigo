/**
 * @indigodb/client — Realtime transport + connection manager
 *
 * Client side of the `@indigodb/realtime` SSE protocol. Works in the browser
 * and Node ≥18: the SSE parser runs over `fetch()` streaming rather than the
 * `EventSource` global (absent in Node until v22), and everything from
 * `@indigodb/realtime` is imported type-only so `pg` never reaches a bundle.
 *
 * One SSE connection per subscribed table, shared (refcounted) between every
 * subscriber of that table. Reconnects with exponential backoff; after a
 * reconnect subscribers get a `resync` signal — events emitted while
 * disconnected are lost in v1 (LISTEN/NOTIFY has no replay), so callers
 * should re-query on resync.
 *
 * Re-exports below (`REALTIME_PATH`/`REALTIME_LOG_PATH`/`LIVE_DEBOUNCE_MS`/
 * `LiveStatus`) exist so `@indigodb/client/realtime` (this file's build
 * output, `dist/realtime.js`) is a self-contained browser-safe entry point
 * (`client-live-queries` spec, design.md decision 2). VALUE imports are
 * `protocol`-only — `@indigodb/realtime/protocol` transitively imports
 * nothing, unlike `@indigodb/realtime`'s root entry which pulls `pg` via
 * `engine.ts`/`wal-source.ts`. Never widen this to a bare
 * `@indigodb/realtime` value import.
 */

import type { RealtimeEvent } from "@indigodb/realtime";
export { REALTIME_PATH, REALTIME_LOG_PATH } from "@indigodb/realtime/protocol";
import { LIVE_DEBOUNCE_MS } from "./live.js";
export { LIVE_DEBOUNCE_MS } from "./live.js";
export type { LiveStatus } from "./live.js";

export type Unsubscribe = () => void;

export interface TransportHandlers {
  onEvent: (event: RealtimeEvent) => void;
  /**
   * Data-free wake-up frame, sent for EVERY table over SSE — the SSE
   * transport is unauthenticated and never carries row data, `@@allow` or
   * not (fail-closed decision, `realtime-live-endpoint` spec fix). Optional
   * — every pre-existing `TransportHandlers` consumer is unaffected; only
   * `.live()` (via `RealtimeConnectionManager`'s `ChannelListener`) actually
   * supplies it. `onEvent`/`change` frames no longer arrive over SSE at all
   * — `RealtimeModelDelegate.subscribe()`'s push handlers (`onInsert`/
   * `onUpdate`/`onDelete`) go dormant; only the authenticated
   * `GET ?handle&offset` log route still delivers row data.
   */
  onWake?: () => void;
  /** Fired on every successful (re)connect, with `true` after the first. */
  onOpen: (reconnected: boolean) => void;
  onError: (error: Error) => void;
  /**
   * Fired instead of a further reconnect attempt when the connect failure
   * is classified TERMINAL (design.md D6): a non-2xx HTTP response that is
   * not 5xx/408/429. `onError` still fires first with the same error — this
   * is an ADDITIONAL signal, not a replacement — so the retry loop can stop
   * cleanly without every existing caller having to opt in. Optional;
   * `.live()` and `.subscribe()` (`RealtimeConnectionManager`) supply none
   * today and simply observe the transport stop retrying a hopeless URL.
   */
  onTerminal?: (error: Error) => void;
}

/**
 * D6 classification: TRUE for the statuses whose retry loop keeps going
 * with backoff (5xx, 408 Request Timeout, 429 Too Many Requests). Every
 * other non-2xx (400, 401, 403, 404, 410, …) is TERMINAL — the loop stops.
 * A `fetch` rejection (`TypeError`: offline, DNS, and CORS — indistinguishable
 * in a browser) never reaches this function; it is caught below and always
 * stays transient, deliberately, since a cross-origin rejection would
 * otherwise strand a user who merely went through a tunnel.
 */
function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

/** Streaming transport seam — SSE today, anything delivering RealtimeEvents tomorrow. */
export interface RealtimeTransport {
  connect(tables: string[], handlers: TransportHandlers): () => void;
}

// ─── SSE over fetch ──────────────────────────────────────────────────────────

export class SseTransport implements RealtimeTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly path: string = "/api/realtime",
  ) {}

  connect(tables: string[], handlers: TransportHandlers): () => void {
    const controller = new AbortController();
    const url = new URL(this.path, this.baseUrl);
    if (tables.length > 0) url.searchParams.set("tables", tables.join(","));

    let stopped = false;
    let everConnected = false;
    let retryMs = 1_000;

    const run = async (): Promise<void> => {
      while (!stopped) {
        try {
          const res = await fetch(url, {
            signal: controller.signal,
            headers: { accept: "text/event-stream" },
          });
          if (!res.ok) {
            const httpError = new Error(`realtime subscribe failed: HTTP ${res.status}`);
            if (!isTransientHttpStatus(res.status)) {
              // Terminal (D6): stop the loop entirely, never schedule
              // another connect attempt. `onError` still fires so every
              // pre-existing caller keeps seeing the failure.
              handlers.onError(httpError);
              handlers.onTerminal?.(httpError);
              return;
            }
            throw httpError; // transient HTTP status — falls to the backoff retry below
          }
          if (!res.body) {
            throw new Error("realtime subscribe failed: empty response body");
          }
          retryMs = 1_000;
          handlers.onOpen(everConnected);
          everConnected = true;
          await this.readStream(res.body, handlers);
          // Server closed the stream; fall through to reconnect.
        } catch (err) {
          if (stopped || controller.signal.aborted) return;
          handlers.onError(err instanceof Error ? err : new Error(String(err)));
        }
        if (stopped) return;
        await sleep(retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      }
    };
    void run();

    return () => {
      stopped = true;
      controller.abort();
    };
  }

  private async readStream(
    body: ReadableStream<Uint8Array>,
    handlers: TransportHandlers,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      for (;;) {
        const split = buffer.indexOf("\n\n");
        if (split === -1) break;
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        this.handleFrame(frame, handlers);
      }
    }
  }

  private handleFrame(frame: string, handlers: TransportHandlers): void {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue; // heartbeat/comment
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (data.length === 0) return;

    if (event === "wake") {
      // Data-free wake-up frame (`realtime-live-endpoint` delta): the
      // frame's JSON body (`{table, op, lsn}`) is parsed only to validate
      // it, never inspected — `.live()` treats ANY wake as the same
      // "refetch" trigger (design decision 8), so no field is read out of
      // it here. A malformed JSON body is skipped, not thrown, same as a
      // malformed `change` frame below.
      try {
        JSON.parse(data.join("\n"));
      } catch {
        return;
      }
      handlers.onWake?.();
      return;
    }

    if (event !== "change") return; // unknown event name — silently dropped
    try {
      handlers.onEvent(JSON.parse(data.join("\n")) as RealtimeEvent);
    } catch {
      // Malformed frame — skip rather than kill the stream.
    }
  }
}

// ─── Connection manager ──────────────────────────────────────────────────────

interface TableChannel {
  close: () => void;
  listeners: Set<ChannelListener>;
  /** Mirrors the transport's own lifecycle — see `ChannelListener.onOpen`
   * and D1's replay contract below. Starts `"connecting"`: no `onOpen`/
   * `onError` has landed yet for this channel. */
  state: "connecting" | "live" | "error";
  /** True once this channel has observed at least one successful open —
   * kept alongside `state` for future diagnostics; `state` alone drives
   * today's replay decision. */
  everOpened: boolean;
  /** The most recent transport error, replayed (same instance) to a
   * listener that joins while the channel is in `"error"` state. */
  lastError: Error | null;
  /** D6 classification of `lastError`: `true` once the transport has
   * reported it TERMINAL (the retry loop stopped). Replayed alongside
   * `lastError` so a late joiner is not told a hopeless channel is merely
   * transiently down. Reset with `lastError`. */
  lastErrorTerminal: boolean;
}

export interface ChannelListener {
  onEvent: (event: RealtimeEvent) => void;
  /** Data-free wake-up trigger — see `TransportHandlers.onWake`'s doc
   * comment. Optional; `.subscribe()` never supplies it. */
  onWake?: () => void;
  /**
   * Fired on every successful (re)connect the listener observes, including
   * the FIRST one (design.md D1 — the earlier `if (!reconnected) return;`
   * swallowed the first open entirely). Also replayed synchronously,
   * INSIDE `subscribe()`, to a listener joining an already-`"live"`
   * channel — always with `reconnected: false` in that replay case, since
   * a late joiner has fetched nothing yet and has no gap to fill.
   * Optional; `.live()` supplies no `onOpen` and observes zero behavior
   * change from this addition.
   */
  onOpen?: (reconnected: boolean) => void;
  /** Unchanged trigger condition (design.md D1): fires only when the
   * transport reports a genuine reconnect (`reconnected === true`), never
   * on a late-subscriber replay. */
  onResync?: () => void;
  onError?: (error: Error) => void;
  /**
   * Fired after `onError` with the SAME error instance when the transport
   * classified the failure TERMINAL (design.md D6) — the retry loop has
   * stopped and no further connect attempt will be made. Also replayed,
   * right after the `onError` replay, to a listener joining a channel whose
   * last error was terminal. Optional; `.live()`/`.subscribe()` supply none.
   */
  onTerminal?: (error: Error) => void;
}

/**
 * Shares one transport connection per table across all of its subscribers,
 * opening lazily on first subscribe and closing when the last unsubscribes.
 */
export class RealtimeConnectionManager {
  private readonly channels = new Map<string, TableChannel>();

  constructor(private readonly transport: RealtimeTransport) {}

  /**
   * Builds the `TransportHandlers` that fan a single transport connection
   * out to every listener currently on `channel`. Shared by the initial
   * open (`subscribe()`) and a channel-level revival (`reviveChannel()`,
   * design.md D6) so both paths wire the exact same fan-out semantics.
   */
  private buildHandlers(channel: TableChannel): TransportHandlers {
    return {
      onEvent: (event) => {
        for (const l of channel.listeners) l.onEvent(event);
      },
      onWake: () => {
        for (const l of channel.listeners) l.onWake?.();
      },
      onOpen: (reconnected) => {
        channel.state = "live";
        channel.everOpened = true;
        channel.lastError = null;
        channel.lastErrorTerminal = false;
        // Snapshot the listener set — a listener added mid-callback by
        // one of these handlers must not be double-invoked.
        for (const l of [...channel.listeners]) {
          l.onOpen?.(reconnected);
          // Unchanged trigger condition (design.md D1): the earlier
          // `if (!reconnected) return;` becomes this inner guard so
          // `onResync`'s firing rule stays bit-for-bit what it was.
          if (reconnected) l.onResync?.();
        }
      },
      onError: (error) => {
        channel.state = "error";
        channel.lastError = error;
        // A fresh error is transient until the transport says otherwise;
        // `onTerminal` follows synchronously when it is not (design.md D6).
        channel.lastErrorTerminal = false;
        for (const l of [...channel.listeners]) l.onError?.(error);
      },
      onTerminal: (error) => {
        channel.lastErrorTerminal = true;
        for (const l of [...channel.listeners]) l.onTerminal?.(error);
      },
    };
  }

  subscribe(table: string, listener: ChannelListener): Unsubscribe {
    let channel = this.channels.get(table);
    if (!channel) {
      const newChannel: TableChannel = {
        close: () => {},
        listeners: new Set<ChannelListener>(),
        state: "connecting",
        everOpened: false,
        lastError: null,
        lastErrorTerminal: false,
      };
      newChannel.close = this.transport.connect([table], this.buildHandlers(newChannel));
      channel = newChannel;
      this.channels.set(table, channel);
    }

    const activeChannel = channel;
    activeChannel.listeners.add(listener);

    // Replay on subscribe (design.md D1): a snapshot of state/lastError
    // taken AFTER the listener is added but BEFORE any replay callback
    // runs, so a late joiner on an already-open or already-errored
    // channel is told so synchronously, before `subscribe()` returns.
    // Replay NEVER calls `onResync` — a late joiner has fetched nothing
    // yet, so its own bootstrap covers it; firing `onResync` would inject
    // a phantom refetch.
    const snapshotState = activeChannel.state;
    const snapshotError = activeChannel.lastError;
    const snapshotTerminal = activeChannel.lastErrorTerminal;
    if (snapshotState === "live") {
      listener.onOpen?.(false);
    } else if (snapshotState === "error" && snapshotError) {
      listener.onError?.(snapshotError);
      // Same order as the live path (onError, then onTerminal), so a late
      // joiner classifies a hopeless channel exactly as an early one did.
      if (snapshotTerminal) listener.onTerminal?.(snapshotError);
    }
    // snapshotState === "connecting" → nothing to replay.

    return () => {
      const ch = this.channels.get(table);
      if (!ch) return;
      ch.listeners.delete(listener);
      if (ch.listeners.size === 0) {
        ch.close();
        this.channels.delete(table);
      }
    };
  }

  /**
   * Channel-level revival (design.md D6): closes the table's current
   * transport connection, if any, and re-opens a fresh one, keeping every
   * existing listener attached — `createLiveSubscription.retry()` is
   * deliberately channel-level, reviving every listener sharing that
   * table's channel, not only the caller. No-op if no channel is open for
   * `table` (nothing to revive).
   */
  reviveChannel(table: string): void {
    const channel = this.channels.get(table);
    if (!channel) return;
    channel.close();
    channel.state = "connecting";
    channel.lastError = null;
    channel.lastErrorTerminal = false;
    channel.close = this.transport.connect([table], this.buildHandlers(channel));
  }

  /** Closes every open connection (used by `$disconnect`). */
  close(): void {
    for (const channel of this.channels.values()) channel.close();
    this.channels.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── createLiveSubscription ──────────────────────────────────────────────────

interface WakeDebouncer {
  wake(): void;
  cancel(): void;
}

/**
 * First-wake-armed fixed debounce window (design.md D3 — deliberately kept
 * separate from `live.ts`'s own ~8-line inline copy, see D2: layering this
 * primitive on `live.ts` would close an import cycle, since `realtime.ts`
 * already imports `LIVE_DEBOUNCE_MS` from `./live.js`). The FIRST wake
 * after idle arms a single trailing timer of `debounceMs`; a later wake
 * arriving before it fires does NOT reset or extend it — re-arming on every
 * wake is the exact starvation bug this guards against under sustained
 * writes. `debounceMs <= 0` disables the window entirely: every wake fires
 * `onFire` immediately, synchronously.
 */
export function createWakeDebouncer(debounceMs: number, onFire: () => void): WakeDebouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    wake(): void {
      if (debounceMs <= 0) {
        onFire();
        return;
      }
      if (timer !== null) return; // already armed for this burst — never re-armed
      timer = setTimeout(() => {
        timer = null;
        onFire();
      }, debounceMs);
      timer.unref?.();
    },
    cancel(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** Five-state machine (design.md D4): `"idle"` until the first `subscribe()`
 * — constructing `createLiveSubscription()` MUST NOT open a channel, start a
 * timer, or otherwise leave `"idle"` on its own. */
export type LiveSubscriptionStatus = "idle" | "connecting" | "live" | "error" | "closed";

/**
 * The triggering transport error, flattened for a snapshot reader
 * (design.md D4/D6). `terminal` is D6's classification: `true` once the
 * transport has stopped retrying, so a UI knows to offer `retry()` rather
 * than wait. `cause` is the original `Error`.
 */
export interface LiveSubscriptionError {
  message: string;
  terminal: boolean;
  cause?: unknown;
}

export interface LiveSubscriptionOptions {
  table: string;
  /** Explicit — no origin-inferring default (design.md D5). Use
   * `browserTransport()` in client code, or `new SseTransport(origin)`
   * directly. */
  transport: RealtimeTransport;
  /** The app's own invalidation callback; NEVER receives rows — the
   * primitive holds no data (realtime-live-subscription spec). */
  onWake?: () => void;
  /** Fired when the transport RE-opens a channel that had already been open —
   * the connection dropped and came back, so events were missed while it was
   * down. Deliberately distinct from `onWake`: a wake says "something changed,
   * refetch soon" and is debounced; a resync says "you cannot know what you
   * missed, refetch now" and is not. The manager already carries this bit
   * (`ChannelListener.onOpen(reconnected)`); the primitive used to discard it,
   * and since `setStatus` skips notifying on an unchanged status, a reconnect
   * returning to `"live"` was invisible to every consumer. NEVER receives rows. */
  onResync?: () => void;
  /** Default `LIVE_DEBOUNCE_MS` (50). `<= 0` disables debouncing
   * (design.md D3). */
  debounceMs?: number;
  /** Default: one `RealtimeConnectionManager` per `transport`, module-cached
   * (`WeakMap`) so sibling subscriptions on the same transport share one
   * channel per table without the caller having to wire that up. */
  manager?: RealtimeConnectionManager;
}

/**
 * Framework-agnostic, browser-safe, SSR-inert status-only subscription
 * (`realtime-live-subscription` spec). Returns EXACTLY these five members —
 * never row data, never a `RealtimeEvent` payload: composing with an app's
 * own data library happens entirely through the caller-supplied `onWake`.
 */
export interface LiveSubscription {
  /** Pure, allocation-free, safe to call before `subscribe()`. */
  getStatus(): LiveSubscriptionStatus;
  /**
   * The current error, or `null` when there is none. The SECOND
   * `useSyncExternalStore` source of the React binding (design.md D4), so
   * the returned identity is STABLE while the underlying error is
   * unchanged — a fresh object per call would tear. Cleared to `null` on
   * the next successful open and by `retry()`.
   */
  getError(): LiveSubscriptionError | null;
  /** First call starts the underlying channel (design.md D4 — lazy start);
   * last unsubscribe stops it. Invoked once per STATUS TRANSITION, never for
   * a repeated identical status. */
  subscribe(onChange: () => void): Unsubscribe;
  /** No-op unless `getStatus() === "error"`. Channel-level (D6): revives
   * every listener sharing this table's channel, not only the caller. */
  retry(): void;
  /** Idempotent. After `close()`, no further `onWake` or `subscribe`
   * callback delivery occurs, even for a wake already in flight. */
  close(): void;
}

const sharedManagers = new WeakMap<RealtimeTransport, RealtimeConnectionManager>();

function getSharedManager(transport: RealtimeTransport): RealtimeConnectionManager {
  let manager = sharedManagers.get(transport);
  if (!manager) {
    manager = new RealtimeConnectionManager(transport);
    sharedManagers.set(transport, manager);
  }
  return manager;
}

export function createLiveSubscription(options: LiveSubscriptionOptions): LiveSubscription {
  const debounceMs = options.debounceMs ?? LIVE_DEBOUNCE_MS;
  const manager = options.manager ?? getSharedManager(options.transport);
  const table = options.table;

  let status: LiveSubscriptionStatus = "idle";
  let unsubscribeChannel: Unsubscribe | null = null;
  // Raw error + its D6 class, kept apart from the flattened snapshot below
  // so `getError()` can hand back ONE stable identity for as long as
  // neither changes (design.md D4: `useSyncExternalStore` tears on a fresh
  // object per call). The snapshot is (re)built lazily, on read — never
  // eagerly — so the terminal upgrade that lands synchronously right after
  // `onError` is already folded in by the time any reader pulls it.
  let rawError: Error | null = null;
  let rawErrorTerminal = false;
  let errorSnapshot: LiveSubscriptionError | null = null;
  const changeListeners = new Set<() => void>();

  const notify = (): void => {
    // Snapshot — a listener added/removed mid-callback must not be
    // double-invoked or skipped.
    for (const cb of [...changeListeners]) cb();
  };

  const readError = (): LiveSubscriptionError | null => {
    if (rawError === null) return null;
    if (errorSnapshot === null || errorSnapshot.cause !== rawError || errorSnapshot.terminal !== rawErrorTerminal) {
      errorSnapshot = { message: rawError.message, terminal: rawErrorTerminal, cause: rawError };
    }
    return errorSnapshot;
  };

  const clearError = (): void => {
    rawError = null;
    rawErrorTerminal = false;
    errorSnapshot = null;
  };

  const setStatus = (next: LiveSubscriptionStatus): void => {
    if (status === next) return; // no callback for a repeated identical status
    status = next;
    notify();
  };

  const debouncer = createWakeDebouncer(debounceMs, () => {
    // A wake already in flight at close() time must never reach onWake.
    if (status === "closed") return;
    options.onWake?.();
  });

  const channelListener: ChannelListener = {
    onEvent: () => {},
    onWake: () => debouncer.wake(),
    onOpen: (reconnected) => {
      clearError(); // cleared on the next successful open (design.md D6)
      setStatus("live");
      // Reported even when `setStatus` was a no-op because the status was
      // already `"live"` — that no-op is precisely why a reconnect cannot be
      // inferred from the status snapshot alone.
      if (reconnected) options.onResync?.();
    },
    onError: (error) => {
      rawError = error;
      // Transient until the transport's `onTerminal` says otherwise; that
      // call follows this one synchronously, before any snapshot is read.
      rawErrorTerminal = false;
      setStatus("error");
    },
    onTerminal: () => {
      // D6: the transport stopped retrying. Upgrade the already-recorded
      // error in place; no status change, so no notify — the snapshot is
      // built lazily on read, so any reader pulls the upgraded value.
      rawErrorTerminal = true;
    },
  };

  const releaseChannel = (): void => {
    unsubscribeChannel?.();
    unsubscribeChannel = null;
  };

  return {
    getStatus: () => status,

    getError: () => readError(),

    subscribe(onChange) {
      changeListeners.add(onChange);
      if (status === "idle") {
        // Lazy start (design.md D4): the first subscribe() — ever, or after
        // every prior one unsubscribed — opens the channel. `"connecting"`
        // is set before `manager.subscribe()` so both a fresh open and a
        // synchronous replay of an already-live channel are preceded by it.
        setStatus("connecting");
        unsubscribeChannel = manager.subscribe(table, channelListener);
      }
      return () => {
        changeListeners.delete(onChange);
        if (changeListeners.size === 0 && status !== "closed") {
          debouncer.cancel();
          releaseChannel();
          status = "idle";
        }
      };
    },

    retry() {
      if (status !== "error") return; // no-op outside error (design.md D6)
      clearError(); // retry() clears lastError (design.md D6)
      setStatus("connecting");
      manager.reviveChannel(table);
    },

    close() {
      if (status === "closed") return; // idempotent
      debouncer.cancel();
      releaseChannel();
      changeListeners.clear();
      status = "closed";
    },
  };
}

/**
 * Convenience `RealtimeTransport` factory for the browser (design.md D5):
 * reads `window.location.origin` so callers don't have to. Deliberately
 * never called at module scope — `createLiveSubscription` takes an
 * EXPLICIT `transport`, with no origin-inferring default; unlike the
 * Studio hook's pre-existing unguarded `new SseTransport(window.location.origin, …)`,
 * this helper is opt-in and throws a NAMED error server-side instead of a
 * bare `window is not defined` `ReferenceError`.
 */
export function browserTransport(path?: string): RealtimeTransport {
  const win = (globalThis as { window?: { location: { origin: string } } }).window;
  if (win === undefined) {
    throw new Error(
      "browserTransport() can only be called in a browser environment (`window` is undefined). " +
        "Pass an explicit RealtimeTransport, e.g. `new SseTransport(origin, path)`, for SSR/Node.",
    );
  }
  return new SseTransport(win.location.origin, path);
}
