# Delta for Realtime Live Endpoint

## ADDED Requirements

### Requirement: Realtime routes return 503 when the source never started, instead of serving as if live

A host that continues running despite a rejected `RealtimeEngine.start()` (per
`realtime-source-contract`'s non-fatal operator behavior for a host process
such as `indigodb studio`) MUST NOT serve `REALTIME_PATH` (the SSE
subscription route) or `REALTIME_LOG_PATH` (the `GET ?handle&offset` route)
as if the source were live. Both routes MUST respond `503` with a fixed,
non-leaking error body when the realtime source is unavailable for that
process. This closes the gap where `RealtimeEngine.handleRequest` writes
`200` plus a `ready` SSE frame unconditionally, without consulting whether
the engine actually started — a response shape a client cannot distinguish
from a genuinely live stream.

#### Scenario: SSE subscription returns 503 when the source never started

- GIVEN a host whose `RealtimeEngine.start()` rejected and which continues
  running (per its own non-fatal policy)
- WHEN a client requests `GET <REALTIME_PATH>?tables=...`
- THEN the response is `503`, not `200`, and no `ready` SSE frame is written

#### Scenario: Log page route returns 503 when the source never started

- GIVEN a host whose `RealtimeEngine.start()` rejected and which continues
  running
- WHEN a client requests `GET <REALTIME_LOG_PATH>?handle=...&offset=...`
- THEN the response is `503`, not a paginated log slice

#### Scenario: Non-realtime routes remain unaffected while realtime routes 503

- GIVEN a host whose `RealtimeEngine.start()` rejected and which continues
  running, serving both realtime and non-realtime routes (e.g. schema, table,
  and query endpoints)
- WHEN a client requests a non-realtime route
- THEN that route responds exactly as it would with a healthy realtime
  source — this degraded state is scoped to `REALTIME_PATH` and
  `REALTIME_LOG_PATH` only
