# Tasks: WAL logical-replication realtime source

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~380 (A) + ~340 (B) ≈ 720 total, authored risk excludes goldens |
| 400-line budget risk | High as one PR, Medium per slice |
| Chained PRs recommended | Yes |
| Suggested split | PR A → PR B |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|----|----|------------------|--------------------|
| 1 | `WalSource` over `pg-logical-replication`, DDL applied by hand for local testing | A (base=tracker) | `pnpm --filter @indigodb/realtime test` | `packages/realtime/test/{parity,resume}.mjs` (real Postgres, `INDIGODB_TEST_DATABASE_URL`) | Revert PR A only; no DDL/CLI wiring exists yet, no consumer depends on `WalSource` |
| 2 | DDL (slot/publication/replica-identity), notify retirement, preflight, CI job | B (base=A) | `pnpm --filter @indigodb/migrator test` | `packages/realtime/test/pg-harness.mjs` invoked from CI's `postgres` job | Revert PR B; manual `DROP PUBLICATION`/`pg_drop_replication_slot` for already-applied migrations (Migration/Rollout step 3) |

## PR A — `WalSource` (base = tracker)

- [x] A0.1 [SPIKE — MUST run first] Pin `pg-logical-replication` version in `packages/realtime/package.json`; confirm `PgoutputPlugin` message variants (`relation`/`insert`/`update`/`delete`/`begin`/`commit`) against installed types; confirm whether `LogicalReplicationService`'s auto-restart/reconnect can be disabled so `WalSource` owns the single backoff policy. Record findings as apply-time deviation notes if the API differs from design's `Interfaces` section.
- [x] A1.1 [RED] `wal-source.ts`: constructor builds `Map<dbTable,{model,columns}>` from `ResolvedSchema` identically to `source.ts:28-45` (test against fixture schema with 2 `@@realtime` models).
- [x] A1.2 [GREEN] implement the constructor + `models` getter mirroring `source.ts`.
- [x] A2.1 [RED] `translate()`: pgoutput `insert`/`update`/`delete` messages map to `RealtimeEvent` with identical fields (table/op/pk/new/old/txid/ts) to `PgNotifySource`'s shape; unknown table (not in the constructor map) is dropped silently, not emitted.
- [x] A2.2 [RED] malformed/unrecognized message variant routes through `onError`, does not throw or terminate the stream.
- [x] A2.3 [GREEN] implement `translate()` + malformed-message handling.
- [x] A3.1 [RED] `txid` = decimal transaction id from the pgoutput `begin` message (decision 9); `ts` = commit message timestamp formatted `YYYY-MM-DDTHH:MM:SS.mmmZ` (decision 10).
- [x] A3.2 [GREEN] wire `begin`/`commit` message handling to populate `txid`/`ts` on every row event of that transaction.
- [x] A4.1 [RED] reconnect uses the same 1s→30s exponential backoff policy as `PgNotifySource` (`source.ts:96-108`); confirm no second backoff loop runs when the library's own reconnect is disabled per A0.1.
- [x] A4.2 [GREEN] implement backoff on `start()`/reconnect path.
- [x] A5.1 [RED] `acknowledge(commitLsn)` fires only after every row event of that transaction has been dispatched to `onEvent` (decision 11); a crash before ack replays on reconnect (at-least-once).
- [x] A5.2 [GREEN] wire acknowledgement after dispatch, `protoVersion: 1` (decision 12).
- [x] A6.1 [GREEN] `packages/realtime/src/index.ts`: export `WalSource`.
- [x] A6.2 [GREEN] `packages/realtime/src/engine.ts`: default `options.source ?? new WalSource(...)`, keep `PgNotifySource` exported/constructible via `RealtimeEngineOptions.source`.
- [x] A6.3 [GREEN] `packages/realtime/src/protocol.ts`/`source.ts`: doc-comment updates only (LSN-arrives-with-shape-log note per decision 9).
- [x] A7.1 [SPIKE — real PG] `packages/realtime/test/pg-harness.mjs`: gate on `INDIGODB_TEST_DATABASE_URL`, self-skip with a printed notice when unset (decision 14).
- [x] A7.2 [RED — real PG] `packages/realtime/test/parity.mjs`: one DML script drives `PgNotifySource` (notify DDL applied by hand) and `WalSource`; events deep-equal after masking `ts`/`txid`, including full `old` on UPDATE/DELETE.
- [x] A7.3 [RED — real PG] `packages/realtime/test/resume.mjs`: `stop()`, commit N rows, `start()` → all N arrive in order; `pg_terminate_backend` on the replication backend → backoff resumes without gaps.
- [x] A7.4 [RED — real PG] ordering/size: 200 rows across interleaved transactions arrive in commit order; no `partial` truncation on a 1 MB text column.
- [x] A8.1 [GREEN] `packages/realtime/package.json`: add `test` script (Turbo-discoverable, self-skips per A7.1 so `ts` CI job stays Postgres-free).
- [x] A8.2 [VERIFY] `pnpm --filter @indigodb/realtime test` (real PG present) and confirm self-skip when `INDIGODB_TEST_DATABASE_URL` is unset.
- [x] A8.3 [VERIFY] `pnpm build && pnpm lint` (incl. `@indigodb/realtime`).
- [x] A8.4 [COMMIT] `feat(realtime): add WalSource over logical replication`.

## PR B — DDL + preflight + CI (base = PR A)

- [ ] B1.1 [RED] `postgres.ts`: `resolveSlotName(env)` accepts default `indigo_realtime`, honours `INDIGODB_REALTIME_SLOT` override, rejects `Bad-Name`, rejects `x"; DROP TABLE "User` (threat: identifier injection), rejects a 64-char name — all before any SQL is built.
- [ ] B1.2 [GREEN] implement `resolveSlotName` with whitelist `/^[a-z0-9_]{1,63}$/`; export from `@indigodb/migrator`.
- [ ] B2.1 [RED] `renderReplicationPreSql(schema)`: emits guarded-`SELECT` slot creation when ≥1 `@@realtime` model exists, guarded slot drop when none/removed; no `AND NOT active` (drop fails loudly on an active slot).
- [ ] B2.2 [GREEN] implement `renderReplicationPreSql`; wire as pre-transaction phase (mirrors `migrate-runner.ts:294-310`'s existing pre-transaction handling, zero new runner machinery).
- [ ] B3.1 [RED] `renderPublicationSql(schema)`: `DO $$ CREATE PUBLICATION ... EXCEPTION WHEN duplicate_object` then one `ALTER PUBLICATION ... SET TABLE <all realtime tables>`; `DROP PUBLICATION IF EXISTS` when the set is empty; `SET TABLE` never emitted with an empty list.
- [ ] B3.2 [GREEN] implement `renderPublicationSql`.
- [ ] B4.1 [RED] `renderReplicaIdentity(table)`: `FULL` for every `@@realtime` table, `DEFAULT` restored when a table stops being realtime.
- [ ] B4.2 [GREEN] implement `renderReplicaIdentity`.
- [ ] B5.1 [RED] `renderDropLegacyNotify()`: emits `DROP TRIGGER IF EXISTS "indigo_rt_<table>"` + `DROP FUNCTION IF EXISTS indigo_notify_trigger() CASCADE`; confirm `renderNotifyFunction`/`renderCreateTrigger`/`REALTIME_CHANNEL` (postgres.ts:250-308) are removed from the emit path, not just unused.
- [ ] B5.2 [GREEN] implement `renderDropLegacyNotify`; delete the 5 identified call sites across `postgres.ts` (block 5 rewrite, `postgres.ts:533-581`) and `migrate.ts` (`migrate.ts:369`, `857-860`, `949-954`, `873`/`1044-1051` phase tagging).
- [ ] B6.1 [RED] `migrate.ts` diff: adding `@@realtime` → migration includes slot pre-transaction statement + publication `SET TABLE` + `REPLICA IDENTITY FULL` + legacy `DROP TRIGGER`/`DROP FUNCTION`; removing the last `@@realtime` model → slot AND publication both drop; ordering keeps publication/slot creation before dependent DDL.
- [ ] B6.2 [GREEN] wire the diff into `diffTable`/schema-level diff per design's ordering requirement.
- [ ] B7.1 [RED — threat: SQL injection via schema identifiers] a quote-bearing `@map` table/column name renders safely through existing `quoteIdent` in all new renderers, never interpolated raw.
- [ ] B7.2 [GREEN] confirm/route all new renderers through `quoteIdent`/`escapeLiteral`.
- [ ] B8.1 [RED] `packages/cli/src/util.ts`: `assertLogicalReplication(client)` — `SHOW wal_level` ≠ `logical` fails with an error naming `ALTER SYSTEM SET wal_level = logical` + restart, applies nothing; passing role without `rolsuper`/`rolreplication` fails naming the required `ALTER ROLE <user> REPLICATION`; preflight runs only when the schema has ≥1 `@@realtime` model, before any DDL.
- [ ] B8.2 [GREEN] implement `assertLogicalReplication`; wire into `db push` and `migrate deploy` in `cli/src/index.ts` (near `cli/src/index.ts:89-112`).
- [ ] B9.1 [GREEN] `cli/src/index.ts`: two-phase push — execute `renderReplicationPreSql` statement-by-statement before `renderPushSql`; `--print` prints both blocks, slot block first (decision 2).
- [ ] B10.1 [VERIFY] `node packages/migrator/test/regen-goldens.mjs` — review diff (realtime added / removed / last-one-removed / `@map`-renamed / notify-era prev → legacy drops fixtures).
- [ ] B10.2 [VERIFY] `pnpm --filter @indigodb/migrator test`.
- [ ] B11.1 [GREEN] `.github/workflows/ci.yml`: add fourth job `postgres`, no `needs:` (mirrors `rust` job's isolation) — `docker run -d ... -c wal_level=logical` + `pg_isready` wait loop (NOT a `services:` block, decision 13), runs `pnpm --filter @indigodb/realtime test` against real Postgres.
- [ ] B11.2 [RED — threat: shell/process integration] confirm the new job carries no elevated `permissions:`, no push capability, default `permissions: contents: read`.
- [ ] B11.3 [VERIFY] a second local run without `-c wal_level=logical` → `db push` exits non-zero, applies nothing (preflight proof).
- [ ] B12.1 [VERIFY] `pnpm build && pnpm lint && pnpm test` (workspace-wide; no `crates/` touched this slice, WASM rebuild rule does not apply).
- [ ] B12.2 [COMMIT] `feat(migrator,cli): replicate @@realtime via WAL logical replication, retire NOTIFY triggers`.

## Post-slice cleanup

- [ ] C1 Confirm proposal Success Criteria fully met across PR A–B (parity, no-loss-on-reconnect, backoff, idempotent DDL, legacy retirement, preflight, CI).
- [ ] C2 Merge the 2 new full specs (`realtime-wal-source`, `realtime-replication-ddl`) and the `ci-pipeline` delta into `openspec/specs/` once this change archives.
- [ ] C3 Log follow-up (non-blocking): `REPLICA IDENTITY FULL` WAL cost — revisit narrowing `old` once the shape log defines it.
- [ ] C4 Log follow-up (non-blocking): ack point is commit-granular — revisit moving behind subscriber flush if SSE back-pressure becomes real (slice 3).
