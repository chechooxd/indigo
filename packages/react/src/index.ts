/**
 * @indigodb/react — placeholder entry point (Phase 5a of `frontend-realtime-sdk`).
 *
 * The real `useLiveTable` hook ships in the next slice (Phase 5b, design.md
 * D4/D5). This stub exists so the package has a genuine shape — real build,
 * lint, test and `npm pack` behavior (D8) — before the hook lands, and so
 * `test/browser-safety.mjs`'s reachable-specifier scan has a real import
 * graph to walk.
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
