/**
 * @indigodb/client
 *
 * Framework-agnostic runtime for the IndigoDB ORM. The generated `indigo.ts`
 * client imports `IndigoClientBase` and `ModelDelegate` from here and wires up
 * typed model delegates. Usable in NestJS, Express or plain Node.
 */

export { IndigoClientBase } from "./client.js";
export type { IndigoClientOptions } from "./client.js";
export { ModelDelegate } from "./delegate.js";
export type * from "./types.js";
