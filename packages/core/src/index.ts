/**
 * @indigodb/core
 *
 * Shared relational IR + resolver/validator for IndigoDB. Takes a parsed
 * `.indigo` `Schema` (from `@indigodb/parser`) and produces a normalized
 * `ResolvedSchema` consumed by the migrator, generator, docs and client.
 */

export * from "./ir.js";
export * from "./resolve.js";
export * from "./validate.js";
export * from "./attributes.js";

// Re-export the parser entry point so consumers can go straight from source
// text to a resolved schema via `@indigodb/core`.
export { parse, IndigoParseError } from "@indigodb/parser";
export type { Schema } from "@indigodb/ast";

// WASM compiler init: a no-op on Node (instantiated synchronously at load);
// in the browser it must be awaited before the first parse/resolve call —
// the Studio does this in main.tsx before rendering.
export { initCompiler } from "@indigodb/compiler";
