/**
 * @indigodb/parser
 *
 * Public parsing API for the `.indigo` language. Since the Rust port, the
 * actual lexer/parser live in `@indigodb/compiler` (Rust → WASM); this
 * package is the thin wrapper that keeps the historical API — a synchronous
 * `parse()` and an `IndigoParseError` with `instanceof` semantics — stable
 * for every consumer.
 *
 * The previous Chevrotain implementation lives under `./legacy/` and is only
 * consumed by the parity harness in `@indigodb/compiler`; it will be removed
 * once the WASM compiler has soaked.
 */

import type { Schema } from "@indigodb/ast";
import { parseSchema } from "@indigodb/compiler";

// ─── Error Types ─────────────────────────────────────────────────────────────

export class IndigoParseError extends Error {
  constructor(
    message: string,
    public readonly errors: ParseErrorDetail[],
  ) {
    super(message);
    this.name = "IndigoParseError";
  }
}

export interface ParseErrorDetail {
  message: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

// ─── Parse Function ──────────────────────────────────────────────────────────

/**
 * Parses an `.indigo` schema string into a typed AST.
 *
 * @throws {IndigoParseError} If the input contains syntax errors — with every
 * error found in the pass (the Rust parser recovers at declaration level),
 * each carrying 1-based line/column.
 */
export function parse(input: string): Schema {
  const result = parseSchema(input);
  if ("errors" in result) {
    throw new IndigoParseError("Parse errors found in .indigo schema", result.errors);
  }
  return result.schema;
}

// Re-export AST types for convenience
export type { Schema } from "@indigodb/ast";
