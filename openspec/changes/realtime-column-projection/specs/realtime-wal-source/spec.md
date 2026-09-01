# Delta for Realtime WAL Source

## ADDED Requirements

### Requirement: `translate` narrows `row.new`/`row.old` to the model's `@@realtime` column allowlist

For a table with `@@realtime(columns: [...])`, `WalSource` MUST narrow `row.new` and
`row.old` — after `renameKeys` translates physical column names to schema field
names, and before the transaction's log rows are built for the
`_indigo_realtime_log` INSERT — to include only the explicitly allowlisted fields.
Narrowing MUST NOT inject the primary key into `new`/`old`; identity travels
separately on `event.pk` (see `realtime-column-projection`'s `event.pk` requirement),
built from `names.primaryKey` independently of this narrowing step and never itself
narrowed. For a table with bare `@@realtime` (no `columns`), `WalSource` MUST NOT
narrow the row; behavior is byte-identical to before this capability.

#### Scenario: Projected table narrows before the log INSERT

- GIVEN a model with `@@realtime(columns: [id, status])` and a `passwordHash` field
- WHEN `WalSource` builds the log row for an inserted row
- THEN the `new` value written to `_indigo_realtime_log` contains only `id` and
  `status`

#### Scenario: Bare `@@realtime` table is not narrowed

- GIVEN a model with bare `@@realtime` (no `columns`)
- WHEN `WalSource` builds the log row for a changed row
- THEN `new`/`old` contain every column, exactly as before this capability existed

### Requirement: Projection runs after bucket computation, on the same buffered row used for dispatch

`WalSource` MUST compute `buckets` from the full, unprojected decoded row before
narrowing `new`/`old`. The narrowed object MUST be the same object subsequently
passed to `onEvent`, so the log INSERT and the dispatched event carry identical,
already-projected payloads — there MUST NOT be a second, independent projection step
downstream.

#### Scenario: Bucket computation precedes and is unaffected by projection

- GIVEN a model with `@@allow(read, auth.userId == this.ownerId)` and
  `@@realtime(columns: [id, status])`, where `ownerId` is excluded from `columns`
- WHEN a row with `ownerId = "u1"` commits
- THEN `buckets` is `{"u1"}`, computed before narrowing, and the log row's `new`
  value omits `ownerId`

#### Scenario: Log row and dispatched event carry the same narrowed payload

- GIVEN a model with `@@realtime(columns: [id, status])`
- WHEN a row change is logged and dispatched in the same transaction
- THEN the `new`/`old` values written to `_indigo_realtime_log` and the `new`/`old`
  values passed to `onEvent` are the identical projected object, not independently
  re-derived

## MODIFIED Requirements

### Requirement: Emitted events are shape-identical to `PgNotifySource`

For insert, update, and delete on a `@@realtime` table, `WalSource` MUST emit a `RealtimeEvent`
with the same fields (`table`, `op`, `pk`, `new`, `old`, `txid`, `ts`) as `PgNotifySource`,
translated from physical table/column names to schema names. When the table declares
`@@realtime(columns: [...])`, the `new`/`old` field **values** MUST be the projected view
(explicitly allowlisted columns only — the primary key appears there only if listed)
rather than every column; `pk` MUST always be complete regardless of `columns`, since
it is built independently of `new`/`old` and never narrowed. The field **set**
(`table`, `op`, `pk`, `new`, `old`, `txid`, `ts`) is unaffected by projection.
(Previously: this requirement described only field-set parity with `PgNotifySource`; it
did not address column-value content, since no projection concept existed.)

#### Scenario: Insert parity

- GIVEN a row is inserted into a `@@realtime` table with no `columns` allowlist
- WHEN both `WalSource` and `PgNotifySource` observe the change
- THEN both emit a `RealtimeEvent` with identical `table`, `op: "insert"`, `pk`, and `new` values

#### Scenario: No `partial: true` truncation

- GIVEN a row whose serialized payload exceeds NOTIFY's 8000-byte limit
- WHEN `WalSource` emits the corresponding event
- THEN the full row is included and `partial` is not set to `true`

#### Scenario: Projected table's emitted `new` value is narrowed, field set unchanged

- GIVEN a row is inserted into a table with `@@realtime(columns: [id, status])`
- WHEN `WalSource` emits the corresponding `RealtimeEvent`
- THEN the event still carries `table`, `op`, `pk`, `new`, `old`, `txid`, `ts` as keys,
  but `new`'s value contains only `id` and `status`
