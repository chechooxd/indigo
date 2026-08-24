/**
 * @indigodb/realtime
 *
 * Postgres → client change-event engine for `@@realtime` tables. Default
 * source (v2) is `WalSource`, over Postgres logical replication (`pgoutput`)
 * — no events lost while disconnected. `PgNotifySource` (v1, LISTEN/NOTIFY)
 * remains exported and constructible via `RealtimeEngineOptions.source`. The
 * `RealtimeSource` seam keeps the wire protocol and SDK stable across both.
 * Transport is SSE over plain `node:http`.
 */

export { RealtimeEngine } from "./engine.js";
export type { RealtimeEngineOptions } from "./engine.js";
export { PgNotifySource } from "./source.js";
export { WalSource, resolveSlotName } from "./wal-source.js";
export type { WalSourceOptions } from "./wal-source.js";
export { REALTIME_PATH } from "./protocol.js";
export type {
  RealtimeEvent,
  RealtimeOp,
  RealtimeReady,
  RealtimeSource,
} from "./protocol.js";
