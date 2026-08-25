# Design: Cacheable `GET ?handle&offset` shape-log endpoint

Verified live against `main` @ `c019bc3`: `engine.ts:100-132` (`handleRequest`, SSE only),
`138-143` (`attach`), `145-153` (`dispatch`), `protocol.ts:14-69` (`RealtimeEvent` —
**`pk` and `ts` are REQUIRED**; the header forbids runtime imports), `core/src/ir.ts:178-215`
(`AllowRule`, `ResolvedTable.allow` absent vs present), `postgres.ts:394-421` (log DDL),
`538-570` (log RLS), `650-719` (`computeBuckets`: `allow === undefined` → `null` public;
`allow` present with no `read` rule → `[]` **deny-all**), `wal-source.ts:383-395,415-449`
(log rows carry **schema-named** `pk`/`new`/`old` and `table_name` = model name),
`cli/src/index.ts:242-250` and `cli/src/studio-server.ts:330-333` (**both hosts route
manually; neither calls `attach()`**), `studio-server.ts:57-102` (`StudioDb.query(sql)` takes
**no bind parameters**), `client/src/client.ts:281-289` (`$authSession`),
`client/src/realtime.ts:103-117` (**unknown SSE event names are silently ignored**),
`client/src/realtime-delegate.ts:84,95,100,104` (**`event.pk` dereferenced unconditionally**),
`migrate-runner.ts:32` (`createHash`, **not** HMAC), `validate.rs:86-97` (the guard),
`validate.rs:1579-1592` + `tests/fixtures.rs:747,760` + `fixtures/snapshots/19-rejected-allow.json:1122`
(its three assertion sites).

## Technical Approach

```
app backend ──mintHandle({table,userId,ttl}, secret)──▶ handle in URL
                                                          │
GET /api/realtime/log?handle&offset ──▶ verifyHandle ─401─┤ (opaque)
                                          │ ok
                                          ▼
                            readOnly tx: SET set_config('app.user_id', u, true)
                                         SELECT … WHERE table_name=$1 AND id>$2::bigint
                                                  ORDER BY id LIMIT 500
                                          │ (RLS on buckets filters here)
                                          ▼
                     rows.length === LIMIT ? sealed: immutable TTL : head: no-store

WalSource ──▶ dispatch() ──┬─ table.allow === undefined → `event: change` (byte-identical)
                           └─ table.allow present       → `event: wake` {table, op, lsn}
```

Handle minting/verification lives in a **new** `packages/realtime/src/handle.ts`, not
`protocol.ts` (which the client imports type-only and whose header forbids runtime code).

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| 1 | **Wake-up predicate** | `table.allow !== undefined` — **any** `@@allow` block, not "has a `read` rule" | the proposal/spec's "carries at least one `read` `AllowRule`" | `computeBuckets` (`postgres.ts:674-678`) returns `[]` **deny-all** for an `@@allow` block with no `read` rule, because the real table has RLS enabled and denies every read. Under the `read`-only predicate a create-only `@@allow` model would keep **full-payload SSE** while its own table denies all reads — exactly the leak the guard existed to prevent. **Requires a one-line spec amendment** (`realtime-live-endpoint` spec, "SSE dispatch is scoped…") |
| 2 | Wake frame typing | New exported `RealtimeWakeEvent {table, op, lsn?}`, sent as a distinct **`event: wake`** SSE frame | make `RealtimeEvent.pk`/`ts` optional; reuse `event: change` | `pk` and `ts` are **required** in `RealtimeEvent` and `realtime-delegate.ts:84,95,100,104` dereferences `event.pk` unconditionally — relaxing them breaks `@indigodb/client` under `strict`. `realtime.ts:111` drops any frame whose event name is not `change`, so `wake` is ignored by today's client instead of producing a `pk: undefined` runtime fault. `change` stays literally byte-identical |
| 3 | Route placement | New `REALTIME_LOG_PATH = "/api/realtime/log"`, GET-only (405 otherwise), served by `handleLogRequest`; `attach()` publishes both paths | one path discriminated by `?handle` presence | SSE is `no-cache` and the log page is `immutable` on the same URL — one path invites a proxy to coalesce or cache across two opposite cache contracts, and the SSE branch emits no `Vary`. A distinct path is also independently CDN-configurable |
| 4 | Host wiring | **Both hosts get an explicit second branch**: `cli/src/index.ts:244` and `studio-server.ts:330` | rely on `attach()` "for free", as the proposal states | **Neither host calls `attach()`** — both route manually against `REALTIME_PATH`. `attach()` is third-party API only. The proposal's "publishes it on both hosts for free" is false; this is two extra explicit branches |
| 5 | DB port | New `RealtimeLogDb { readOnly<T>(fn: (query: (sql: string, params: unknown[]) => Promise<{rows}>) => Promise<T>): Promise<T> }`, defaulting to a lazily-created `pg.Pool` from `connectionString`; injectable for tests | mirror `StudioDb` verbatim, as the proposal states | `StudioDb.query(sql)` accepts **no bind parameters** (`studio-server.ts:57-68`). `offset`, table name and claim are all attacker-influenced and MUST be bound, never interpolated. The *shape* (`readOnly` = `BEGIN; SET TRANSACTION READ ONLY; …; ROLLBACK`) is reused — and is required anyway, since `set_config(…, true)` is transaction-local and must share the SELECT's transaction |
| 6 | Signature input | HMAC over the **base64url payload segment text**, not over re-serialized JSON; `sig` compared with `timingSafeEqual` **after an explicit length check** | sign the decoded/canonicalized JSON | Verification must never depend on JSON key order or number canonicalization. `timingSafeEqual` **throws** on unequal lengths — an unguarded call turns a truncated signature into a 500 instead of a 401 |
| 7 | Cursor type | `offset` is a **decimal digit string** (`/^\d{1,19}$/`), bound as text and cast `id > $2::bigint`; the response `offset` is a string | JS `number` | `id` is `bigserial`; `pg` returns `int8` as a string and values above 2^53 lose precision as a `number`. Rejecting a non-matching `offset` before any SQL is built also kills the injection surface. Absent `offset` ≡ `"0"` |
| 8 | Sealed = `hasMore` | One predicate, `rows.length === PAGE_SIZE`, drives **both** `hasMore` and `Cache-Control` | separate "is this the tail?" probe | The log has no UPDATE/DELETE policy (slice 3 decision 6) and `buckets` is written once, so a post-RLS full page is genuinely immutable for that `(handle, offset)`. A second probe could disagree with `hasMore` and produce a cached "nothing yet" — the endpoint's likeliest bug |
| 9 | Missing secret at request time | Uniform opaque `401` for every request when `INDIGODB_REALTIME_SECRET` is unset; the daemon *preflight* hard-fails only in the `@@realtime`+`@@allow` case (per spec) | 503 / omit the route / serve public tables unsigned | Uniformity is the security property (decision 9): a request that reached the query has already proven it names an allowed table. A distinct 503 would also advertise the deployment's configuration |
| 10 | Stale-but-valid table | Signature valid, but the table is no longer `@@realtime` → `404`, matching SSE's existing unknown-table 404 | 401 | The caller signed that table name itself; a 404 reveals nothing it did not already hold, and reusing SSE's code keeps one behaviour for "not a realtime table" |
| 11 | Response events | Log rows map straight to `RealtimeEvent` (`table_name`→`table`, `op`, `pk`, `new`, `old`, `ts`, `lsn`, `txid`) with no renaming | translate physical→schema names at read time | `wal-source.ts:429,446-447` already stores **schema-named** keys and the model name in `table_name`, so the log is already in wire vocabulary. Confirms the handle's `t` is the **model** name |

## Interfaces

```ts
// packages/realtime/src/handle.ts (NEW — node:crypto lives here, never protocol.ts)
export interface HandlePayload { v: 1; t: string; u: string; exp: number }
export function mintHandle(o: { table: string; userId: string | number; ttl?: number }, secret: string): string;
export function verifyHandle(token: string, secret: string): { table: string; userId: string } | null; // null = every failure
export const DEFAULT_HANDLE_TTL_SECONDS = 3600;

// packages/realtime/src/protocol.ts (types only)
export interface RealtimeWakeEvent { table: string; op: RealtimeOp; lsn?: string; seq?: number }
export interface RealtimeLogPage { events: RealtimeEvent[]; offset: string; hasMore: boolean }
export const REALTIME_LOG_PATH = "/api/realtime/log";
export const REALTIME_LOG_PAGE_SIZE = 500;   // server-fixed (decision 11 of the proposal)

// packages/realtime/src/engine.ts
handleLogRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
```

```sql
SELECT set_config('app.user_id', $1, true);
SELECT id, lsn, txid, table_name, op, pk, "new", "old", ts
  FROM "_indigo_realtime_log"
 WHERE table_name = $2 AND id > $3::bigint
 ORDER BY id LIMIT 500;                      -- existing (table_name, lsn, id) index; no new index
```

`validate.rs` diff — delete exactly lines 86-97 (the `if` block and its two comment lines);
`has_attr` remains used elsewhere. Then delete `allow_realtime_conflict_is_rejected`
(`1579-1592`), `tests/fixtures.rs:747` and its `"RealtimeAndAllow"` entry at `760`, and
regenerate `fixtures/snapshots/19-rejected-allow.json` (one error entry disappears; the
envelope stays `{errors}` because the file's other models still fail).

## File Changes

| File | PR | Action | Description |
|---|---|---|---|
| `packages/realtime/src/handle.ts` | A | Create | `mintHandle`/`verifyHandle`, `node:crypto` HMAC, length-guarded `timingSafeEqual` |
| `packages/realtime/src/protocol.ts` | A | Modify | `RealtimeWakeEvent`, `RealtimeLogPage`, `REALTIME_LOG_PATH`, `REALTIME_LOG_PAGE_SIZE` — **types/constants only** |
| `packages/realtime/src/engine.ts` | A/B | Modify | A: `handleLogRequest`, `RealtimeLogDb` port + lazy pool, `attach()` second path. B: `dispatch()` wake-up branch |
| `packages/realtime/src/index.ts` | A | Modify | Export the new symbols |
| `packages/cli/src/index.ts` | A/B | Modify | A: explicit `REALTIME_LOG_PATH` branch (decision 4). B: `INDIGODB_REALTIME_SECRET` preflight |
| `packages/cli/src/studio-server.ts` | A | Modify | Explicit `REALTIME_LOG_PATH` branch (**not** free via `attach()`) |
| `crates/indigo-compiler/src/validate.rs` | B | Modify | Delete `86-97` and `1579-1592` |
| `crates/indigo-compiler/tests/fixtures.rs` | B | Modify | Drop the two `RealtimeAndAllow` assertion sites |
| `fixtures/19-rejected-allow.indigo` + a valid realtime fixture | B | Modify | `RealtimeAndAllow` stops erroring; add the combination to an **accepted** fixture so `realtime: true` + `allow: [...]` on one `ResolvedTable` is snapshot-covered |
| `packages/compiler/wasm/` | B | Modify | Rebuilt artifact; CI `wasm-drift` is the source of truth |
| `packages/realtime/test/{handle,endpoint}.mjs` | A/B | Create | Unit + real-Postgres suites, registered in `package.json`'s `test` chain |

## Testing Strategy

| Layer | What | How |
|---|---|---|
| Unit (no DB) | `mintHandle`/`verifyHandle` round-trip; tampered payload, tampered signature, truncated signature (must return `null`, **not throw**), `v: 2`, past `exp`, missing secret, default TTL ≈ 3600s | `packages/realtime/test/handle.mjs`, plain Node |
| Unit (no DB) | `offset` validation: `""`, `"-1"`, `"1e3"`, `"1; DROP…"`, 20 digits → rejected before SQL is built | same |
| Unit (no DB) | `dispatch()` scoping: hand-built `ResolvedSchema` with (a) no `allow`, (b) `read` rule, (c) **create-only `allow`** (decision 1's RED test) → `change` / `wake` / `wake` | fake `ServerResponse` capturing written frames |
| Integration (real PG) | Cursor: 3 rows in one commit share an `lsn`, each returned once; paging to exhaustion; `hasMore`/`Cache-Control` sealed vs head (incl. the empty-page inverted-TTL guard) | `endpoint.mjs` on slice 2's `postgres` lane |
| Integration (real PG) | RLS isolation: two handles, same table, different `u` → disjoint row sets, **enforced by policy, asserted with a non-superuser role** | same |
| Integration (real PG) | Byte-identity: the same `(handle, offset)` sealed page re-requested returns an identical body | same |
| CLI | Daemon exits non-zero without `INDIGODB_REALTIME_SECRET` when a model is `@@realtime`+`@@allow`; starts when none is | spawn-based check |
| Rust | `cargo test` after the guard deletion; `parity.mjs` golden diff is the review artifact | `regen-snapshots.mjs` |

## Threat Matrix

Subprocess, VCS/PR automation and executable-file classification rows are `N/A`.

| Row | Applicable | Safe behavior | RED test |
|---|---|---|---|
| Routing — path/method confusion | Yes | Only exact `REALTIME_LOG_PATH` + `GET` reaches the handler; anything else 405/404. SSE's path never serves cacheable JSON | `POST`/`HEAD` to the log path → 405; `?handle=` on the SSE path → still SSE |
| SQL injection via `offset` / table / claim | Yes | `offset` regex-validated then bound; table and claim come only from the verified payload and are bound parameters | `offset=1;DROP…` and a handle minted with `t = 'x" OR 1=1'` both return no rows and no error |
| Identity spoofing via query/header | Yes | `app.user_id` is set only from the verified payload; no other request field is read | Request carrying `?userId=`/`X-User-Id` alongside a valid handle sees no change in rows |
| Oracle via error differentiation | Yes | One opaque `401` body for signature/version/expiry/malformed/missing-secret | The five failure modes produce byte-identical responses |
| Cache poisoning / cross-user cache hit | Yes | Identity is inside the cache key; only sealed pages are cacheable; no `Vary` dependence | Head page asserts `no-store`; two identities never share a URL |
| Amplification via client-tunable page size | Yes | `LIMIT` is the module constant `REALTIME_LOG_PAGE_SIZE` | `?limit=100000` returns ≤ 500 |
| Secret handling | Yes | Secret read from env at call time, never logged, never echoed in a response | Error paths assert the secret never appears in output |

## Migration / Rollout

Code-only: no DDL, no data change, `_indigo_realtime_log` and slice 1/3 RLS untouched.
Order per PR: `pnpm build && pnpm lint && pnpm test`, then the real-Postgres suite via
`INDIGODB_TEST_DATABASE_URL`; PR B additionally runs `cd crates && cargo test`,
`pnpm --filter @indigodb/compiler build:wasm`, `regen-snapshots.mjs` (diff is the review
artifact) and commits the artifact, letting CI `wasm-drift` reconcile. Rollback is the
proposal's four steps.

## Slice Plan

Two chained PRs (B targets A). `400-line budget risk: High` as one PR, `Medium` per slice.
`Chained PRs recommended: Yes`. `Decision needed before apply: Yes` — decision 1 changes a
written spec requirement.

- **PR A — the endpoint.** `handle.ts`, protocol types/constants, `handleLogRequest` + the DB
  port, both host branches, handle/cursor/cache suites. `dispatch()` untouched. ≈ 330 lines.
- **PR B — guard removal + SSE scoping.** `dispatch()` wake-up branch, `validate.rs` deletions,
  fixtures/snapshots, WASM rebuild, daemon preflight, isolation suite. ≈ 250 lines.

## Risks (design-level, beyond the proposal's)

| Risk | Mitigation |
|---|---|
| **A superuser or `BYPASSRLS` connection string defeats the endpoint entirely** — `FORCE ROW LEVEL SECURITY` binds the owner but not a superuser, so the daemon would return every row to every handle | Cannot be fixed in code from inside the connection. Document as a deployment requirement; the RLS isolation test MUST run as a non-bypassing role or it proves nothing |
| Third pg connection pool in the studio process (metadata + read-only + log) | Small `max`, lazily created only when the log route is first hit |
| Bucket matching is textual (slice 3's own risk) — a non-canonical claim (`"007"` vs `7`) matches the real table but not `buckets` | Inherited, unchanged; the handle's `u` is `String(userId)`, same coercion as `$authSession` |
| Handle is a bearer capability in a URL that also lands in CDN logs | Mandatory `exp`; read-only, single-table, RLS-bounded capability |
| `lsn` is absent on `PgNotifySource`, so a wake frame degrades to `{table, op}` | Acceptable: the client re-fetches by `offset`, never by `lsn`; documented on the type |
| Unbounded log growth still has no pruning path | Inherited from slice 3; the endpoint makes retention more urgent, not less |

## Open Questions

- [ ] **Blocking-ish**: decision 1 contradicts the already-written spec requirement ("at least
      one `read` `@@allow` rule"). The spec needs a one-line amendment to `@@allow` presence
      before `sdd-apply`, or the implementation will encode a leak.
- [ ] Non-blocking: whether `.live()` (deferred slice) wants a `Last-Event-ID`/resume hint on
      the `wake` frame. The frame shape is additive, so deferring costs nothing.
