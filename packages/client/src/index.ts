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
export { ModelDelegate, IndigoRelationError, IndigoNestedWriteError } from "./delegate.js";
export type { SiblingRegistry, RunAtomic, NestedWriteErrorCode } from "./delegate.js";
export { RealtimeModelDelegate } from "./realtime-delegate.js";
export type { SubscribeHandlers } from "./realtime-delegate.js";
export { RealtimeConnectionManager, SseTransport } from "./realtime.js";
export type { RealtimeTransport, TransportHandlers, Unsubscribe } from "./realtime.js";
export type { RealtimeEvent, RealtimeOp } from "@indigodb/realtime";
export { currentQueryContext } from "./context.js";
export type * from "./types.js";
export * from "./adapters/index.js";
