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
import type { ResolvedSchema } from "@indigodb/core";
import type { RealtimeEvent, RealtimeOp, RealtimeSource } from "./protocol.js";

/** Default replication slot/publication name; overridden by `INDIGODB_REALTIME_SLOT`. */
const DEFAULT_SLOT = "indigo_realtime";
/** Postgres logical replication slot names accept only this alphabet. */
const SLOT_NAME_PATTERN = /^[a-z0-9_]{1,63}$/;

/**
 * Resolves the replication slot name the same way `@indigodb/migrator`'s DDL
 * path will (design decision 6/7): fixed default, `INDIGODB_REALTIME_SLOT`
 * override, validated before any connection is attempted. PR A owns a local
 * copy — PR B introduces the canonical `resolveSlotName` export in
 * `@indigodb/migrator`; this stays byte-identical to it by construction so
 * PR B can replace this call with an import without behaviour change.
 */
export function resolveSlotName(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.INDIGODB_REALTIME_SLOT?.trim() || DEFAULT_SLOT;
  if (!SLOT_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid INDIGODB_REALTIME_SLOT "${name}": replication slot names must ` +
        `match ${SLOT_NAME_PATTERN} (lowercase letters, digits, underscores, 1-63 chars)`,
    );
  }
  return name;
}

interface TableNames {
  /** Model name for the wire. */
  model: string;
  /** Physical column name → field name. */
  columns: Map<string, string>;
  /** Primary key, physical column names (order as declared). */
  primaryKey: string[];
}

/** A single decoded row change, buffered until its transaction commits. */
interface PendingRow {
  table: string;
  op: RealtimeOp;
  pk: Record<string, unknown>;
  new?: Record<string, unknown>;
  old?: Record<string, unknown>;
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
      });
    }
  }

  /** Model names of the tables this source will emit events for. */
  get models(): string[] {
    return [...this.tables.values()].map((t) => t.model);
  }

  async start(
    onEvent: (event: RealtimeEvent) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    this.stopped = false;
    // Initial connect failures throw so a daemon fails fast with a clear
    // error; once established, losses are retried with backoff instead —
    // same contract as PgNotifySource.start().
    await this.connect(onEvent, onError);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.txid = undefined;
    this.pending = [];
    const service = this.service;
    this.service = null;
    if (service) await service.stop().catch(() => {});
  }

  private async connect(
    onEvent: (event: RealtimeEvent) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    const service = new LogicalReplicationService(
      { connectionString: this.connectionString } as pg.ClientConfig,
      { acknowledge: { auto: false, timeoutSeconds: 0 } },
    );
    this.service = service;
    this.txid = undefined;
    this.pending = [];

    service.on("error", (err) => onError(err));
    // Fires once the replication stream is actually live (after the server
    // acks START_REPLICATION) — the same "we're connected" signal
    // PgNotifySource resets its backoff on after `LISTEN` succeeds. Resetting
    // here (not merely after `subscribe()` returns, which only happens once
    // the stream *ends*) is what lets the backoff delay actually grow across
    // consecutive failures instead of being wiped every attempt.
    service.on("start", () => {
      this.retryMs = 1_000;
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

    try {
      await service.subscribe(plugin, this.slot);
      // subscribe() resolves when the stream ends without an error (e.g. our
      // own stop()). If that happened while we intended to keep running,
      // treat it the same as a dropped connection.
      if (this.service === service && !this.stopped) {
        this.scheduleReconnect(onEvent, onError);
      }
    } catch (err) {
      if (this.service !== service) return; // superseded by a newer connect()
      onError(err instanceof Error ? err : new Error(String(err)));
      if (!this.stopped) this.scheduleReconnect(onEvent, onError);
      else throw err;
    }
  }

  private scheduleReconnect(
    onEvent: (event: RealtimeEvent) => void,
    onError: (error: Error) => void,
  ): void {
    if (this.stopped) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    this.retryTimer = setTimeout(() => {
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
        for (const row of this.pending) {
          const event: RealtimeEvent = {
            table: row.table,
            op: row.op,
            pk: row.pk,
            ts,
            txid,
          };
          if (row.new) event.new = row.new;
          if (row.old) event.old = row.old;
          onEvent(event);
        }
        this.pending = [];
        this.txid = undefined;
        if (commitLsn) this.service?.acknowledge(commitLsn).catch(() => {});
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

    const row: PendingRow = { table: names.model, op, pk };
    if (fresh) row.new = renameKeys(fresh, names.columns);
    if (old) row.old = renameKeys(old, names.columns);
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
