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
          if (!res.ok || !res.body) {
            throw new Error(`realtime subscribe failed: HTTP ${res.status}`);
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
}

/**
 * Shares one transport connection per table across all of its subscribers,
 * opening lazily on first subscribe and closing when the last unsubscribes.
 */
export class RealtimeConnectionManager {
  private readonly channels = new Map<string, TableChannel>();

  constructor(private readonly transport: RealtimeTransport) {}

  subscribe(table: string, listener: ChannelListener): Unsubscribe {
    let channel = this.channels.get(table);
    if (!channel) {
      const listeners = new Set<ChannelListener>();
      const newChannel: TableChannel = {
        close: () => {},
        listeners,
        state: "connecting",
        everOpened: false,
        lastError: null,
      };
      newChannel.close = this.transport.connect([table], {
        onEvent: (event) => {
          for (const l of listeners) l.onEvent(event);
        },
        onWake: () => {
          for (const l of listeners) l.onWake?.();
        },
        onOpen: (reconnected) => {
          newChannel.state = "live";
          newChannel.everOpened = true;
          newChannel.lastError = null;
          // Snapshot the listener set — a listener added mid-callback by
          // one of these handlers must not be double-invoked.
          for (const l of [...listeners]) {
            l.onOpen?.(reconnected);
            // Unchanged trigger condition (design.md D1): the earlier
            // `if (!reconnected) return;` becomes this inner guard so
            // `onResync`'s firing rule stays bit-for-bit what it was.
            if (reconnected) l.onResync?.();
          }
        },
        onError: (error) => {
          newChannel.state = "error";
          newChannel.lastError = error;
          for (const l of [...listeners]) l.onError?.(error);
        },
      });
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
    if (snapshotState === "live") {
      listener.onOpen?.(false);
    } else if (snapshotState === "error" && snapshotError) {
      listener.onError?.(snapshotError);
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

  /** Closes every open connection (used by `$disconnect`). */
  close(): void {
    for (const channel of this.channels.values()) channel.close();
    this.channels.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
