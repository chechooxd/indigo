/**
 * @indigodb/realtime — Wire protocol
 *
 * Source-agnostic shapes shared by the engine, the SSE transport and the
 * client SDK. Nothing here may import runtime code: `@indigodb/client`
 * consumes these types type-only so the browser bundle stays free of `pg`.
 *
 * Events speak *schema* names (model + field), never physical table/column
 * names — the engine translates before fan-out, so swapping the v1
 * LISTEN/NOTIFY source for logical replication (WAL) in v2 changes nothing
 * on the wire.
 */

export type RealtimeOp = "INSERT" | "UPDATE" | "DELETE";

export interface RealtimeEvent<Row = Record<string, unknown>> {
  /** Model name as written in the schema (e.g. "User"), not the db name. */
  table: string;
  op: RealtimeOp;
  /** Primary key of the affected row, keyed by field name. */
  pk: Record<string, unknown>;
  /** Row after the change (INSERT/UPDATE). Absent when `partial`. */
  new?: Row;
  /** Row before the change (UPDATE/DELETE). Absent when `partial`. */
  old?: Row;
  /** Payload exceeded NOTIFY's 8000-byte limit; refetch by `pk`. */
  partial?: boolean;
  /**
   * v1 (`PgNotifySource`): `txid_current()`. v2 (`WalSource`): the decimal
   * transaction id from the pgoutput `begin` message — same *meaning* as v1,
   * not the LSN.
   */
  txid?: string;
  /**
   * The commit LSN as the `X/Y` hex string PostgreSQL prints for `pg_lsn`
   * (`realtime-shape-log` design, `WalSource` decision). Populated by
   * `WalSource` on every event it emits — it always has a commit LSN
   * available from the `commit` message. `PgNotifySource` does not populate
   * it: NOTIFY-based delivery has no commit LSN to surface. This is
   * additive and does not break parity for `table`/`op`/`pk`/`new`/`old`/
   * `txid`/`ts` — an absent `lsn` is not a contract violation.
   */
  lsn?: string;
  /** ISO-8601 UTC timestamp taken inside the transaction. */
  ts: string;
  /** Per-connection monotonic sequence (SSE `id:`), stamped at fan-out. */
  seq?: number;
}

/**
 * A stream of row-change events. `WalSource` (v2, logical replication) is
 * the default; `PgNotifySource` (v1, LISTEN/NOTIFY) remains available — same
 * consumers either way.
 */
export interface RealtimeSource {
  start(
    onEvent: (event: RealtimeEvent) => void,
    onError: (error: Error) => void,
  ): Promise<void>;
  stop(): Promise<void>;
}

/** Payload of the SSE `ready` frame sent on subscription. */
export interface RealtimeReady {
  tables: string[];
}

/**
 * A data-free SSE wake-up signal for `@@allow`-protected models (PR B wires
 * `dispatch()` to emit this — this PR only adds the type). Distinct from
 * `RealtimeEvent`: `pk`/`ts` are required there and
 * `realtime-delegate.ts` dereferences `event.pk` unconditionally, so a
 * wake-up frame — which by design carries no row data — cannot reuse that
 * shape without relaxing fields `@indigodb/client` depends on being present.
 */
export interface RealtimeWakeEvent {
  table: string;
  op: RealtimeOp;
  /** Absent when the source has no commit LSN available (`PgNotifySource`). */
  lsn?: string;
  seq?: number;
}

/** Response body of `GET ?handle&offset`. */
export interface RealtimeLogPage<Row = Record<string, unknown>> {
  events: RealtimeEvent<Row>[];
  /** Next request's cursor — `_indigo_realtime_log.id`, as a decimal string. */
  offset: string;
  /** `true` only when the page was filled to `REALTIME_LOG_PAGE_SIZE`. */
  hasMore: boolean;
}

/** Default HTTP path the engine serves SSE subscriptions on. */
export const REALTIME_PATH = "/api/realtime";

/** HTTP path the engine serves the cacheable `GET ?handle&offset` log page on. */
export const REALTIME_LOG_PATH = "/api/realtime/log";

/** Server-fixed page size for `GET ?handle&offset` — never client-supplied. */
export const REALTIME_LOG_PAGE_SIZE = 500;
