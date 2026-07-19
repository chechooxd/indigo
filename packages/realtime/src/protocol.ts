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
  /** v1: `txid_current()`; v2 (WAL): the LSN. */
  txid?: string;
  /** ISO-8601 UTC timestamp taken inside the transaction. */
  ts: string;
  /** Per-connection monotonic sequence (SSE `id:`), stamped at fan-out. */
  seq?: number;
}

/**
 * A stream of row-change events. The seam for v2: `PgNotifySource` today,
 * a `WalSource` over logical replication tomorrow, same consumers.
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
