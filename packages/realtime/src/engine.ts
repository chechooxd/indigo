/**
 * @indigodb/realtime — Engine
 *
 * Embeddable fan-out hub: consumes a `RealtimeSource` (default: `WalSource`,
 * v2 logical replication; `PgNotifySource`, v1 LISTEN/NOTIFY, remains
 * constructible via `options.source`) and distributes change events to
 * in-process listeners (`on("change")`) and SSE subscribers
 * (`handleRequest`/`attach`). Consumed by the `indigodb realtime` command,
 * embedded in the studio server, and attachable to any user-owned
 * `node:http` server — no framework, no dependencies beyond `pg`.
 *
 * SSE contract (see protocol.ts): `GET <path>?tables=User,Post` (no param =
 * every realtime table). Frames: `event: ready` once on subscribe, then
 * `event: wake` with a data-free `RealtimeWakeEvent` per row change (`id:` =
 * per-connection seq), with `:ping` heartbeats in between. The SSE route is
 * unauthenticated, so it NEVER carries row data (`new`/`old`) for any
 * table, `@@allow` or not — a wake frame only tells a subscriber to refetch.
 * Row data is only ever served over the authenticated `GET ?handle&offset`
 * log route (`handleLogRequest`); in-process listeners (`on("change")`)
 * still receive the full `RealtimeEvent`, since they are not on the wire.
 */

import type { IncomingMessage, ServerResponse, Server } from "node:http";
import pg from "pg";
import type { ResolvedSchema } from "@indigodb/core";
import type {
  RealtimeEvent,
  RealtimeReady,
  RealtimeLogPage,
  RealtimeOp,
  RealtimeWakeEvent,
  PresenceMember,
  PresenceEvent,
  ChannelReady,
  BroadcastMessage,
  RealtimeMetrics,
  RealtimeTelemetryEvent,
} from "./protocol.js";
import {
  REALTIME_PATH,
  REALTIME_LOG_PATH,
  REALTIME_CHANNELS_PATH,
  REALTIME_BROADCAST_PATH,
  REALTIME_PRESENCE_PATH,
  REALTIME_METRICS_PATH,
  REALTIME_LOG_PAGE_SIZE,
  DEFAULT_PRESENCE_TTL_MS,
  MAX_CHANNEL_BODY_BYTES,
  type RealtimeSource,
} from "./protocol.js";
import { WalSource } from "./wal-source.js";
import { verifyHandle } from "./handle.js";

export interface RealtimeEngineOptions {
  connectionString: string;
  schema: ResolvedSchema;
  /**
   * Exact origins (`scheme://host[:port]`) permitted to read the SSE
   * (`handleRequest`) and log replay (`handleLogRequest`) routes.
   * Omitted or empty ⇒ CLOSED: no cross-origin browser access at all — this
   * is the default (D7). A request with NO `Origin` header at all is
   * ALWAYS allowed regardless of this setting: this is what keeps the
   * `indigodb realtime` CLI daemon, curl, an operator proxy, and the
   * Studio's own same-origin embedded engine working unchanged. Matching is
   * exact string equality on the lowercase-normalized origin — never a
   * prefix, suffix, or substring test.
   */
  allowedOrigins?: string[];
  /** Event source override — defaults to `WalSource`. `PgNotifySource` (v1) remains constructible. */
  source?: RealtimeSource;
  /** SSE heartbeat interval. Default 25s (under common 30s proxy idle cuts). */
  heartbeatMs?: number;
  /** Called with source errors (connection loss etc.). Default: console.error. */
  onError?: (error: Error) => void;
  /**
   * Read-only DB port backing `GET ?handle&offset` (`handleLogRequest`).
   * Defaults to a lazily-created `pg.Pool` (small `max`) bound to
   * `connectionString` — created only the first time the log route is hit,
   * never at construction. Injectable for tests.
   */
  logDb?: RealtimeLogDb;
  /** Per-subscriber socket-buffer cap in bytes, probed before every frame.
   *  Over cap ⇒ the subscriber is evicted (stream ended) and reported via `onError`.
   *  NOTE: `.live()`/`useLiveTable` refetch on reconnect and are unaffected; a raw
   *  `RealtimeModelDelegate.subscribe()` caller has NO automatic resync and misses
   *  events after an eviction until it supplies its own (documented limitation). */
  maxBufferedBytes?: number;
  /** Presence member TTL before automatic expiry (default 30_000 ms). */
  presenceTtlMs?: number;
  /** Optional auth hook invoked before admitting channel subscribe/broadcast/presence requests. */
  authorizeChannel?: (req: IncomingMessage, context: ChannelAuthContext) => boolean | Promise<boolean>;
  /** Optional structured telemetry sink (zero secrets, zero row payloads). */
  onTelemetry?: (event: RealtimeTelemetryEvent) => void;
}

/** Context passed to `RealtimeEngineOptions.authorizeChannel`. */
export interface ChannelAuthContext {
  channel: string;
  action: "subscribe" | "broadcast" | "presence";
  clientId?: string;
}

/** Default per-subscriber buffered-bytes cap — 16x the measured 64 KiB
 *  `writableHighWaterMark` on Node v22.23.2, comfortably separating a busy
 *  socket from a stalled one. */
export const DEFAULT_MAX_BUFFERED_BYTES = 1_048_576;

/** Minimal query result shape `RealtimeLogDb.readOnly`'s `query` resolves to. */
export interface RealtimeLogQueryResult {
  rows: Array<Record<string, unknown>>;
}

/**
 * Narrow DB port `handleLogRequest` depends on. Deliberately NOT
 * `StudioDb`'s shape (`studio-server.ts`'s `query(sql)`, no bind
 * parameters) — `offset`, table name and the identity claim are all
 * attacker-influenced values that MUST be bound parameters, never
 * string-concatenated into SQL (design decision 5).
 */
export interface RealtimeLogDb {
  /**
   * Runs `fn` inside one `BEGIN; SET TRANSACTION READ ONLY; ...; ROLLBACK`
   * transaction (mirrors `StudioDb.readOnly`'s shape). The `set_config`
   * call and the log `SELECT` MUST run inside the SAME transaction here —
   * `set_config(..., true)` is transaction-local, so binding it on a
   * different connection/transaction from the `SELECT` would silently fail
   * to scope RLS.
   */
  readOnly<T>(
    fn: (query: (sql: string, params: unknown[]) => Promise<RealtimeLogQueryResult>) => Promise<T>,
  ): Promise<T>;
}

/** Byte-identical across every failure cause — no distinguishing detail. */
const OPAQUE_401_BODY = JSON.stringify({ error: "Unauthorized" });

function sendOpaque401(res: ServerResponse, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(401, { "content-type": "application/json", ...extraHeaders });
  res.end(OPAQUE_401_BODY);
}

interface RealtimeLogRow {
  id: string;
  lsn: string | null;
  txid: string | null;
  table_name: string;
  op: RealtimeOp;
  pk: Record<string, unknown>;
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
  ts: string;
}

interface Subscriber {
  res: ServerResponse;
  /** null = all realtime tables. */
  tables: Set<string> | null;
  seq: number;
}

interface ChannelSubscriber {
  res: ServerResponse;
  channel: string;
  clientId?: string;
  seq: number;
}

interface PresenceEntry {
  member: PresenceMember;
  timer: NodeJS.Timeout;
}

const VALID_CHANNEL_IDENT = /^[A-Za-z0-9_.:-]{1,128}$/;

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds maximum size");
  }
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > maxBytes) {
      throw new BodyTooLargeError();
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

export class RealtimeEngine {
  private readonly source: RealtimeSource;
  private readonly connectionString: string;
  private readonly heartbeatMs: number;
  private readonly onError: (error: Error) => void;
  private readonly onTelemetry?: (event: RealtimeTelemetryEvent) => void;
  private readonly authorizeChannel?: (
    req: IncomingMessage,
    context: ChannelAuthContext,
  ) => boolean | Promise<boolean>;
  private readonly presenceTtlMs: number;
  private readonly realtimeModels: Set<string>;
  /** Lowercase-normalized exact-match set (D7). Empty ⇒ closed by default. */
  private readonly allowedOrigins: Set<string>;
  private readonly subscribers = new Set<Subscriber>();
  private readonly listeners = new Set<(event: RealtimeEvent) => void>();
  private readonly channelSubscribers = new Map<string, Set<ChannelSubscriber>>();
  private readonly channelPresence = new Map<string, Map<string, PresenceEntry>>();
  private readonly broadcastListeners = new Set<(msg: BroadcastMessage) => void>();
  private readonly maxBufferedBytes: number;
  private heartbeat: NodeJS.Timeout | null = null;
  private started = false;
  private startedAtMs: number | null = null;

  // Observability counters (zero secrets, zero row payloads).
  private totalSubscribersConnected = 0;
  private totalSubscribersEvicted = 0;
  private eventsDispatched = 0;
  private readonly eventsByTable = new Map<string, number>();
  private readonly eventsByOp: Record<RealtimeOp, number> = { INSERT: 0, UPDATE: 0, DELETE: 0 };
  private lastEventAt: string | null = null;
  private lastLsn: string | null = null;
  private logRequests = 0;
  private logSealedPages = 0;
  private logHeadPages = 0;
  private logUnauthorized = 0;
  private logErrors = 0;
  private broadcastsSent = 0;
  private errorCount = 0;

  private readonly injectedLogDb: RealtimeLogDb | null;
  /** Lazily created default `RealtimeLogDb` — never opened unless the log
   * route is actually hit (design: "small `max`, lazily created only when
   * the log route is first hit"). */
  private ownedLogPool: pg.Pool | null = null;
  private ownedLogDb: RealtimeLogDb | null = null;

  constructor(options: RealtimeEngineOptions) {
    this.source =
      options.source ??
      new WalSource(options.connectionString, options.schema);
    this.connectionString = options.connectionString;
    this.heartbeatMs = options.heartbeatMs ?? 25_000;
    this.onError = options.onError ?? ((err) => console.error("[indigodb realtime]", err.message));
    this.onTelemetry = options.onTelemetry;
    this.authorizeChannel = options.authorizeChannel;
    this.presenceTtlMs = options.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS;
    this.realtimeModels = new Set(
      options.schema.tables.filter((t) => t.realtime).map((t) => t.name),
    );
    this.allowedOrigins = new Set((options.allowedOrigins ?? []).map((o) => o.toLowerCase()));
    this.injectedLogDb = options.logDb ?? null;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  }

  private emitTelemetry(event: RealtimeTelemetryEvent): void {
    try {
      this.onTelemetry?.(event);
    } catch {
      // Telemetry observers must never crash the engine.
    }
  }

  private reportError(error: Error): void {
    this.errorCount += 1;
    this.emitTelemetry({ kind: "error", message: error.message });
    this.onError(error);
  }

  /** Model names served by this engine. */
  get models(): string[] {
    return [...this.realtimeModels];
  }

  /** Synchronous operational metrics snapshot (never carries row payloads or secrets). */
  getMetrics(): RealtimeMetrics {
    let activeChannelSubscribers = 0;
    for (const set of this.channelSubscribers.values()) activeChannelSubscribers += set.size;
    let activePresenceMembers = 0;
    for (const map of this.channelPresence.values()) activePresenceMembers += map.size;
    const activeChannels = new Set([
      ...this.channelSubscribers.keys(),
      ...this.channelPresence.keys(),
    ]).size;

    const byTable: Record<string, number> = {};
    for (const [k, v] of this.eventsByTable.entries()) byTable[k] = v;

    return {
      started: this.started,
      startedAt: this.startedAtMs !== null ? new Date(this.startedAtMs).toISOString() : null,
      uptimeMs: this.started && this.startedAtMs !== null ? Math.max(0, Date.now() - this.startedAtMs) : 0,
      models: this.models,
      subscribers: {
        active: this.subscribers.size,
        totalConnected: this.totalSubscribersConnected,
        totalEvicted: this.totalSubscribersEvicted,
      },
      events: {
        dispatched: this.eventsDispatched,
        byTable,
        byOp: { ...this.eventsByOp },
        lastEventAt: this.lastEventAt,
        lastLsn: this.lastLsn,
      },
      log: {
        requests: this.logRequests,
        sealedPages: this.logSealedPages,
        headPages: this.logHeadPages,
        unauthorized: this.logUnauthorized,
        errors: this.logErrors,
      },
      channels: {
        activeChannels,
        activeSubscribers: activeChannelSubscribers,
        activePresenceMembers,
        broadcastsSent: this.broadcastsSent,
      },
      errors: this.errorCount,
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.source.start(
        (event) => this.dispatch(event),
        (err) => this.reportError(err),
      );
    } catch (err) {
      this.started = false;
      await this.source.stop().catch(() => {});
      throw err;
    }
    this.startedAtMs = Date.now();
    this.heartbeat = setInterval(() => {
      for (const sub of [...this.subscribers]) this.send(sub, ":ping\n\n");
      for (const subs of [...this.channelSubscribers.values()]) {
        for (const sub of [...subs]) this.sendChannel(sub, ":ping\n\n");
      }
    }, this.heartbeatMs);
    // A daemon with subscribers shouldn't be kept alive by the heartbeat alone.
    this.heartbeat.unref?.();
  }

  async stop(): Promise<void> {
    if (this.started) {
      this.started = false;
      this.startedAtMs = null;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      for (const sub of this.subscribers) sub.res.end();
      this.subscribers.clear();
      await this.source.stop();
    }
    for (const subs of this.channelSubscribers.values()) {
      for (const sub of subs) sub.res.end();
    }
    this.channelSubscribers.clear();
    for (const members of this.channelPresence.values()) {
      for (const entry of members.values()) clearTimeout(entry.timer);
    }
    this.channelPresence.clear();
    if (this.ownedLogPool) {
      await this.ownedLogPool.end();
      this.ownedLogPool = null;
      this.ownedLogDb = null;
    }
  }

  /** In-process listener over every change event. Returns an unsubscribe. */
  on(event: "change", listener: (e: RealtimeEvent) => void): () => void {
    void event;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** In-process listener over ephemeral channel broadcast messages. */
  onBroadcast(listener: (msg: BroadcastMessage) => void): () => void {
    this.broadcastListeners.add(listener);
    return () => this.broadcastListeners.delete(listener);
  }

  /**
   * D7 admission decision for a request's `Origin` header. A missing
   * header is ALWAYS allowed (undefined here means "no header", not "empty
   * string"); a present header is checked by exact, lowercase-normalized
   * string equality — never a prefix/suffix/substring test.
   */
  private isOriginAllowed(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    return this.allowedOrigins.has(origin.toLowerCase());
  }

  /** CORS response headers for an admitted request — `{}` when there was no
   * `Origin` header to begin with (nothing to grant, nothing to vary on). */
  private corsHeaders(origin: string | undefined): Record<string, string> {
    if (origin === undefined) return {};
    return { "access-control-allow-origin": origin, vary: "origin" };
  }

  /** Uniform 403 for a present-but-not-allowed `Origin` — no CORS header,
   * `text/plain` body, readable by operators and curl; a browser sees an
   * opaque network failure via the missing CORS header regardless. */
  private rejectOrigin(res: ServerResponse): void {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("realtime: origin not allowed");
  }

  /**
   * Serves one SSE subscription request. Routes are the caller's job — pair
   * with `attach()` for bare servers or call directly from a router.
   */
  handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (!this.isOriginAllowed(origin)) {
      this.rejectOrigin(res);
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, this.corsHeaders(origin));
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const tablesParam = url.searchParams.get("tables");
    let tables: Set<string> | null = null;

    if (tablesParam) {
      const requested = tablesParam.split(",").map((t) => t.trim()).filter(Boolean);
      const unknown = requested.filter((t) => !this.realtimeModels.has(t));
      if (unknown.length > 0) {
        res.writeHead(404, { "content-type": "application/json", ...this.corsHeaders(origin) });
        res.end(JSON.stringify({ error: `Not a realtime table: ${unknown.join(", ")}` }));
        return;
      }
      tables = new Set(requested);
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      ...this.corsHeaders(origin),
      "x-accel-buffering": "no",
    });

    const sub: Subscriber = { res, tables, seq: 0 };
    this.subscribers.add(sub);
    this.totalSubscribersConnected += 1;
    const resolvedTables = tables ? [...tables] : this.models;
    this.emitTelemetry({ kind: "subscriber_connect", tables: resolvedTables });
    const ready: RealtimeReady = { tables: resolvedTables };
    this.send(sub, `event: ready\ndata: ${JSON.stringify(ready)}\n\n`);

    req.on("close", () => {
      if (this.subscribers.delete(sub)) {
        this.emitTelemetry({ kind: "subscriber_disconnect", tables: resolvedTables });
      }
    });
  }

  /**
   * Mounts all realtime routes on a bare `node:http` server: SSE wakes,
   * signed-handle log replay, ephemeral channels (SSE, broadcast, presence),
   * and operational metrics.
   */
  attach(
    server: Server,
    path: string = REALTIME_PATH,
    logPath: string = REALTIME_LOG_PATH,
  ): void {
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === path) {
        this.handleRequest(req, res);
        return;
      }
      if (url.pathname === logPath) {
        void this.handleLogRequest(req, res);
        return;
      }
      if (url.pathname === REALTIME_CHANNELS_PATH) {
        void this.handleChannelRequest(req, res);
        return;
      }
      if (url.pathname === REALTIME_BROADCAST_PATH) {
        void this.handleBroadcastRequest(req, res);
        return;
      }
      if (url.pathname === REALTIME_PRESENCE_PATH) {
        void this.handlePresenceRequest(req, res);
        return;
      }
      if (url.pathname === REALTIME_METRICS_PATH) {
        this.handleMetricsRequest(req, res);
      }
    });
  }

  /** Serves `GET /api/realtime/metrics` (D7 origin-gated, `no-store`, zero secrets). */
  handleMetricsRequest(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (!this.isOriginAllowed(origin)) {
      this.rejectOrigin(res);
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, this.corsHeaders(origin));
      res.end();
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json", ...this.corsHeaders(origin) });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...this.corsHeaders(origin),
    });
    res.end(JSON.stringify(this.getMetrics()));
  }

  /** Lists current presence members for a channel. */
  private presenceSnapshot(channel: string): PresenceMember[] {
    const map = this.channelPresence.get(channel);
    if (!map) return [];
    return [...map.values()].map((e) => ({ ...e.member, state: { ...e.member.state } }));
  }

  /** Serves `GET /api/realtime/channels?channel=<name>[&clientId=<id>]` SSE stream. */
  async handleChannelRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    if (!this.isOriginAllowed(origin)) {
      this.rejectOrigin(res);
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, this.corsHeaders(origin));
      res.end();
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json", ...this.corsHeaders(origin) });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const channel = url.searchParams.get("channel") ?? "";
    const clientId = url.searchParams.get("clientId") ?? undefined;
    if (!VALID_CHANNEL_IDENT.test(channel) || (clientId !== undefined && !VALID_CHANNEL_IDENT.test(clientId))) {
      res.writeHead(400, { "content-type": "application/json", ...this.corsHeaders(origin) });
      res.end(JSON.stringify({ error: "Invalid channel or clientId" }));
      return;
    }

    if (this.authorizeChannel) {
      const allowed = await this.authorizeChannel(req, { channel, action: "subscribe", clientId });
      if (!allowed) {
        sendOpaque401(res, this.corsHeaders(origin));
        return;
      }
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      ...this.corsHeaders(origin),
      "x-accel-buffering": "no",
    });

    const sub: ChannelSubscriber = { res, channel, clientId, seq: 0 };
    let subs = this.channelSubscribers.get(channel);
    if (!subs) {
      subs = new Set();
      this.channelSubscribers.set(channel, subs);
    }
    subs.add(sub);

    const ready: ChannelReady = { channel, members: this.presenceSnapshot(channel) };
    this.sendChannel(sub, `event: channel_ready\ndata: ${JSON.stringify(ready)}\n\n`);

    req.on("close", () => {
      const current = this.channelSubscribers.get(channel);
      if (current) {
        current.delete(sub);
        if (current.size === 0) this.channelSubscribers.delete(channel);
      }
      if (clientId) {
        const stillConnected = [...(this.channelSubscribers.get(channel) ?? [])].some(
          (other) => other.clientId === clientId,
        );
        if (!stillConnected) {
          this.removePresence(channel, clientId);
        }
      }
    });
  }

  /** Serves `POST /api/realtime/channels/broadcast`. */
  async handleBroadcastRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    if (!this.isOriginAllowed(origin)) {
      this.rejectOrigin(res);
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, this.corsHeaders(origin));
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", ...this.corsHeaders(origin) });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    let raw: unknown;
    try {
      raw = await readJsonBody(req, MAX_CHANNEL_BODY_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        res.writeHead(413, { "content-type": "application/json", ...this.corsHeaders(origin) });
        res.end(JSON.stringify({ error: "Payload too large" }));
        return;
      }
      res.writeHead(400, { "content-type": "application/json", ...this.corsHeaders(origin) });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      res.writeHead(400, { "content-type": "application/json", ...this.corsHeaders(origin) });
      res.end(JSON.stringify({ error: "Body must be a JSON object" }));
      return;
    }
    const body = raw as Record<string, unknown>;
    const channel = typeof body.channel === "string" ? body.channel : "";
    const event = typeof body.event === "string" ? body.event : "";
    const senderId = typeof body.senderId === "string" ? body.senderId : undefined;
    if (
      !VALID_CHANNEL_IDENT.test(channel) ||
      !VALID_CHANNEL_IDENT.test(event) ||
      (senderId !== undefined && !VALID_CHANNEL_IDENT.test(senderId))
    ) {
      res.writeHead(400, { "content-type": "application/json", ...this.corsHeaders(origin) });
      res.end(JSON.stringify({ error: "Invalid channel, event, or senderId" }));
      return;
    }

    if (this.authorizeChannel) {
      const allowed = await this.authorizeChannel(req, {
        channel,
        action: "broadcast",
        clientId: senderId,
      });
      if (!allowed) {
        sendOpaque401(res, this.corsHeaders(origin));
        return;
      }
    }

    const message: BroadcastMessage = {
      channel,
      event,
      payload: body.payload ?? null,
      ...(senderId !== undefined ? { senderId } : {}),
      ts: new Date().toISOString(),
    };
    for (const listener of this.broadcastListeners) listener(message);

    let delivered = 0;
    const subs = this.channelSubscribers.get(channel);
    if (subs) {
      for (const sub of [...subs]) {
        sub.seq += 1;
        if (this.sendChannel(sub, `id: ${sub.seq}\nevent: broadcast\ndata: ${JSON.stringify(message)}\n\n`)) {
          delivered += 1;
        }
      }
    }
    this.broadcastsSent += 1;
    this.emitTelemetry({ kind: "broadcast", channel, event, delivered });

    res.writeHead(202, { "content-type": "application/json", ...this.corsHeaders(origin) });
    res.end(JSON.stringify({ delivered }));
  }

  /** Serves `POST /api/realtime/channels/presence`. */
  async handlePresenceRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    if (!this.isOriginAllowed(origin)) {
      this.rejectOrigin(res);
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, this.corsHeaders(origin));
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", ...this.corsHeaders(origin) });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    let raw: unknown;
    try {
      raw = await readJsonBody(req, MAX_CHANNEL_BODY_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        res.writeHead(413, { "content-type": "application/json", ...this.corsHeaders(origin) });
        res.end(JSON.stringify({ error: "Payload too large" }));
        return;
      }
      res.writeHead(400, { "content-type": "application/json", ...this.corsHeaders(origin) });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      res.writeHead(400, { "content-type": "application/json", ...this.corsHeaders(origin) });
      res.end(JSON.stringify({ error: "Body must be a JSON object" }));
      return;
    }
    const body = raw as Record<string, unknown>;
    const channel = typeof body.channel === "string" ? body.channel : "";
    const clientId = typeof body.clientId === "string" ? body.clientId : "";
    const action = body.action;
    if (
      !VALID_CHANNEL_IDENT.test(channel) ||
      !VALID_CHANNEL_IDENT.test(clientId) ||
      (action !== "track" && action !== "untrack")
    ) {
      res.writeHead(400, { "content-type": "application/json", ...this.corsHeaders(origin) });
      res.end(JSON.stringify({ error: "Invalid channel, clientId, or action" }));
      return;
    }
    if (
      action === "track" &&
      body.state !== undefined &&
      (typeof body.state !== "object" || body.state === null || Array.isArray(body.state))
    ) {
      res.writeHead(400, { "content-type": "application/json", ...this.corsHeaders(origin) });
      res.end(JSON.stringify({ error: "state must be a JSON object" }));
      return;
    }

    if (this.authorizeChannel) {
      const allowed = await this.authorizeChannel(req, { channel, action: "presence", clientId });
      if (!allowed) {
        sendOpaque401(res, this.corsHeaders(origin));
        return;
      }
    }

    if (action === "track") {
      const member = this.upsertPresence(
        channel,
        clientId,
        (body.state as Record<string, unknown> | undefined) ?? {},
      );
      res.writeHead(200, { "content-type": "application/json", ...this.corsHeaders(origin) });
      res.end(JSON.stringify({ member, members: this.presenceSnapshot(channel) }));
      return;
    }

    const removed = this.removePresence(channel, clientId);
    res.writeHead(200, { "content-type": "application/json", ...this.corsHeaders(origin) });
    res.end(JSON.stringify({ removed, members: this.presenceSnapshot(channel) }));
  }

  private upsertPresence(
    channel: string,
    clientId: string,
    state: Record<string, unknown>,
  ): PresenceMember {
    let map = this.channelPresence.get(channel);
    if (!map) {
      map = new Map();
      this.channelPresence.set(channel, map);
    }
    const existing = map.get(clientId);
    const now = new Date().toISOString();
    if (existing) clearTimeout(existing.timer);
    const member: PresenceMember = {
      clientId,
      state: { ...state },
      joinedAt: existing?.member.joinedAt ?? now,
      updatedAt: now,
    };
    const timer = setTimeout(() => {
      this.removePresence(channel, clientId);
    }, this.presenceTtlMs);
    timer.unref?.();
    map.set(clientId, { member, timer });

    const kind: "join" | "update" = existing ? "update" : "join";
    this.broadcastPresenceEvent(channel, existing ? "presence_update" : "presence_join", member);
    this.emitTelemetry({ kind: "presence_change", channel, action: kind, clientId });
    return { ...member, state: { ...member.state } };
  }

  private removePresence(channel: string, clientId: string): boolean {
    const map = this.channelPresence.get(channel);
    if (!map) return false;
    const entry = map.get(clientId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    map.delete(clientId);
    if (map.size === 0) this.channelPresence.delete(channel);
    this.broadcastPresenceEvent(channel, "presence_leave", entry.member);
    this.emitTelemetry({ kind: "presence_change", channel, action: "leave", clientId });
    return true;
  }

  private broadcastPresenceEvent(
    channel: string,
    eventName: "presence_join" | "presence_update" | "presence_leave",
    member: PresenceMember,
  ): void {
    const subs = this.channelSubscribers.get(channel);
    if (!subs) return;
    const payload: PresenceEvent = { channel, member };
    for (const sub of [...subs]) {
      sub.seq += 1;
      this.sendChannel(sub, `id: ${sub.seq}\nevent: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
  }

  private sendChannel(sub: ChannelSubscriber, frame: string): boolean {
    const subs = this.channelSubscribers.get(sub.channel);
    if (!subs || !subs.has(sub)) return false;
    const buffered = sub.res.writableLength ?? 0;
    if (buffered > this.maxBufferedBytes) {
      subs.delete(sub);
      if (subs.size === 0) this.channelSubscribers.delete(sub.channel);
      this.totalSubscribersEvicted += 1;
      try {
        sub.res.write("event: overflow\n\n");
      } catch {
        // best-effort
      }
      try {
        sub.res.end();
      } catch {
        // best-effort
      }
      this.emitTelemetry({
        kind: "subscriber_evicted",
        buffered,
        cap: this.maxBufferedBytes,
        scope: "channel",
      });
      this.reportError(
        new Error(
          `[backpressure] channel SSE subscriber evicted: buffered=${buffered} cap=${this.maxBufferedBytes} channel=${sub.channel}`,
        ),
      );
      return false;
    }
    sub.res.write(frame);
    return true;
  }

  /** Lazily creates the default `pg.Pool`-backed `RealtimeLogDb`, or returns the injected one. */
  private getLogDb(): RealtimeLogDb {
    if (this.injectedLogDb) return this.injectedLogDb;
    if (this.ownedLogDb) return this.ownedLogDb;

    const pool = new pg.Pool({ connectionString: this.connectionString, max: 4 });
    this.ownedLogPool = pool;
    this.ownedLogDb = {
      async readOnly(fn) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET TRANSACTION READ ONLY");
          return await fn(async (sql, params) => {
            const result = await client.query(sql, params);
            return { rows: result.rows };
          });
        } finally {
          // Always ROLLBACK, never COMMIT — this path only ever reads.
          await client.query("ROLLBACK").catch(() => {});
          client.release();
        }
      },
    };
    return this.ownedLogDb;
  }

  /**
   * Serves one page of `_indigo_realtime_log` for a verified handle:
   * `GET ?handle&offset` → `{events, offset, hasMore}`.
   *
   * Failure ordering: method guard (405) → handle verification (opaque
   * 401, uniform across tampered payload / tampered signature / unknown
   * version / expired / missing secret / missing-or-malformed handle) →
   * stale-table check (404 — the caller already proved it signed that
   * table name, design decision 10) → offset validation (400) → the
   * read-only query.
   */
  async handleLogRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // D7 origin gate — applied identically to `handleRequest`, and BEFORE
    // handle verification: a rejected origin must never reach (or leak
    // anything about the validity of) a handle, valid or not.
    const origin = req.headers.origin;
    if (!this.isOriginAllowed(origin)) {
      this.rejectOrigin(res);
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, this.corsHeaders(origin));
      res.end();
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json", ...this.corsHeaders(origin) });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    this.logRequests += 1;
    const url = new URL(req.url ?? "/", "http://localhost");
    const handleParam = url.searchParams.get("handle");

    // Uniform opaque 401 (design decision 9): a request that reached this
    // point with an unset secret is indistinguishable from every other
    // verification failure — no distinct status/body for "server
    // misconfigured" vs. "handle invalid".
    const secret = process.env.INDIGODB_REALTIME_SECRET;
    const verified = secret && handleParam ? verifyHandle(handleParam, secret) : null;
    if (!verified) {
      this.logUnauthorized += 1;
      sendOpaque401(res, this.corsHeaders(origin));
      return;
    }

    if (!this.realtimeModels.has(verified.table)) {
      res.writeHead(404, { "content-type": "application/json", ...this.corsHeaders(origin) });
      res.end(JSON.stringify({ error: `Not a realtime table: ${verified.table}` }));
      return;
    }

    // Absent offset ≡ "0". `/^\d{1,19}$/` rejects negative numbers,
    // scientific notation, SQL-injection-shaped strings and >19-digit
    // overflow BEFORE any SQL is built — bigserial exceeds
    // Number.MAX_SAFE_INTEGER, so this stays a string, never a JS number.
    const offsetParam = url.searchParams.get("offset") ?? "0";
    if (!/^\d{1,19}$/.test(offsetParam)) {
      res.writeHead(400, { "content-type": "application/json", ...this.corsHeaders(origin) });
      res.end(JSON.stringify({ error: "Invalid offset" }));
      return;
    }

    let rows: RealtimeLogRow[];
    try {
      rows = (await this.getLogDb().readOnly(async (query) => {
        // `set_config(..., true)` is transaction-local — this MUST run on
        // the same connection/transaction as the SELECT below, or RLS
        // scoping silently no-ops.
        await query("SELECT set_config('app.user_id', $1, true)", [verified.userId]);
        const result = await query(
          `SELECT id::text AS id, lsn::text AS lsn, txid, table_name, op, pk, "new", "old", ts::text AS ts` +
            ` FROM "_indigo_realtime_log"` +
            ` WHERE table_name = $1 AND id > $2::bigint` +
            // LIMIT is the module constant, never client input (amplification threat).
            ` ORDER BY id LIMIT ${REALTIME_LOG_PAGE_SIZE}`,
          [verified.table, offsetParam],
        );
        return result.rows;
      })) as unknown as RealtimeLogRow[];
    } catch {
      this.logErrors += 1;
      // Never surface DB error text upstream — defense in depth for the
      // secret-handling threat and general error-oracle hygiene.
      res.writeHead(500, { "content-type": "application/json", ...this.corsHeaders(origin) });
      res.end(JSON.stringify({ error: "Internal error" }));
      return;
    }

    // Log rows are already schema-named (`wal-source.ts`) — no
    // physical→schema translation, straight mapping (design decision 11).
    const events: RealtimeEvent[] = rows.map((row) => ({
      table: row.table_name,
      op: row.op,
      pk: row.pk,
      new: row.new ?? undefined,
      old: row.old ?? undefined,
      txid: row.txid ?? undefined,
      lsn: row.lsn ?? undefined,
      ts: row.ts,
    }));

    // ONE predicate drives both `hasMore` and the cache header — never two
    // independently-computed checks that could disagree (design decision
    // 8). A short/empty page (including zero rows) is head-of-log and MUST
    // stay `no-store`; only a page that filled the fixed limit is sealed
    // and immutable.
    const sealed = events.length === REALTIME_LOG_PAGE_SIZE;
    if (sealed) this.logSealedPages += 1;
    else this.logHeadPages += 1;
    this.emitTelemetry({ kind: "log_page", table: verified.table, count: events.length, sealed });
    const nextOffset = rows.length > 0 ? rows[rows.length - 1].id : offsetParam;

    const page: RealtimeLogPage = { events, offset: nextOffset, hasMore: sealed };

    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": sealed ? "public, max-age=31536000, immutable" : "no-store",
      ...this.corsHeaders(origin),
    });
    res.end(JSON.stringify(page));
  }

  private dispatch(event: RealtimeEvent): void {
    this.eventsDispatched += 1;
    this.eventsByTable.set(event.table, (this.eventsByTable.get(event.table) ?? 0) + 1);
    this.eventsByOp[event.op] = (this.eventsByOp[event.op] ?? 0) + 1;
    this.lastEventAt = event.ts;
    if (event.lsn !== undefined) this.lastLsn = event.lsn;
    this.emitTelemetry({ kind: "event_dispatched", table: event.table, op: event.op, lsn: event.lsn });

    // In-process listeners (e.g. the Studio embedding this engine
    // same-process) are NOT on the wire — they keep receiving the full,
    // unscoped event regardless of `@@allow`.
    for (const listener of this.listeners) listener(event);
    // SSE subscribers are unauthenticated (`handleRequest` performs zero
    // authentication; CORS is gated by the D7 origin allowlist, never a
    // wildcard), so this route MUST NEVER carry row data — for ANY table,
    // `@@allow` or not
    // (fail-closed decision, `realtime-live-endpoint` spec fix). Every SSE
    // subscriber gets a data-free wake-up frame; the authenticated
    // `handleLogRequest` (`GET ?handle&offset`) is the sanctioned path for
    // row data, gated behind a signed handle and RLS scoping.
    for (const sub of [...this.subscribers]) {
      if (sub.tables && !sub.tables.has(event.table)) continue;
      sub.seq += 1;
      const wake: RealtimeWakeEvent = { table: event.table, op: event.op, lsn: event.lsn, seq: sub.seq };
      this.send(sub, `id: ${sub.seq}\nevent: wake\ndata: ${JSON.stringify(wake)}\n\n`);
    }
  }

  /**
   * Single bounded write choke point — every SSE frame (heartbeat, ready,
   * wake, change) MUST route through here, never `res.write()` directly.
   * Probes `res.writableLength` BEFORE writing (design decision 1): over
   * `maxBufferedBytes` ⇒ evict instead of writing, so one oversized frame
   * cannot itself evict an otherwise-healthy subscriber. Returns `true` if
   * the frame was written, `false` if evicted or the subscriber was already
   * gone (re-entrancy guard for the snapshot-iteration pattern).
   */
  private send(sub: Subscriber, frame: string): boolean {
    if (!this.subscribers.has(sub)) return false;
    const buffered = sub.res.writableLength ?? 0;
    if (buffered > this.maxBufferedBytes) {
      this.evict(sub, buffered);
      return false;
    }
    sub.res.write(frame);
    return true;
  }

  /**
   * Removes `sub` from the registry and terminates its stream. Idempotent —
   * `res.end()` fires `req.on("close")`, which deletes the same `sub`, so
   * `evict()` must be safe to call twice (design decision 5). The
   * `event: overflow` frame is best-effort only: its delivery is never a
   * precondition for removal or termination (RSB-6).
   */
  private evict(sub: Subscriber, buffered: number): void {
    if (!this.subscribers.delete(sub)) return;
    this.totalSubscribersEvicted += 1;
    try {
      sub.res.write("event: overflow\n\n");
    } catch {
      // best-effort — a backed-up or already-broken socket may reject this.
    }
    try {
      sub.res.end();
    } catch {
      // best-effort — removal and eviction reporting still proceed.
    }
    const tables = sub.tables ? [...sub.tables].join(",") : "*";
    this.emitTelemetry({
      kind: "subscriber_evicted",
      buffered,
      cap: this.maxBufferedBytes,
      scope: "table",
    });
    this.reportError(
      new Error(
        `[backpressure] SSE subscriber evicted: buffered=${buffered} cap=${this.maxBufferedBytes} tables=${tables}`,
      ),
    );
  }
}
