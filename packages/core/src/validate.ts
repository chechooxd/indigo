/**
 * @indigodb/core — Validator
 *
 * Delegates to the Rust compiler (`@indigodb/compiler`), keeping the
 * historical synchronous `validate(schema)` API. Returns a list of errors
 * (empty === valid) rather than throwing, so callers can surface all
 * problems at once. The previous TS implementation lives in
 * `./legacy/validate.ts`, consumed only by the parity harness.
 */

import type { Schema } from "@indigodb/ast";
import { validateSchema } from "@indigodb/compiler";
import type { ValidationError } from "./ir.js";

export function validate(schema: Schema): ValidationError[] {
  return validateSchema(schema) as ValidationError[];
}
