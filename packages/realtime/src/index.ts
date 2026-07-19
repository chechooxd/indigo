/**
 * @indigodb/realtime
 *
 * Postgres → client change-event engine for `@@realtime` tables. v1 source is
 * LISTEN/NOTIFY (triggers emitted by the migrator); the `RealtimeSource` seam
 * keeps the wire protocol and SDK stable for a v2 WAL/logical-replication
 * source. Transport is SSE over plain `node:http`.
 */

export { RealtimeEngine } from "./engine.js";
export type { RealtimeEngineOptions } from "./engine.js";
export { PgNotifySource } from "./source.js";
export { REALTIME_PATH } from "./protocol.js";
export type {
  RealtimeEvent,
  RealtimeOp,
  RealtimeReady,
  RealtimeSource,
} from "./protocol.js";
