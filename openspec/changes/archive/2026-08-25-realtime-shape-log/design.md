# Design: LSN-keyed shape log with pre-evaluated bucket auth

Verified live against `main` @ `c019bc3`: `wal-source.ts:173-179` (the `data` handler is
**synchronous**), `212-276` (`handleMessage`; `commit` at `238-261`, `commitLsn` at `244`,
ack at `259`), `100-116` (constructor's realtime-table map), `134-143` (`stop()`),
`protocol.ts:16-39` (`RealtimeEvent`, `txid` doc comment), `core/src/ir.ts:165-182`
(`AllowOperand` — **includes `string`/`number`/`boolean` literals**), `186-215`
(`ResolvedTable.allow`, absent vs empty), `postgres.ts:344-354` (`renderPublicationSql`,
empty→`DROP PUBLICATION`), `378` (`AUTH_SETTING`), `426-456` (`renderOperand`/
`renderCondition` — emits only `left = right` over **this table's own columns**),
`466-480` (`renderPolicy`), `565-585` (`renderRlsBlock`: `undefined`→`[]`, `[]`→disable),
`591-643` (`renderPushSql`'s 6 blocks), `migrate.ts:61-74` (`safe`/`forced`), `976-996`
(realtime preamble), `1049-1062` (publication after 3c, then dropped tables),
`introspect.ts:47-52,305,334` (`exclude` defaults to `["_indigo_migrations"]`),
`migrate-runner.ts:144-157` (`_indigo_migrations` idempotent DDL),
`crates/.../validate.rs:86-97` (the `@@realtime` + `@@allow` guard), `837-858` (accepted
operand pairs).

## Technical Approach

```
@@realtime ──▶ postgres.ts / migrate.ts ──▶ CREATE TABLE _indigo_realtime_log (+ RLS)
                                              excluded from introspection

WalSource                                                     writer: ordinary pg.Client
  service.on("data") ─sync─▶ handleMessage
       begin/insert/update/delete → this.pending (unchanged)
       commit → capture (batch, commitLsn, txid, ts), reset buffers, then
                enqueue on a serial promise chain:
                   INSERT … VALUES (…),(…)  ──▶ onEvent(...) ──▶ acknowledge(lsn)
                          │
                          └─ on failure: no dispatch, no ack, tear the stream down
```

The log table is IndigoDB-owned bookkeeping in the user's own database, exactly like
`_indigo_migrations`: `_indigo_`-prefixed, idempotent DDL, no separate metadata store. Its
lifecycle is bound to realtime itself (created when any table is `@@realtime`, dropped when
none is), mirroring how `renderPublicationSql` already handles the publication.

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| 1 | Async ordering in a sync handler | The `commit` case captures `(batch, commitLsn, txid, ts)`, resets `pending`/`txid` synchronously, then appends `insert → dispatch → ack` to a **serial promise chain** (`this.chain = this.chain.then(...)`); `stop()` awaits it | `await` inside the handler; per-commit fire-and-forget | `service.on("data")` (`173`) is sync and keeps delivering while a write is in flight. Without a chain, two commits' inserts and acks interleave and LSN order is lost. This is the single largest new failure mode in the slice |
| 2 | Failure handling | A failed INSERT dispatches nothing, acks nothing, and **tears the replication connection down** (`service.stop()` + `scheduleReconnect`) | log the error and continue with the next commit | Ack is monotonic: acking a *later* commit implicitly confirms the failed one, so "skip and continue" silently loses the transaction the retry was supposed to preserve. Only a teardown makes redelivery real |
| 3 | Ordering vs. dispatch | insert → dispatch → ack (proposal decision 6) | dispatch → insert → ack | A dispatched-but-unlogged event is an unfillable hole; a logged-but-undispatched one is recovered on reconnect. Cost: dispatch latency now includes one round trip |
| 4 | Table shape | One shared `_indigo_realtime_log`, `id bigserial PRIMARY KEY` + `lsn pg_lsn NOT NULL`; canonical order is `ORDER BY lsn, id` | `lsn` as PK | Many rows share one commit LSN, so `lsn` is not unique. `bigserial` supplies intra-transaction order; with one exclusive slot there is exactly one writer, so id order == commit order |
| 5 | Introspection exclusion | Add `"_indigo_realtime_log"` to `introspect.ts:305`'s default `exclude` | leave it | **Without this, shadow-replay/introspection sees the log as a user table and `planMigration` emits `DROP TABLE "_indigo_realtime_log" CASCADE`**, breaking the round-trip no-op invariant. Same reason `_indigo_migrations` is already excluded |
| 6 | RLS on the log | `ENABLE` + `FORCE`, one `FOR SELECT` policy on `buckets`, **plus an explicit `FOR INSERT WITH CHECK (true)`** | ENABLE without FORCE; SELECT policy only | `FORCE` is required or the owning role bypasses RLS entirely (`renderRlsBlock`'s own rationale). But under `FORCE` with no INSERT policy, **the WalSource writer's own INSERT fails** with "new row violates row-level security policy". No UPDATE/DELETE policy is emitted, which makes the log append-only by construction |
| 7 | Policy construction | Hand-written SQL reusing `AUTH_SETTING` and the `NULLIF(current_setting(…), '')` idiom; policy names follow `policyName`'s `indigo_p_<table>_<action>_<n>` shape | call `renderPolicy` verbatim (as the proposal states) | `renderCondition` (`449-456`) can only emit `left = right` against a `ResolvedTable`'s own columns. `buckets IS NULL OR … = ANY(buckets)` is outside that grammar and the log table has no `ResolvedTable`. The *mechanism* (`AUTH_SETTING`, the empty-string guard, naming) is reused; the renderer is not |
| 8 | Bucket vocabulary | Handle **all four** accepted operand pairs, not just `field == claim` | assume the closed `field == claim` grammar the proposal describes | `AllowOperand` carries literals (`ir.ts:165-171`) and `validate.rs:837-858` rejects only claim-vs-literal and literal-vs-literal. `field == literal`, `field == field` and `claim == claim` all reach the IR |
| 9 | Bucket semantics | `NULL` = no `read` rules at all (public). `text[]` = the claim values that satisfy a `field == claim` rule. `{}` = read rules exist but none is satisfiable (deny-all). A caller-independent rule (`field == literal`, `field == field`, `claim == claim`) that the row satisfies collapses the whole array to `NULL` | one flat "empty means public" rule | Mirrors `renderRlsBlock`'s existing `undefined` vs `[]` split exactly. Collapsing to `NULL` is correct because a caller-independent PERMISSIVE rule grants read to everyone, and PERMISSIVE rules OR together |
| 10 | Bucket key type | `text[]`; values are `String(value)`, and a `NULL` field value contributes **no** element | typed per-model columns | One shared heterogeneous table cannot carry per-model types, and `current_setting` is text. A NULL field never satisfies `col = claim` (SQL NULL), so emitting it would be a false grant |
| 11 | UPDATE buckets | Union of the bucket values derived from `new` **and** `old` | `new` only | With `REPLICA IDENTITY FULL` both tuples are present. If `ownerId` changes, the losing owner must still observe the row leaving their view |
| 12 | Batch granularity | One multi-row parameterized INSERT per WAL transaction | one INSERT per row | Proposal decision 8; one round trip on the hot path. Parameterized (`pg` placeholders), never string-built — the payload is user data |
| 13 | `db push` drop branch | When no table is `@@realtime`, push emits `DROP TABLE IF EXISTS "_indigo_realtime_log";`; in `migrate.ts` the same drop is `forced(...)` with an explicit impact string | `safe()` | Dropping the log destroys realtime history. `forced` routes it through the same `--force` gate as `DROP TABLE`, matching how the migrator already treats data loss |
| 14 | No feedback loop | The log table is never added to the publication (`renderPublicationSql` filters on `t.realtime`, and the log has no `ResolvedTable`) | explicit exclusion statement | The loop is impossible by construction; asserted in a test rather than defended with DDL |

## Interfaces

```ts
// packages/migrator/src/postgres.ts (exported; migrate.ts + tests reuse)
export const REALTIME_LOG_TABLE = "_indigo_realtime_log";
export function renderRealtimeLogSql(schema: ResolvedSchema): string[];  // create+indexes+RLS | drop
export function computeBuckets(                                          // pure, PR B
  table: ResolvedTable,
  row: Record<string, unknown>,        // physical column names
  old?: Record<string, unknown>,
): string[] | null;                    // null = public, [] = deny-all

// packages/realtime/src/protocol.ts
export interface RealtimeEvent<Row = …> { …; lsn?: string; }   // "X/Y" hex, additive
```

```sql
CREATE TABLE IF NOT EXISTS "_indigo_realtime_log" (
  id         bigserial PRIMARY KEY,
  lsn        pg_lsn      NOT NULL,
  txid       text,
  table_name text        NOT NULL,
  op         text        NOT NULL CHECK (op IN ('INSERT','UPDATE','DELETE')),
  pk         jsonb       NOT NULL,
  "new"      jsonb,
  "old"      jsonb,
  ts         timestamptz NOT NULL,
  buckets    text[]
);
CREATE INDEX IF NOT EXISTS "_indigo_realtime_log_lsn_idx"   ON "_indigo_realtime_log" (lsn, id);
CREATE INDEX IF NOT EXISTS "_indigo_realtime_log_table_idx" ON "_indigo_realtime_log" (table_name, lsn, id);
CREATE INDEX IF NOT EXISTS "_indigo_realtime_log_buckets_idx" ON "_indigo_realtime_log" USING gin (buckets);

ALTER TABLE "_indigo_realtime_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "_indigo_realtime_log" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "indigo_p__indigo_realtime_log_read_0" ON "_indigo_realtime_log";
CREATE POLICY "indigo_p__indigo_realtime_log_read_0" ON "_indigo_realtime_log"
  AS PERMISSIVE FOR SELECT
  USING (buckets IS NULL OR NULLIF(current_setting('app.user_id', true), '') = ANY (buckets));
DROP POLICY IF EXISTS "indigo_p__indigo_realtime_log_create_0" ON "_indigo_realtime_log";
CREATE POLICY "indigo_p__indigo_realtime_log_create_0" ON "_indigo_realtime_log"
  AS PERMISSIVE FOR INSERT WITH CHECK (true);
```

## File Changes

| File | PR | Action | Description |
|---|---|---|---|
| `packages/migrator/src/postgres.ts` | A/B | Modify | `REALTIME_LOG_TABLE`, `renderRealtimeLogSql` (A: table+indexes; B: RLS block), wired into `renderPushSql` block 5 |
| `packages/migrator/src/migrate.ts` | A/B | Modify | Emit create/drop in the `prevHasRealtime !== nextHasRealtime` branch (`990-992`), drop as `forced` |
| `packages/migrator/src/introspect.ts` | A | Modify | Default `exclude` gains `_indigo_realtime_log` (decision 5) |
| `packages/migrator/src/index.ts` | A | Modify | Export the new symbols |
| `packages/realtime/src/wal-source.ts` | A/B | Modify | Second `pg.Client`, serial write chain, `commit` rewrite; B passes `buckets` |
| `packages/realtime/src/protocol.ts` | A | Modify | `lsn?: string`; replace the `txid` doc comment's forward reference |
| `packages/migrator/test/fixtures/*` | A | Modify | Regenerated goldens (`regen-goldens.mjs`) |
| `packages/realtime/test/{log,buckets}.mjs` | A/B | Create | Real-Postgres suites on slice 2's `postgres` lane |

## Testing Strategy

| Layer | What | How |
|---|---|---|
| Unit (no DB) | `computeBuckets`: `field == claim` (single/multi/union of new+old), NULL field → skipped, `field == literal` satisfied → `null`, unsatisfied → excluded, `create`-only rules → `[]`, `allow: []` → `[]`, `allow: undefined` → `null` | Hand-constructed `ResolvedTable` IR — **not `.indigo` source** (see risks) |
| Migrator golden | first `@@realtime` added → create; last removed → `forced` drop; second realtime table added → no log DDL churn | `packages/migrator/test/migrator.mjs` + `regen-goldens.mjs` |
| Migrator unit | `planMigration(introspectResolvedSchema(db), next)` is empty after a push that created the log (the decision-5 RED test) | `introspect.mjs` round-trip |
| Integration (real PG) | Ordering: 200 rows over interleaved transactions → `ORDER BY lsn, id` matches commit order; batch = one INSERT per transaction | `packages/realtime/test/log.mjs` |
| Integration (real PG) | Durability: revoke INSERT / drop the table mid-stream → no `onEvent`, no ack, connection torn down; restore and restart → the transaction is redelivered (decisions 1–3) | same harness |
| Integration (real PG) | RLS: the writer inserts under `FORCE` RLS (decision 6's RED test); a non-superuser `SET app.user_id` SELECT returns wildcard + own-bucket rows only; `buckets = NULL` visible to everyone | `packages/realtime/test/buckets.mjs` |
| Integration (real PG) | Push idempotency: `db push` twice is a no-op; the log table never appears in the publication (decision 14) | scratch database |

## Threat Matrix

Routing, subprocess, VCS/PR automation and executable-file classification rows are `N/A`.

| Row | Safe behavior | RED test |
|---|---|---|
| SQL injection through logged row data | The INSERT is fully parameterized; no row value is ever concatenated into SQL | A row whose text column is `'); DROP TABLE "User"; --` round-trips as data |
| Identifier injection into the log DDL | `REALTIME_LOG_TABLE` is a module constant, never schema- or env-derived | Static: no interpolation site exists |
| Privilege escalation via the log | Read is RLS-gated by `buckets`; no UPDATE/DELETE policy exists, so the log is append-only for any non-bypassing role | Non-superuser `UPDATE`/`DELETE` on the log affects 0 rows |

## Migration / Rollout

Additive. An existing realtime database gains the table on the next `db push` / `migrate deploy`;
the log starts empty, so history begins at that LSN — there is no backfill and none is possible.
Order per PR: `pnpm build && pnpm lint && pnpm test`, then `node packages/migrator/test/regen-goldens.mjs`
(the diff is the review artifact), then the real-Postgres suite via `INDIGODB_TEST_DATABASE_URL`.
No `crates/` change, so **no WASM rebuild and no snapshot regen**. Rollback is the proposal's four
steps; the `DROP TABLE` is destructive and deliberate.

## Slice Plan

Two chained PRs (B targets A). `400-line budget risk: High` as one PR, `Medium` per slice.
`Chained PRs recommended: Yes`. `Decision needed before apply: No`.

- **PR A — persistence.** Log DDL + indexes, introspection exclusion, `WalSource`'s second client
  and serial write chain, `lsn` on the wire, ordering/durability suites. `buckets` is written as
  `NULL` throughout. ≈ 320 authored lines.
- **PR B — bucket auth.** `computeBuckets` + its unit matrix, the RLS block on the log, and the
  isolation suite. ≈ 260 authored lines.

## Risks (design-level, beyond the proposal's)

| Risk | Mitigation |
|---|---|
| **The compiler guard makes `@@realtime` + `@@allow` unreachable** (`validate.rs:86-97`): no valid `.indigo` schema can produce a realtime table with `allow` rules, so `computeBuckets` is forward-compatible mechanism, not live behaviour, until slice 4 lifts the guard | Unit-test `computeBuckets` against hand-constructed IR and drive the integration suite from a hand-built `ResolvedSchema`. **The proposal's success criterion "`buckets` on a model with `@@allow(read, ownerId == auth.userId)`" is not expressible as schema source today** — `sdd-spec` should restate it at the IR level |
| Bucket matching is **textual**, while slice 1's own policies cast the claim to the column's SQL type (`renderCondition`) | A non-canonical `$auth("007")` matches `ownerId = 7` on the real table but not `'7' = ANY(buckets)` in the log. Documented; the test matrix covers Int-, String- and uuid-keyed models |
| Doubled connection footprint, and a replication connection plus an ordinary one both crossing PgBouncer | Slice 2 already documents the direct-port requirement; the writer uses the same connection string and is opened lazily inside `connect()` |
| One round trip added to every commit before dispatch (decision 3) | Batched per transaction; the chain (decision 1) means back-pressure shows up as growing latency, not reordering. Revisit only if measured |
| Unbounded growth with no pruning path — and the append-only policy set (decision 6) means a future pruner needs a bypassing role or a DELETE policy | Proposal's top operational caveat; recorded here as a constraint the retention follow-up inherits |

## Open Questions

- [ ] Non-blocking: `buckets` currently derives from `read` rules only. If slice 4 filters live SSE
      by bucket, `update`/`delete` visibility may need its own array.
- [ ] Non-blocking: retention will have to reconcile with the log's append-only policy set.
