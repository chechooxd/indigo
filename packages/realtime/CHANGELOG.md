# @indigodb/realtime

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
  - @indigodb/core@0.1.0
  - @indigodb/migrator@0.1.0
