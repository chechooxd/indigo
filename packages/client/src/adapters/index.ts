/**
 * @indigodb/client — Named driver adapter factories (`client-driver-adapters`
 * spec). Each produces an `IndigoClientOptions["db"]` (`DriverAdapter`)
 * value carrying the same parity guarantees as the built-in
 * `connectionString` path.
 */

export { createPgAdapter } from "./pg.js";
export type { PgAdapterConfig, PgAdapter } from "./pg.js";
export { createPGliteAdapter } from "./pglite.js";
export type { PGliteLike } from "./pglite.js";
