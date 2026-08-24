# Proposal: WAL logical-replication realtime source

Change: `realtime-wal-source` (Road to 1.0, Phase 4). Slice 2 of the realtime epic, parity-only. Exploration: Engram #708; decisions: Engram `sdd/realtime-wal-source/decisions`.

## Intent

Realtime v1 captures changes with `LISTEN indigo_events` (`packages/realtime/src/source.ts`), fed by the `indigo_notify_trigger()` DDL in `packages/migrator/src/postgres.ts`. That path loses every event that occurs while the client is disconnected — `source.ts`'s own doc comment states the gap is unrecoverable in v1 — and truncates payloads past NOTIFY's 8000-byte limit into `partial: true` refetches. A logical replication slot checkpoints an LSN server-side, so a reconnecting consumer resumes exactly where it stopped. `protocol.ts` already names WAL as the v2 seam; this slice fills it without changing the wire shape.

## Scope

### In Scope
- `WalSource implements RealtimeSource` (new `packages/realtime/src/wal-source.ts`) over `START_REPLICATION SLOT ... LOGICAL` with `pgoutput`, emitting the **exact** `RealtimeEvent` shape `PgNotifySource` emits today (table/op/pk/new/old/txid/ts) — physical→schema name translation included.
- `pg-logical-replication` as a new dependency of `@indigodb/realtime`, deduped against the pinned `pg ^8.13.0`.
- `WalSource` becomes the default source in `packages/realtime/src/engine.ts` (`source ?? new WalSource(...)`); `PgNotifySource` stays exported but is no longer wired by default.
- DDL-time replication lifecycle in `packages/migrator/src/postgres.ts` + `migrate.ts`: idempotent `CREATE PUBLICATION` over `@@realtime` tables, slot create/drop tied to schema state, publication drop when the last `@@realtime` table disappears.
- Retire the NOTIFY trigger: `renderNotifyFunction`/`renderCreateTrigger` stop being emitted; the versioned diff drops existing `indigo_notify_*` objects.
- Slot naming: fixed default `indigo_realtime`, overridable via `INDIGODB_REALTIME_SLOT`, resolved identically by the DDL path (`packages/migrator` + `packages/cli`) and the consumer path (`WalSource`).
- `wal_level` preflight in `packages/cli` (`db push` / `migrate deploy`): `SHOW wal_level` and a clear actionable error when it is not `logical` — IndigoDB cannot fix it (needs superuser + restart).
- New `postgres` CI job in `.github/workflows/ci.yml`, a sibling of `rust` (no `needs:`), running a service container with `-c wal_level=logical`, plus a real-Postgres test harness for `@indigodb/realtime`.

### Out of Scope
- Shape log / LSN-addressed `GET ?handle&offset` API — slice 3. `RealtimeEvent.txid` keeps its current meaning; no LSN surfaces yet.
- Per-row / per-subscriber realtime filtering. `engine.ts` still fans out by `sub.tables.has(event.table)`; the compiler guard rejecting `@@realtime` + `@@allow` stays in place.
- Dual-write or NOTIFY fallback for hosts without `wal_level=logical` — a hard preflight error, not a degraded path.
- Slot ownership by the `RealtimeEngine`/daemon at runtime.
- PGlite coverage: confirmed unable to run logical replication (`electric-sql/pglite#1047`/`#1054` unmerged).
- `packages/client` (`SseTransport`, `RealtimeModelDelegate`) and `@indigodb/studio` — unchanged by construction.

## Capabilities

### New Capabilities
- `realtime-wal-source`: `WalSource` contract — slot connection, `pgoutput` decode, event-shape parity with `PgNotifySource`, resume-after-disconnect from the slot's confirmed LSN, reconnect/backoff, unknown-table and malformed-message handling, engine default.
- `realtime-replication-ddl`: publication + slot emission for push and versioned migrations, idempotency, ordering, NOTIFY-object retirement diff, `wal_level` preflight diagnostics.

### Modified Capabilities
- `ci-pipeline`: adds a fourth independent job running a real Postgres service container; `ts` stays Postgres-free and Rust-free.

## Approach

`wal-source.ts` mirrors `source.ts`'s existing structure — same `ResolvedSchema`-derived `Map<dbTable, {model, columns}>`, same `start(onEvent, onError)`/`stop()` surface, same exponential backoff (1s→30s) — but its transport is a `pg-logical-replication` `LogicalReplicationService` in `pgoutput` mode instead of a `LISTEN`ing `pg.Client`. `pgoutput` relation messages carry column names, so `translate()` reuses the physical→schema rename logic rather than parsing a JSON payload; begin/commit framing is consumed but not surfaced (no transactional batching in this slice). Acknowledged LSNs are the only durable state, and they live in the slot, so `WalSource` stores nothing locally.

On the DDL side, `postgres.ts` gains `renderCreatePublication`/`renderDropPublication` and a slot ensure/drop block following the existing idempotent `DO $$` pattern used by `renderCreateTrigger`, while the notify function/trigger renderers are deleted from the emit path and replaced in `migrate.ts` by drop statements so existing databases converge. Library choice is `pg-logical-replication` (maintained, decodes `pgoutput` natively so no `wal2json` server extension is required — many managed hosts do not offer it — and ships TS types).

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `packages/realtime/src/wal-source.ts` | New | `WalSource implements RealtimeSource` |
| `packages/realtime/src/engine.ts` | Modified | default source becomes `WalSource` |
| `packages/realtime/src/{protocol,index}.ts` | Modified | export `WalSource`; doc comments updated (no interface change) |
| `packages/realtime/src/source.ts` | Modified | `PgNotifySource` retained, marked non-default |
| `packages/realtime/package.json` | Modified | `pg-logical-replication` dependency |
| `packages/migrator/src/postgres.ts` | Modified | publication + slot DDL; notify trigger emission removed |
| `packages/migrator/src/migrate.ts` | Modified | publication/slot diff; drop legacy notify objects |
| `packages/cli/src/` | Modified | `wal_level` preflight for `db push` / `migrate deploy` |
| `.github/workflows/ci.yml` | Modified | new `postgres` job |
| `packages/realtime/test/` | New | real-Postgres harness + parity/resume tests |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Orphaned slot retains WAL and fills disk | High | Slot is schema-state-owned: dropped when the last `@@realtime` table goes away; documented as the top operational caveat |
| Managed hosts cannot set `wal_level=logical` | High | Accepted: hard preflight error with the exact remedy. No fallback by decision |
| Existing deployments break at cutover | Med | Migration drops notify objects and creates the publication/slot in one ordered migration; realtime consumers restart on the new source |
| Event-shape drift between the two sources | Med | Parity is the acceptance bar: same golden `RealtimeEvent` assertions run against both sources |
| New CI job flakiness / longer runs | Med | Independent job, no `needs:` — mirrors `rust`; failures are isolated and visible |
| `pg-logical-replication` pulls a divergent `pg` tree | Med | pnpm dedupe check against the pinned `pg ^8.13.0` at apply time |
| Slot creation needs elevated privileges | Med | Preflight also verifies `REPLICATION` privilege and errors early with the required `GRANT` |

## Rollback Plan

1. Revert `engine.ts`'s default back to `PgNotifySource` and delete `wal-source.ts` + the dependency.
2. Restore the notify function/trigger renderers in `postgres.ts`/`migrate.ts`; a forward migration re-creates the triggers.
3. Manually `DROP PUBLICATION` and `SELECT pg_drop_replication_slot(...)` on already-migrated databases — mandatory, since an unconsumed slot keeps retaining WAL.
4. Remove the `postgres` CI job; `ts`, `rust`, `wasm-drift` are untouched.

## Dependencies

- `main` @ `c019bc3` (slice 1 archived).
- New npm dependency `pg-logical-replication`.
- New CI infrastructure convention: a Postgres service container with `wal_level=logical`.

## Success Criteria

- [ ] `WalSource` emits `RealtimeEvent`s byte-identical in shape to `PgNotifySource` for insert/update/delete on a `@@realtime` model
- [ ] Changes committed while the source is stopped are delivered after restart (the v1 loss gap is closed)
- [ ] No `partial: true` truncation path is needed — full rows arrive regardless of size
- [ ] `db push` on a schema with `@@realtime` creates the publication and slot idempotently; running twice is a no-op
- [ ] Removing the last `@@realtime` model drops the publication and slot in the versioned migration
- [ ] Generated DDL contains no `indigo_notify_trigger`; a migration from a notify-era schema drops the legacy objects
- [ ] `db push` against `wal_level=replica` fails with a clear, actionable error and applies nothing
- [ ] The new `postgres` CI job runs the realtime suite green; `ts` remains Postgres-free
- [ ] `pnpm build`, `lint`, `test` and `cd crates && cargo test` green

## Open Questions

### Resolved

- **Slot naming (multi-tenant deployments sharing one Postgres)** — *Resolved 2026-08-24.*
  The replication slot name is the fixed default **`indigo_realtime`**, overridable through the
  environment variable **`INDIGODB_REALTIME_SLOT`**. The name follows this repo's existing CLI
  env-var convention `INDIGODB_<AREA>_<THING>` (`INDIGODB_STUDIO_HOST`, `INDIGODB_STUDIO_DIST`
  in `packages/cli/src/index.ts`/`studio-server.ts`, `INDIGODB_MIGRATE_PREV` in `migrate-runner.ts`);
  `DATABASE_URL` stays the only unprefixed variable, as the ecosystem-standard connection string.
  Rejected: deriving the slot name per database/schema — it makes the name unpredictable, so
  operators could not find or drop an orphaned slot (the top operational risk in this change),
  and slot names are already database-scoped in Postgres, so derivation only matters when several
  IndigoDB deployments share one database. That case is served explicitly by the override.
  Implications: the same value must be read consistently on both sides of the seam — the DDL
  path (`packages/migrator` slot create/drop, driven by `packages/cli`) and the consumer path
  (`WalSource` in `packages/realtime`) — or `db push` creates one slot while the source connects
  to another. Validation of the override (Postgres slot-name rules: lowercase letters, digits and
  underscores) and a mismatch diagnostic belong to `sdd-spec`/`sdd-design`.

### Still open

None. The change is fully scoped and ready for `sdd-spec` / `sdd-design`.
