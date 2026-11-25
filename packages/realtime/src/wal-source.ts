/**
 * @indigodb/realtime — WAL logical-replication event source (v2)
 *
 * Structural sibling of `source.ts` (v1, LISTEN/NOTIFY): same constructor-built
 * `Map<dbTable,{model,columns}>`, same `start/stop` surface, same 1s→30s
 * exponential backoff, same drop-unknown-table rule. Only the transport
 * differs — `pg-logical-replication`'s `LogicalReplicationService` streams
 * `pgoutput` messages over a dedicated replication connection instead of
 * `LISTEN`/`NOTIFY`, so a change committed while this source is stopped or
 * disconnected is still delivered on reconnect (resumed from the
 * replication slot's confirmed LSN) — the gap `PgNotifySource`'s doc
 * comment calls out as v2's reason to exist.
 *
 * `pg-logical-replication`'s `LogicalReplicationService` has NO internal
 * reconnect/retry loop (verified live, A0.1 spike): on a connection error or
 * an unexpected stream end its `subscribe()` promise rejects and nothing
 * else happens. `WalSource` owns the single backoff policy end to end,
 * mirroring `PgNotifySource`'s `scheduleReconnect` (`source.ts:96-108`)
 * exactly — there is no second reconnect loop to race against.
 *
 * Acknowledgement (decision 11): the library's own auto-ack (per XLogData
 * chunk, immediately) is disabled (`acknowledge: { auto: false }`).
 * `WalSource` buffers every row event of a transaction and flushes them to
 * `onEvent` only on `commit`, then acknowledges the commit LSN — so an ack
 * only ever happens after every row of that transaction has been handed to
 * the caller. A crash between dispatch and ack replays the transaction on
 * reconnect (at-least-once; v1 was at-most-once). Consumers already refetch
 * by `pk` (`RealtimeModelDelegate`), so a replay is idempotent.
 *
 * `acknowledge.timeoutSeconds` is set to 10, NOT 0 (found live, not by
 * design — a prior value of 0 disabled the library's periodic standby-status
 * timer entirely, since `checkStandbyStatus()` only arms it when
 * `timeoutSeconds > 0`). That timer is not just about acking received data —
 * it is this client's half of the replication liveness protocol: Postgres's
 * `wal_sender_timeout` (default 60s) kills the walsender if the client sends
 * nothing for that long, data or not. With no writes to acknowledge and no
 * periodic timer either, an idle `@@realtime` table got disconnected by
 * Postgres every ~60s, forever, in production as much as in a quiet test —
 * observed as a repeating "terminating walsender process due to replication
 * timeout" in the server log, masquerading as a hang under backoff. 10s
 * leaves a wide margin under the 60s default without spamming keepalives.
 *
 * `txid`/`ts` (decisions 9/10): `txid` is the decimal transaction id from
 * the `begin` message (same *meaning* as v1's `txid_current()::text`; LSN
 * addressing is a later slice's contract — see `protocol.ts`'s doc comment).
 * `ts` is the `commit` message's server timestamp, formatted to the same
 * `YYYY-MM-DDTHH:MM:SS.mmmZ` shape the v1 trigger emitted (transaction-scoped
 * and server-authoritative, like v1's `clock_timestamp()`; the deviation is
 * *when* within the transaction it's taken — v1 stamped statement time, v2
 * stamps commit time).
 *
 * pgoutput's `relation.keyColumns` is NOT a reliable primary-key source here:
 * under `REPLICA IDENTITY FULL` (required for full-row `old` — decision 8,
 * PR B's job to set) Postgres marks EVERY column as a "key" column, not just
 * the true primary key (verified live, A0.1 spike). `pk` is therefore always
 * derived from the `ResolvedSchema`'s own `primaryKey` column list, never
 * from the wire message.
 */

import pg from "pg";
import {
  LogicalReplicationService,
  PgoutputPlugin,
  type Pgoutput,
} from "pg-logical-replication";
type Message = Pgoutput.Message;
type MessageRelation = Pgoutput.MessageRelation;
import type { ResolvedSchema, ResolvedTable } from "@indigodb/core";
import { resolveSlotName, REALTIME_LOG_TABLE, quoteIdent, computeBuckets } from "@indigodb/migrator";
import type { RealtimeEvent, RealtimeOp, RealtimeSource } from "./protocol.js";
import { project, projectionSet } from "./projection.js";

// `resolveSlotName` is re-exported for `@indigodb/realtime` consumers (and
// this module's own default below) — canonical implementation now lives in
// `@indigodb/migrator`'s `postgres.ts` (design decision 6/7: one resolver
// shared by migrator/CLI/realtime, closing PR A's self-contained local copy).
export { resolveSlotName };

interface TableNames {
  /** Model name for the wire. */
  model: string;
  /** Physical column name → field name. */
  columns: Map<string, string>;
  /** Primary key, physical column names (order as declared). */
  primaryKey: string[];
  /**
   * The table's own `ResolvedTable`, cached once at construction (`realtime
   * -shape-log` PR B) so `computeBuckets` never needs to re-resolve the
   * schema per row — `decodeRow` just reads this reference. `buckets` are
   * still computed per row (they depend on that row's actual field values,
   * design decisions 8-11), but the (table -> its `allow` rules) lookup
   * itself is derived once, here, not per event.
   */
  table: ResolvedTable;
  /**
   * `@@realtime(columns: [...])` allowlist (`realtime-column-projection`,
   * design decision 3-4), resolved once here alongside `columns`/
   * `primaryKey`. `null` = bare `@@realtime`, no narrowing. Physical
   * (dbName) keyed, like `columns`/`primaryKey` — applied to the RAW
   * pgoutput tuple in `decodeRow`, before `renameKeys`.
   */
  projection: Set<string> | null;
}

/** A single decoded row change, buffered until its transaction commits. */
interface PendingRow {
  table: string;
  op: RealtimeOp;
  pk: Record<string, unknown>;
  new?: Record<string, unknown>;
  old?: Record<string, unknown>;
  /**
   * Pre-evaluated read-authorization buckets (`realtime-shape-log` PR B,
   * design decisions 8-11) — computed once in `decodeRow` from the RAW
   * physical-column-keyed pgoutput payload (before `renameKeys` converts it
   * to schema field names for the wire `RealtimeEvent`), since
   * `AllowOperand.Field.name` always carries the PHYSICAL column name.
   */
  buckets: string[] | null;
}

export interface WalSourceOptions {
  /** Replication slot/publication name override. Default: `resolveSlotName()`. */
  slot?: string;
}

export class WalSource implements RealtimeSource {
  private readonly slot: string;
  private readonly tables = new Map<string, TableNames>();
  private service: LogicalReplicationService | null = null;
  private stopped = true;
  private retryMs = 1_000;
  private retryTimer: NodeJS.Timeout | null = null;

  /** Current transaction being buffered, cleared on commit/rollback-equivalent. */
  private txid: string | undefined;
  private pending: PendingRow[] = [];

  /**
   * Second, ordinary `pg.Client` connection (design decision, `WalSource`
   * opens a dedicated log-writer connection): the replication connection
   * cannot run DML, so `_indigo_realtime_log` INSERTs go through this
   * separate connection, opened alongside the replication stream in
   * `connect()` and closed/reopened together with it.
   */
  private writer: pg.Client | null = null;

  /**
   * Serial promise chain enforcing insert -> dispatch -> ack ordering
   * (design decision 1). `service.on("data")` (the caller of
   * `handleMessage`) is synchronous and keeps delivering while a write is in
   * flight, so without this chain two commits' inserts/acks would interleave
   * and LSN order would be lost — the single largest new failure mode this
   * slice introduces. `stop()` awaits it.
   */
  private chain: Promise<void> = Promise.resolve();

  /**
   * One-shot "ready" deferred (`realtime-start-contract`): created fresh in
   * `start()`, resolved from `service.on("start")` once the stream is
   * confirmed live, rejected from `connect()`'s catch on a first-attempt
   * failure or from `start()`'s own backstop. `settleReady()` settles it
   * then **nulls this field** — that null is the entire first-attempt
   * scoping mechanism: once null, a later reconnect attempt's own settle
   * calls become no-ops, so `start()`'s promise can only ever be settled by
   * the attempt it was created for.
   */
  private ready: { resolve: () => void; reject: (err: Error) => void } | null = null;

  /**
   * Settles the current `ready` deferred (if any) and nulls the field
   * immediately, before invoking the captured `resolve`/`reject` — so a
   * later reconnect's own call, even one already in flight, observes a null
   * `ready` and no-ops instead of re-settling an already-settled promise.
   */
  private settleReady(outcome: "resolve" | "reject", err?: Error): void {
    const ready = this.ready;
    if (!ready) return;
    this.ready = null;
    if (outcome === "resolve") ready.resolve();
    else ready.reject(err as Error);
  }

  /** Test seam (private, no interface change): overridden in unit tests. */
  private createService(): LogicalReplicationService {
    return new LogicalReplicationService(
      { connectionString: this.connectionString } as pg.ClientConfig,
      { acknowledge: { auto: false, timeoutSeconds: 10 } },
    );
  }

  /** Test seam (private, no interface change): overridden in unit tests. */
  private createWriter(): pg.Client {
    return new pg.Client({ connectionString: this.connectionString } as pg.ClientConfig);
  }

  constructor(
    private readonly connectionString: string,
    schema: ResolvedSchema,
    options: WalSourceOptions = {},
  ) {
    this.slot = options.slot ?? resolveSlotName();
    for (const table of schema.tables) {
      if (!table.realtime) continue;
      const columns = new Map<string, string>();
      for (const col of table.columns) columns.set(col.dbName, col.name);
      this.tables.set(table.dbName, {
        model: table.name,
        columns,
        primaryKey: table.primaryKey,
        table,
        projection: projectionSet(table),
      });
    }
  }

  /** Model names of the tables this source will emit events for. */
  get models(): string[] {
    return [...this.tables.values()].map((t) => t.model);
  }

  /**
   * Resolves once the stream is confirmed live (Postgres has acked
   * `START_REPLICATION`) — NOT when the replication stream ends. Rejects if
   * the first connection attempt fails, carrying the underlying Postgres
   * error. Settlement is scoped to that first attempt only: a later
   * reconnect driven by `scheduleReconnect()` never re-settles this
   * promise, whichever way it resolves — see `settleReady()`. `stop()`
   * called while this first attempt is still pending always rejects this
   * promise rather than leaving it pending; `connect()`'s own internals
   * (supersession checks, the orphaned-socket guard, backoff scheduling)
   * are unchanged by this contract.
   */
  async start(
    onEvent: (event: RealtimeEvent) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    // A stale pending deferred from an overlapping prior start() call (not
    // expected in normal use, but must not leak) is rejected before a new
    // one is created.
    this.settleReady("reject", new Error("WalSource: superseded by a later start()"));
    this.stopped = false;
    const ready = new Promise<void>((resolve, reject) => {
      this.ready = { resolve, reject };
    });
    // Runs detached — connect()'s own reconnect loop keeps the stream alive
    // across the rest of this source's lifetime; start() awaits only the
    // ready deferred above, never this promise directly.
    const attempt = this.connect(onEvent, onError);
    // Backstop: whichever way the first connect() attempt itself settles —
    // including exit paths (an early `stopped` return, either supersession
    // return, normal completion) that don't call settleReady() themselves —
    // this guarantees `ready` is settled too. A no-op once `connect()`'s own
    // resolve/reject path in `service.on("start")` or the catch block has
    // already settled it (this.ready is already null by then).
    attempt.then(
      () => this.settleReady("reject", new Error("WalSource: stream ended before it became live")),
      (err) => this.settleReady("reject", err instanceof Error ? err : new Error(String(err))),
    );
    // Attached AFTER `.then()` above, on the same promise: `.then()`'s
    // rejection handler runs first and forwards the real error into
    // settleReady(); this `.catch()` only ever observes the
    // already-consumed rejection of a separate derived promise, so nothing
    // the deferred needs is swallowed, and no rejection is ever unobserved.
    attempt.catch(() => {});
    await ready;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.txid = undefined;
    this.pending = [];
    // Let any in-flight insert -> dispatch -> ack sequence settle before
    // tearing down the connections it depends on.
    await this.chain.catch(() => {});
    const service = this.service;
    this.service = null;
    if (service) await service.stop().catch(() => {});
    await this.closeWriter();
  }

  /** Closes and clears the log-writer connection, if any. Idempotent. */
  private async closeWriter(): Promise<void> {
    const writer = this.writer;
    this.writer = null;
    if (writer) await writer.end().catch(() => {});
  }

  private async connect(
    onEvent: (event: RealtimeEvent) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    // A reconnect timer fired (or a stale caller re-entered connect()) after
    // stop() already ran — bail before touching any connection. Without this,
    // a retry scheduled just before stop() can race stop()'s clearTimeout,
    // survive it, and go on to redial a slot the caller's fixture may have
    // already dropped — failing forever and keeping the process alive on its
    // own backoff timer (observed: a 46-minute CI hang).
    if (this.stopped) return;

    // Any writer left over from a prior connect()/teardown is stale by
    // construction — close it defensively before opening a fresh one.
    await this.closeWriter();

    const service = this.createService();
    this.service = service;
    this.txid = undefined;
    this.pending = [];
    this.chain = Promise.resolve();

    service.on("error", (err) => onError(err));
    // Fires once the replication stream is actually live (after the server
    // acks START_REPLICATION) — the same "we're connected" signal
    // PgNotifySource resets its backoff on after `LISTEN` succeeds. Resetting
    // here (not merely after `subscribe()` returns, which only happens once
    // the stream *ends*) is what lets the backoff delay actually grow across
    // consecutive failures instead of being wiped every attempt.
    service.on("start", () => {
      this.retryMs = 1_000;
      // Confirms the stream is live — the one `start()`-readiness signal
      // this source has. A no-op on any reconnect after the first attempt
      // already settled `start()`'s promise (`this.ready` is null by then).
      this.settleReady("resolve");
    });

    const plugin = new PgoutputPlugin({
      protoVersion: 1, // decision 12: v2 stream_* messages need buffering, zero parity benefit
      publicationNames: [this.slot],
    });

    service.on("data", (_lsn, message: Message) => {
      try {
        this.handleMessage(message, onEvent, onError);
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    });

    // Declared outside the try so the catch block can close it too — see the
    // note there on why supersession must close, not just abandon, a writer
    // that got as far as being assigned to `this.writer`.
    let writer: pg.Client | undefined;

    try {
      // Opened before subscribing so the writer is ready before the first
      // commit can possibly arrive. Same connection string as the
      // replication stream; an ordinary connection can run DML where the
      // replication one cannot.
      writer = this.createWriter();
      // Attached before connect() so nothing can fire before it's listening.
      // pg.Client extends EventEmitter — an 'error' event with no listener
      // is fatal to the whole Node process (not just this connection), and
      // this client's socket dies independently of the replication one on
      // any admin-initiated kill, network drop, or server restart. The
      // replication connection's own "error"/subscribe-rejection handling
      // already drives reconnection; this only stops the writer's socket
      // from taking the host process down with it (observed: an admin
      // `pg_terminate_backend()` during test teardown crashed the process).
      writer.on("error", (err) => {
        onError(err instanceof Error ? err : new Error(String(err)));
      });
      await writer.connect();
      if (this.service !== service) {
        // Superseded by a newer connect() while the writer was connecting.
        await writer.end().catch(() => {});
        return;
      }
      this.writer = writer;

      await service.subscribe(plugin, this.slot);
      // Teardown THIS attempt's service and writer unconditionally once
      // subscribe() ends. `pg-logical-replication`'s `subscribe()` returns
      // `plugin.start()` without awaiting it, so its own catch/stop() does not
      // run when the stream ends or rejects — leaving `checkStandbyStatusTimer`
      // (a ref'd 1s setInterval) alive forever if we overwrite `this.service`
      // on reconnect without stopping the finished instance first.
      const endedStale = this.service !== service || this.stopped;
      if (this.service === service) this.service = null;
      await service.stop().catch(() => {});
      if (this.writer === writer) this.writer = null;
      await writer.end().catch(() => {});
      if (endedStale || this.stopped) return;
      this.scheduleReconnect(onEvent, onError);
    } catch (err) {
      const failedStale = this.service !== service || this.stopped;
      if (this.service === service) this.service = null;
      await service.stop().catch(() => {});
      if (writer && this.writer === writer) this.writer = null;
      await writer?.end().catch(() => {});
      if (failedStale || this.stopped) return;
      const wrapped = err instanceof Error ? err : new Error(String(err));
      onError(wrapped);
      // A no-op on any reconnect attempt after the first one already
      // settled `start()`'s promise (`this.ready` is null by then) — this
      // is the ONLY reject path for a first-attempt connect failure.
      this.settleReady("reject", wrapped);
      if (!this.stopped) this.scheduleReconnect(onEvent, onError);
    }
  }

  private scheduleReconnect(
    onEvent: (event: RealtimeEvent) => void,
    onError: (error: Error) => void,
  ): void {
    if (this.stopped) return;
    // Defensive: clear any timer already outstanding before overwriting the
    // handle. Two calls in quick succession would otherwise orphan the first
    // timer — stop()'s clearTimeout only ever sees the second one — leaving
    // an uncancellable reconnect loop running after stop().
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped) return;
      this.connect(onEvent, onError).catch((err) => {
        onError(err instanceof Error ? err : new Error(String(err)));
        if (!this.stopped) this.scheduleReconnect(onEvent, onError);
      });
    }, delay);
  }

  /** Decodes one pgoutput message, buffering row events until their commit. */
  private handleMessage(
    message: Message,
    onEvent: (event: RealtimeEvent) => void,
    onError: (error: Error) => void,
  ): void {
    switch (message.tag) {
      case "begin":
        this.txid = String(message.xid);
        this.pending = [];
        return;
      case "insert": {
        const row = this.decodeRow("INSERT", message.relation, undefined, message.new);
        if (row) this.pending.push(row);
        return;
      }
      case "update": {
        const row = this.decodeRow("UPDATE", message.relation, message.old ?? undefined, message.new);
        if (row) this.pending.push(row);
        return;
      }
      case "delete": {
        const row = this.decodeRow("DELETE", message.relation, message.old ?? undefined, undefined);
        if (row) this.pending.push(row);
        return;
      }
      case "commit": {
        // The library's .d.ts types `commitTime` as the boxed `BigInt`
        // interface rather than the `bigint` primitive it actually returns
        // (verified live, A0.1 spike) — cast through the runtime value.
        const ts = formatCommitTime(message.commitTime as unknown as bigint);
        const txid = this.txid;
        const commitLsn = message.commitLsn;
        const batch = this.pending;
        this.pending = [];
        this.txid = undefined;

        // Capture (batch, commitLsn, txid, ts) synchronously, right here,
        // then append the insert -> dispatch -> ack sequence to the serial
        // chain (design decision 1). `handleMessage` itself stays
        // synchronous and returns immediately — `service.on("data")` keeps
        // delivering the next message while this settles, exactly the
        // condition the chain exists to serialize against.
        this.chain = this.chain
          .then(() => this.flushCommit(batch, commitLsn, txid, ts, onEvent, onError))
          .catch((err) => {
            onError(err instanceof Error ? err : new Error(String(err)));
          });
        return;
      }
      case "relation":
      case "message":
      case "origin":
      case "truncate":
      case "type":
        // Valid, decodable protocol messages this source has no action for
        // (relation metadata is tracked internally by the plugin already;
        // the rest carry no row-level change data). Not an error.
        return;
      default: {
        const unknown = message as { tag?: unknown };
        onError(new Error(`WalSource: unrecognized pgoutput message tag ${String(unknown.tag)}`));
      }
    }
  }

  /**
   * One transaction's insert -> dispatch -> ack sequence (design decisions
   * 1-3, 12). An empty `batch` (every row change in the transaction touched
   * a non-@@realtime table) skips the log write entirely and just acks —
   * there is nothing to redeliver for a transaction that never logged
   * anything. Runs serialized on `this.chain`; never called directly from
   * `handleMessage`.
   */
  private async flushCommit(
    batch: PendingRow[],
    commitLsn: string | null,
    txid: string | undefined,
    ts: string,
    onEvent: (event: RealtimeEvent) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    if (batch.length > 0) {
      const writer = this.writer;
      if (!writer) {
        onError(new Error("WalSource: log-writer connection unavailable; commit not acknowledged"));
        await this.teardownAfterLogFailure(onEvent, onError);
        return;
      }
      try {
        const { sql, params } = buildLogInsert(batch, commitLsn, txid, ts);
        await writer.query(sql, params);
      } catch (err) {
        // A failed insert dispatches nothing and acks nothing (design
        // decision 2): ack is monotonic, so acking a LATER commit would
        // implicitly confirm this one too, silently losing the transaction
        // the redelivery-on-reconnect contract exists to preserve. Tearing
        // the whole connection down (not "log and continue") is what makes
        // that redelivery real.
        onError(err instanceof Error ? err : new Error(String(err)));
        await this.teardownAfterLogFailure(onEvent, onError);
        return;
      }
    }

    for (const row of batch) {
      const event: RealtimeEvent = {
        table: row.table,
        op: row.op,
        pk: row.pk,
        ts,
        txid,
      };
      if (row.new) event.new = row.new;
      if (row.old) event.old = row.old;
      if (commitLsn) event.lsn = commitLsn;
      onEvent(event);
    }

    if (commitLsn) {
      const service = this.service;
      if (service) await service.acknowledge(commitLsn).catch(() => {});
    }
  }

  /** Tears the replication + writer connections down and schedules a reconnect (design decision 2). */
  private async teardownAfterLogFailure(
    onEvent: (event: RealtimeEvent) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    const service = this.service;
    this.service = null;
    if (service) await service.stop().catch(() => {});
    await this.closeWriter();
    if (!this.stopped) this.scheduleReconnect(onEvent, onError);
  }

  /** Physical row(s) → wire event fields (schema names), or null to drop (unknown table). */
  private decodeRow(
    op: RealtimeOp,
    relation: MessageRelation,
    old: Record<string, unknown> | null | undefined,
    fresh: Record<string, unknown> | null | undefined,
  ): PendingRow | null {
    const names = this.tables.get(relation.name);
    if (!names) return null; // not a @@realtime table (or misconfigured publication)

    const pkSource = fresh ?? old;
    const pk: Record<string, unknown> = {};
    if (pkSource) {
      for (const col of names.primaryKey) {
        pk[names.columns.get(col) ?? col] = pkSource[col];
      }
    }

    // computeBuckets over the RAW, physical-column-keyed tuples — NOT the
    // renamed (schema-field-keyed) ones below. `AllowOperand.Field.name`
    // always carries the physical column name (postgres.ts's own
    // `columnByDbName` comment), so bucket evaluation must happen before
    // `renameKeys` converts `fresh`/`old` for the wire event. INSERT: only
    // `fresh` exists, passed as `row`. DELETE: only `old` exists, passed as
    // `row` (there is no "old" half to union in that case). UPDATE: both
    // exist, `old` passed as the union half (design decision 11).
    const primary = fresh ?? old ?? {};
    const secondary = fresh && old ? old : undefined;
    const buckets = computeBuckets(names.table, primary, secondary);

    // Column projection (`realtime-column-projection`, design decision 4):
    // narrow the RAW, physical-column-keyed row to the allowlist BEFORE
    // `renameKeys`, immediately after `computeBuckets` above — buckets are
    // always derived from the full row (decision 4 ordering; RCP-12), and
    // `new`/`old` are narrowed via the exact same `project()` call, adjacent
    // lines, so a half-fix that only narrows one of them cannot happen
    // (decision 5). `pk`, built above, is never passed through `project()`.
    const row: PendingRow = { table: names.model, op, pk, buckets };
    if (fresh) row.new = renameKeys(project(fresh, names.projection), names.columns);
    if (old) row.old = renameKeys(project(old, names.projection), names.columns);
    return row;
  }
}

function renameKeys(
  row: Record<string, unknown>,
  columns: Map<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[columns.get(key) ?? key] = value;
  }
  return out;
}

/** pgoutput `commitTime` is microseconds since the Unix epoch (library already applies the
 * Postgres 2000-01-01 epoch offset) → `YYYY-MM-DDTHH:MM:SS.mmmZ`, matching v1's trigger format. */
function formatCommitTime(commitTime: bigint): string {
  return new Date(Number(commitTime / 1000n)).toISOString();
}

/**
 * Builds one multi-row parameterized `INSERT` for a whole WAL transaction
 * (design decision 12: one INSERT per commit, never one per row). Every
 * value — including row payload data — travels as a bound `pg` parameter;
 * nothing from `batch` is ever concatenated into the SQL text (threat
 * matrix: SQL injection through logged row data). `pk`/`new`/`old` are
 * JSON-stringified and cast `::jsonb` in the SQL (same pattern
 * `@indigodb/client`'s `delegate.ts` already uses for jsonb parameters —
 * `pg` does not auto-serialize plain objects for a jsonb column). `buckets`
 * (`realtime-shape-log` PR B) was pre-computed per row in `decodeRow` via
 * `computeBuckets`; `pg` serializes the bound JS array/`null` to the
 * `text[]` parameter automatically.
 */
function buildLogInsert(
  batch: PendingRow[],
  commitLsn: string | null,
  txid: string | undefined,
  ts: string,
): { sql: string; params: unknown[] } {
  const table = quoteIdent(REALTIME_LOG_TABLE);
  const valueClauses: string[] = [];
  const params: unknown[] = [];
  for (const row of batch) {
    const base = params.length;
    const placeholders = [
      `$${base + 1}`,
      `$${base + 2}`,
      `$${base + 3}`,
      `$${base + 4}`,
      `$${base + 5}::jsonb`,
      `$${base + 6}::jsonb`,
      `$${base + 7}::jsonb`,
      `$${base + 8}`,
      `$${base + 9}::text[]`,
    ];
    valueClauses.push(`(${placeholders.join(", ")})`);
    params.push(
      commitLsn,
      txid ?? null,
      row.table,
      row.op,
      JSON.stringify(row.pk),
      row.new ? JSON.stringify(row.new) : null,
      row.old ? JSON.stringify(row.old) : null,
      ts,
      row.buckets,
    );
  }
  const sql =
    `INSERT INTO ${table} (lsn, txid, table_name, op, pk, "new", "old", ts, buckets) ` +
    `VALUES ${valueClauses.join(", ")}`;
  return { sql, params };
}
