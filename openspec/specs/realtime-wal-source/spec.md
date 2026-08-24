# Realtime WAL Source Specification

## Purpose

Defines `WalSource`, a `RealtimeSource` implementation over Postgres logical replication
(`pgoutput`), providing event-shape parity with `PgNotifySource` while closing the
"events lost while disconnected" gap inherent to `LISTEN`/`NOTIFY`.

## Requirements

### Requirement: `WalSource` implements the `RealtimeSource` contract

`WalSource` MUST implement `packages/realtime/src/protocol.ts`'s `RealtimeSource` interface
(`start(onEvent, onError)` / `stop()`) with no changes to that interface.

#### Scenario: Drop-in construction

- GIVEN a `ResolvedSchema` with at least one `@@realtime` model
- WHEN `new WalSource(resolvedSchema, connectionOptions)` is constructed
- THEN it exposes the same `start`/`stop` surface `PgNotifySource` exposes, with no interface changes

### Requirement: Emitted events are shape-identical to `PgNotifySource`

For insert, update, and delete on a `@@realtime` table, `WalSource` MUST emit a `RealtimeEvent`
with the same fields (`table`, `op`, `pk`, `new`, `old`, `txid`, `ts`) as `PgNotifySource`,
translated from physical table/column names to schema names.

#### Scenario: Insert parity

- GIVEN a row is inserted into a `@@realtime` table
- WHEN both `WalSource` and `PgNotifySource` observe the change
- THEN both emit a `RealtimeEvent` with identical `table`, `op: "insert"`, `pk`, and `new` values

#### Scenario: No `partial: true` truncation

- GIVEN a row whose serialized payload exceeds NOTIFY's 8000-byte limit
- WHEN `WalSource` emits the corresponding event
- THEN the full row is included and `partial` is not set to `true`

### Requirement: Changes are not lost while disconnected

`WalSource` MUST resume from the replication slot's confirmed LSN on reconnect, delivering
every change committed while the source was stopped or disconnected.

#### Scenario: Resume after restart

- GIVEN `WalSource` is stopped and one or more changes are committed on a `@@realtime` table
- WHEN `WalSource` restarts and reconnects to the same slot
- THEN every change committed during the gap is delivered, in commit order

### Requirement: Reconnect uses exponential backoff

On connection loss, `WalSource` MUST retry with the same exponential backoff policy
`PgNotifySource` uses (1s initial, capped at 30s), then resume streaming from the slot.

#### Scenario: Backoff caps at 30s

- GIVEN repeated connection failures
- WHEN `WalSource` retries
- THEN each retry delay increases exponentially and MUST NOT exceed 30 seconds

### Requirement: Unknown tables and malformed messages are dropped, not fatal

`WalSource` MUST silently skip `pgoutput` relation/change messages for tables not present in
its `@@realtime` table map, and MUST drop malformed or undecodable messages via `onError`
without terminating the stream.

#### Scenario: Change on a non-realtime table is ignored

- GIVEN a publication that (by misconfiguration) includes a non-`@@realtime` table
- WHEN a change arrives for that table
- THEN `WalSource` does not emit a `RealtimeEvent` for it and continues streaming

#### Scenario: Malformed message does not crash the stream

- GIVEN an undecodable `pgoutput` message
- WHEN `WalSource` receives it
- THEN `onError` is invoked with a descriptive error and the replication stream continues

### Requirement: `WalSource` is the engine's default source

`packages/realtime/src/engine.ts` MUST construct `WalSource` by default (`source ?? new
WalSource(...)`); `PgNotifySource` MUST remain exported and constructible via
`RealtimeEngineOptions.source`.

#### Scenario: Default engine construction uses WAL

- GIVEN `new RealtimeEngine(options)` with no `options.source` provided
- WHEN the engine starts
- THEN it uses a `WalSource` instance, not `PgNotifySource`

#### Scenario: `PgNotifySource` remains available

- GIVEN `new RealtimeEngine({ ...options, source: new PgNotifySource(...) })`
- WHEN the engine starts
- THEN it uses the explicitly provided `PgNotifySource` instance

### Requirement: Slot name resolution matches the DDL path

`WalSource` MUST resolve the replication slot name identically to
`packages/migrator`/`packages/cli`: the fixed default `indigo_realtime`, overridden by
`INDIGODB_REALTIME_SLOT` when set, validated against Postgres slot-name rules (lowercase
letters, digits, underscores only).

#### Scenario: Default slot name

- GIVEN `INDIGODB_REALTIME_SLOT` is unset
- WHEN `WalSource` connects
- THEN it starts replication on slot `indigo_realtime`

#### Scenario: Override is honored

- GIVEN `INDIGODB_REALTIME_SLOT=tenant_a_realtime`
- WHEN `WalSource` connects
- THEN it starts replication on slot `tenant_a_realtime`

#### Scenario: Invalid override is rejected

- GIVEN `INDIGODB_REALTIME_SLOT=Tenant-A!`
- WHEN `WalSource` resolves the slot name
- THEN construction fails with a diagnostic naming the invalid characters, and no connection
  is attempted
