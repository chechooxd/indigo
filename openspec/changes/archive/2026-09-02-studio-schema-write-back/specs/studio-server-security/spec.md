# Delta for Studio Server Security

## MODIFIED Requirements

### Requirement: Datasource redaction in API responses, in both directions, computed per request

The system MUST NOT expose the `datasource` block — including connection
strings supplied via `env()` or as a literal URL — in any response served by
`/api/schema` or `/api/schema/source`. Redaction MUST apply to the entire
`datasource` block, not only the `url` field. `GET /api/schema/source` MUST
compute this redaction by reading the schema file from disk and running the
shared `splitDatasource` scanner on every request; it MUST NOT serve a
snapshot computed once at server startup, since a cached snapshot cannot
reflect a datasource block edited on disk after the process started.

Redaction now also has an inbound direction: a buffer submitted to
`PUT /api/schema/source` MUST NOT be able to introduce a `datasource` block
into the persisted file by including one literally in the submitted text —
the write route rejects such a buffer outright (per `studio-schema-write`).
The real datasource block, when reattached server-side to satisfy a
sentinel-substitution write, MUST be read from disk and spliced back into the
file being written; it MUST NOT be included in any HTTP response, log line,
or error message, so the credential never leaves the process in either
direction of this route.

#### Scenario: /api/schema omits datasource regardless of literal or env() URL

- GIVEN a resolved schema whose `datasource` uses a literal connection string
- WHEN a client requests `GET /api/schema`
- THEN the JSON response contains no `datasource` key
- AND this holds identically when the schema instead uses `env()` for the URL

#### Scenario: /api/schema/source omits datasource block from raw source, computed fresh each time

- GIVEN raw `.indigo` source text containing a `datasource` block with a
  connection string
- WHEN a client requests `GET /api/schema/source`
- THEN the returned text does not contain the `datasource` block or any
  connection string it held
- AND this redaction is computed by reading the current on-disk file for that
  request, not served from a value cached at server startup

#### Scenario: A literal datasource block in a write buffer never reaches disk or a response

- GIVEN a client submits a `PUT /api/schema/source` buffer containing a
  literal `datasource { ... }` block with a connection string
- WHEN the server processes the request
- THEN the request is rejected before any write occurs
- AND the submitted connection string does not appear in the HTTP response,
  in any log line, or anywhere on disk beyond the client's own submitted
  buffer never being persisted

#### Scenario: The real datasource block never appears in a response during reattachment

- GIVEN a valid `PUT /api/schema/source` request that triggers server-side
  reattachment of the real datasource block
- WHEN the write succeeds
- THEN the `200` response body does not contain the datasource block or its
  connection string

(Previously: this requirement covered only outbound redaction on
`GET /api/schema` and `GET /api/schema/source`, and `GET /api/schema/source`
was permitted to serve a snapshot computed once at startup rather than
per-request.)
</content>
