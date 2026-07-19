/**
 * @indigodb/core — Resolver
 *
 * Since the Rust port, resolution runs in `@indigodb/compiler` (Rust → WASM);
 * this wrapper keeps the historical synchronous `resolve(schema)` API and
 * applies the `ResolvedSchema` typing (the compiler package returns it
 * untyped to avoid a dependency cycle — the IR types live here).
 *
 * The previous TS implementation lives in `./legacy/resolve.ts`, consumed
 * only by the parity harness in `@indigodb/compiler`.
 */

import type { Schema } from "@indigodb/ast";
import { resolveSchema } from "@indigodb/compiler";
import type { ResolvedSchema } from "./ir.js";

/** Resolves a parsed schema into the relational IR. */
export function resolve(schema: Schema): ResolvedSchema {
  return resolveSchema(schema) as ResolvedSchema;
}
