/**
 * @indigodb/core — LEGACY TS resolver/validator.
 *
 * Reference side of the TS↔Rust parity harness
 * (`packages/compiler/test/parity.mjs`). Not exported from the package
 * entrypoint; scheduled for removal once the WASM compiler has soaked.
 */

export { resolve } from "./resolve.js";
export { validate } from "./validate.js";
