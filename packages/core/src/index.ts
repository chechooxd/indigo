/**
 * @indigodb/core
 *
 * Shared relational IR + resolver/validator for IndigoDB. Takes a parsed
 * `.indigo` `Schema` (from `@indigodb/parser`) and produces a normalized
 * `ResolvedSchema` consumed by the migrator, generator, docs and client.
 */

import { parseSchemaWithSpans } from "@indigodb/compiler";
import type { SpanIndex } from "@indigodb/compiler";
import { IndigoParseError } from "@indigodb/parser";
import type { Schema } from "@indigodb/ast";

export * from "./ir.js";
export * from "./resolve.js";
export * from "./validate.js";
export * from "./attributes.js";
export * from "./print.js";

// Re-export the parser entry point so consumers can go straight from source
// text to a resolved schema via `@indigodb/core`.
export { parse, IndigoParseError } from "@indigodb/parser";
export type { Schema } from "@indigodb/ast";

// WASM compiler init: a no-op on Node (instantiated synchronously at load);
// in the browser it must be awaited before the first parse/resolve call —
// the Studio does this in main.tsx before rendering.
export { initCompiler } from "@indigodb/compiler";

// ─── Spans (ast-source-spans) ──────────────────────────────────────────────
//
// Side channel only — see `parseSchemaWithSpans` in `@indigodb/compiler`.
// `parseWithSpans` mirrors `parse`'s throw-on-error convention (an
// `IndigoParseError`) rather than the `{schema}|{errors}` result shape, so
// callers that already use `parse` get a consistent API.

export type {
  SourceSpan,
  AttributeSpan,
  FieldSpan,
  ModelSpan,
  SpanIndex,
} from "@indigodb/compiler";

/**
 * Parses `.indigo` source into `{schema, spans}`. `schema` is
 * byte-identical to what `parse(source)` returns — spans never become AST
 * fields (design decision D1).
 *
 * @throws {IndigoParseError} Same contract as `parse`.
 */
export function parseWithSpans(source: string): { schema: Schema; spans: SpanIndex } {
  const result = parseSchemaWithSpans(source);
  if ("errors" in result) {
    throw new IndigoParseError("Parse errors found in .indigo schema", result.errors);
  }
  return result;
}
