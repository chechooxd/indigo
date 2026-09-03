/**
 * @indigodb/compiler — browser entrypoint.
 *
 * WASM instantiation is async in the browser, so callers must
 * `await initCompiler()` once (the Studio does it in main.tsx before
 * rendering); afterwards `parse`/`resolve`/`validate` are synchronous.
 * The `new URL(..., import.meta.url)` asset reference is handled natively
 * by Vite — no wasm plugin needed.
 */

import init from "../wasm/indigo_compiler.js";
import { markInitialized } from "./shared.js";

let pending: Promise<void> | null = null;

/** Idempotent async init; must complete before any compiler call. */
export function initCompiler(): Promise<void> {
  pending ??= init({
    module_or_path: new URL("../wasm/indigo_compiler_bg.wasm", import.meta.url),
  }).then(() => markInitialized());
  return pending;
}

export {
  parseSchema,
  resolveSchema,
  validateSchema,
  compileSchema,
  parseSchemaWithSpans,
} from "./shared.js";
export type {
  CompilerError,
  ParseResult,
  CompileResult,
  SourceSpan,
  AttributeSpan,
  FieldSpan,
  ModelSpan,
  SpanIndex,
  ParseWithSpansResult,
} from "./shared.js";
