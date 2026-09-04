# Delta for Studio Schema Write

## ADDED Requirements

### Requirement: One brace-depth scanner, reused for both redaction and reattachment

The system MUST derive `redactSource(source)` from a single scanner,
`splitDatasource(source) -> { redacted, block, placeholderLine }`, so that
exactly one brace-depth scan of `datasource { ... }` exists anywhere in
`studio-server.ts`. `redactSource` MUST become a thin wrapper returning
`splitDatasource(source).redacted`. The write path MUST NOT perform a second,
independent scan of the incoming buffer to locate or validate a `datasource`
region; it MUST instead perform a literal exact-match substitution of the
sentinel line `// datasource redacted by Studio` (`placeholderLine`), splicing
in the `block` produced by applying `splitDatasource` to the current on-disk
file at write time. There is exactly one scanner, so the redaction the client
saw and the block reattached at write time cannot drift apart by construction
— not by code review discipline.

#### Scenario: redactSource and the write path share one scanner

- GIVEN `studio-server.ts` after this change
- WHEN the datasource brace-depth scan logic is located in the module
- THEN it exists in exactly one function (`splitDatasource`), and both
  `redactSource` (read path) and the `PUT` handler (write path) call it
  rather than each re-implementing a scan

### Requirement: `schemaPath` threaded from CLI into the write route

`StudioOptions` and `startStudio` MUST accept a `schemaPath` alongside the
existing `source` string, threaded from `packages/cli/src/index.ts`'s
`studio` command. When `schemaPath` is absent (e.g. an embedder or test
harness that constructs `StudioOptions` from an in-memory `source` only), the
write route MUST be unavailable rather than attempting to write to an
undefined location.

#### Scenario: CLI invocation supplies schemaPath

- GIVEN `indigodb studio` is started against a real `.indigo` file
- WHEN `startStudio` resolves its options
- THEN `StudioOptions.schemaPath` holds the absolute path to that file

### Requirement: `GET /api/schema/source` re-reads and re-redacts on every request

`GET /api/schema/source` MUST read the schema file from disk and compute
`splitDatasource` on every request. The startup-computed `publicSource`
snapshot (`studio-server.ts:771`) MUST be deleted; no cached copy of the
source text MUST be served. The response MUST include an opaque `version`
field: a content hash of the on-disk bytes at read time. This is the
precondition for the staleness check below being detectable at all — with a
startup snapshot, a file changed externally after the server started could
never be distinguished from an unchanged file.

#### Scenario: An external edit is visible on the next GET

- GIVEN Studio has been running for some time and a client already fetched
  `GET /api/schema/source` once
- WHEN the `.indigo` file is modified outside Studio (e.g. by an editor or
  `git checkout`), and the client calls `GET /api/schema/source` again
- THEN the response reflects the file's current on-disk content, not the
  content captured at server startup
- AND the returned `version` differs from the `version` returned by the
  first call

### Requirement: Sentinel-count enforcement is safe by construction, not by luck

`PUT /api/schema/source` MUST count occurrences of the sentinel line
`// datasource redacted by Studio` in the incoming buffer and act as follows,
performing no partial write in any rejection case:

| Incoming buffer condition | Response |
|---|---|
| Exactly one sentinel line, and the on-disk file has a datasource block | Splice the real block back in place of the sentinel; continue to validation |
| Zero sentinel lines, and the on-disk file has a datasource block | `400`, nothing written, message names the placeholder line verbatim |
| Two or more sentinel lines | `400`, nothing written |
| A literal `datasource` keyword at declaration position anywhere in the buffer | `400`, nothing written — a credential must never travel inbound either |
| The on-disk file has no datasource block at all | No sentinel is expected; the buffer is written as-is (subject to the other requirements below) |

A `datasource` block is not mandatory to the `.indigo` grammar in general —
most fixtures have none, and the compiler's own validator only rejects more
than one. This table's "exactly one sentinel" branch is nonetheless always
the live path for a *running* Studio process: `packages/cli/src/index.ts`
calls `resolveConnectionString(resolved)` immediately before `startStudio`,
and that call `process.exit(1)`s when no datasource block with a URL is
present. A Studio process that is up and serving `GET /api/schema/source`
therefore always has exactly one on-disk datasource block, and its every
served buffer therefore always contains exactly one sentinel line, until the
user's own edit removes or duplicates it. This is stated so a future reader
who hits a zero- or multi-sentinel refusal does not "fix" the perceived
false-positive by loosening the guard — doing so reopens the
credential-destruction hazard this route exists to close.

#### Scenario: A round-trip preserves the datasource block byte-for-byte

- GIVEN a real `.indigo` file on disk holding a literal connection string in
  its `datasource` block
- WHEN a client fetches `GET /api/schema/source`, edits the returned
  (redacted) buffer to add a new model without touching the sentinel line,
  and `PUT`s the modified buffer back with the fetched `version`
- THEN the response is `200`
- AND reading the `.indigo` file back off disk shows the `datasource` block
  is byte-identical to what was there before the edit, and the new model is
  present

#### Scenario: Deleting the sentinel line refuses the write

- GIVEN the on-disk file has a datasource block and the client's buffer omits
  the sentinel line entirely
- WHEN the client `PUT`s that buffer
- THEN the response is `400`, naming the placeholder line
- AND the on-disk file is byte-unchanged from before the request

#### Scenario: A duplicated sentinel line refuses the write

- GIVEN the client's buffer contains the sentinel line twice
- WHEN the client `PUT`s that buffer
- THEN the response is `400`
- AND the on-disk file is byte-unchanged from before the request

#### Scenario: An inbound literal datasource block is refused, never persisted

- GIVEN the client's buffer contains a literal `datasource { ... }` block
  (e.g. the user pasted a connection string directly into the editor)
- WHEN the client `PUT`s that buffer
- THEN the response is `400`
- AND the on-disk file is unchanged, and the inbound literal block is never
  written to disk or logged

#### Scenario: A schema with no datasource block round-trips without a sentinel

- GIVEN the on-disk `.indigo` file has no `datasource` block
- WHEN a client fetches, edits, and `PUT`s the buffer with no sentinel line
  present
- THEN the write proceeds (subject to staleness and validation checks) with
  no sentinel-count refusal

### Requirement: Staleness is rejected by content hash, buffer is never discarded

`GET /api/schema/source`'s `version` MUST be echoed by the client on
`PUT /api/schema/source`. The server MUST re-read the file, recompute its
content hash, and compare it against the echoed `version` before applying any
write. A mismatch MUST produce `409`, with nothing written to disk. The
client's submitted buffer MUST NOT be discarded by the server on a `409`; it
remains available in the client for the user to preserve or reconcile.

#### Scenario: A concurrent external edit is caught before overwrite

- GIVEN a client fetched `GET /api/schema/source` and received `version: v1`
- WHEN the `.indigo` file is modified externally (changing its content hash),
  and the client then `PUT`s a buffer echoing `version: v1`
- THEN the response is `409`
- AND the on-disk file retains the externally-made edit, unaffected by the
  client's stale write attempt

### Requirement: Atomic write via temp file and rename

A write that passes the sentinel, staleness, and validation checks MUST be
committed via a temp file created in the same directory as the schema file,
followed by an atomic rename over the target path. No write MUST use a
direct, non-atomic `writeFileSync` against the target path.

#### Scenario: No temp file is left behind after a successful write

- GIVEN a valid `PUT /api/schema/source` request
- WHEN the write completes with `200`
- THEN the schema file's directory contains no leftover temp file

#### Scenario: No temp file is left behind after a rejected write

- GIVEN a `PUT /api/schema/source` request that fails validation (`422`)
- WHEN the response is returned
- THEN the schema file's directory contains no leftover temp file, and the
  target file is unchanged

### Requirement: Pre-write compile validation gates every write

Before committing any write, the server MUST reattach the datasource block
(per the sentinel-substitution requirement above) into the full candidate
text and run `parse` then `resolve` against it. A failure at either stage
MUST produce `422` with the diagnostics from that failure, and MUST NOT write
anything to disk — including no partial or temp-file write.

#### Scenario: A schema that fails to parse is never written

- GIVEN a client submits a buffer containing a syntax error
- WHEN the client `PUT`s it
- THEN the response is `422` with parse diagnostics
- AND the on-disk file is byte-unchanged, and no temp file remains

#### Scenario: A schema that fails validation is never written

- GIVEN a client submits a buffer that parses but fails `resolve` (e.g. a
  duplicate model name)
- WHEN the client `PUT`s it
- THEN the response is `422` with validation diagnostics
- AND the on-disk file is byte-unchanged, and no temp file remains

### Requirement: Absence of `schemaPath` reports `schemaWritable: false` and refuses the route

`GET /api/auth/status` MUST additionally report a `schemaWritable: boolean`
field: `true` only when `StudioOptions.schemaPath` is present, independent of
read-only mode or auth state. `PUT /api/schema/source` MUST respond `404`
whenever `schemaPath` is absent, regardless of buffer content.

#### Scenario: Embedder or test harness without a real file reports not writable

- GIVEN `StudioOptions` was constructed with a `source` string and no
  `schemaPath`
- WHEN a client calls `GET /api/auth/status`
- THEN the response includes `schemaWritable: false`
- AND a `PUT /api/schema/source` request receives `404`

#### Scenario: A real file path reports writable, subject to other gates

- GIVEN `StudioOptions.schemaPath` is set to a real file
- WHEN a client calls `GET /api/auth/status`
- THEN the response includes `schemaWritable: true`
- AND this is independent of read-only mode being active — a read-only
  server with a real `schemaPath` still reports `schemaWritable: true`, since
  writability and the read-only refusal are reported through separate fields
  and the read-only gate (per `studio-readonly-mode`) is what ultimately
  produces the `403`

### Requirement: Every write outcome is a distinct, non-2xx-safe, user-observable result

Every `PUT /api/schema/source` outcome MUST map to exactly one of the
following distinguishable results, and a success indication MUST NEVER be
shown for a non-2xx response:

| Outcome | Status | Studio UI behavior |
|---|---|---|
| Write succeeds | `200` | Toast confirms the save; the dirty flag clears; the new `version` is adopted for the next edit cycle |
| Stale content | `409` | The editor buffer is kept, never discarded; a banner states the file changed on disk and offers an explicit Reload action the user must choose |
| Sentinel/redaction conflict | `400` | Message names the placeholder comment line; buffer kept |
| Schema fails to compile | `422` | Monaco markers and/or the diagnostics panel (per `studio-editor-diagnostics`) show the failure; buffer kept; nothing was written |
| Read-only mode active | `403` | The existing read-only banner/messaging is shown; Save was never attempted to succeed silently |
| No `schemaPath` configured | `404` (route) / `schemaWritable: false` (probe) | Save control is rendered disabled, with a tooltip stating persistence is unavailable in this session |

Save MUST NOT be rendered as enabled-and-silently-inert in any of these
cases: it is either enabled and produces one of the above distinguishable
results, or disabled with a stated reason.

#### Scenario: A successful save shows a toast and clears the dirty flag

- GIVEN the user has an unsaved edit and clicks Save
- WHEN the server responds `200`
- THEN a success toast is shown, the dirty indicator clears, and the client
  adopts the response's new `version`

#### Scenario: No success toast is ever shown for a non-2xx response

- GIVEN the user clicks Save
- WHEN the server responds with any of `400`, `409`, `422`, `403`, or `404`
- THEN no success toast or other success indication is shown
- AND the editor buffer is preserved, not cleared or reset

#### Scenario: Save renders disabled with a reason when the server is not writable

- GIVEN the status probe reports `schemaWritable: false`
- WHEN the ERD designer renders the Save control
- THEN the control is disabled and carries a tooltip explaining persistence
  is unavailable in this session
- AND clicking it (if reachable) performs no request
