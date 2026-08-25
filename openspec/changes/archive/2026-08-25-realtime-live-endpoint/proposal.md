# Proposal: Cacheable `GET ?handle&offset` shape-log endpoint

Change: `realtime-live-endpoint` (Road to 1.0, Phase 4). Slice 4 of the realtime epic. Exploration: Engram #731; decisions: Engram `sdd/realtime-live-endpoint/decisions`.

## Intent

Slice 3 landed `_indigo_realtime_log` (`packages/migrator/src/postgres.ts`, written by `packages/realtime/src/wal-source.ts`) with per-row `buckets` and RLS already enforced. Nothing reads it over the wire. The only wire path is SSE (`RealtimeEngine.handleRequest`, `packages/realtime/src/engine.ts`), which sets `cache-control: no-cache, no-transform`, keeps per-connection `seq` state, and fans out by `sub.tables.has(event.table)` — table name only, zero identity. So today: history is durable but unreachable, a disconnected client still loses events (`packages/client/src/realtime.ts`'s `onResync` fires with no replay), and the compiler guard in `crates/indigo-compiler/src/validate.rs:88` still refuses `@@realtime` + `@@allow` because the live push path would leak RLS-hidden rows.

This slice adds the read path that closes all three: a stateless, CDN-cacheable `GET` over the log, keyed by an offset cursor and a handle that **bakes the caller's identity into the URL** — which is what makes the cache key per-user-safe, and what finally makes row-level realtime auth real instead of theoretical.

## Scope

### In Scope

- **`GET <path>?handle=<token>&offset=<id>`** on `RealtimeEngine` — a second route branch alongside SSE, returning `{events: RealtimeEvent[], offset: <next>, hasMore: boolean}`.
- **`offset` = `_indigo_realtime_log.id`** (bigserial), not `lsn`. Multiple rows share one commit LSN, so `lsn` is not a unique cursor; `id` is. It is LSN-consistent by construction (the replication slot is exclusive — one writer, arrival order ≡ commit order), and this invariant is stated, not assumed.
- Query is `WHERE table_name = <handle's table> AND id > <offset> ORDER BY id LIMIT N`, served by the existing `(table_name, lsn, id)` index. No new index.
- **`handle` = an opaque signed token binding `{table, identity claim}`**, minted server-side, verified on every request; the endpoint sets `app.user_id` from the token's claim via `set_config('app.user_id', $1, true)` — the exact mechanism `$authSession` already uses (`packages/client/src/client.ts:286`) — so slice 3's RLS on the log does the row filtering, unchanged. **The endpoint never trusts an identity supplied outside the signature.**
- **Table-scoped handles only (v1)**: no arbitrary `where` encoding. `computeBuckets` can only evaluate `@@allow` field-equals-claim rules; there is no server-side evaluator for arbitrary predicates. Clients over-fetch their bucket-visible slice and narrow client-side.
- **Lifting the `@@realtime` + `@@allow` compiler guard** (`crates/indigo-compiler/src/validate.rs`, plus its `allow_realtime_conflict_is_rejected` test and the `model-allow-rules` requirement).
- **Scoping SSE `dispatch()` down to a wake-up signal for `@@allow`-protected models**: for a model carrying `read` `AllowRule`s, the SSE frame carries change *notification* only (no `new`/`old` payload) — "something changed on this table, re-fetch from your offset". Models without `@@allow` keep today's full-payload SSE behavior byte-identical.
- Cache headers on the endpoint, with an explicit rule for head-of-log (empty/partial) responses versus sealed full pages.

### Out of Scope — deferred

- **`.live()` client API** (`packages/client/src/realtime.ts`, `realtime-delegate.ts`). Follow-up slice. Decision 2 gives it a clear future shape — SSE wakes, `GET` fetches — but no client code lands here.
- **Arbitrary `where`-shaped handles** / a real live-query evaluator over the log's `new`/`old` jsonb.
- **Log retention / pruning.** Still the top operational commitment, still deferred (slice 3's own framing, and slice 2's orphaned-slot precedent).
- Per-subscriber identity *inside* SSE (an auth handshake on `IncomingMessage`). Decision 2 makes it unnecessary: SSE stops carrying protected data instead of learning to filter it.
- `@indigodb/studio` and the generated client (`packages/generator/src/client.ts`) — untouched.

## Capabilities

### New Capabilities

- `realtime-live-endpoint`: the `GET ?handle&offset` contract — route, response shape, `offset`=`id` cursor semantics and its one-writer ordering invariant, handle minting/verification and tamper rejection, identity→`app.user_id` binding, table-scoped-only limitation, pagination/`hasMore`, cache-header rules, and the SSE wake-up scoping for `@@allow` models.

### Modified Capabilities

- `model-allow-rules`: the "`@@realtime` and `@@allow` are mutually exclusive" requirement is **removed** and replaced by the conditions under which the combination is now legal.
- `realtime-shape-log`: gains a defined read path — the log is now readable over the wire under the handle-derived RLS context, and its `id` column becomes public cursor contract, not an internal PK.

## Approach

The route lands on `RealtimeEngine` itself, next to `handleRequest`, so `attach()` publishes it on **both** existing hosts for free — the standalone `indigodb realtime` daemon (`packages/cli/src/index.ts`) and the embedded studio server (`packages/cli/src/studio-server.ts`) — matching the "one engine, two hosts" precedent already in the code. The production-facing home is the daemon; studio inherits it as dev tooling. Reads go through an injectable DB port mirroring `StudioDb`'s `query`/`readOnly` shape, which is this repo's established way to test a real HTTP handler against a real-but-embeddable Postgres.

**Handle encoding (the security-critical piece).** `handle = base64url(payload) "." base64url(HMAC-SHA256(payload, secret))`, payload `{v:1, t:<model>, u:<claim>, exp}`. Verification uses `timingSafeEqual`; any signature, version, or expiry mismatch is a flat `401` with no detail. The secret comes from `INDIGODB_REALTIME_SECRET`, following the established `INDIGODB_<AREA>_<THING>` convention (`INDIGODB_REALTIME_SLOT`, `INDIGODB_STUDIO_DIST`), and the daemon refuses to start without it when any model is `@@realtime`+`@@allow`. `node:crypto` HMAC has precedent in `packages/cli/src/migrate-runner.ts`. Minting is exposed as a small helper so the app's own backend mints handles after its own auth — exactly the division `$auth` already establishes: IndigoDB never authenticates, it only consumes a claim the app vouches for.

**Caching.** The identity is inside the URL, so `(handle, offset)` → bytes is a pure function and the URL *is* a safe cache key. But only for **sealed** pages: a response that filled `LIMIT` can never change and gets a long immutable TTL; a short/empty page at the head of the log is a snapshot of "nothing yet" and must not be cached (`no-store`). Handle expiry rotates URLs, which trades some cache churn for bounded capability lifetime.

**Guard removal.** With the endpoint as the RLS-enforced read path and SSE reduced to a payload-free wake-up for `@@allow` models, no path remains that fans protected row data to an unauthenticated subscriber. That, and only that, is what makes the `validate.rs` guard removable.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `packages/realtime/src/engine.ts` | Modified | new `GET ?handle&offset` route branch; `dispatch()` payload scoping for `@@allow` models |
| `packages/realtime/src/protocol.ts` | Modified | handle/offset types, response shape, mint/verify helpers, route constant |
| `packages/realtime/package.json` | Unchanged | `pg` + `node:crypto` only; no new dependency |
| `crates/indigo-compiler/src/validate.rs` | Modified | remove the `@@realtime`+`@@allow` rejection and its test |
| `packages/compiler/wasm/` | Modified | rebuilt artifact (CI `wasm-drift` is the source of truth) |
| `packages/cli/src/index.ts` | Modified | `INDIGODB_REALTIME_SECRET` preflight for the daemon |
| `packages/cli/src/studio-server.ts` | Unchanged | inherits the route via `attach()` |
| `packages/realtime/test/` | New | endpoint, tamper-rejection, RLS-isolation and cursor tests |
| `fixtures/*.indigo` | Modified | a formerly-rejected `@@realtime`+`@@allow` fixture becomes valid |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Handle forgery → cross-tenant read | High impact | HMAC-SHA256 + `timingSafeEqual`, versioned payload, mandatory secret with startup preflight, opaque `401` |
| Handle is a bearer capability in a URL (logs, referrers, history) | Med | Mandatory `exp`; the token grants only the log slice RLS already permits, never write access |
| Cached page served to the wrong caller | Med | Identity is in the cache key by construction; only sealed full pages are cacheable, head pages are `no-store` |
| Guard lifted while SSE still leaks | Med | SSE scoping and guard removal ship in the same change; a spec scenario asserts no `new`/`old` on the wire for `@@allow` models |
| SSE payload scoping is a breaking change for existing `@@realtime` consumers | Low | Only applies to models with `@@allow`, which the compiler rejected until now — so no such consumer can exist |
| `id`-ordering assumption breaks under multiple writers (HA/failover) | Low | Stated as an explicit design invariant, asserted in spec; out of scope today |
| Over-fetching under table-scoped handles | Med | Documented v1 limitation; bounded by `LIMIT` + RLS, narrowed client-side |
| 400-line budget | High | Chained PRs (endpoint → guard + SSE scoping), as slices 2 and 3 both needed |

## Rollback Plan

1. Revert the route branch and handle helpers in `engine.ts`/`protocol.ts`; SSE returns to today's behavior.
2. Restore the `@@realtime`+`@@allow` rejection in `validate.rs` and its test; rebuild the WASM artifact and let `wasm-drift` reconcile.
3. Revert `dispatch()`'s payload scoping — additive-only for models that could not previously exist.
4. Drop the `INDIGODB_REALTIME_SECRET` preflight. No DDL, no migration, no data change: `_indigo_realtime_log` and slice 1 RLS are untouched, so rollback is code-only.

## Dependencies

- `main` @ `c019bc3` (slices 1–3 archived).
- No new npm dependency.
- Rust toolchain + `pnpm --filter @indigodb/compiler build:wasm` (guard removal touches `crates/`).
- Existing `postgres` CI job.

## Success Criteria

- [ ] `GET ?handle&offset` returns log rows for the handle's table with `id > offset`, ordered by `id`, capped by `LIMIT`, with a resumable next `offset`
- [ ] Two callers with different identities and the same table receive different row sets under the same offset, enforced by RLS, not by application code
- [ ] A handle with a mutated payload, mutated signature, wrong version, or past `exp` is rejected `401` and reads nothing
- [ ] The daemon refuses to start without `INDIGODB_REALTIME_SECRET` when any model is `@@realtime`+`@@allow`
- [ ] A sealed full page is cacheable and byte-identical on re-request; a head-of-log page is `no-store`
- [ ] A model with both `@@realtime` and `@@allow` compiles clean; the old diagnostic is gone
- [ ] SSE frames for an `@@allow` model carry no `new`/`old` payload; frames for a non-`@@allow` `@@realtime` model are byte-identical to today
- [ ] `pnpm build`, `lint`, `test` and `cd crates && cargo test` green; committed WASM artifact rebuilt

## Open Questions

### Resolved (user, 2026-08-25)

1. **Cache vs RLS** — identity is baked into the URL via the handle, making the CDN cache key per-user-safe. Caching applies broadly, not only to public (`buckets IS NULL`) rows.
2. **Guard resolution** — this slice lifts it. The endpoint becomes the mandatory read path for `@@allow` models; SSE is scoped down to a data-free wake-up signal for those models.
3. **`handle` scope** — table-scoped only for v1. No arbitrary `where`; clients narrow client-side. Matches what `computeBuckets` can evaluate today.
4. **`.live()`** — deferred to a follow-up slice. Decision 2 gives it its future shape (SSE wakes, `GET` fetches); this proposal must not foreclose it.
5. **Slice shape** — endpoint only (exploration approach 1), matching the roadmap's WAL → shape log → endpoint → `.live()` sequencing.

### Resolved (user, 2026-08-25, second round — recommendations adopted exactly)

6. **Handle minting surface and secret ownership** — the app mints, IndigoDB only verifies. `@indigodb/realtime` exports `mintHandle({table, userId, ttl}, secret)` and `verifyHandle(token, secret)`; the app's own backend authenticates the user and calls `mintHandle` after its own auth. The secret is read from `INDIGODB_REALTIME_SECRET`, and the daemon preflight fails fast when it is absent and any model is `@@realtime`+`@@allow`. This is the same division `$auth` already draws: IndigoDB never authenticates, it consumes a claim the app vouches for. **Rejected:** deriving key material from `DATABASE_URL` — rotating the DB password would silently invalidate every outstanding handle, coupling two unrelated rotation lifecycles.
7. **Handle expiry** — `exp` is **mandatory**, default TTL ~1h, configurable at mint. A non-expiring signed URL is a permanent, unrevocable read capability: the only way to withdraw it would be rotating the secret for every user at once. Accepted cost: URLs rotate hourly and cache entries rotate with them, which is tolerable because sealed pages dominate the request mix.
8. **Cache TTL for sealed vs. head pages** — a page that hit `LIMIT` is sealed and therefore immutable: `Cache-Control: public, max-age=31536000, immutable`. A short or empty head-of-log page is a snapshot of "nothing yet" and must be `Cache-Control: no-store`. Inverting this rule would cache "nothing happened yet" forever — the endpoint's single most likely correctness bug — so the sealed/head distinction is a first-class spec requirement, not a header detail.
9. **Public (no-`@@allow`) models** — they also require a signed handle, **uniformly**. One code path, no "is this table protected?" branch at request time, and the table allowlist stays inside the signature rather than in a client-supplied query param. Uniformity is the security property here: a request that reaches the query has already been proven to name an allowed table.
10. **Wake-up SSE frame payload** — `{table, op, lsn}` only; `pk` is **dropped**. A composite or natural PK can itself carry the protected value (e.g. `ownerId` inside a compound key), so keeping `pk` would reintroduce the leak in miniature and undermine the very reason the compiler guard is being lifted. Clients do not need it: they re-fetch by offset, not by key.
11. **Maximum page size** — server-fixed, not client-supplied. A client-tunable `limit` multiplies the cache-key space (defeating the sealed-page caching this slice exists for) and hands out a cheap amplification lever. The fixed page size is part of the endpoint contract.

### Still open

None. All eleven questions are resolved; the proposal is ready for `sdd-spec` and `sdd-design`.
