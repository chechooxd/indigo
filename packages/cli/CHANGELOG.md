# @indigodb/cli

## 0.1.2

### Patch Changes

- Add cross-database replication slot preflight checks for `db push`, `migrate deploy`, and `migrate dev`, and update init template guidance from `indigodb docs` to `indigodb studio`.
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @indigodb/core@0.1.2
  - @indigodb/generator@0.1.2
  - @indigodb/migrator@0.1.2
  - @indigodb/studio@0.1.2
  - @indigodb/parser@0.1.2
  - @indigodb/realtime@0.1.2

## 0.1.1

### Patch Changes

- Add package-level `README.md` documentation to all `@indigodb/*` packages and align `@indigodb/react` with the published release cohort.
- Updated dependencies
  - @indigodb/parser@0.1.1
  - @indigodb/core@0.1.1
  - @indigodb/migrator@0.1.1
  - @indigodb/generator@0.1.1
  - @indigodb/realtime@0.1.1
  - @indigodb/studio@0.1.1

## 0.1.0

### Minor Changes

- Initial public release (`0.1.0`) of IndigoDB:

  - `.indigo` schema compiler (Rust → WASM) and relational IR with native types, enum mappings, relations, referential actions, partial/expression indexes, row-level security (`@@allow`), and `@@realtime` column projections.
  - PostgreSQL schema differ, DDL generator, catalog introspector (`db pull`), shadow replay, destructive guards, checksummed migration history, and transactional `data.sql` data migrations.
  - Type-safe generated TypeScript ORM client with relations, nested writes, aggregations, cursor pagination, transactions, `$withSession`, `$extends`, `explain()`, and `pg` / `PGlite` driver adapters.
  - PostgreSQL WAL logical-replication SSE engine, ephemeral Presence & Broadcast channels, structured realtime observability (`getMetrics`, `GET /api/realtime/metrics`, `onTelemetry`), browser-safe `@indigodb/client/realtime` SDK, and `@indigodb/react` hooks (`useLiveTable`, `useChannel`).
  - IndigoDB CLI (`init`, `db push`/`pull`, `migrate dev`/`deploy`/`status`/`resolve`, `generate`, `realtime`, `studio`) and visual `@indigodb/studio` workspace (ER diagram + editor, data browser, read-only SQL console, schema docs).

### Patch Changes

- Updated dependencies
  - @indigodb/parser@0.1.0
  - @indigodb/core@0.1.0
  - @indigodb/migrator@0.1.0
  - @indigodb/generator@0.1.0
  - @indigodb/realtime@0.1.0
  - @indigodb/studio@0.1.0
