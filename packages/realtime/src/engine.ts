/**
 * @indigodb/realtime — Engine
 *
 * Embeddable fan-out hub: consumes a `RealtimeSource` (v1: LISTEN/NOTIFY) and
 * distributes change events to in-process listeners (`on("change")`) and SSE
 * subscribers (`handleRequest`/`attach`). Consumed by the `indigodb realtime`
 * command, embedded in the studio server, and attachable to any user-owned
 * `node:http` server — no framework, no dependencies beyond `pg`.
 *
 * SSE contract (see protocol.ts): `GET <path>?tables=User,Post` (no param =
 * every realtime table). Frames: `event: ready` once on subscribe, then
 * `event: change` with a `RealtimeEvent` per row change (`id:` = per-connection
 * seq), with `:ping` heartbeats in between.
 */

import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { ResolvedSchema } from "@indigodb/core";
import type { RealtimeEvent, RealtimeReady } from "./protocol.js";
import { REALTIME_PATH, type RealtimeSource } from "./protocol.js";
import { PgNotifySource } from "./source.js";

export interface RealtimeEngineOptions {
  connectionString: string;
  schema: ResolvedSchema;
  /** Event source override — defaults to `PgNotifySource`; v2: a WAL source. */
  source?: RealtimeSource;
  /** SSE heartbeat interval. Default 25s (under common 30s proxy idle cuts). */
  heartbeatMs?: number;
  /** Called with source errors (connection loss etc.). Default: console.error. */
  onError?: (error: Error) => void;
}

interface Subscriber {
  res: ServerResponse;
  /** null = all realtime tables. */
  tables: Set<string> | null;
  seq: number;
}

export class RealtimeEngine {
  private readonly source: RealtimeSource;
  private readonly heartbeatMs: number;
  private readonly onError: (error: Error) => void;
  private readonly realtimeModels: Set<string>;
  private readonly subscribers = new Set<Subscriber>();
  private readonly listeners = new Set<(event: RealtimeEvent) => void>();
  private heartbeat: NodeJS.Timeout | null = null;
  private started = false;

  constructor(options: RealtimeEngineOptions) {
    this.source =
      options.source ??
      new PgNotifySource(options.connectionString, options.schema);
    this.heartbeatMs = options.heartbeatMs ?? 25_000;
    this.onError = options.onError ?? ((err) => console.error("[indigodb realtime]", err.message));
    this.realtimeModels = new Set(
      options.schema.tables.filter((t) => t.realtime).map((t) => t.name),
    );
  }

  /** Model names served by this engine. */
  get models(): string[] {
    return [...this.realtimeModels];
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.source.start((event) => this.dispatch(event), this.onError);
    this.heartbeat = setInterval(() => {
      for (const sub of this.subscribers) sub.res.write(":ping\n\n");
    }, this.heartbeatMs);
    // A daemon with subscribers shouldn't be kept alive by the heartbeat alone.
    this.heartbeat.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const sub of this.subscribers) sub.res.end();
    this.subscribers.clear();
    await this.source.stop();
  }

  /** In-process listener over every change event. Returns an unsubscribe. */
  on(event: "change", listener: (e: RealtimeEvent) => void): () => void {
    void event;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Serves one SSE subscription request. Routes are the caller's job — pair
   * with `attach()` for bare servers or call directly from a router.
   */
  handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const tablesParam = url.searchParams.get("tables");
    let tables: Set<string> | null = null;

    if (tablesParam) {
      const requested = tablesParam.split(",").map((t) => t.trim()).filter(Boolean);
      const unknown = requested.filter((t) => !this.realtimeModels.has(t));
      if (unknown.length > 0) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `Not a realtime table: ${unknown.join(", ")}` }));
        return;
      }
      tables = new Set(requested);
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
      "x-accel-buffering": "no",
    });

    const sub: Subscriber = { res, tables, seq: 0 };
    this.subscribers.add(sub);
    const ready: RealtimeReady = { tables: tables ? [...tables] : this.models };
    res.write(`event: ready\ndata: ${JSON.stringify(ready)}\n\n`);

    req.on("close", () => {
      this.subscribers.delete(sub);
    });
  }

  /**
   * Mounts `handleRequest` on a bare `node:http` server at `path`. Requests
   * outside `path` are left to the server's other listeners.
   */
  attach(server: Server, path: string = REALTIME_PATH): void {
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === path) this.handleRequest(req, res);
    });
  }

  private dispatch(event: RealtimeEvent): void {
    for (const listener of this.listeners) listener(event);
    for (const sub of this.subscribers) {
      if (sub.tables && !sub.tables.has(event.table)) continue;
      sub.seq += 1;
      const payload: RealtimeEvent = { ...event, seq: sub.seq };
      sub.res.write(`id: ${sub.seq}\nevent: change\ndata: ${JSON.stringify(payload)}\n\n`);
    }
  }
}
