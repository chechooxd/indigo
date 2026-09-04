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
} from "./protocol.js";
import { REALTIME_PATH, REALTIME_LOG_PATH, REALTIME_LOG_PAGE_SIZE, type RealtimeSource } from "./protocol.js";
import { WalSource } from "./wal-source.js";
import { verifyHandle } from "./handle.js";

export interface RealtimeEngineOptions {
  connectionString: string;
  schema: ResolvedSchema;
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

function sendOpaque401(res: ServerResponse): void {
  res.writeHead(401, { "content-type": "application/json" });
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

export class RealtimeEngine {
  private readonly source: RealtimeSource;
  private readonly connectionString: string;
  private readonly heartbeatMs: number;
  private readonly onError: (error: Error) => void;
  private readonly realtimeModels: Set<string>;
  private readonly subscribers = new Set<Subscriber>();
  private readonly listeners = new Set<(event: RealtimeEvent) => void>();
  private readonly maxBufferedBytes: number;
  private heartbeat: NodeJS.Timeout | null = null;
  private started = false;

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
    this.realtimeModels = new Set(
      options.schema.tables.filter((t) => t.realtime).map((t) => t.name),
    );
    this.injectedLogDb = options.logDb ?? null;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  }

  /** Model names served by this engine. */
  get models(): string[] {
    return [...this.realtimeModels];
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.source.start((event) => this.dispatch(event), this.onError);
    } catch (err) {
      // A rejected first attempt must not leave the engine permanently
      // "started" — reset before rethrowing so a caller that catches this
      // and later retries (e.g. after an operator fixes the underlying
      // cause) genuinely reaches `source.start()` again (RSC-14).
      //
      // The source must be stopped HERE, not left to the caller. A rejected
      // attempt has already armed `scheduleReconnect()`'s backoff timer, and
      // `stop()` below does all of its work inside `if (this.started)` —
      // which the line above has just made false. So a caller doing the
      // obvious thing (`catch { await engine.stop() }`) would get a silent
      // no-op while the timer retried forever, keeping the process alive.
      // Observed directly: the degraded-Studio suite printed "all green" and
      // then never exited.
      this.started = false;
      await this.source.stop().catch(() => {});
      throw err;
    }
    this.heartbeat = setInterval(() => {
      for (const sub of [...this.subscribers]) this.send(sub, ":ping\n\n");
    }, this.heartbeatMs);
    // A daemon with subscribers shouldn't be kept alive by the heartbeat alone.
    this.heartbeat.unref?.();
  }

  async stop(): Promise<void> {
    if (this.started) {
      this.started = false;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      for (const sub of this.subscribers) sub.res.end();
      this.subscribers.clear();
      await this.source.stop();
    }
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
    this.send(sub, `event: ready\ndata: ${JSON.stringify(ready)}\n\n`);

    req.on("close", () => {
      this.subscribers.delete(sub);
    });
  }

  /**
   * Mounts `handleRequest` (SSE) AND `handleLogRequest` (the cacheable
   * `GET ?handle&offset` page) on a bare `node:http` server. Requests
   * outside both paths are left to the server's other listeners. NOTE: the
   * standalone `indigodb realtime` daemon and the embedded studio server do
   * NOT call `attach()` — both route manually (design decision 4) — so this
   * is `attach()`'s own internal dispatch, for any OTHER host that does use
   * it, not a substitute for those two hosts' explicit branches.
   */
  attach(server: Server, path: string = REALTIME_PATH, logPath: string = REALTIME_LOG_PATH): void {
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === path) {
        this.handleRequest(req, res);
        return;
      }
      if (url.pathname === logPath) {
        void this.handleLogRequest(req, res);
      }
    });
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
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const handleParam = url.searchParams.get("handle");

    // Uniform opaque 401 (design decision 9): a request that reached this
    // point with an unset secret is indistinguishable from every other
    // verification failure — no distinct status/body for "server
    // misconfigured" vs. "handle invalid".
    const secret = process.env.INDIGODB_REALTIME_SECRET;
    const verified = secret && handleParam ? verifyHandle(handleParam, secret) : null;
    if (!verified) {
      sendOpaque401(res);
      return;
    }

    if (!this.realtimeModels.has(verified.table)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `Not a realtime table: ${verified.table}` }));
      return;
    }

    // Absent offset ≡ "0". `/^\d{1,19}$/` rejects negative numbers,
    // scientific notation, SQL-injection-shaped strings and >19-digit
    // overflow BEFORE any SQL is built — bigserial exceeds
    // Number.MAX_SAFE_INTEGER, so this stays a string, never a JS number.
    const offsetParam = url.searchParams.get("offset") ?? "0";
    if (!/^\d{1,19}$/.test(offsetParam)) {
      res.writeHead(400, { "content-type": "application/json" });
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
      // Never surface DB error text upstream — defense in depth for the
      // secret-handling threat and general error-oracle hygiene.
      res.writeHead(500, { "content-type": "application/json" });
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
    const nextOffset = rows.length > 0 ? rows[rows.length - 1].id : offsetParam;

    const page: RealtimeLogPage = { events, offset: nextOffset, hasMore: sealed };

    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": sealed ? "public, max-age=31536000, immutable" : "no-store",
    });
    res.end(JSON.stringify(page));
  }

  private dispatch(event: RealtimeEvent): void {
    // In-process listeners (e.g. the Studio embedding this engine
    // same-process) are NOT on the wire — they keep receiving the full,
    // unscoped event regardless of `@@allow`.
    for (const listener of this.listeners) listener(event);
    // SSE subscribers are unauthenticated (`handleRequest` performs zero
    // authentication and sets `access-control-allow-origin: "*"`), so this
    // route MUST NEVER carry row data — for ANY table, `@@allow` or not
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
    this.onError(
      new Error(
        `[backpressure] SSE subscriber evicted: buffered=${buffered} cap=${this.maxBufferedBytes} tables=${tables}`,
      ),
    );
  }
}
