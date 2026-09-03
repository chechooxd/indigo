# Studio Layout Persistence Specification

## Purpose

Node positions dragged on the ERD canvas MUST survive a page reload and a
Studio process restart. Positions are view layout, not schema semantics, so
they are stored in a sidecar `schema.layout.json` file next to the schema
file, with its own versioned route reusing the atomic-write and
content-hash staleness shape `studio-schema-write` already established —
independent of, and never gated behind, a schema Save.

## Requirements

### Requirement: Layout is stored as a sidecar file keyed by table name

`schema.layout.json` MUST live in the same directory as the schema file
(`{schemaPath dir}/schema.layout.json`) and store a JSON object mapping
table name to `{x, y}`. Table names not present in the current schema MUST
be ignored on read, and a table present in the schema but absent from the
layout file MUST fall back to the existing seeded-position formula rather
than erroring.

#### Scenario: A stale key for a deleted table is ignored, not an error

- GIVEN `schema.layout.json` contains a position for `OldTable`, which no
  longer exists in the current schema
- WHEN the canvas loads
- THEN no error occurs, `OldTable`'s stale entry is ignored, and every
  current table renders normally

#### Scenario: A table missing from the layout file falls back to the seed formula

- GIVEN a newly added table `Tag` has no entry in `schema.layout.json`
- WHEN the canvas loads
- THEN `Tag` is positioned using the existing formula-based seed, not an
  error or a `(0,0)` default

### Requirement: GET/PUT layout route mirrors the schema write route's version and atomic-write contract

`GET /api/schema/layout` MUST return the current layout object plus an
opaque `version` (content hash of the sidecar file's bytes, or a fixed
sentinel when the file does not yet exist). `PUT /api/schema/layout` MUST
accept `{layout, version}`, reject with `409` on a version mismatch without
writing, and commit via a temp file + atomic rename in the same directory,
identical in shape to `studio-schema-write`'s write path.

#### Scenario: A stale layout write is rejected without overwriting a concurrent update

- GIVEN a client fetched `GET /api/schema/layout` and received `version: v1`
- WHEN the sidecar file is modified externally, and the client then `PUT`s
  a layout echoing `version: v1`
- THEN the response is `409` and the on-disk sidecar retains the external
  edit

#### Scenario: A successful layout write commits atomically

- GIVEN a valid `PUT /api/schema/layout` request
- WHEN the write completes with `200`
- THEN the sidecar file's directory contains no leftover temp file, and
  reading `schema.layout.json` back shows exactly the submitted positions

### Requirement: Layout writes are debounced and independent of schema Save

Dragging a node MUST trigger a debounced autosave to
`PUT /api/schema/layout`, decoupled from the schema's dirty-buffer/Save
cycle defined in `studio-erd-editing`. A layout write MUST NOT require or
wait for a schema Save, and a schema Save MUST NOT implicitly write layout.

#### Scenario: Dragging a node persists without clicking schema Save

- GIVEN the user has no pending schema edits
- WHEN the user drags a table node to a new position and waits past the
  debounce window
- THEN `PUT /api/schema/layout` is sent automatically, with no schema Save
  click required

#### Scenario: A schema Save does not implicitly write layout

- GIVEN the user has moved a node but the layout debounce has not yet fired
- WHEN the user clicks schema Save
- THEN `PUT /api/schema/source` is sent, and no `PUT /api/schema/layout`
  request is sent as a side effect of that Save

### Requirement: Layout route reports and enforces writability like the schema write route

`GET /api/auth/status` MUST report `layoutWritable: boolean`, `true` only
when `StudioOptions.schemaPath` is present (the sidecar path is derived
from it), independent of read-only mode. `PUT /api/schema/layout` MUST
respond `404` whenever `schemaPath` is absent, regardless of body content.

#### Scenario: Missing schemaPath reports layout not writable and the route 404s

- GIVEN `StudioOptions` was constructed with an in-memory `source` and no
  `schemaPath`
- WHEN a client calls `GET /api/auth/status`
- THEN the response includes `layoutWritable: false`
- AND a `PUT /api/schema/layout` request receives `404`, even with a
  well-formed `{layout, version}` body

#### Scenario: Missing schemaPath also disables layout GET meaningfully

- GIVEN `schemaPath` is absent
- WHEN a client calls `GET /api/schema/layout`
- THEN the response is `404`, consistent with there being no sidecar
  location to read from

### Requirement: Read-only mode refuses layout writes identically to schema writes

When Studio is running with `readOnly: true`, `PUT /api/schema/layout` MUST
be refused by the same shared read-only gate `studio-readonly-mode` defines
for `PUT /api/schema/source`, before any staleness or write-target logic
runs. (Full behavior, including the audit-log line and the explicit
write-route set, is specified in `studio-readonly-mode`'s delta for this
change.)

#### Scenario: A layout drag in read-only mode is refused, not silently dropped

- GIVEN `readOnly` is true
- WHEN the user drags a node and the debounce fires a
  `PUT /api/schema/layout` request
- THEN the response is `403 {error: "Studio is running in read-only mode"}`
- AND the sidecar file is unchanged, and the UI indicates the drag was not
  persisted rather than showing a silent success

#### Scenario: Read-only mode combined with a missing schemaPath still refuses via read-only first

- GIVEN `readOnly` is true and `schemaPath` is absent (so `layoutWritable`
  is also `false`)
- WHEN a client sends `PUT /api/schema/layout`
- THEN the response is `403` from the read-only gate, since that gate runs
  before route-specific `schemaPath` handling — the response is not `404`
</content>
