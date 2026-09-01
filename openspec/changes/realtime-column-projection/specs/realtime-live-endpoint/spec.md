# Delta for Realtime Live Endpoint

## ADDED Requirements

### Requirement: `dispatch()` and `handleLogRequest` forward stored bodies verbatim and never re-widen

For a table with `@@realtime(columns: [...])`, `RealtimeEngine.dispatch()` MUST emit
the SSE frame's `new`/`old` exactly as received from `WalSource` (already projected)
— it MUST NOT re-read or re-derive a wider payload. `handleLogRequest` MUST map
`_indigo_realtime_log` rows to `RealtimeEvent`s verbatim, applying no filtering of
its own. Because `handleLogRequest` filters nothing and the log itself stores only
the projected view (`realtime-shape-log`), a replay page is structurally guaranteed
to be exactly as narrow as the live SSE frame for the same row: a narrow stored row
cannot produce a wider page, since nothing widens it in between. This is the
normative guarantee; a DB-gated test exercising `GET ?handle&offset` end-to-end is
confirmation of it, not the sole proof. There MUST be no code path, option, or flag
that restores a projected-out column at dispatch or replay time.

This requirement is independent of, and stacks with, the existing `@@allow` row-level
SSE scoping: a model may have neither, either, or both of `@@allow` row filtering and
`@@realtime(columns: [...])` column projection active at once.

#### Scenario: Live SSE frame matches the projected log row

- GIVEN a model with `@@realtime(columns: [id, status])` and a `passwordHash` field
- WHEN a row change is dispatched over SSE
- THEN the frame's `new`/`old` contain only `id` and `status` — identical to what was
  written to `_indigo_realtime_log`

#### Scenario: Replay page is exactly as narrow as the live frame (structural guarantee; DB-gated test confirms it)

- GIVEN a model with `@@realtime(columns: [id, status])`, and `handleLogRequest`
  mapping stored log rows to `RealtimeEvent`s with no filtering step of its own
- WHEN a client pages through `GET ?handle&offset` covering that row's change
- THEN the returned event's `new`/`old` values contain only `id` and `status`,
  matching what the live SSE frame carried at dispatch time — guaranteed by the
  stored row already being narrow, not by any narrowing performed at replay time;
  a `log.mjs`/`endpoint.mjs` DB-gated test that exercises this end-to-end confirms
  the guarantee but is not required for the guarantee to hold

#### Scenario: Column projection and `@@allow` row scoping compose

- GIVEN a model with both `@@allow(read, auth.userId == this.ownerId)` and
  `@@realtime(columns: [id, status])`, where `ownerId` is excluded from `columns`
- WHEN a row change is dispatched
- THEN row-level access is still governed by `buckets` (computed from the full row,
  per `realtime-wal-source`), and the frame's `new`/`old` — for subscribers who pass
  the row-level check — contain only `id` and `status`

### Requirement: `subscribe()` callbacks receive the projected payload; this is an intentional shape change

The generated client's `RealtimeModelDelegate.subscribe()` (`onInsert`, `onUpdate`,
`onDelete`, `onChange`) MUST receive exactly the `new`/`old` values dispatched by the
engine — narrowed for any model using `@@realtime(columns: [...])`. This is an
intentional, accepted breaking-ish change in payload shape for any model that adopts
`columns`: existing subscriber code reading a now-excluded field receives `undefined`
for it, not an error.

#### Scenario: Subscriber receives fewer keys after adopting `columns`

- GIVEN a generated client subscribed to a model that previously streamed all columns
  and now declares `@@realtime(columns: [id, status])`
- WHEN a row changes
- THEN `onInsert`/`onUpdate`/`onDelete`/`onChange` receive `new`/`old` containing only
  `id` and `status`; a previously-present field such as `passwordHash` is simply
  absent from the object, not present as `undefined` via an explicit key

#### Scenario: Non-projected model's subscriber is unaffected

- GIVEN a generated client subscribed to a model with bare `@@realtime`
- WHEN a row changes
- THEN `subscribe()` callbacks receive every column, exactly as before this
  capability existed
