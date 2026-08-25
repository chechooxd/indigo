# Tasks: LSN-keyed shape log with pre-evaluated bucket auth

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~320 (A) + ~260 (B) ≈ 580 total, authored risk excludes goldens |
| 400-line budget risk | High as one PR, Medium per slice |
| Chained PRs recommended | Yes |
| Suggested split | PR A → PR B |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|----|----|------------------|--------------------|
| 1 | Persistence: log DDL + indexes, introspection exclusion, `WalSource`'s second client + serial write chain, `lsn` on the wire; `buckets` written as `NULL` throughout | A (base=tracker) | `pnpm --filter @indigodb/realtime test` / `pnpm --filter @indigodb/migrator test` | `packages/realtime/test/log.mjs` (real Postgres, `INDIGODB_TEST_DATABASE_URL`) | Revert PR A only; no consumer reads `buckets` yet, and the log table is additive bookkeeping |
| 2 | Bucket auth: `computeBuckets` + its unit matrix, RLS block on the log table, isolation suite | B (base=A) | `pnpm --filter @indigodb/migrator test` | `packages/realtime/test/buckets.mjs` (real Postgres) | Revert PR B; PR A's log keeps persisting with `buckets = NULL` (publicly readable, no RLS regression) |

## PR A — Persistence (base = tracker)

- [x] A0.1 [SPIKE — MUST run first] Confirm a second `pg.Client` connection (distinct from the logical replication connection) can be opened against the same connection string inside `WalSource`; confirm the commit LSN's `pg_lsn` text formatting matches the `"X/Y"` hex shape assumed by the design. Record findings as apply-time deviation notes if the API differs.
  - Confirmed live: a second, ordinary `pg.Client` opens cleanly against the same connection string alongside an active `LogicalReplicationService` — no conflict. `message.commitLsn` (pgoutput's `commit` message) is already typed `string | null` and already prints the `"X/Y"` hex shape the design assumes (verified against `wal-source.mjs`'s existing fixtures, e.g. `"0/2"`, and against real Postgres in `log.mjs`/`parity.mjs`, e.g. `"1A/2B"`) — no reformatting needed, `event.lsn = commitLsn` directly.
- [x] A1.1 [RED] `postgres.ts`: `renderRealtimeLogSql(schema)` emits an idempotent `CREATE TABLE IF NOT EXISTS "_indigo_realtime_log"` (`id bigserial PRIMARY KEY`, `lsn pg_lsn NOT NULL`, `txid text`, `table_name text NOT NULL`, `op text NOT NULL CHECK (op IN ('INSERT','UPDATE','DELETE'))`, `pk jsonb NOT NULL`, `"new"`/`"old" jsonb`, `ts timestamptz NOT NULL`, `buckets text[]`) plus 3 indexes (`(lsn,id)`, `(table_name,lsn,id)`, `gin(buckets)`) when ≥1 `@@realtime` model exists; `DROP TABLE IF EXISTS` when none do.
- [x] A1.2 [GREEN] implement `renderRealtimeLogSql` — table + indexes only in this PR (RLS is PR B's block, design's File Changes split); export `REALTIME_LOG_TABLE` constant; wire into `renderPushSql` block 5 (decisions 4, 13).
- [x] A2.1 [RED] `introspect.ts`: default `exclude` gains `"_indigo_realtime_log"`; `planMigration(introspectResolvedSchema(db), next)` is empty after a push that created the log table — **without this fix, shadow-replay sees the log as a user table and emits `DROP TABLE "_indigo_realtime_log" CASCADE"`, breaking the round-trip no-op invariant** (decision 5).
- [x] A2.2 [GREEN] add `"_indigo_realtime_log"` to `introspect.ts:305`'s default `exclude` array.
- [x] A3.1 [RED] `migrate.ts`: adding the first `@@realtime` model → migration includes the log table create (`safe`); removing the last `@@realtime` model → migration includes a `forced(...)` drop with an explicit impact string (decision 13); a second `@@realtime` table added while the log already exists → no log DDL churn.
- [x] A3.2 [GREEN] wire create/drop into the `prevHasRealtime !== nextHasRealtime` branch (`976-996`), routing the drop through `forced(...)`.
- [x] A4.1 [GREEN] `protocol.ts`: add optional `lsn?: string` to `RealtimeEvent` (additive; `PgNotifySource` may omit it — not a contract violation); replace the `txid` doc comment's forward reference.
- [x] A5.1 [RED] `wal-source.ts`: on `commit`, `insert → onEvent → acknowledge` runs through a **serial promise chain** (`this.chain = this.chain.then(...)`); two back-to-back commits' inserts/acks never interleave even though `service.on("data")` keeps delivering synchronously while a write is in flight (decision 1 — the largest new failure mode in this slice).
- [x] A5.2 [RED] a failed `INSERT` dispatches no `onEvent` call, does not acknowledge the commit LSN, and **tears the replication connection down** (`service.stop()` + `scheduleReconnect`) rather than logging and continuing — ack is monotonic, so acking a later commit would implicitly confirm the lost one (decision 2).
- [x] A5.3 [GREEN] implement: open a second ordinary `pg.Client` at `start()` alongside the replication connection; the `commit` case captures `(batch, commitLsn, txid, ts)`, resets `pending`/`txid` synchronously, then appends `insert → dispatch → ack` to the serial chain; `stop()` awaits the chain.
- [x] A5.4 [RED] the log write is a single **multi-row parameterized `INSERT`** per WAL transaction (decision 12), never one `INSERT` per row; `buckets` is written as `NULL` for every row in this PR (bucket computation is deferred to PR B).
- [x] A5.5 [GREEN] build the multi-row `INSERT` from the transaction's buffered row changes; populate `lsn`/`txid`/`ts`/`table_name`/`op`/`pk`/`"new"`/`"old"`, `buckets` always `NULL`.
- [x] A5.6 [GREEN] populate `RealtimeEvent.lsn` on every event `WalSource` emits, formatted as the `"X/Y"` hex string Postgres prints for `pg_lsn`.
- [x] A6.1 [RED — threat: SQL injection through logged row data] a row whose text column is `'); DROP TABLE "User"; --` round-trips through the log `INSERT` as inert data.
- [x] A6.2 [GREEN] confirm/route the multi-row `INSERT` through `pg`'s parameterized placeholders exclusively — no row value is ever string-built into SQL.
- [x] A7.1 [VERIFY] `node packages/migrator/test/regen-goldens.mjs` — review diff: first `@@realtime` added → create; last removed → `forced` drop; second realtime table added → no log DDL churn.
- [x] A8.1 [RED — real PG] `packages/realtime/test/log.mjs`: 200 rows over interleaved transactions → reading `_indigo_realtime_log` in `ORDER BY lsn, id` reproduces commit order; a multi-row transaction produces exactly one `INSERT` (batch-granularity assertion).
- [x] A8.2 [RED — real PG] durability: revoke `INSERT` / drop the log table mid-stream → no `onEvent` call, no ack, connection torn down; restore and restart → the transaction is redelivered (decisions 1–3).
  - Implemented as: drop `_indigo_realtime_log` mid-stream (not `REVOKE`, since the test connects as the superuser `postgres` role which bypasses grants) → the writer's `INSERT` fails, no `onEvent`, no ack, connection torn down and a reconnect scheduled → the table is restored via `renderRealtimeLogSql` → the transaction is redelivered exactly once on reconnect. Verified against real Postgres.
- [x] A8.3 [RED — real PG] push idempotency: `db push` applied twice against a schema with `@@realtime` models is a no-op; the log table never appears in the publication (decision 14, mirrors `realtime-wal-source`'s existing publication assertions).
- [x] A8.4 [GREEN] wire `log.mjs` into the same `postgres` CI lane already used by `realtime-wal-source`/`realtime-rls-allow-rule` (self-skips when `INDIGODB_TEST_DATABASE_URL` is unset). No CI workflow changes needed — the `postgres` job already runs `pnpm --filter @indigodb/realtime test`, and `log.mjs` is now wired into that package's `test` script.
- [x] A9.1 [VERIFY] `pnpm --filter @indigodb/realtime test && pnpm --filter @indigodb/migrator test` (real PG present) and confirm self-skip when `INDIGODB_TEST_DATABASE_URL` is unset.
  - `@indigodb/migrator test`: fully green against real Postgres (via PGlite) — zero failures.
  - `@indigodb/realtime test`: `wal-source.mjs` (23/23), `pg-harness.mjs` self-test, `parity.mjs` (2/2), and `log.mjs` (4/4) all green against a real `postgres:17 -c wal_level=logical` Docker container. `resume.mjs`'s 2nd/3rd checks intermittently hang in this local Docker-Desktop-on-macOS environment — **confirmed via `git stash` A/B testing to be pre-existing on pristine `main`, not a PR A regression** (the exact same hang reproduces with `wal-source.ts`/`protocol.ts` fully reverted). Self-skip confirmed clean with `INDIGODB_TEST_DATABASE_URL` unset (`pnpm --filter @indigodb/realtime test` prints `SKIP -` for every real-PG suite, 23 unit tests still run and pass).
- [x] A9.2 [VERIFY] `pnpm build && pnpm lint && pnpm test` (workspace-wide; no `crates/` touched this slice — no WASM rebuild, no snapshot regen). All 18 Turbo tasks green (`pnpm test`, `INDIGODB_TEST_DATABASE_URL` unset, so real-PG suites self-skip cleanly — no hang risk in this path).
- [x] A9.3 [COMMIT] `feat(migrator,realtime): add _indigo_realtime_log persistence with ordered insert-dispatch-ack`.

## PR B — Bucket auth (base = PR A)

- [x] B1.1 [RED] `postgres.ts`: `computeBuckets(table, row, old)` — a single `field == claim` rule yields `[row[field]]`; multiple `field == claim` rules on distinct fields union; a `NULL` field value contributes **no** element (decision 10); a `field == literal`/`field == field`/`claim == claim` rule the row satisfies **caller-independently** collapses the whole result to `null` (decision 9, PERMISSIVE-OR); read rules exist but none is satisfiable → `[]` (deny-all); a model with `@@allow` rules but none for `action: "read"` (e.g. only `create`-action rules) → `[]` (deny-all, NOT `null`) — that model's real table has RLS enabled and denies all reads by default with no matching `read` policy, so the log must not be more permissive than the RLS-protected real table; `table.allow` undefined (no `@@allow` block at all) → `null` (public — the real table has no RLS enabled either); UPDATE buckets union the values derived from both `new` and `old` (decision 11).
- [x] B1.2 [GREEN] implement `computeBuckets` handling all four accepted `AllowOperand` pairs (`field == claim`, `field == literal`, `field == field`, `claim == claim` — decision 8, `AllowOperand` is not a closed field==claim vocabulary), values coerced via `String(value)`; export from `postgres.ts` per design Interfaces.
- [x] B1.3 [RED — flagged, do not silently skip] non-`NULL` `buckets` cases MUST be exercised by hand-constructing a `ResolvedTable` with `allow` rules **in-memory**, NOT via a compiled `.indigo` fixture: the `@@realtime` + `@@allow` compiler guard (`validate.rs:86-97`) makes that combination unreachable through real schema source until slice 4 lifts the guard. This is its own explicit task precisely so the non-public-bucket path is not accidentally left untested.
- [x] B2.1 [RED] `postgres.ts`: RLS block on `_indigo_realtime_log` — `ENABLE` + `FORCE ROW LEVEL SECURITY`; one `FOR SELECT` policy `USING (buckets IS NULL OR NULLIF(current_setting('app.user_id', true), '') = ANY (buckets))`; a second `FOR INSERT WITH CHECK (true)` policy (decision 6); policy names follow `indigo_p__indigo_realtime_log_<action>_<n>`.
- [x] B2.2 [GREEN] hand-write the RLS SQL reusing `AUTH_SETTING` and the `NULLIF(current_setting(…), '')` idiom plus `policyName`'s naming shape — **not** a call into `renderPolicy` (decision 7: `renderCondition` only emits `left = right` over a `ResolvedTable`'s own columns, and the log table has no `ResolvedTable`); wire into `renderRealtimeLogSql` alongside PR A's table+indexes.
- [x] B3.1 [GREEN] `wal-source.ts`: pass `computeBuckets(table, row, old)`'s result into the multi-row `INSERT`'s `buckets` column, replacing PR A's hardcoded `NULL`.
- [x] B4.1 [RED — threat: privilege escalation via the log] a non-superuser `UPDATE`/`DELETE` against `_indigo_realtime_log` affects 0 rows (no `UPDATE`/`DELETE` policy exists under `FORCE` RLS → append-only by construction).
- [x] B4.2 [GREEN] confirm no `UPDATE`/`DELETE` policy is ever emitted for the log table (structural — this assertion should already pass once B2 lands; keep it standalone so a future change can't silently add one).
- [x] B5.1 [RED — real PG] `packages/realtime/test/buckets.mjs`: the `WalSource` writer's own `INSERT` succeeds under `FORCE` RLS via the `FOR INSERT WITH CHECK (true)` policy — **without this policy, `FORCE` RLS blocks the writer's own writes** (decision 6's RED test).
- [x] B5.2 [RED — real PG] `SET app.user_id` isolation: a query under `SET app.user_id = 'u1'` returns rows with `buckets = NULL` (public) and rows with `buckets` containing `'u1'`, and excludes rows whose `buckets` contain only other values.
- [x] B5.3 [RED — real PG] driven from a hand-built `ResolvedSchema` with a `read` `AllowRule` (per B1.3's flagged constraint) against a real Postgres table: a row committed on that table logs with a non-`NULL` `buckets`, and RLS correctly restricts read to the matching claim.
- [x] B5.4 [RED — real PG] textual bucket matching stays consistent with slice 1's SQL-type casting for at least Int-, String-, and uuid-keyed models (design risk 8: a non-canonical claim like `"007"` vs `7` must not silently diverge between the real table's cast comparison and the log's textual `= ANY(buckets)` match — assert/document the matrix rather than "fixing" the mismatch).
- [x] B5.5 [GREEN] wire `buckets.mjs` into the same `postgres` CI lane as `log.mjs` (self-skips when `INDIGODB_TEST_DATABASE_URL` is unset).
- [x] B6.1 [VERIFY] `node packages/migrator/test/regen-goldens.mjs` — review diff (the RLS block now appears in log-table-creating fixtures).
  - Diff reviewed and committed in the `computeBuckets`/RLS commit: only the 3 realtime-touching fixtures (`realtime-added`, `realtime-added-mapped-table`, `realtime-second-table-added`) changed, appending exactly the RLS block (`ENABLE`/`FORCE` + read/insert policy pair) after the existing indexes — no other fixture drifted. Re-ran after B3-B5 landed: no further drift.
- [x] B6.2 [VERIFY] `pnpm --filter @indigodb/realtime test && pnpm --filter @indigodb/migrator test` (real PG present) and confirm self-skip when `INDIGODB_TEST_DATABASE_URL` is unset.
  - Real PG (`postgres:17 -c wal_level=logical` via Docker, port 55433): `wal-source.mjs` (27/27, incl. 4 new B3.1 wiring cases), `pg-harness.mjs` self-test, `parity.mjs` (2/2), `log.mjs` (4/4, unaffected by PR B), `buckets.mjs` (5/5 — B4.1/B5.1-B5.4, run twice for reproducibility). `resume.mjs` intermittently hangs in this local Docker-Desktop-on-macOS environment — this is the SAME pre-existing flake PR A's A9.1 already documented and confirmed via `git stash` A/B testing to be unrelated to shape-log changes; PR B touches only `decodeRow`/`buildLogInsert`, not `resume.mjs`'s reconnect path, and every other real-PG suite (including ones sharing the same reconnect/backoff code path in `log.mjs`'s durability check) passed cleanly. `@indigodb/migrator test`: all green (unit + `computeBuckets` matrix + RLS DDL + goldens + shadow + pull-roundtrip). Self-skip confirmed clean with `INDIGODB_TEST_DATABASE_URL` unset (workspace `pnpm test` below).
- [x] B6.3 [VERIFY] `pnpm build && pnpm lint && pnpm test` (workspace-wide; no `crates/` touched this slice — no WASM rebuild, no snapshot regen).
  - `pnpm build`: 10/10 Turbo tasks green. `pnpm lint`: 18/18 green. `pnpm test`: 18/18 green (`INDIGODB_TEST_DATABASE_URL` unset — every real-PG suite self-skips with a printed notice, no hang risk in this path).
- [x] B6.4 [COMMIT] `feat(migrator,realtime): compute read-authorization buckets and enforce RLS on _indigo_realtime_log`.

## Post-slice cleanup

- [ ] C1 Confirm proposal Success Criteria fully met across PR A–B, restated at the IR level per design's flagged risk: "`buckets` on a model with `@@allow(read, ownerId == auth.userId)`" is exercised via a hand-built `ResolvedTable`, not a compiled `.indigo` fixture, until slice 4 lifts the `@@realtime`+`@@allow` compiler guard.
- [ ] C2 Merge the 1 new full spec (`realtime-shape-log`) and the `realtime-wal-source` delta into `openspec/specs/` once this change archives.
- [ ] C3 Log follow-up (non-blocking): `buckets` derives from `read` rules only; slice 4's live SSE filtering may need separate `update`/`delete` visibility arrays.
- [ ] C4 Log follow-up (non-blocking): retention must reconcile with the log's append-only policy set — no `UPDATE`/`DELETE` policy exists to support pruning without a bypassing role.
