# Delta for Realtime Shape Log

## ADDED Requirements

### Requirement: `_indigo_realtime_log` stores the projected view for `@@realtime(columns: [...])` tables

For a table with `@@realtime(columns: [...])`, the `new`/`old` `jsonb` values written
to `_indigo_realtime_log` MUST already be narrowed to the explicitly allowlisted
columns — the log MUST NOT store the full row, and MUST NOT store the primary key
inside `new`/`old` unless it was itself listed. A column excluded by the allowlist
MUST NOT be recoverable from the log after the write. Widening the allowlist later
MUST NOT retroactively recover values for rows logged before the widening; only
newly-written rows reflect the wider set. Identity is unaffected by any of this: it
is not stored in `_indigo_realtime_log`'s `new`/`old` columns but in the log row's
own `pk` column, populated from `event.pk` (see `realtime-column-projection`).

#### Scenario: Log row never carries a projected-out column

- GIVEN a model with `@@realtime(columns: [id, status])` and a `passwordHash` field
- WHEN a row's change is logged
- THEN reading that log row's `new`/`old` values never yields `passwordHash`, under
  any query

#### Scenario: Widening the allowlist does not recover prior history

- GIVEN a model logged rows while `@@realtime(columns: [id])` was in effect
- WHEN the schema is later changed to `@@realtime(columns: [id, email])` and
  redeployed
- THEN rows logged before the change still lack `email` in their `new`/`old` values;
  only rows logged after the change carry it

### Requirement: Bare `@@realtime` log rows are unaffected by this capability

For a table with bare `@@realtime` (no `columns`), `_indigo_realtime_log` rows MUST
continue to store every column, exactly as before this capability existed.

#### Scenario: Non-projected table's log rows are unchanged

- GIVEN a model with bare `@@realtime`
- WHEN a row's change is logged
- THEN the log row's `new`/`old` values contain every column, byte-identical to
  behavior before this capability
