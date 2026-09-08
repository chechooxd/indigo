/**
 * @indigodb/react — entry point.
 *
 * `useLiveTable` (Phase 5b, design.md D4/D5) is the package's real product:
 * a thin `useSyncExternalStore` binding over `createLiveSubscription`. Both
 * are re-exported here so a consumer never has to reach into `@indigodb/client`
 * directly.
 *
 * This file imports ONLY the browser-safe `./realtime` subpath of
 * `@indigodb/client` — never the package's root entry, which value-exports
 * `IndigoClientBase` and drags in `pg` + `node:async_hooks`. See
 * `packages/client/README.md`'s "Browser usage" section for the contract
 * this package builds on.
 */
export { createLiveSubscription, browserTransport } from "@indigodb/client/realtime";
export type {
  LiveSubscription,
  LiveSubscriptionOptions,
  LiveSubscriptionStatus,
  LiveSubscriptionError,
} from "@indigodb/client/realtime";
export { useLiveTable } from "./use-live-table.js";
export type { UseLiveTableOptions, UseLiveTableResult } from "./use-live-table.js";
