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
