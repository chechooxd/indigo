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
