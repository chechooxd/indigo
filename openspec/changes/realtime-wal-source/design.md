# Design: WAL logical-replication realtime source

Verified live against `main` @ `c019bc3`: `protocol.ts:16-46` (`RealtimeEvent`, `RealtimeSource`),
`source.ts:19` (`CHANNEL`), `28-45` (the `Map<dbTable,{model,columns}>` built from `ResolvedSchema`),
`96-108` (1s→30s backoff), `110-142` (`translate`), `engine.ts:50-59` (`options.source ?? new
PgNotifySource`), `postgres.ts:250-308` (`REALTIME_CHANNEL`, `renderNotifyFunction`,
`renderCreateTrigger`/`renderDropTrigger`), `533-581` (`renderPushSql`'s 6 numbered blocks),
`migrate.ts:369` (trigger on `createTable`), `857-860` (realtime toggle), `949-954` (notify function
emission), `873`/`1044-1051` (`phase` tagging, `NO_TRANSACTION_*` markers),
`migrate-runner.ts:294-310` (pre-transaction statements run *before* `BEGIN`, one `query()` each),
`cli/src/index.ts:89-112` (`db push` = one `client.query(sql)`), `ci.yml:66-118` (three jobs, no `needs:`).

## Technical Approach

    @@realtime  ──resolve──▶  ResolvedTable.realtime
       │
       ├── postgres.ts / migrate.ts ── DDL, two phases
       │      pre-transaction:  SELECT pg_create_logical_replication_slot('indigo_realtime','pgoutput') …
       │      transaction:      CREATE PUBLICATION indigo_realtime; ALTER PUBLICATION … SET TABLE …;
       │                        ALTER TABLE … REPLICA IDENTITY FULL;
       │                        DROP TRIGGER indigo_rt_*; DROP FUNCTION indigo_notify_trigger()   ← retirement
       │
       └── packages/realtime/wal-source.ts
              LogicalReplicationService(pgoutput) ──relation/insert/update/delete──▶ translate()
                          │                                                              │
                          └── commit ──▶ acknowledge(lsn)                    RealtimeEvent (unchanged shape)
                                                                                         │
                                                                              engine.ts dispatch (untouched)

`wal-source.ts` is a structural sibling of `source.ts`: same constructor-built name map, same
`start/stop` surface, same 1s→30s backoff, same drop-unknown-table rule. Only the transport differs.
`protocol.ts`, `engine.ts`'s fan-out, `@indigodb/client` and the studio are untouched by construction.

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| 1 | Slot DDL placement | Slot create/drop is tagged **`pre-transaction`** (`migrate.ts`'s existing phase), and `db push` runs it as separate `query()` calls *before* the main script | one script; a new `post-transaction` phase | `pg_create_logical_replication_slot` fails with `cannot create logical replication slot in transaction that has performed writes`. Push sends its whole script as one implicit transaction, so slot DDL cannot live in it. Pre-transaction already exists for enum `ADD VALUE` and `migrate-runner.ts:307-310` already runs it outside `BEGIN` — zero new runner machinery |
| 2 | Push execution shape | New exported `renderReplicationPreSql(schema): string[]`; `db push` executes it statement-by-statement before `renderPushSql`, and `--print` prints both, slot block first | fold into `renderPushSql`'s string | `--print` must stay a faithful transcript of what executes. Keeping two artifacts makes the transaction boundary visible instead of implied |
| 3 | Idempotency form | `SELECT pg_create_logical_replication_slot($name,'pgoutput') WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = $name);` | `DO $$ … EXCEPTION WHEN duplicate_object` | Slot functions raise `object_in_use`/generic errors, not `duplicate_object`, so the repo's `DO`-guard pattern does not apply. A guarded `SELECT` performs no write, which decision 1 depends on |
| 4 | Dropping an active slot | Guard on **existence only**; a slot held by a running consumer makes the statement fail loudly, and the CLI maps `replication slot "…" is active` to "stop `indigodb realtime` first" | `AND NOT active` (silent skip) | Silent skip is exactly how an orphaned slot retains WAL forever — the change's top operational risk (proposal Risks). Failing a migration is recoverable; silent WAL retention is not |
| 5 | Publication convergence | `DO $$ CREATE PUBLICATION … EXCEPTION WHEN duplicate_object THEN null; END $$;` then a single `ALTER PUBLICATION … SET TABLE <all realtime tables>`; `DROP PUBLICATION IF EXISTS` when the set is empty | per-table `ADD TABLE`/`DROP TABLE` diffing | `SET TABLE` is declarative — add, remove and reorder converge in one statement, so push and the versioned diff cannot disagree. `CREATE PUBLICATION` has no `IF NOT EXISTS`, so the existing `DO` guard (`renderEnum`, `renderForeignKey`) is reused verbatim. `SET TABLE` rejects an empty list, hence the drop branch |
| 6 | One name for slot + publication | Both are `indigo_realtime`, both from `INDIGODB_REALTIME_SLOT`; resolved by one exported `resolveSlotName(env)` in `@indigodb/migrator`, imported by `packages/cli` and `packages/realtime` | separate `INDIGODB_REALTIME_PUBLICATION` | Decision 6 (Engram #709) chose predictability so an operator can find and drop orphans. Two variables double the mismatch surface the decision was written to close. Single resolver = the DDL side and `WalSource` cannot diverge |
| 7 | Name validation | `resolveSlotName` rejects anything outside `/^[a-z0-9_]{1,63}$/` with a named error, before any SQL is built | quote/escape and accept | Postgres slot names accept only that alphabet, so validation is a *total* check, not a mitigation — and it removes identifier injection through the env var (threat matrix) by construction rather than by escaping |
| 8 | `REPLICA IDENTITY FULL` | Emitted for every `@@realtime` table; `DEFAULT` restored when a table stops being realtime | leave the default | **Parity requires it.** `pgoutput` under the default replica identity sends only key columns in the old tuple, so `event.old` for UPDATE/DELETE would be a PK stub while `PgNotifySource` sends the whole row. Cost is WAL volume; that is the price of the stated acceptance bar |
| 9 | `txid` semantics | Decimal transaction id from the pgoutput `begin` message — same meaning as v1's `txid_current()::text` | the commit LSN (which `protocol.ts:28` anticipates) | Parity-only slice; LSN addressing is slice 3's contract. Changing the field's meaning now would silently break any consumer that de-duplicates on it. `protocol.ts:28`'s doc comment is updated to say the LSN arrives with the shape log |
| 10 | `ts` semantics | pgoutput `commit` message timestamp, formatted to the same `YYYY-MM-DDTHH:MM:SS.mmmZ` shape the trigger emits | per-row wall clock at decode time | Keeps `ts` transaction-scoped and server-authoritative, as v1's `clock_timestamp()` was. Documented deviation: v1 stamped statement time, v2 stamps commit time; the format and ordering guarantees are identical |
| 11 | Acknowledgement point | `acknowledge(commitLsn)` **after** every row event of that transaction has been handed to `onEvent` | ack per row; ack on receipt | Acking before dispatch reintroduces the loss window this slice exists to close. Consequence: delivery becomes **at-least-once** (v1 was at-most-once) — a crash between dispatch and ack replays the transaction. Acceptable: `RealtimeModelDelegate` already refetches by pk, so a replayed event is idempotent at the consumer |
| 12 | pgoutput protocol version | `protoVersion: 1` | `2` | v2 adds `stream_*` messages for in-progress transactions, which would need a whole buffering path for zero parity benefit |
| 13 | CI Postgres transport | A **`docker run` step**, not `services:` | `services: postgres:` | GitHub Actions' `services.<id>.options` maps to `docker create` flags and **cannot pass container command arguments**, so `-c wal_level=logical` is unreachable there. Postgres defaults to `wal_level=replica`, so a service container cannot host this suite at all |
| 14 | Test gating | The realtime suite reads `INDIGODB_TEST_DATABASE_URL` and skips with a printed notice when unset | always-on; a separate script name | `packages/realtime` gains a `test` script that Turbo picks up, so it also runs inside the `ts` job — self-skipping is what keeps `ts` Postgres-free (`ci.yml:12-14`) while the `postgres` job sets the variable and gets full coverage |

## Interfaces

```ts
// packages/migrator/src/postgres.ts — replication lifecycle (exported; migrate.ts + cli reuse)
export function resolveSlotName(env?: NodeJS.ProcessEnv): string;      // decisions 6/7
export function renderReplicationPreSql(schema: ResolvedSchema): string[];   // slot create|drop
export function renderPublicationSql(schema: ResolvedSchema): string[];      // create/SET TABLE|drop
export function renderReplicaIdentity(table: ResolvedTable): string;         // FULL | DEFAULT
export function renderDropLegacyNotify(): string;                            // DROP FUNCTION … CASCADE
// removed from the emit path: renderNotifyFunction, renderCreateTrigger, REALTIME_CHANNEL

// packages/realtime/src/wal-source.ts
export class WalSource implements RealtimeSource {
  constructor(connectionString: string, schema: ResolvedSchema, options?: { slot?: string });
  get models(): string[];
  start(onEvent, onError): Promise<void>;
  stop(): Promise<void>;
}

// packages/cli/src/util.ts
export async function assertLogicalReplication(client: pg.Client): Promise<void>;
```

`assertLogicalReplication` runs only when the schema has a `@@realtime` table, before any DDL:
`SHOW wal_level` ≠ `logical` → error naming the exact remedy (`ALTER SYSTEM SET wal_level =
logical` + restart, and that IndigoDB cannot do it); then `SELECT rolsuper OR rolreplication FROM
pg_roles WHERE rolname = current_user` false → error naming `ALTER ROLE <user> REPLICATION`.
Nothing is applied when either check fails.

Emitted shape for `model Post { … @@realtime }` (push, pre-transaction block then main script):

```sql
SELECT pg_create_logical_replication_slot('indigo_realtime', 'pgoutput')
WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'indigo_realtime');
-- ── main script ──
DO $$ BEGIN CREATE PUBLICATION "indigo_realtime"; EXCEPTION WHEN duplicate_object THEN null; END $$;
ALTER PUBLICATION "indigo_realtime" SET TABLE "Post";
ALTER TABLE "Post" REPLICA IDENTITY FULL;
DROP TRIGGER IF EXISTS "indigo_rt_Post" ON "Post";
DROP FUNCTION IF EXISTS indigo_notify_trigger() CASCADE;
```

## File Changes

| File | PR | Action | Description |
|---|---|---|---|
| `packages/realtime/src/wal-source.ts` | A | Create | `WalSource`; decode, translate, backoff, ack |
| `packages/realtime/package.json` | A | Modify | `pg-logical-replication` dep; `test` script (decision 14) |
| `packages/realtime/src/index.ts` | A | Modify | export `WalSource` |
| `packages/realtime/src/engine.ts` | A | Modify | `options.source ?? new WalSource(...)` (`engine.ts:51-53`) |
| `packages/realtime/src/{protocol,source}.ts` | A | Modify | doc comments only — `txid`/LSN (decision 9), `PgNotifySource` marked non-default |
| `packages/realtime/test/{pg-harness,parity,resume}.mjs` | A | Create | real-Postgres harness + suites |
| `packages/migrator/src/postgres.ts` | B | Modify | five new renderers; delete `renderNotifyFunction`/`renderCreateTrigger`/`REALTIME_CHANNEL`; `renderPushSql` block 5 rewritten |
| `packages/migrator/src/migrate.ts` | B | Modify | slot statements (`pre-transaction`), publication/replica-identity diff, legacy-notify drops; remove `369`/`857-860`/`949-954` trigger paths |
| `packages/migrator/test/fixtures/*` | B | Modify | regenerated goldens (`regen-goldens.mjs`) |
| `packages/cli/src/{util,index}.ts` | B | Modify | `assertLogicalReplication`; two-phase `db push`; `migrate deploy` preflight |
| `.github/workflows/ci.yml` | B | Modify | fourth job `postgres`, no `needs:` |

## Testing Strategy

| Layer | What | How |
|---|---|---|
| Unit (no DB) | `resolveSlotName` accepts the default, honours the override, rejects `Bad-Name`, `"; DROP …`, 64 chars | plain Node assertions in `packages/realtime/test` |
| Migrator golden | realtime added / removed / last-one-removed / `@map`-renamed / notify-era prev schema → legacy drops | `packages/migrator/test/migrator.mjs` + `regen-goldens.mjs` |
| Migrator unit | slot statements carry `phase: "pre-transaction"`; `SET TABLE` never emitted with an empty list; generated SQL contains no `indigo_notify_trigger` | assertions over `planMigration` |
| Integration (real PG) | **Parity**: same INSERT/UPDATE/DELETE script drives `PgNotifySource` (notify DDL applied manually) and `WalSource`; events deep-equal after masking `ts`/`txid` — including full `old` on UPDATE/DELETE, which is decision 8's RED test | `packages/realtime/test/parity.mjs` |
| Integration (real PG) | **No loss on reconnect** (the bug): `stop()`, commit N rows, `start()` → all N arrive in order. Second case: kill the replication connection server-side (`pg_terminate_backend`) and assert backoff resumes without gaps | `packages/realtime/test/resume.mjs` |
| Integration (real PG) | **Ordering**: 200 rows across interleaved transactions arrive in commit order; **no `partial`** on a 1 MB text column (the v1 8000-byte path) | same harness |
| Integration (real PG) | Push idempotency: `db push` twice is a no-op; dropping the last `@@realtime` model removes slot *and* publication | harness against a scratch database |
| Preflight | `wal_level=replica` container → `db push` exits non-zero, applies nothing (`\dt` unchanged) | second container in the `postgres` job, started without `-c wal_level=logical` |

## Threat Matrix

Routing, subprocess, VCS/PR automation and executable-file classification rows are `N/A`. Three rows apply:

| Row | Safe behavior | RED test |
|---|---|---|
| Identifier injection via `INDIGODB_REALTIME_SLOT` | Whitelist-validated before any SQL is built (decision 7); never escaped-and-accepted | `INDIGODB_REALTIME_SLOT='x"; DROP TABLE "User'` → named error, zero SQL emitted |
| Shell/process integration (new CI job) | The `postgres` job has no `needs:`, default `permissions: contents: read`, and never pushes — only `wasm-drift` holds write | reviewed as part of the workflow diff; no secret is exposed to the container |
| Privilege escalation via preflight | Preflight only *reads* (`SHOW`, `pg_roles`); it never attempts `ALTER SYSTEM` or `ALTER ROLE` on the user's behalf | run as a non-replication role: exits with the `GRANT` instruction, applies nothing |

## Migration / Rollout

Direct cutover, no dual-write (decision 4, Engram #709). A notify-era database converges in one
migration: legacy trigger + function dropped, publication and slot created, `REPLICA IDENTITY FULL`
set. Operators must restart realtime consumers after deploy — the source changes, the wire does not.
Order per PR: `pnpm build && pnpm lint && pnpm test`, then `node packages/migrator/test/regen-goldens.mjs`
(the diff is the review artifact), then the real-Postgres suite locally via
`INDIGODB_TEST_DATABASE_URL`. No `crates/` change, so **no WASM rebuild and no snapshot regen** in
this slice. Rollback is the proposal's four steps; step 3 (manual `DROP PUBLICATION` +
`pg_drop_replication_slot`) is mandatory — a reverted binary leaves a slot that still retains WAL.

## Slice Plan

Two chained PRs (B targets A). `400-line budget risk: High` as one PR, `Medium` per slice.
`Chained PRs recommended: Yes`. `Decision needed before apply: No`.

- **PR A — source + tests.** `wal-source.ts`, dependency, engine default, exports, the real-Postgres
  harness and the three suites. Self-contained: the DDL can still be applied by hand, so A is
  testable without B. ≈ 380 authored lines.
- **PR B — DDL, preflight, CI.** `postgres.ts`, `migrate.ts`, `cli`, the `postgres` job, goldens.
  ≈ 340 authored lines (goldens excluded from authored risk).

## Risks (design-level, beyond the proposal's)

| Risk | Mitigation |
|---|---|
| **`services:` cannot set `wal_level`** (decision 13) — the proposal's wording would have produced a job that cannot work | `docker run -d … postgres:17 -c wal_level=logical` as an ordinary step, with a `pg_isready` wait loop; the second, `replica`-level container reuses the same step shape |
| **`REPLICA IDENTITY FULL` was not in the proposal** (decision 8) and materially raises WAL volume per update | Documented as an operational caveat next to the orphan-slot one. It is not optional: without it the parity acceptance bar fails on `old` |
| `pg-logical-replication`'s surface is thinner than its README implies — `LogicalReplicationService` owns its own reconnect and its `data` callback is `(lsn, message)` with a union-typed message | **PR A must open with a spike** pinning the exact version, confirming `PgoutputPlugin` message variants and that the service's own auto-restart can be disabled so `WalSource` owns the single backoff policy (`source.ts:96-108`) |
| A replication connection cannot cross PgBouncer in transaction/statement pooling mode | `WalSource` opens its own connection from the same string; documented so operators point it at the direct port. Detection is out of scope this slice |
| `pg-logical-replication` may pull a second `pg` tree | `pnpm why pg` at apply time; a root `pnpm.overrides` pin is the fallback |
| At-least-once replaces at-most-once (decision 11) | Consumer-side already idempotent (`realtime-delegate.ts` refetches by pk); called out in the source's doc comment |

## Open Questions

- [ ] Non-blocking: `REPLICA IDENTITY FULL` on a table with a very wide row is expensive. A future
      slice could narrow `old` to changed columns once the shape log defines what `old` means.
- [ ] Non-blocking: the ack point (decision 11) is commit-granular. If SSE back-pressure ever
      becomes real, ack should move behind subscriber flush — a slice-3 concern.
