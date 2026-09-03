/**
 * @indigodb/compiler — Node entrypoint.
 *
 * Instantiates the WASM module synchronously at load time, so `parse` &co are
 * usable immediately — the CLI keeps its fully synchronous flow. The exported
 * `initCompiler` is a no-op kept for isomorphism with the browser entry.
 */

import { readFileSync } from "node:fs";
import { initSync } from "../wasm/indigo_compiler.js";
import { markInitialized } from "./shared.js";

initSync({
  module: readFileSync(new URL("../wasm/indigo_compiler_bg.wasm", import.meta.url)),
});
markInitialized();

/** No-op on Node (init happens synchronously at module load). */
export async function initCompiler(): Promise<void> {}

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
