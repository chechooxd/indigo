/**
 * @indigodb/compiler — shared wrapper over the WASM exports.
 *
 * The WASM boundary speaks JSON strings with envelopes (`{ok}` / `{errors}` /
 * `{error}`); this module unwraps them into plain typed results. It never
 * throws domain classes — `IndigoParseError` is reconstructed by
 * `@indigodb/parser` so `instanceof` keeps working for consumers.
 *
 * `resolveSchema`/`validateSchema` return loosely-typed values on purpose:
 * `ResolvedSchema`/`ValidationError` live in `@indigodb/core`, which depends
 * on this package — core applies the cast, avoiding a dependency cycle.
 */

import type { Schema } from "@indigodb/ast";
import * as wasm from "../wasm/indigo_compiler.js";

/** Structured compiler diagnostic (superset of parser's ParseErrorDetail). */
export interface CompilerError {
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

let initialized = false;

/** Called by the platform entrypoints once the WASM module is instantiated. */
export function markInitialized(): void {
  initialized = true;
}

function ensureInitialized(): void {
  if (!initialized) {
    throw new Error(
      "IndigoDB compiler not initialized — await initCompiler() before parsing.",
    );
  }
}

export type ParseResult = { schema: Schema } | { errors: CompilerError[] };

export function parseSchema(source: string): ParseResult {
  ensureInitialized();
  const out = JSON.parse(wasm.parse(source));
  return "ok" in out ? { schema: out.ok as Schema } : { errors: out.errors };
}

export function resolveSchema(schema: Schema): unknown {
  ensureInitialized();
  const out = JSON.parse(wasm.resolve(JSON.stringify(schema)));
  if ("error" in out) throw new Error(out.error);
  return out.ok;
}

export function validateSchema(schema: Schema): unknown[] {
  ensureInitialized();
  const out = JSON.parse(wasm.validate(JSON.stringify(schema)));
  if ("error" in out) throw new Error(out.error);
  return out.ok;
}

export type CompileResult =
  | { schema: Schema; resolved: unknown; validationErrors: unknown[] }
  | { errors: CompilerError[] };

/** One-shot parse+validate+resolve (single boundary crossing). */
export function compileSchema(source: string): CompileResult {
  ensureInitialized();
  const out = JSON.parse(wasm.compile(source));
  return "ok" in out ? out.ok : { errors: out.errors };
}

/**
 * Source span, side-channel only — never a field on `Schema`/`Model`/
 * `Field`/`Attribute` (see `ast-source-spans` spec, decision D1). `start`/
 * `end` are UTF-16 code-unit offsets, end-exclusive, so
 * `currentText.slice(span.start, span.end)` yields exactly the node's
 * source text. `line`/`column`/`endLine`/`endColumn` are 1-based.
 */
export interface SourceSpan {
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface AttributeSpan {
  name: string;
  span: SourceSpan;
}

export interface FieldSpan {
  name: string;
  decl: SourceSpan;
  nameToken: SourceSpan;
  typeToken: SourceSpan;
  attributes: AttributeSpan[];
}

export interface ModelSpan {
  name: string;
  decl: SourceSpan;
  nameToken: SourceSpan;
  bodyOpen: SourceSpan;
  bodyClose: SourceSpan;
  fields: FieldSpan[];
  attributes: SourceSpan[];
}

/** Enums/`datasource`/`generator`/`TableGroup` carry no spans — unedited. */
export interface SpanIndex {
  models: ModelSpan[];
}

export type ParseWithSpansResult =
  | { schema: Schema; spans: SpanIndex }
  | { errors: CompilerError[] };

/**
 * Side channel: `schema` here is byte-identical to what `parseSchema(source)`
 * would return. `parseSchema`'s own output is unaffected by this function
 * existing (see `ast-source-spans` spec).
 */
export function parseSchemaWithSpans(source: string): ParseWithSpansResult {
  ensureInitialized();
  const out = JSON.parse(wasm.parse_with_spans(source));
  return "ok" in out
    ? { schema: out.ok.schema as Schema, spans: out.ok.spans as SpanIndex }
    : { errors: out.errors };
}
