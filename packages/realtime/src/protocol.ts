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
   * not the LSN. A future slice may add LSN addressing alongside this field;
   * the commit LSN arrives with the shape log when that lands.
   */
  txid?: string;
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

/** Default HTTP path the engine serves SSE subscriptions on. */
export const REALTIME_PATH = "/api/realtime";
