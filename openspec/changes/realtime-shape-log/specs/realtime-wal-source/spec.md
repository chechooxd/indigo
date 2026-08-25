# Delta for Realtime WAL Source

## ADDED Requirements

### Requirement: `WalSource` opens a dedicated log-writer connection

`WalSource` MUST open a second, ordinary `pg.Client` connection (distinct from its logical
replication connection, which cannot run DML) to write `_indigo_realtime_log` rows. This
connection MUST be owned by `WalSource` itself, opened alongside the replication connection.

#### Scenario: Second connection opened on start

- GIVEN `WalSource` is constructed and started
- WHEN it establishes its replication stream
- THEN it also holds an open ordinary `pg.Client` connection usable for `INSERT` statements

### Requirement: `RealtimeEvent` carries the commit `lsn`

`RealtimeEvent` (`packages/realtime/src/protocol.ts`) MUST include an optional `lsn` field: the
commit LSN as the `X/Y` hex string Postgres prints for `pg_lsn`. `WalSource` MUST populate `lsn`
on every event it emits. `PgNotifySource` is not required to populate it, since NOTIFY-based
delivery has no commit LSN to surface; this is an additive field and does not break shape parity
for `table`, `op`, `pk`, `new`, `old`, `txid`, or `ts`.

#### Scenario: `WalSource` events carry `lsn`

- GIVEN a row is inserted into a `@@realtime` table
- WHEN `WalSource` emits the corresponding `RealtimeEvent`
- THEN `event.lsn` is set to that transaction's commit LSN, formatted as an `X/Y` hex string

#### Scenario: `PgNotifySource` events omit `lsn`

- GIVEN a row is inserted into a `@@realtime` table observed via `PgNotifySource`
- WHEN `PgNotifySource` emits the corresponding `RealtimeEvent`
- THEN `event.lsn` is not set, and this is not a contract violation

### Requirement: Log write precedes dispatch, which precedes acknowledgment

On `commit`, `WalSource` MUST, in order: (1) write the transaction's buffered row changes to
`_indigo_realtime_log` as one multi-row `INSERT`, (2) dispatch each row to `onEvent`, (3)
acknowledge the commit LSN. If step 1 fails, `WalSource` MUST NOT perform steps 2 or 3, and the
transaction MUST be redelivered on reconnect. This ordering exists because a dispatched-but-unlogged
event is a gap no later reader can fill, whereas a logged-but-undispatched event is recoverable.

#### Scenario: Successful commit follows insert-dispatch-ack order

- GIVEN a transaction commits on a `@@realtime` table with the log-writer connection healthy
- WHEN `WalSource` processes the `commit` message
- THEN the log `INSERT` completes before any `onEvent` call, and `onEvent` calls complete before
  the commit LSN is acknowledged

#### Scenario: Log write failure skips dispatch and ack

- GIVEN the log-writer connection is unavailable when a transaction commits
- WHEN `WalSource` attempts the log `INSERT` and it fails
- THEN no `onEvent` call is made for that transaction and the commit LSN is not acknowledged
