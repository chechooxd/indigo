# Delta for Realtime Live Endpoint

## MODIFIED Requirements

### Requirement: SSE dispatch is scoped to a data-free wake-up signal for `@@allow`-protected models

For a model carrying an `@@allow` block at all (`ResolvedTable.allow !== undefined`), regardless
of whether that block includes a `read` rule, `RealtimeEngine.dispatch()` MUST send an SSE frame
containing only `{table, op, lsn}` — no `pk`, `new`, or `old`. This is because `computeBuckets`
returns `[]` (deny-all) for an `@@allow` block with no `read` rule, and the real table's RLS
denies every read without a matching policy; scoping only on the presence of a `read` rule would
leave such a model on full-payload SSE while its `GET ?handle&offset` path denies all reads,
reopening the leak the guard exists to prevent. Models without `@@allow` MUST continue to receive
today's full-payload SSE frames, byte-identical to prior behavior.

This wake frame is now a **client-observable trigger contract**: the generated client's
`.live()` (see `client-live-queries`) treats `event: wake` as the sole signal to refetch via
`GET ?handle&offset`, and MUST NOT rely on the wake frame carrying any row data. The frame
shape and its data-free guarantee are therefore load-bearing for a real consumer, not only an
internal implementation detail.
(Previously: this requirement described only the server-side dispatch contract; it had no
client consumer, so the frame's observability by a live-query loop was unverified in practice.)

#### Scenario: `@@allow` model wake-up frame carries no row data

- GIVEN a model with `@@allow(read, auth.userId == this.ownerId)` and `@@realtime`
- WHEN a row changes on that model
- THEN the dispatched SSE frame contains only `table`, `op`, and `lsn` — `pk`, `new`, and `old`
  are all absent

#### Scenario: `pk` is dropped even though it could disambiguate the row

- GIVEN a model with a composite primary key where one key field is itself sensitive
  (e.g. `ownerId` inside the key)
- WHEN a row changes and the wake-up frame is dispatched
- THEN `pk` is absent from the frame; clients determine what changed by re-fetching from
  `GET ?handle&offset`, not by key

#### Scenario: Create-only `@@allow` model still gets wake-up-only SSE

- GIVEN a model with `@@allow(create, true)` and `@@realtime`, and no `read` rule anywhere in
  its `@@allow` block
- WHEN a row changes on that model
- THEN the dispatched SSE frame is still the scoped `{table, op, lsn}` shape, not a full payload
  — because `ResolvedTable.allow !== undefined` for this model, even though `computeBuckets`
  would independently deny all reads via RLS

#### Scenario: Non-`@@allow` realtime model is unaffected

- GIVEN a `@@realtime` model with no `@@allow` block
- WHEN a row changes on that model
- THEN the dispatched SSE frame is byte-identical to the frame shape emitted before this change
  (`table`, `op`, `pk`, `new`, `old`, `txid`, `ts`, `lsn`, `seq` as applicable)

#### Scenario: A generated `.live()` query observes the wake frame as its refetch trigger

- GIVEN a generated client for a model with `@@realtime` and `@@allow`, with an active
  `.live()` query on that model
- WHEN the model's row changes and the scoped `{table, op, lsn}` frame is dispatched
- THEN `.live()` receives `event: wake` as the trigger to schedule a debounced `findMany`
  refetch, using only `table` and `op` to decide to refetch — never reading `pk`/`new`/`old`
  from the frame, since none are present

### Requirement: Handle payload, signing, and verification

A handle MUST be `base64url(payload) "." base64url(HMAC-SHA256(payload, secret))`, where
`payload = {v: 1, t: <table>, u: <identity claim>, exp: <unix timestamp>}`. Verification MUST
use a timing-safe comparison. The secret MUST be read from `INDIGODB_REALTIME_SECRET`. Minting
MUST be exposed as `mintHandle({table, userId, ttl}, secret)`; verification as
`verifyHandle(token, secret)`. The endpoint MUST NOT trust any identity claim supplied outside
the verified signature.

Handle provisioning to the generated client is pinned to an **app-supplied `getHandle`
callback** (`IndigoClientOptions.realtime.getHandle: (table) => Promise<string>`), not to any
IndigoDB-owned HTTP minting route. The app calls `mintHandle` itself, server-side, after its
own authentication, and returns the resulting token string to the client via `getHandle`.
IndigoDB MUST NOT expose any HTTP route that mints a handle on the app's behalf; doing so would
require IndigoDB to authenticate the caller, which is explicitly out of scope — `$auth` already
draws this line, and `getHandle` preserves it.
(Previously: this requirement described only the server-side mint/verify contract, with no
stated position on how a client obtains a handle at all — no client consumer existed yet.)

#### Scenario: Minted handle round-trips

- GIVEN `mintHandle({table: "Order", userId: "u1", ttl: 3600}, secret)`
- WHEN the resulting token is passed to `verifyHandle(token, secret)`
- THEN verification succeeds and yields `{table: "Order", userId: "u1"}`

#### Scenario: Identity comes only from the verified handle

- GIVEN a valid handle minted for `userId: "u1"`
- WHEN the request is processed
- THEN `app.user_id` is set to `"u1"` from the verified payload, regardless of any other
  identity-shaped value present in the request

#### Scenario: The client never mints a handle directly

- GIVEN a generated client with `realtime.getHandle` configured to call `mintHandle` on the
  app's own backend
- WHEN a `.live()` query needs a handle
- THEN the client calls the app-supplied `getHandle(table)` function and uses its resolved
  token verbatim; the client package itself never calls `mintHandle` or any minting HTTP route
