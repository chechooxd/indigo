# Tasks: Cacheable `GET ?handle&offset` shape-log endpoint

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~330 (A) + ~250 (B) ≈ 580 total, authored risk excludes goldens/WASM |
| 400-line budget risk | High as one PR, Medium per slice |
| Chained PRs recommended | Yes |
| Suggested split | PR A → PR B |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: Yes — design decision 1 amends the spec's SSE wake-up predicate
from "carries a `read` `AllowRule`" to "`ResolvedTable.allow !== undefined`" (already applied to
`openspec/changes/realtime-live-endpoint/specs/realtime-live-endpoint/spec.md`; PR B implements
the corrected predicate, not the originally-proposed one).
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|----|----|------------------|--------------------|
| 1 | The endpoint: `handle.ts` mint/verify, `RealtimeLogDb` port, `handleLogRequest`, both host branches, cursor/cache-header logic | A (base=tracker) | `pnpm --filter @indigodb/realtime test` | `packages/realtime/test/{handle,endpoint}.mjs` (unit + real Postgres, `INDIGODB_TEST_DATABASE_URL`) | Revert PR A only; no compiler/SSE change exists yet, route is additive, `_indigo_realtime_log` untouched |
| 2 | Guard removal + SSE wake-up scoping + WASM | B (base=A) | `cd crates && cargo test` / `pnpm --filter @indigodb/realtime test` | `packages/realtime/test/dispatch.mjs` (fake `ServerResponse`); `node packages/compiler/test/parity.mjs` | Revert PR B; restore the `validate.rs` rejection + test, rebuild WASM, let `wasm-drift` reconcile; PR A's endpoint keeps working unchanged (rollback is code-only, per proposal) |

## PR A — The endpoint (base = tracker)

- [ ] A1.1 [RED] `packages/realtime/src/handle.ts`: `mintHandle({table,userId,ttl},secret)` /
  `verifyHandle(token,secret)` round-trip (`{table:"Order",userId:"u1"}` in → out); `ttl` omitted
  defaults `exp` to ~3600s from mint time; `mintHandle` with no way to omit `exp` (mandatory,
  never `undefined`/`0`/absent on the signed payload).
- [ ] A1.2 [RED — threat: forgery/tamper] tampered payload segment (re-encoded with a different
  `u`, NOT re-signed) → `verifyHandle` returns `null`; tampered signature segment (bit flipped) →
  `null`; unrecognized `v: 2` payload, correctly signed → `null`; expired `exp` (past), valid
  signature → `null`; a **truncated** signature segment (shorter byte length than the real HMAC)
  → `null`, and critically **does not throw** — `timingSafeEqual` throws on unequal-length
  buffers, so the length check MUST run before the compare or this degrades to a 500 instead of a
  401 upstream.
- [ ] A1.3 [GREEN] implement `mintHandle`/`verifyHandle`: HMAC-SHA256 over the **base64url payload
  segment TEXT** (never re-serialized/canonicalized JSON — design decision 6), `node:crypto`
  (`createHmac`, `timingSafeEqual`), explicit `Buffer.byteLength` check before the timing-safe
  compare, `DEFAULT_HANDLE_TTL_SECONDS = 3600`, `HandlePayload {v:1,t,u,exp}`. Secret read from
  the `secret` argument only — no direct `process.env` read inside `handle.ts` (callers supply
  `INDIGODB_REALTIME_SECRET`).
- [ ] A2.1 [GREEN] `packages/realtime/src/protocol.ts` (types/constants only — no runtime
  imports, per the file's existing header contract): add `RealtimeWakeEvent
  {table,op,lsn?,seq?}` as a distinct type (NOT a relaxed `RealtimeEvent` — `pk`/`ts` stay
  required on `RealtimeEvent` so `realtime-delegate.ts`'s unconditional `event.pk` dereference
  keeps compiling under `strict`); `RealtimeLogPage {events,offset,hasMore}`;
  `REALTIME_LOG_PATH = "/api/realtime/log"`; `REALTIME_LOG_PAGE_SIZE = 500`.
- [ ] A3.1 [RED] `packages/realtime/src/engine.ts` — offset validation: `""`, `"-1"`, `"1e3"`,
  `"1; DROP TABLE"`, a 20-digit string all rejected **before any SQL is built**; absent `offset`
  is treated as `"0"`; a valid `/^\d{1,19}$/` string is bound as text and cast `id >
  $2::bigint` (never interpolated, never coerced to a JS `number` — `bigserial` exceeds
  `Number.MAX_SAFE_INTEGER`).
- [ ] A3.2 [GREEN] implement offset parsing/validation per design decision 7 (regex-gate, reject
  before query construction, response `offset` returned as a string).
- [ ] A4.1 [RED] `RealtimeLogDb` port shape: `readOnly<T>(fn)` runs `fn` inside `BEGIN; SET
  TRANSACTION READ ONLY; ...; ROLLBACK` (mirrors `StudioDb`'s `readOnly` shape) but — unlike
  `StudioDb.query(sql)` — `query(sql, params)` accepts bind parameters, since `offset`/table/claim
  are all attacker-influenced and MUST be bound, never interpolated (design decision 5, explicit
  divergence from `StudioDb`).
- [ ] A4.2 [GREEN] implement `RealtimeLogDb` with a lazily-created `pg.Pool` default
  (`connectionString`-driven, small `max`), injectable for tests (PGlite/fake-port pattern
  mirroring the `StudioDb` test idiom).
- [ ] A5.1 [RED] `set_config('app.user_id', $1, true)` runs **inside the same read-only
  transaction** as the log `SELECT` — `set_config(..., true)` is transaction-local, so issuing it
  on a different connection/transaction from the `SELECT` silently fails to scope RLS.
- [ ] A5.2 [RED] identity used for `app.user_id` comes ONLY from the verified handle's `u` claim —
  a request additionally carrying `?userId=`/an `X-User-Id` header alongside a valid handle sees
  no change in the rows returned (threat: identity spoofing via query/header).
- [ ] A5.3 [GREEN] `handleLogRequest(req,res)`: verify handle → `401` (opaque, uniform body) on
  any of the 4 failure causes (tampered payload / tampered signature / unknown version /
  expired) or on a missing/malformed `handle` param, including when `INDIGODB_REALTIME_SECRET`
  is unset entirely (design decision 9 — uniform `401` at request time, distinct from PR B's
  startup preflight) → else open `readOnly` tx, `set_config` the claim, `SELECT table_name=$1 AND
  id > $2::bigint ORDER BY id LIMIT 500` → map rows straight to `RealtimeEvent` (no
  physical→schema renaming — the log already stores schema-named keys, design decision 11).
- [ ] A6.1 [RED] a signature-valid handle naming a table that is no longer `@@realtime` (or never
  was) → `404`, matching SSE's existing unknown-table behavior (design decision 10) — not `401`,
  since the caller already proved it signed that table name itself.
- [ ] A6.2 [GREEN] wire the stale-table 404 branch, reusing SSE's existing unknown-table check.
- [ ] A7.1 [RED] cache headers: a response whose `events.length === REALTIME_LOG_PAGE_SIZE`
  (page filled, `hasMore: true`) → `Cache-Control: public, max-age=31536000, immutable`; a
  response with fewer than `REALTIME_LOG_PAGE_SIZE` events, **including zero** → `Cache-Control:
  no-store` (the inverted-TTL regression guard: an empty head-of-log page must never be
  cacheable) — one predicate (`rows.length === PAGE_SIZE`) drives BOTH `hasMore` and the header,
  never two independently-computed checks that could disagree (design decision 8).
- [ ] A7.2 [GREEN] implement the sealed/head cache-header branch off the single `rows.length ===
  PAGE_SIZE` predicate.
- [ ] A8.1 [RED — threat: SQL injection] `offset=1;DROP TABLE` and a handle minted with `t = 'x"
  OR 1=1'` both return no rows / no server error (table name and claim are bound parameters
  sourced only from the verified payload, never string-built into SQL).
- [ ] A8.2 [RED — threat: amplification via client-tunable page size] `?limit=100000` (or any
  limit-shaped param) never returns more than `REALTIME_LOG_PAGE_SIZE` rows — `LIMIT` is the
  module constant, not client input.
- [ ] A8.3 [RED — threat: routing/method confusion] `POST`/`HEAD` to `REALTIME_LOG_PATH` → `405`;
  `?handle=` appended to the existing SSE path still serves SSE, never the JSON page (the two
  paths are distinct per design decision 3 — SSE `no-cache` and the log's `immutable` must never
  share a URL).
- [ ] A8.4 [GREEN] wire method-guard (`405` for non-GET) and confirm route separation.
- [ ] A9.1 [RED — threat: secret handling] the secret never appears in any response body, error
  message, or thrown error's `.message` across every failure path exercised above.
- [ ] A9.2 [GREEN] audit error paths; confirm no interpolation of `secret`/token internals into
  user-facing output.
- [ ] A10.1 [GREEN] `packages/realtime/src/engine.ts`: wire `handleLogRequest` as a second route
  branch (`attach()` publishes both paths — this is `attach()`'s own internal dispatch, distinct
  from decision 4's finding that the HOST processes don't call `attach()` at all, see A11).
- [ ] A10.2 [GREEN] `packages/realtime/src/index.ts`: export `handleLogRequest`,
  `RealtimeLogDb`, `mintHandle`, `verifyHandle`, `RealtimeWakeEvent`, `RealtimeLogPage`,
  `REALTIME_LOG_PATH`, `REALTIME_LOG_PAGE_SIZE`.
- [ ] A11.1 [RED] `packages/cli/src/index.ts` (~line 244, the standalone `indigodb realtime`
  daemon's manual routing) and `packages/cli/src/studio-server.ts` (~line 330, the embedded
  server's manual routing): each gets its own explicit `REALTIME_LOG_PATH` branch — confirmed
  necessary because **neither host calls `attach()`** (design finding, decision 4); a request to
  `REALTIME_LOG_PATH` on either host reaches `handleLogRequest`, not a 404.
- [ ] A11.2 [GREEN] add the explicit branch to both `cli/src/index.ts` and
  `cli/src/studio-server.ts`.
- [ ] A12.1 [RED — real PG] `packages/realtime/test/endpoint.mjs`: cursor correctness — 3 rows in
  one commit sharing one `lsn` are each returned exactly once, ordered by `id`; paging to
  exhaustion via successive `offset`s eventually returns `hasMore: false`.
- [ ] A12.2 [RED — real PG, own explicit task per apply prompt — do NOT let this be silently
  satisfied by a default/superuser connection] **RLS isolation MUST run as a non-superuser,
  non-`BYPASSRLS` role.** `FORCE ROW LEVEL SECURITY` binds the table owner but never a superuser
  connection, so a test asserting isolation over a superuser/`BYPASSRLS` pool proves nothing (top
  design risk). The test harness MUST `CREATE ROLE ... NOLOGIN` (or equivalent) and run the
  endpoint's query connection `SET ROLE` to that non-bypassing role before asserting: two valid
  handles for the same table, different `userId` claims, disjoint `buckets`-scoped rows → each
  request returns only its own identity's rows, enforced by the policy, not application code.
  Explicitly document in the test file header that this is a rollback boundary in itself: if this
  test is ever weakened to run as a superuser, it silently stops proving RLS isolation at all.
- [ ] A12.3 [RED — real PG] byte-identity: the same `(handle, offset)` sealed page re-requested
  returns an identical response body.
- [ ] A12.4 [GREEN] wire `endpoint.mjs` into the same `postgres` CI lane already used by
  `log.mjs`/`buckets.mjs` (self-skips when `INDIGODB_TEST_DATABASE_URL` is unset). No CI workflow
  changes needed — `packages/realtime`'s `test` script already runs in that lane.
- [ ] A13.1 [VERIFY] `pnpm --filter @indigodb/realtime test` (real PG present) and confirm
  self-skip when `INDIGODB_TEST_DATABASE_URL` is unset.
- [ ] A13.2 [VERIFY] `pnpm build && pnpm lint && pnpm test` (workspace-wide; no `crates/` touched
  in this PR — no WASM rebuild, no snapshot regen).
- [ ] A13.3 [COMMIT] `feat(realtime,cli): add cacheable GET /api/realtime/log endpoint`.

## PR B — Guard removal + SSE wake-up scoping + WASM (base = PR A)

- [ ] B1.1 [RED] `packages/realtime/src/engine.ts` `dispatch()` scoping: hand-built
  `ResolvedSchema`/`ResolvedTable` fixtures for (a) no `allow` at all → full-payload `event:
  change` frame, byte-identical to today (`table`,`op`,`pk`,`new`,`old`,`txid`,`ts`,`lsn`,`seq`);
  (b) `allow` present with a `read` rule → scoped `event: wake` frame `{table,op,lsn}` only, no
  `pk`/`new`/`old`; (c) **`allow` present with ONLY a `create` rule, no `read` rule anywhere**
  (the corrected-predicate RED test per the spec fix, Engram #734/#735) → ALSO scoped `event:
  wake`, not full payload — asserts the predicate is `table.allow !== undefined` (any `@@allow`
  block), not "carries a `read` `AllowRule`". Without this exact case the create-only model would
  wrongly stay on full-payload SSE while its `GET ?handle&offset` path denies all reads via RLS,
  reopening the leak the guard exists to prevent.
- [ ] B1.2 [RED] composite-PK case: a hand-built table with an `@@allow` block and a composite
  primary key (one key field itself sensitive, e.g. `ownerId` inside the key) → wake frame still
  omits `pk` entirely, even though `pk` could otherwise disambiguate the row; clients must re-fetch
  by offset, never by key.
- [ ] B1.3 [GREEN] implement the `dispatch()` branch: `table.allow !== undefined` →
  `RealtimeWakeEvent {table,op,lsn}` on a distinct `event: wake` SSE frame; else unchanged
  `event: change` full payload. Confirm `packages/client/src/realtime.ts:111`'s existing
  "unknown event name is silently ignored" behavior means today's client tolerates `wake` frames
  with no code change on the client side (additive-safe, no client package changes in this PR).
- [ ] B2.1 [GREEN] `packages/cli/src/index.ts`: `INDIGODB_REALTIME_SECRET` startup preflight —
  the daemon refuses to start when any resolved model is both `@@realtime` and `@@allow` and the
  env var is unset; starts normally when no model combines both, secret unset or not.
- [ ] B2.2 [RED] preflight unit test (spawn-based or fake-schema-driven): schema with a
  `@@realtime`+`@@allow` model, secret unset → non-zero exit, diagnostic names the missing env
  var; secret set → starts; schema with no such model, secret unset → starts.
- [ ] B2.3 [GREEN] wire B2.2's test.
- [ ] B3.1 [RED] `crates/indigo-compiler/src/validate.rs`: `allow_realtime_conflict_is_rejected`
  removed; a fixture combining `@@realtime`+`@@allow` on one model now compiles with **zero**
  diagnostics naming that conflict (the specific "conflicting attributes" diagnostic is gone;
  other unrelated diagnostics in the same fixture, if any, are unaffected).
- [ ] B3.2 [GREEN] delete `validate.rs:86-97` (the `if` block + its two comment lines — `has_attr`
  remains used elsewhere, confirm no dangling unused-import warning) and
  `validate.rs:1579-1592` (`allow_realtime_conflict_is_rejected`).
- [ ] B3.3 [GREEN] `crates/indigo-compiler/tests/fixtures.rs`: drop the `"RealtimeAndAllow"`
  assertion at line 747 and its entry at line 760.
- [ ] B4.1 [GREEN] `fixtures/19-rejected-allow.indigo`: the `RealtimeAndAllow` model stops
  producing that diagnostic (the file's other rejection-class models keep failing — envelope
  stays `{errors}`, one fewer entry).
- [ ] B4.2 [GREEN] add the `@@realtime`+`@@allow` combination to an **accepted** fixture (new or
  existing) so `realtime: true` + `allow: [...]` co-occurring on one `ResolvedTable` is
  snapshot-covered on the accept path, not just "no longer rejected."
- [ ] B5.1 [VERIFY] `cd crates && cargo test` — confirm `allow_realtime_conflict_is_rejected`'s
  removal and B3.1's fixture assertion both hold.
- [ ] B5.2 [GREEN] `pnpm --filter @indigodb/compiler build:wasm` — rebuild the WASM artifact,
  commit it (per repo convention: local rebuild is for dev, `wasm-drift` on `main` is the source
  of truth for the exact committed bytes).
- [ ] B5.3 [VERIFY] `node packages/compiler/test/regen-snapshots.mjs` — review the diff: only
  `19-rejected-allow.json` (one error entry disappears) and the new/modified accepted fixture from
  B4.2 change; no other snapshot drifts.
- [ ] B5.4 [VERIFY] `node packages/compiler/test/parity.mjs` — golden diff is the review artifact,
  confirm green.
- [ ] B6.1 [VERIFY] `pnpm --filter @indigodb/realtime test` (real PG present) and confirm
  self-skip when `INDIGODB_TEST_DATABASE_URL` is unset — `dispatch.mjs`'s scoping suite is unit
  (no DB), `endpoint.mjs` from PR A is unaffected and still green.
- [ ] B6.2 [VERIFY] `pnpm build && pnpm lint && pnpm test` (workspace-wide).
- [ ] B6.3 [COMMIT] `feat(compiler,realtime,cli): lift @@realtime+@@allow guard, scope SSE to a wake-up signal`.

## Post-slice cleanup

- [ ] C1 Confirm proposal Success Criteria fully met across PR A–B (paginated cursor page, RLS
  row-set isolation by identity, uniform opaque 401 across all 4+1 failure causes including
  models without `@@allow`, daemon secret preflight, sealed-vs-head cache correctness, guard
  lifted with a clean compile, byte-identical SSE for non-`@@allow` models,
  `pnpm build/lint/test` + `cargo test` green with the committed WASM artifact rebuilt).
- [ ] C2 Merge the 1 new full spec (`realtime-live-endpoint`) and the `model-allow-rules` /
  `realtime-shape-log` deltas into `openspec/specs/` once this change archives.
- [ ] C3 Log follow-up (non-blocking): `.live()` client API is deferred to a follow-up slice;
  its shape is SSE-wakes-then-GET-fetches per proposal decision 4 — the `wake` frame's shape is
  additive, so this slice does not foreclose it, but no client-package work happens here.
- [ ] C4 Log follow-up (non-blocking): log retention/pruning has no path yet (inherited from
  slice 3); this slice makes it more operationally urgent, not less.
- [ ] C5 Log follow-up (non-blocking): whether `.live()`'s deferred `wake` frame wants a
  `Last-Event-ID`/resume hint is an open, non-blocking design question noted in design.md.
