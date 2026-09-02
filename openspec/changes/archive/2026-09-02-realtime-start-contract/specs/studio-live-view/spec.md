# Delta for Studio Live View

## ADDED Requirements

### Requirement: The live badge reads `error`, never `live`, when realtime is unavailable

The Table Browser's live status MUST NOT read `live` from a response that is
not an actually-open, deliverable stream. When the realtime route responds
`503` (per `realtime-live-endpoint`'s "source never started" behavior), the
subscribing transport MUST treat that response as a connection failure, not
as a successful open, and the Table Browser's status MUST become `error`.
The badge MUST NOT assert `live` over a stream that can never deliver an
event — doing so would misreport a dead stream as healthy.

#### Scenario: Badge reads `error`, not `live`, when the realtime route responds 503

- GIVEN the active table is realtime-eligible and a backend is connected, but
  the host's realtime source never started
- WHEN the Table Browser opens its live subscription and receives a `503`
  response from `REALTIME_PATH`
- THEN the transport does not fire its "connection open" signal, and the
  Table Browser's status becomes `error`, never `live`

#### Scenario: The rest of the Studio remains usable while the badge reports error

- GIVEN the live badge is reporting `error` because the realtime source never
  started
- WHEN the user browses tables, runs queries, or reads documentation
- THEN those non-realtime features behave exactly as they would with a
  healthy realtime source — only the live badge and refresh-on-change
  behavior for the active table are affected
