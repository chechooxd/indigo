# Delta for client-live-queries

## ADDED Requirements

### Requirement: `@indigodb/client` exposes a browser-safe `./realtime` subpath free of `pg` and `node:async_hooks`

`packages/client/package.json` MUST declare an additive `"./realtime"` export subpath mapping
to a build (`dist/realtime.js`) that re-exports `SseTransport`, `RealtimeConnectionManager`,
and the realtime path constants (including `REALTIME_PATH`), and that transitively imports
neither `pg` nor `node:async_hooks`. The existing `.` entry point and its behavior MUST remain
unchanged; this subpath is purely additive.

#### Scenario: `./realtime` subpath resolves and is Node-surface-free

- GIVEN a consumer imports `@indigodb/client/realtime`
- WHEN the module graph reachable from that import is inspected
- THEN it exposes `SseTransport` and `REALTIME_PATH`, and contains no import of `pg` or
  `node:async_hooks`

#### Scenario: The root `.` entry point is unaffected

- GIVEN a consumer imports `@indigodb/client` (the root entry)
- WHEN the generated `IndigoClient` and `ModelDelegate` surface is inspected
- THEN its exports and behavior are byte-identical to before this subpath was added

#### Scenario: A bundler targeting the browser never pulls in `pg`

- GIVEN a frontend app imports only `@indigodb/client/realtime`
- WHEN its production bundle is built
- THEN the bundle contains no `pg` or `node:async_hooks` import
