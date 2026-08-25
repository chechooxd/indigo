# Delta for Realtime Shape Log

## MODIFIED Requirements

### Requirement: `_indigo_realtime_log` is one shared table, discriminated by `table_name`

The migrator MUST emit exactly one `_indigo_realtime_log` table, not one table per `@@realtime`
model, following the `_indigo_migrations` internal-table precedent. Its columns MUST be: `id`
(`bigserial PRIMARY KEY`, the public cursor for `realtime-live-endpoint`'s `GET ?handle&offset`
route), `lsn` (`pg_lsn`, the commit-ordering key), `table_name`, `op`, `pk` (`jsonb`), `new`/`old`
(`jsonb`, nullable), `txid`, `ts`, `buckets` (`text[]`, nullable). `id` MUST NOT be treated as an
internal-only implementation detail: it is the offset cursor consumers page with, and its
ordering guarantee (arrival order equals commit order, by construction of a single-writer
replication slot) is a contract external callers rely on.
(Previously: the requirement listed the same columns without `id`, and did not describe `id`
as a public contract — it was an internal primary key with no external consumer.)

#### Scenario: Two `@@realtime` models share one log table

- GIVEN a schema with two `@@realtime` models
- WHEN `db push` DDL is rendered and applied
- THEN exactly one `_indigo_realtime_log` table exists, and rows for both models are
  distinguished only by `table_name`

#### Scenario: `id` is usable as a stable pagination cursor

- GIVEN a client holds `offset = <last id it saw>` for one table
- WHEN it later queries `WHERE table_name = <table> AND id > offset ORDER BY id`
- THEN it receives every row committed after that point, exactly once, in commit order — with
  no gap or reordering possible, because `id` is a strictly increasing `bigserial` and the
  replication slot guarantees single-writer arrival order

## ADDED Requirements

### Requirement: `id` ordering is LSN-consistent by construction, not by runtime check

Because `_indigo_realtime_log` has exactly one writer (the replication slot is exclusive),
`id` assignment order MUST equal commit (`lsn`) order for as long as that single-writer
invariant holds. This is a stated design invariant of the current architecture, not a property
enforced by a runtime check on each insert.

#### Scenario: Reading by `id` reproduces commit order

- GIVEN multiple committed transactions on `@@realtime` tables
- WHEN their log rows are read back ordered by `id`
- THEN the order matches the order the transactions committed in, consistent with reading by
  `lsn`

#### Scenario: Multiple concurrent writers is out of scope

- GIVEN a hypothetical deployment with more than one process writing to
  `_indigo_realtime_log` (e.g. an HA/failover configuration)
- WHEN such a deployment is considered
- THEN the `id`-ordering guarantee is explicitly out of scope for this change; the single-writer
  invariant is a stated precondition, not something this change verifies or defends against
