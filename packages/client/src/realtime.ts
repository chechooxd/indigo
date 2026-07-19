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
 */

import type { RealtimeEvent } from "@indigodb/realtime";

export type Unsubscribe = () => void;

export interface TransportHandlers {
  onEvent: (event: RealtimeEvent) => void;
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
    if (event !== "change" || data.length === 0) return;
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
}

interface ChannelListener {
  onEvent: (event: RealtimeEvent) => void;
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
      const close = this.transport.connect([table], {
        onEvent: (event) => {
          for (const l of listeners) l.onEvent(event);
        },
        onOpen: (reconnected) => {
          if (!reconnected) return;
          for (const l of listeners) l.onResync?.();
        },
        onError: (error) => {
          for (const l of listeners) l.onError?.(error);
        },
      });
      channel = { close, listeners };
      this.channels.set(table, channel);
    }

    channel.listeners.add(listener);
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
