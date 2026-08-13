/**
 * @indigodb/client — PGlite-backed driver adapter (`client-driver-adapters`
 * spec).
 *
 * Promotes `test/pglite-harness.mjs`'s `createPgliteDb` to a public export.
 * `PGliteLike` is a minimal structural interface — no `@electric-sql/pglite`
 * runtime import, so PGlite stays a devDependency only (design.md
 * "Interfaces / Contracts").
 */

import type { DriverAdapter, Executor } from "../types.js";

/**
 * Structural subset of PGlite's own API that this adapter needs. Matches the
 * shape already used by `test/pglite-harness.mjs`'s `createPgliteDb`.
 */
export interface PGliteLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  transaction<T>(fn: (tx: PGliteLike) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

/**
 * Builds a `DriverAdapter` over a PGlite (or PGlite-shaped) instance. Wraps
 * PGlite's own `transaction(tx => …)` API (design.md Decision 6) — never
 * raw `BEGIN`/`COMMIT` statements — and the inner closure touches ONLY the
 * `tx` handle it receives, never the outer `pglite` instance
 * (electric-sql/pglite#76).
 *
 * `close` is omitted by default (design.md Decision 7 — same ownership rule
 * as `createPgAdapter`: the caller constructed the PGlite instance). Pass
 * `{ close: true }` to opt in.
 */
export function createPGliteAdapter(
  pglite: PGliteLike,
  options: { close?: boolean } = {},
): DriverAdapter {
  const exec: Executor = async (sql, params) => (await pglite.query(sql, params)).rows;

  const transaction: DriverAdapter["transaction"] = (fn) =>
    pglite.transaction(async (tx) =>
      fn(async (sql, params) => (await tx.query(sql, params)).rows),
    );

  const adapter: DriverAdapter = { exec, transaction };
  if (options.close) {
    adapter.close = async () => {
      await pglite.close?.();
    };
  }
  return adapter;
}
