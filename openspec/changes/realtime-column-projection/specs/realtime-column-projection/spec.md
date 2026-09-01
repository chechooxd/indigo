# Realtime Column Projection Specification

## Purpose

Defines `@@realtime(columns: [...])`, a closed column allowlist for `@@realtime` models:
grammar, compile-time validation, the resolved IR field, and the single write-time
enforcement guarantee that a non-allowlisted column never reaches
`_indigo_realtime_log`, an SSE frame, a replay page, or a `subscribe()` callback.
This is a sibling capability to `model-allow-rules`: rows (which subscribers see) and
columns (which fields they see) are orthogonal axes, both resolved onto the same
`ResolvedTable`.

## Requirements

### Requirement: Bare `@@realtime` streams all columns, unchanged

A model declared with bare `@@realtime` (no `columns` argument) MUST stream every
column, byte-identical to behavior before this capability existed. Declaring
`columns` MUST NOT be required and MUST NOT change resolution for schemas that omit it.

#### Scenario: Bare `@@realtime` is unaffected

- GIVEN a model declared `@@realtime` with no `columns` argument
- WHEN the schema is resolved
- THEN `ResolvedTable` carries no column-allowlist field, and existing golden
  snapshots for this shape remain byte-identical

### Requirement: `columns` is a closed allowlist, exclusive to `@@realtime`

`@@realtime(columns: [a, b, ...])` MUST accept a list of field names naming exactly
the columns that MUST be included in `new`/`old` payloads; any field not listed MUST
be excluded. The `columns` argument name MUST only be valid within `@@realtime`; any
other attribute using `columns` as a named argument MUST be rejected as an unknown
argument, since no other `ArgShape` in the attribute table defines it.

#### Scenario: Listed columns narrow the payload

- GIVEN `@@realtime(columns: [id, status])` on a model with fields `id`, `status`,
  `passwordHash`
- WHEN the schema is resolved
- THEN `ResolvedTable` carries a column allowlist containing exactly `id` and `status`

#### Scenario: `columns` on a non-`@@realtime` attribute is rejected

- GIVEN a model attribute other than `@@realtime` (e.g. `@@index`) supplied with a
  `columns:` named argument
- WHEN the schema is validated
- THEN a located diagnostic rejects `columns` as an unknown named argument for that
  attribute

#### Scenario: A newly added field is excluded until opted in

- GIVEN a model with `@@realtime(columns: [id, status])`, later given a new field
  `email`
- WHEN the schema is resolved without adding `email` to `columns`
- THEN `email` is excluded from the allowlist; no code change is required to keep it
  excluded

### Requirement: A listed column that does not exist on the model is a compile error

Each entry in `columns` MUST reference an existing field on the same model. A listed
name with no matching field MUST produce a located compiler diagnostic naming the
unknown field, following the same field-existence checking `validate.rs` already
performs for `@relation` and `@@allow` field references, and MUST NOT resolve.

#### Scenario: Unknown column name rejected

- GIVEN `@@realtime(columns: [id, ghostField])` where `ghostField` is not a field on
  the model
- WHEN the schema is validated
- THEN validation fails with a located diagnostic naming `ghostField`

### Requirement: Duplicate column names are a compile error

`columns` MUST NOT contain the same field name more than once. A duplicate MUST
produce a located diagnostic and MUST NOT silently deduplicate.

#### Scenario: Duplicate entry rejected

- GIVEN `@@realtime(columns: [id, status, id])`
- WHEN the schema is validated
- THEN validation fails with a located diagnostic naming the duplicated field `id`

### Requirement: An empty `columns` list is valid and means no row body, identity only

`@@realtime(columns: [])` MUST be accepted, not rejected. It MUST resolve to an
allowlist containing zero fields. Since `event.pk` carries identity independently of
`columns` (see the primary-key requirement below), an empty list means `new`/`old`
are emitted as empty objects — a "notify me a row changed, send no body" shape, with
precedent in this codebase's `@@allow` wake-frame path, which already emits identity
with no row data.

#### Scenario: Empty list resolves to identity-only notifications

- GIVEN `@@realtime(columns: [])` on a model with primary key `id`
- WHEN a row changes on that model
- THEN the emitted `new`/`old` payload is an empty object, and `event.pk` still
  carries `id`

### Requirement: `event.pk` carries identity outside the projected view and is never narrowed

Primary-key identity for a changed row MUST travel on `RealtimeEvent.pk`, built
independently of `new`/`old` from `names.primaryKey`, and column projection MUST NOT
narrow `pk`. A primary-key field appears inside `new`/`old` only if it is explicitly
listed in `columns` — projection MUST NOT implicitly inject it there. Every consumer
that needs identity (`onDelete`, `onInsert`, the delegate's `partial` refetch,
`handleLogRequest`) reads `event.pk`, never a key inside `new`/`old`; `.live()` reads
neither and uses frames only as refetch triggers. This is why `pk` surviving
projection is sufficient on its own to keep identity-dependent consumers working.

#### Scenario: `event.pk` is complete even when the PK column is absent from `columns`

- GIVEN `@@realtime(columns: [status])` on a model whose primary key is `id`
- WHEN a row changes
- THEN `event.pk` contains the complete primary key (`id`), and `new`/`old` contain
  only `status` — `id` does NOT additionally appear inside `new`/`old`

#### Scenario: An explicitly listed PK field does appear in `new`/`old`, in addition to `pk`

- GIVEN `@@realtime(columns: [id, status])` on a model whose primary key is `id`
- WHEN a row changes
- THEN `new`/`old` contain `id` and `status` (because `id` was explicitly listed),
  and `event.pk` also independently carries `id`

### Requirement: Projection is enforced once, at write time, before the log INSERT

The projected view MUST be computed once, in `WalSource`, immediately before the row
is written to `_indigo_realtime_log`, and that same projected object MUST be the one
dispatched onward. There MUST NOT be a separate re-projection step at SSE dispatch,
replay, or the generated client. A column excluded by the allowlist MUST NOT appear
in the log row, an SSE frame, a `GET ?handle&offset` replay page, or a `subscribe()`
callback's `new`/`old`.

#### Scenario: Excluded column absent end-to-end

- GIVEN `@@realtime(columns: [id, status])` on a model with a `passwordHash` field
- WHEN a row is inserted, updated, and deleted
- THEN `passwordHash` is absent from the `_indigo_realtime_log` row, the dispatched
  SSE frame, any replay page covering that row, and the values passed to
  `subscribe()`'s `onInsert`/`onUpdate`/`onDelete`/`onChange`

#### Scenario: `old` image is projected identically to `new`

- GIVEN `@@realtime(columns: [id, status])` on a model with a `passwordHash` field
- WHEN an UPDATE or DELETE changes a row whose previous `passwordHash` value would
  otherwise appear in the `old` image
- THEN the projected `old` image omits `passwordHash`, exactly as `new` does

### Requirement: Bucket computation runs on the full row, before projection

`computeBuckets` MUST evaluate `read` `AllowRule`s against the full decoded row,
before column projection narrows it. Projecting a field out of `columns` MUST NOT
change which subscribers are authorized to read that row; the field's value MUST
still contribute to `buckets` even though it is absent from the emitted payload.

#### Scenario: An `@@allow` read-rule field excluded from `columns` still authorizes correctly

- GIVEN a model with `@@allow(read, auth.userId == this.ownerId)` and
  `@@realtime(columns: [id, status])`, where `ownerId` is NOT in `columns`
- WHEN a row with `ownerId = "u1"` changes
- THEN `buckets` is `{"u1"}` (row-authorization unaffected), and the emitted `new`
  payload does not contain `ownerId`

### Requirement: New test coverage for this capability MUST run without a database

Any test asserting projection behavior (grammar, IR, or write-time enforcement) MUST
pass with `INDIGODB_TEST_DATABASE_URL` unset, following `dispatch.mjs`'s
fake-`ServerResponse`/fake-`RealtimeSource` pattern. A test that only runs when a
live Postgres is configured MUST NOT be the sole coverage for any scenario in this
spec.

#### Scenario: Projection suite passes in a default checkout

- GIVEN a fresh checkout with `INDIGODB_TEST_DATABASE_URL` unset
- WHEN the column-projection test suite runs
- THEN every scenario in this spec that has a corresponding test executes and
  passes — none are skipped for lack of a database
