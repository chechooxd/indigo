# Proposal: LSN-keyed shape log with pre-evaluated bucket auth

Change: `realtime-shape-log` (Road to 1.0, Phase 4). Slice 3 of the realtime epic. Exploration: Engram #720; decisions: Engram `sdd/realtime-shape-log/decisions`.

## Intent

Slice 2 landed `WalSource` (`packages/realtime/src/wal-source.ts`), but nothing is persisted: row events are buffered per transaction, flushed to `RealtimeEngine.dispatch()` on `commit`, and the commit LSN is used only for `service.acknowledge(commitLsn)` (line 259) and then discarded. So realtime history is not addressable, not resumable past the slot's own retention, and not auditable.

Worse, it has no auth record. `RealtimeEngine.dispatch()` fans out by `sub.tables.has(event.table)` — table granularity only — which is exactly why the compiler guard in `crates/indigo-compiler/src/validate.rs` still refuses `@@realtime` + `@@allow` on one model. Row-level realtime auth cannot exist until a per-change durable record exists to evaluate auth against.

This slice creates that record: every committed change is persisted keyed by its commit LSN, with its read-authorization pre-evaluated once at write time into buckets — not re-evaluated per change × per subscriber.

## Scope

### In Scope

- **Shared** internal table `_indigo_realtime_log`, discriminated by a `table_name` column — one table, not one per `@@realtime` model — mirroring the sole existing internal-table precedent `_indigo_migrations` (`packages/cli/src/migrate-runner.ts`). Columns: `lsn` (commit LSN as native `pg_lsn`, the addressing key), `table_name`, `op`, `pk` jsonb, `new`/`old` jsonb, `txid`, `ts`, `buckets`.
- DDL owned by `db push` / `migrate deploy` (`packages/migrator/src/postgres.ts` idempotent path, `migrate.ts` versioned diff), following slices 1–2's declarative `_indigo_`-prefixed ownership model and the idempotent `DO $$` / `IF NOT EXISTS` pattern.
- `WalSource` itself opens a second ordinary `pg.Client` (the replication connection cannot run DML) and INSERTs each flushed event in the `commit` case, where `message.commitLsn` is already in scope. Write happens alongside the existing `onEvent` dispatch, not in place of it.
- `buckets` computed at write time from `ResolvedTable.allow` (`packages/core/src/ir.ts`), `action: "read"` rules only. Because `AllowRule` is a closed `field == claim` vocabulary, the row's own field value **is** the bucket key; multiple `read` rules union (PERMISSIVE = OR, matching slice 1's RLS semantics).
- A `@@realtime` model with **no** `@@allow` rules writes `buckets = NULL` (wildcard, publicly visible) — consistent with the real table, where absent `@@allow` means RLS is never enabled at all.
- RLS on `_indigo_realtime_log` itself, reusing slice 1's `renderPolicy` / `AUTH_SETTING` (`app.user_id`) machinery verbatim: readable when `buckets IS NULL OR current_setting('app.user_id', true) = ANY(buckets)`.
- `lsn` surfaced on `RealtimeEvent` (`packages/realtime/src/protocol.ts`), whose `txid` doc comment already anticipates this.

### Out of Scope — all deferred to slice 4

- The CDN-cacheable `GET ?handle&offset` HTTP endpoint. Nothing reads the log over the wire in this slice.
- The `.live()` client API (`packages/client/src/realtime.ts`, `realtime-delegate.ts`) — offset/handle bookkeeping does not exist and is a separate contract.
- Subscriber identity in SSE. `Subscriber` gains no `userId`; `RealtimeEngine.dispatch()` is untouched and still filters by table name.
- Lifting the `@@realtime` + `@@allow` compiler guard. It stays in place after this slice, because the live SSE push path remains unfiltered.
- Log retention / pruning (time-based, row-cap, or LSN-tied). Acknowledged as a real operational commitment and documented as a follow-up — the same treatment slice 2 gave orphaned-slot cleanup.

## Capabilities

### New Capabilities

- `realtime-shape-log`: the `_indigo_realtime_log` contract — table shape and LSN addressing, DDL emission/idempotency for push and versioned migrations, the `WalSource` write path and its ordering/durability relative to dispatch and ack, bucket computation from `read` `AllowRule`s, the NULL-buckets public case, and RLS on the log table.

### Modified Capabilities

- `realtime-wal-source`: `WalSource` gains a second connection and a persistence side effect; the commit-LSN handling and the acknowledge ordering become observable contract, and `RealtimeEvent` gains `lsn`.

## Approach

Two chained PRs, mirroring slice 2's own delivery shape.

**PR A — persistence.** `postgres.ts` gains a `_indigo_realtime_log` renderer next to the existing publication/slot renderers, emitted whenever any table is `@@realtime`, with the matching create/drop in `migrate.ts`'s diff so the table appears and disappears with realtime itself. `WalSource` opens a dedicated `pg.Client` in `connect()` and, in `handleMessage`'s `commit` case, INSERTs the buffered batch keyed by `commitLsn` before acknowledging — persist-then-ack, so a crash re-delivers rather than loses. Tested on the real-Postgres CI lane slice 2 stood up.

**PR B — bucket auth.** A pure function over `ResolvedTable.allow` extracts `{field, claim}` pairs for `action: "read"` and maps them to the event's own row values, producing `buckets text[] | NULL`. `postgres.ts` emits `ENABLE ROW LEVEL SECURITY` plus a policy on the log table built through the existing `renderPolicy`/`AUTH_SETTING` path rather than a second auth mechanism. Test matrix: multiple `read` rules, `create`-only rules, zero rules, non-`@@allow` `@@realtime`, and a `SET app.user_id` read proving isolation.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `packages/migrator/src/postgres.ts` | Modified | `_indigo_realtime_log` DDL + RLS via `renderPolicy`/`AUTH_SETTING` |
| `packages/migrator/src/migrate.ts` | Modified | versioned create/drop of the log table with realtime state |
| `packages/realtime/src/wal-source.ts` | Modified | second `pg.Client`; INSERT on commit before ack |
| `packages/realtime/src/protocol.ts` | Modified | `lsn` on `RealtimeEvent` |
| `packages/core/src/ir.ts` | Unchanged | `ResolvedTable.allow` / `AllowRule` consumed as-is |
| `packages/realtime/test/` | Modified | persistence + bucket/RLS coverage on the Postgres lane |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Unbounded log growth (every row DML, unlike `_indigo_migrations`) | High | Explicitly out of scope; documented as the top operational caveat and the first slice-4 ops follow-up |
| Doubled connection footprint per `WalSource` | Med | Documented; one extra ordinary client per instance, opened lazily with the replication connection |
| Log write fails while dispatch succeeds → divergence | Med | Persist before ack; a failed insert must not ack the LSN, so the transaction is redelivered |
| `buckets = NULL` reads as accidentally permissive | Med | Deliberate and specified: mirrors the real table, where no `@@allow` means no RLS at all |
| Write latency added to the realtime hot path | Med | One batched INSERT per transaction, not per row |
| PR B alone approaching the 400-line budget | Med | Chained PRs are the delivery decision; `sdd-tasks` forecasts against the guard |

## Rollback Plan

1. Revert `wal-source.ts`'s second client and commit-case INSERT; `onEvent` dispatch and ack behavior return to slice 2 exactly.
2. Remove the log-table renderers from `postgres.ts`/`migrate.ts`; a forward migration `DROP TABLE IF EXISTS "_indigo_realtime_log"` (RLS policies drop with it).
3. Remove `lsn` from `RealtimeEvent` — additive today, so no consumer depends on it.
4. Slice 1 RLS and slice 2 publication/slot are untouched; the compiler guard never moved.

## Dependencies

- `main` @ `c019bc3` (slices 1 and 2 archived).
- No new npm dependency: `pg` is already a `@indigodb/realtime` dependency.
- Existing `postgres` CI job with `wal_level=logical`.

## Success Criteria

- [ ] `db push` on a schema with any `@@realtime` model creates `_indigo_realtime_log` idempotently; running twice is a no-op
- [ ] Removing the last `@@realtime` model drops the log table in the versioned migration
- [ ] Every committed insert/update/delete on a `@@realtime` model appears as one row keyed by its commit LSN, ordered by LSN
- [ ] A failed log write does not acknowledge the LSN; the transaction is redelivered after restart
- [ ] `buckets` on a model with `@@allow(read, ownerId == auth.userId)` holds that row's `ownerId`; multiple `read` rules union
- [ ] A `@@realtime` model with no `@@allow` writes `buckets = NULL` and is readable by any `app.user_id`
- [ ] Under `SET app.user_id`, a non-superuser SELECT on `_indigo_realtime_log` returns only wildcard rows and that user's buckets
- [ ] `RealtimeEngine.dispatch()`, the SSE wire shape, and the `@@realtime` + `@@allow` compiler guard are byte-identical to today
- [ ] `pnpm build`, `lint`, `test` and `cd crates && cargo test` green

## Open Questions

### Resolved (user, 2026-08-24)

1. **Table topology** — shared `_indigo_realtime_log` discriminated by `table_name`, not per-model tables. Follows `_indigo_migrations`, avoids per-model dynamic DDL.
2. **Buckets without `@@allow`** — `NULL` wildcard = publicly visible, matching the real table's actual RLS-disabled accessibility.
3. **Retention/pruning** — out of scope, documented follow-up (slice 2's orphaned-slot-cleanup precedent).
4. **Log-writer connection ownership** — `WalSource` owns the second `pg.Client`; it already holds the decoded event and LSN.
5. **Subscriber identity in SSE** — deferred to slice 4 with the endpoint and `.live()`; the compiler guard stays.

6. **Write ordering vs. dispatch** — insert into `_indigo_realtime_log` → dispatch via SSE → acknowledge the LSN. The log is the durable record: a dispatched-but-unlogged event is a hole no later reader can fill, whereas a logged-but-undispatched event is recovered on reconnect. A failed insert therefore must not acknowledge, so the transaction is redelivered.
7. **`lsn` representation** — native Postgres `pg_lsn` column type, surfaced on the wire as the `X/Y` hex string Postgres itself prints. Ordering and comparison stay server-side and no 64-bit integer has to cross the JSON boundary.
8. **Batch insert granularity** — one multi-row INSERT per WAL transaction, matching `WalSource`'s existing per-commit flush boundary and keeping the added hot-path latency to a single round trip.
9. **Log inclusion rule** — exactly the `@@realtime` table set. Publication membership already gates what `WalSource` decodes, so the log's contents follow `@@realtime` with no second inclusion rule to keep in sync. A model with `@@allow` but no `@@realtime` never appears.

### Still open

None. All 9 questions are resolved; the proposal is ready for `sdd-spec` and `sdd-design`.
