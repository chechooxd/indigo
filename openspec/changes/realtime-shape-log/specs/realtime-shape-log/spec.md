# Realtime Shape Log Specification

## Purpose

Defines `_indigo_realtime_log`, the shared, LSN-addressed, durable record of every committed
change on an `@@realtime` table, with its read-authorization pre-evaluated once at write time
into `buckets`. This is the persistence and auth-record layer beneath the (currently table-only)
SSE fan-out; it does not itself serve reads over the wire.

## Requirements

### Requirement: `_indigo_realtime_log` is one shared table, discriminated by `table_name`

The migrator MUST emit exactly one `_indigo_realtime_log` table, not one table per `@@realtime`
model, following the `_indigo_migrations` internal-table precedent. Its columns MUST be: `lsn`
(`pg_lsn`, the addressing key), `table_name`, `op`, `pk` (`jsonb`), `new`/`old` (`jsonb`,
nullable), `txid`, `ts`, `buckets` (`text[]`, nullable).

#### Scenario: Two `@@realtime` models share one log table

- GIVEN a schema with two `@@realtime` models
- WHEN `db push` DDL is rendered and applied
- THEN exactly one `_indigo_realtime_log` table exists, and rows for both models are
  distinguished only by `table_name`

### Requirement: `_indigo_realtime_log` DDL is idempotent and tracks `@@realtime` state

The migrator MUST emit the table via the existing idempotent `DO $$` / `IF NOT EXISTS` pattern
whenever any table is `@@realtime`, and versioned migrations MUST create it when the first
`@@realtime` model is added and drop it when the last one is removed.

#### Scenario: First push creates the log table

- GIVEN a schema with one `@@realtime` model and no existing log table
- WHEN `db push` DDL is applied
- THEN `_indigo_realtime_log` is created

#### Scenario: Re-running push is a no-op

- GIVEN a schema whose log table was already applied
- WHEN `db push` runs again unchanged
- THEN the rendered DDL converges without error

#### Scenario: Last `@@realtime` model removed drops the table

- GIVEN a previously migrated schema with one `@@realtime` model
- WHEN `@@realtime` is removed and the migration is applied
- THEN the migration drops `_indigo_realtime_log`

### Requirement: Log inclusion is exactly the `@@realtime` table set

A row MUST be written to `_indigo_realtime_log` if and only if its source table is `@@realtime`.
A model with `@@allow` but no `@@realtime` MUST NOT appear in the log; the log has no inclusion
rule independent of publication membership.

#### Scenario: Non-realtime model never appears

- GIVEN a model with `@@allow(read, ...)` but no `@@realtime`
- WHEN rows are committed on that model
- THEN no row is written to `_indigo_realtime_log`

### Requirement: Every committed change is persisted keyed by its commit LSN

For each committed transaction touching an `@@realtime` table, `WalSource` MUST write one row per
row-change into `_indigo_realtime_log`, keyed by that transaction's commit LSN, as a single
multi-row `INSERT` per transaction (not one `INSERT` per row).

#### Scenario: Multi-row transaction produces one INSERT

- GIVEN a transaction that inserts three rows into a `@@realtime` table
- WHEN the transaction commits
- THEN one multi-row `INSERT` writes all three log rows, sharing that transaction's commit `lsn`

#### Scenario: Rows are ordered by LSN

- GIVEN multiple committed transactions on `@@realtime` tables
- WHEN their log rows are read back
- THEN reading in `lsn` order reproduces commit order

### Requirement: A failed log write blocks acknowledgment

`WalSource` MUST insert the transaction's log rows before dispatching to `onEvent` and before
acknowledging the commit LSN. If the insert fails, `WalSource` MUST NOT acknowledge that LSN.

#### Scenario: Insert failure prevents ack and redelivers

- GIVEN the log-writer connection is unavailable when a transaction commits
- WHEN `WalSource` attempts to write that transaction's log rows and the write fails
- THEN the commit LSN is not acknowledged, and the transaction is redelivered after reconnect

### Requirement: `buckets` is computed from `read` `AllowRule`s at write time

For a row on a table with at least one `read` `AllowRule` (`ResolvedTable.allow`), `WalSource`
MUST compute `buckets` as the union of that row's own field values for every `{field, claim}`
pair across all `read` rules (PERMISSIVE union, matching RLS semantics), evaluated once at write
time — not re-evaluated per subscriber.

#### Scenario: Single `read` rule

- GIVEN `@@allow(read, ownerId == auth.userId)` and a row with `ownerId = "u1"`
- WHEN that row's change is logged
- THEN `buckets` is `{"u1"}`

#### Scenario: Multiple `read` rules union

- GIVEN two `@@allow(read, ...)` rules on distinct fields, `ownerId = "u1"` and `teamId = "t2"`
- WHEN that row's change is logged
- THEN `buckets` contains both `"u1"` and `"t2"`

#### Scenario: `create`-only rules do not contribute, and deny all reads

- GIVEN a model with at least one `@@allow` rule (e.g. only `@@allow(create, ...)`) and no
  `read` rule
- WHEN a row's change is logged
- THEN `buckets` is `[]` (empty array, deny-all via bucket matching) — NOT `NULL`. The model
  has `@@allow` rules, so RLS is enabled on its real table, and per slice-1's deny-by-default
  semantics no matching `read` policy means the real table denies all reads. `NULL` (public) is
  reserved for models with no `@@allow` block at all, where the real table has no RLS enabled;
  using `NULL` here would make the log strictly more permissive than the RLS-protected real
  table it mirrors — a security inconsistency, not a cosmetic one.

### Requirement: No `@@allow` rules at all writes `buckets = NULL`, publicly visible

A `@@realtime` model with **no `@@allow` block at all** MUST write `buckets = NULL` for its log
rows. `NULL` MUST be treated as a wildcard, readable regardless of `app.user_id`. This is not a
new permissiveness: a model with no `@@allow` never gets RLS enabled on its real table either, so
its rows are already unconditionally readable there. Logging the same rows as publicly visible in
the shape log preserves that existing accessibility rather than introducing a stricter or looser
rule.

This is distinct from a model that HAS `@@allow` rules but none for `action: "read"` (e.g.
create-only rules): that model's real table DOES have RLS enabled, and with no matching `read`
policy it denies all reads by default. Its log rows MUST write `buckets = []`, not `NULL` — see
the "`create`-only rules do not contribute, and deny all reads" scenario above.

#### Scenario: No `@@allow` at all

- GIVEN a `@@realtime` model declared with no `@@allow` block
- WHEN a row's change is logged
- THEN `buckets` is `NULL`

#### Scenario: `NULL` buckets are readable by any authenticated user

- GIVEN a log row with `buckets = NULL`
- WHEN a query runs under `SET app.user_id = 'any-user'`
- THEN that row is returned, because `buckets IS NULL` is unconditionally true in the RLS policy

#### Scenario: `NULL` buckets do not bypass RLS for other rows

- GIVEN one log row with `buckets = NULL` (public model) and one log row with
  `buckets = '{"u1"}'` (row-scoped model)
- WHEN a query runs under `SET app.user_id = 'u2'`
- THEN the public row is returned and the `u1`-scoped row is not

### Requirement: RLS on `_indigo_realtime_log` reuses the existing policy machinery

The migrator MUST enable and force RLS on `_indigo_realtime_log` and emit one policy built through
the existing `renderPolicy`/`AUTH_SETTING` (`app.user_id`) path, not a second auth mechanism, with
a `USING` clause equivalent to `buckets IS NULL OR current_setting('app.user_id', true) = ANY(buckets)`.

#### Scenario: Row-scoped read is isolated

- GIVEN log rows with `buckets = '{"u1"}'` and `buckets = '{"u2"}'`
- WHEN a query runs under `SET app.user_id = 'u1'`
- THEN only the `u1` row is returned
