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
export type { RealtimeEngineOptions, RealtimeLogDb, RealtimeLogQueryResult } from "./engine.js";
export { PgNotifySource } from "./source.js";
export { WalSource, resolveSlotName } from "./wal-source.js";
export type { WalSourceOptions } from "./wal-source.js";
export { REALTIME_PATH, REALTIME_LOG_PATH, REALTIME_LOG_PAGE_SIZE } from "./protocol.js";
export type {
  RealtimeEvent,
  RealtimeOp,
  RealtimeReady,
  RealtimeSource,
  RealtimeWakeEvent,
  RealtimeLogPage,
} from "./protocol.js";
export { mintHandle, verifyHandle, DEFAULT_HANDLE_TTL_SECONDS } from "./handle.js";
export type { HandlePayload } from "./handle.js";
