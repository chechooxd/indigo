/**
 * @indigodb/client
 *
 * Framework-agnostic runtime for the IndigoDB ORM. The generated `indigo.ts`
 * client imports `IndigoClientBase` and `ModelDelegate` from here and wires up
 * typed model delegates. Usable in NestJS, Express or plain Node.
 */

export { IndigoClientBase } from "./client.js";
export type { IndigoClientOptions, RealtimeOptions } from "./client.js";
export { IndigoDatabaseError, withDatabaseErrors } from "./errors.js";
export type { DatabaseErrorCode } from "./errors.js";
export { ModelDelegate, IndigoRelationError, IndigoNestedWriteError, IndigoNotFoundError } from "./delegate.js";
export type { SiblingRegistry, RunAtomic, NestedWriteErrorCode } from "./delegate.js";
export { RealtimeModelDelegate, LiveModelDelegate } from "./realtime-delegate.js";
export type { SubscribeHandlers } from "./realtime-delegate.js";
export { RealtimeConnectionManager, SseTransport } from "./realtime.js";
export type { RealtimeTransport, TransportHandlers, Unsubscribe, ChannelListener } from "./realtime.js";
export { decodeHandlePayload, IndigoLiveHandleError, LIVE_DEBOUNCE_MS } from "./live.js";
export type {
  LiveQuery,
  LiveStatus,
  LiveHandlers,
  HandlePayload,
  HandleFailureReason,
  HandleInfo,
  GetHandleFn,
  RunScoped,
  ClientRunScoped,
} from "./live.js";
export type { RealtimeEvent, RealtimeOp } from "@indigodb/realtime";
export { currentQueryContext } from "./context.js";
export { IndigoPromise, isIndigoPromise, defer, runDeferred, IndigoTransactionError } from "./promise.js";
export type { TransactionErrorCode } from "./promise.js";
export type * from "./types.js";
export * from "./adapters/index.js";
