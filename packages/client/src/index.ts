/**
 * @indigodb/client
 *
 * Framework-agnostic runtime for the IndigoDB ORM. The generated `indigo.ts`
 * client imports `IndigoClientBase` and `ModelDelegate` from here and wires up
 * typed model delegates. Usable in NestJS, Express or plain Node.
 */

export { IndigoClientBase } from "./client.js";
export type { IndigoClientOptions, RealtimeOptions } from "./client.js";
export { ModelDelegate, IndigoRelationError } from "./delegate.js";
export type { SiblingRegistry, RunAtomic } from "./delegate.js";
export { RealtimeModelDelegate } from "./realtime-delegate.js";
export type { SubscribeHandlers } from "./realtime-delegate.js";
export { RealtimeConnectionManager, SseTransport } from "./realtime.js";
export type { RealtimeTransport, TransportHandlers, Unsubscribe } from "./realtime.js";
export type { RealtimeEvent, RealtimeOp } from "@indigodb/realtime";
export type * from "./types.js";
