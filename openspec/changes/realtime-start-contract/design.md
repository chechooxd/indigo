# Design: Realtime `start()` Readiness Contract

## Technical Approach

`WalSource` gains a one-shot **ready deferred**, created in `start()`, resolved from the existing
`service.on("start")` handler (`wal-source.ts:238`) and rejected from `connect()`'s catch.
`start()` awaits only that deferred; the `connect()` promise runs detached. `connect()`'s
internals — both supersession checks (`:279`, `:300`), the orphaned-socket guard,
`scheduleReconnect()` — are untouched. `PgNotifySource` already conforms and gets no code change.
`protocol.ts` documents the contract as a comment only; no signature change.

## Architecture Decisions

### Decision: Deferred lifecycle — `start()` owns every settle path

**Choice**: `private ready: { resolve; reject } | null`. `settleReady(outcome, err?)` settles then
**nulls the field** — that null is the whole first-attempt scoping mechanism. `start()`:

```ts
async start(onEvent, onError) {
  this.settleReady("reject", new Error("WalSource: superseded by a later start()"));
  this.stopped = false;
  const ready = new Promise<void>((resolve, reject) => { this.ready = { resolve, reject }; });
  const attempt = this.connect(onEvent, onError);
  attempt.then(
    () => this.settleReady("reject", new Error("WalSource: stream ended before it became live")),
    (err) => this.settleReady("reject", toError(err)),
  );
  attempt.catch(() => {});   // see the unhandled-rejection decision
  await ready;               // the ONLY thing start() awaits
}
```

`connect()` adds exactly two lines: `this.settleReady("resolve")` inside the existing
`service.on("start")` handler, and `this.settleReady("reject", error)` in the catch immediately
after `onError(error)`.

**Why it cannot leak into a reconnect**: a second `connect()` only ever runs from
`scheduleReconnect()` (armed only from `connect()`'s own success/catch tails or
`teardownAfterLogFailure`, which requires a live stream ⇒ already resolved). Every exit of the
first `connect()` — early `stopped` return, either supersession return, catch, normal completion —
either settles the deferred itself or is covered by the `attempt.then(...)` backstop, which fires
on that same first attempt. By the time any reconnect attempt exists, `this.ready` is `null` and
both settle calls are no-ops.

**`stop()` while `start()` is pending**: `stop()` sets `stopped = true`; the in-flight first
`connect()` reaches a `stopped` return or its catch, `attempt` settles, and the backstop **rejects**
the deferred. `start()` therefore always settles — never hangs. Rejection, not resolution, because
a stopped source is not live.

**Alternatives rejected**: an `onReady` callback on `RealtimeSource` (widens a seam the spec forbids
widening); a timeout-based resolve (invents a liveness signal Postgres already sends).

### Decision: Unhandled-rejection safety

**Choice**: `attempt.catch(() => {})` attaches in `start()`, on the same promise, **after**
`attempt.then(onFulfilled, onRejected)` has already registered. It swallows nothing the deferred
needs: `.then`'s rejection handler runs first and forwards the real error into `settleReady`; the
`.catch` observes only the already-consumed rejection of a separate derived promise. The catch on
`attempt` is registered synchronously in the same tick, so no rejection is ever unobserved.

**Rejected**: `void this.connect(...)` alone (unhandled rejection kills the process) and
`process.on("unhandledRejection")` (global, hides other faults).

### Decision: Remove the dead `else throw err`

**Choice**: delete `else throw err;` (`wal-source.ts:319`), leaving `if (!this.stopped)
this.scheduleReconnect(...)`. It is unreachable on the normal path (the guard at `:308` exhausts
`stopped`) and only *nearly* dead in theory — a consumer whose `onError` synchronously calls
`stop()` flips `stopped` between the two checks. Even then a throw into a now-detached promise
signals nobody. The deferred is the single failure channel. `start()`'s doc comment (`:178-180`),
which today claims a fail-fast parity that has never worked, is rewritten to state the real
contract. **Rejected**: leaving it as documentation — unreachable code in a catch block is exactly
the "green signal that verifies nothing" this repo keeps shipping.

### Decision: `RealtimeEngine.start()` guarantees

`engine.ts:156` needs no restructuring — nothing after the `await` assumes stream end; it only arms
the heartbeat. One fix: `this.started = true` is set *before* the await, so a rejected start leaves
a permanently "started", permanently dead engine. Reset `this.started = false` in a catch before
rethrowing. On resolve the engine now guarantees to `studio-server.ts` / `cli/index.ts`: *the source
accepted a live stream and the heartbeat is armed* — a point-in-time fact, not a promise of future
liveness (reconnects stay silent by design).

### Decision: Operator-visible behaviour

| Call site | Behaviour | Output |
|---|---|---|
| `cli/index.ts:269` | wrap in `try/catch`; `console.error("❌ Realtime failed to start: " + err.message)` then `process.exit(1)` — before `server.listen`, so no port is bound | non-zero exit, Postgres error text |
| `studio-server.ts:823` | `try { await engine.start() } catch (err) { console.error("⚠ Realtime unavailable: " + err.message + " — Studio continues without live updates"); realtimeAvailable = false; await engine.stop().catch(() => {}) }`, then `listen` as usual | warning line; server binds |

### Decision: the Studio live badge must not lie (**answers the traced question**)

**Traced**: `useLiveTable` sets `status: 'live'` from `onOpen`; `SseTransport` (`realtime.ts:76-80`)
fires `onOpen` on **any HTTP 200**; `engine.handleRequest` (`engine.ts:207-218`) writes 200 + a
`ready` frame **unconditionally — it never consults `started` or the source**. So with the
non-fatal Studio path and a dead source, the badge would read **`live` over a stream that can never
deliver an event**. Confirmed misreport, and this change is what makes it reachable (today the
Studio simply never binds).

**Choice**: fix it here, in `studio-server.ts` only — `if (path === REALTIME_PATH && engine)` at
`:928` becomes conditional on `realtimeAvailable`, returning `503 {"error":"Realtime unavailable"}`
otherwise (same for `REALTIME_LOG_PATH` at `:934`). `SseTransport` then throws on `!res.ok` →
`onError` → the badge reads `error`. ~6 lines, no `engine.ts` API change.
**Tradeoff accepted**: `realtimeAvailable` is latched false for the process (the engine is stopped,
so its background backoff is not silently retrying behind a false badge); recovery requires a
Studio restart. **Rejected**: shipping the lie as a follow-up — a badge asserting `live` over a
dead stream is this repo's signature defect wearing a UI, and it would be *introduced* by this
change.

## Data Flow

    start()  ──creates──▶ ready deferred ◀──resolve── service.on("start")   [stream live]
       │                        ▲
       │                        └──reject──── connect() catch  [initial connect failure]
       │                        └──reject──── attempt settled while still pending  [backstop]
       └──detached──▶ connect() ──▶ subscribe() ... ──▶ scheduleReconnect()  [never settles ready]

    engine.start() ─await─▶ source.start() ─▶ heartbeat armed
         │ resolve ─▶ cli: listen()        │ studio: listen(), realtimeAvailable = true
         │ reject  ─▶ cli: exit(1)         │ studio: warn, listen(), realtimeAvailable = false → 503

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/realtime/src/wal-source.ts` | Modify | `ready` field + `settleReady()`; `start()` rewrite; resolve in `service.on("start")`; reject in catch; delete `else throw err`; private `createService()`/`createWriter()` test seams; corrected doc comment |
| `packages/realtime/src/protocol.ts` | Modify | Normative `start()`/`stop()` contract as a doc comment on `RealtimeSource` (comment only) |
| `packages/realtime/src/engine.ts` | Modify | Reset `started = false` when `source.start()` rejects |
| `packages/cli/src/index.ts` | Modify | try/catch → message + `process.exit(1)` before `listen` |
| `packages/cli/src/studio-server.ts` | Modify | Non-fatal start, `realtimeAvailable` latch, 503 on both realtime routes |
| `packages/realtime/test/wal-source.mjs` | Modify | Default-checkout readiness/rejection/scoping tests; tail `console.log` at `:702` becomes `strictEqual(passed, <N>)` |
| `packages/realtime/test/source-contract.mjs` | Create | Seam-level checks: `PgNotifySource` first-attempt rejection, signature-freeze assertions, no-DB guard |
| `packages/realtime/test/parity.mjs` | Modify | `PgNotifySource` resolve-timing assertion (DB-gated) |
| `packages/cli/test/studio-realtime-degraded.mjs` | Create | Studio binds + 503 with an unreachable realtime source (PGlite harness) |
| `packages/cli/test/realtime-fail-fast.mjs` | Create | `spawnSync` the built CLI, assert non-zero exit |
| `apps/studio/src/features/studio/browser/hooks/useLiveTable.test.ts` | Create/Modify | SLV-1/SLV-2 — real `SseTransport` over a stubbed `fetch` returning 503 (vitest, the one package that uses it) |
| `packages/realtime/test/dispatch.mjs` | Modify | RSC-14 (rejected `engine.start()` is restartable) + DESIGN-ONLY-1 |
| `packages/realtime/package.json` | Modify | Chain `source-contract.mjs` into the `test` script (plain-Node convention, no runner) |
| `packages/cli/package.json` | Modify | Chain the two new `cli/test` files into the `test` script |

**Harness seam — confirmed, not assumed**: `withStudio` (`packages/cli/test/studio-harness.mjs:95-104`)
already passes `connectionString: "postgres://unused/unused"` *separately* from the injected
`createPgliteStudioDb(db)`, and spreads `...options` last — so a test can override it. Only
`RealtimeEngine` (`studio-server.ts:821`) ever dials that string; `StudioDb` never does. The new
degraded test overrides it to `postgres://127.0.0.1:1/db` rather than relying on the default's DNS
failure for the host `unused`, which is resolver-dependent and slow. The risk flagged in the first
pass is closed.

## Interfaces / Contracts

```ts
/**
 * start(onEvent, onError) resolves ONCE THE STREAM IS CONFIRMED LIVE — the
 * server has accepted the subscription (PgNotifySource: `LISTEN` returned;
 * WalSource: the server acked START_REPLICATION). It MUST NOT wait for the
 * stream to end. It rejects if the FIRST connection attempt fails; later
 * losses are retried with backoff and never re-settle it. stop() during a
 * pending start() settles it as a rejection — never leaves it pending.
 */
```

**Test seam** (private, no interface change): `createService()` / `createWriter()` factory methods
on `WalSource`, overridden in tests via `source["createService"] = ...` — the same reach-into-the-
instance style `wal-source.mjs:53-54,65` already uses. **Rejected**: a module mocker (`esmock`) —
the repo has no mocking framework and `config.yaml` forbids introducing one.

## Testing Strategy

**Reconciled against the landed spec, second pass (2026-09-01).** IDs are spec scenario IDs in the
spec's own order, one prefix per capability: `RSC-n` = `realtime-source-contract` (14 scenarios),
`RWS-n` = `realtime-wal-source` (11), `EPT-n` = `realtime-live-endpoint` (3), `SLV-n` =
`studio-live-view` (2). **30 scenarios across four capabilities; every one has at least one row
below** — see the coverage statement after the tables. (`EPT`, not `RLE`, because "RLE-2" is
already this repo's shorthand for the held `realtime-column-projection` branch.) **Default
checkout** = runs with no
`INDIGODB_TEST_DATABASE_URL` (six of nine `packages/realtime/test/` suites SKIP without it —
`endpoint`, `buckets`, `pg-harness`, `parity`, `log`, `resume`; `wal-source`, `dispatch` and
`handle` run unconditionally, as do all PGlite-backed `packages/cli` suites).

### `realtime-source-contract` (14 scenarios)

| ID | Spec scenario | Test file | Assertion | Default checkout |
|---|---|---|---|---|
| RSC-1 | `start()` resolves promptly on a healthy stream, not at stream end | `realtime/test/wal-source.mjs` | fake service; fire `"start"`; `start()` resolves while `subscribe()`'s promise is **still pending** — assert both halves | **Yes** |
| RSC-2 | `WalSource` satisfies the seam's resolve-timing requirement | `realtime/test/wal-source.mjs` | same fake, asserted through the **public** `RealtimeSource` surface only (`start`/`stop`), no private reads | **Yes** |
| RSC-3 | `PgNotifySource` satisfies the seam's resolve-timing requirement | `realtime/test/parity.mjs` | existing `notifySource.start()` (`:107`) gains an explicit "settled before any event arrives" assertion | No (DB-gated) |
| RSC-4 | Missing replication slot rejects `start()` | `realtime/test/wal-source.mjs` | `createService()` returns a fake whose `subscribe()` rejects with the real Postgres shape (`code: "42704"`, `does not exist`); `await rejects` with **that same error identity** | **Yes** |
| RSC-5 | **Authentication failure rejects `start()`** | `realtime/test/wal-source.mjs` | **different path from RSC-4**: `createWriter()`'s `connect()` rejects with `{ code: "28P01", message: "password authentication failed" }` — fails before `subscribe()` is ever reached; assert the rejection carries that error, and that `subscribe()` was never called | **Yes** |
| RSC-6 | `PgNotifySource` rejects on a first-attempt connect failure | `realtime/test/source-contract.mjs` (new) | `new PgNotifySource("postgres://127.0.0.1:1/db", schema)`; `start()` rejects with ECONNREFUSED — no seam, no DB, no code change to `source.ts` | **Yes** |
| RSC-7 | A reconnect failure after a successful start does not reject `start()` | `realtime/test/wal-source.mjs` | after RSC-1 resolves, drive a second `connect()` whose writer rejects; spy on the captured `resolve`/`reject` shows **zero** further calls; `source["ready"] === null` | **Yes** |
| RSC-8a | A reconnect **success** after a successful start does not re-resolve `start()` | `realtime/test/wal-source.mjs` | after RSC-1 resolves, fire `"start"` on a second fake service; settle-spy call count stays at 1 | **Yes** |
| RSC-8b | A reconnect **success after a rejected start** does not re-settle it either | `realtime/test/wal-source.mjs` | after RSC-4's rejection, fire `"start"` on a second fake service; the original rejection stands and no unhandled rejection is raised | **Yes** |
| RSC-9 | `stop()` before the stream goes live tears down the in-flight attempt | `realtime/test/wal-source.mjs` | writer `connect()` held open; call `stop()`; `await start()` **rejects** within one macrotask, and the fake service's `stop()`/writer `end()` were both called | **Yes** |
| RSC-10 | Backoff-driven reconnect scheduling is unchanged | `realtime/test/wal-source.mjs:648` (existing A4) | the existing 1s→30s suite must stay green untouched — this is the executable form of "connect() internals unmodified" | **Yes** |
| RSC-11 | **No `RealtimeSource` signature change** | `realtime/test/source-contract.mjs` (new) + `pnpm lint` | executable, not prose: (a) `strictEqual(WalSource.prototype.start.length, 2)` and the same for `PgNotifySource`, plus `deepStrictEqual` of the sorted own-method names against the frozen `["models","start","stop"]` list; (b) an `rg` guard asserting `protocol.ts`'s `interface RealtimeSource` body diff is **comment-only** (no line outside `/** */` changed); (c) `tsc --noEmit` proves no structural widening | **Yes** |
| RSC-12 | Standalone daemon exits non-zero on a rejected `start()` | `cli/test/realtime-fail-fast.mjs` (new) | `spawnSync(process.execPath, [cliEntry, "realtime", ...])` with `postgres://127.0.0.1:1/db`; `status !== 0`, stderr contains the driver error, and the port is **not** listening | **Yes** |
| RSC-13 | Studio server binds its port despite a rejected `start()` | `cli/test/studio-realtime-degraded.mjs` (new) | `withStudio` with a `@@realtime` schema and `connectionString: "postgres://127.0.0.1:1/db"`; `GET /api/schema` → 200 | **Yes** |
| RSC-14 | A rejected `engine.start()` resets the engine's started state | `realtime/test/dispatch.mjs` | fake source whose `start()` rejects; the rejection propagates AND a **second** `engine.start()` is not short-circuited by leftover state — assert the second call reaches `source.start()` again, not just that `engine["started"] === false` | **Yes** |

### `realtime-wal-source` (11 scenarios)

| ID | Spec scenario | Test file | Assertion | Default checkout |
|---|---|---|---|---|
| RWS-1 | **Drop-in construction** | `realtime/test/wal-source.mjs` (existing A1.1 section, extended) | `new WalSource(url, testSchema())` exposes exactly `start`/`stop`/`models`; `models` matches the `@@realtime` set; construction performs no I/O (no `createService`/`createWriter` call before `start()`) | **Yes** |
| RWS-2 | `start()` resolves once the stream is confirmed live, not at stream end | `realtime/test/wal-source.mjs` | same case as RSC-1, asserted on `WalSource` concretely | **Yes** |
| RWS-3 | `start()` rejects on a missing replication slot | `realtime/test/wal-source.mjs` | same case as RSC-4 | **Yes** |
| RWS-4 | **`start()` rejects on an authentication failure** | `realtime/test/wal-source.mjs` | same case as RSC-5 — a **separate** case from RWS-3, since a `28P01` on the writer connection and a `42704` from `subscribe()` reach the deferred through different code paths | **Yes** |
| RWS-5 | A later reconnect failure does not reject the already-settled `start()` | `realtime/test/wal-source.mjs` | same case as RSC-7 | **Yes** |
| RWS-6a | A later reconnect success does not re-resolve the already-settled `start()` | `realtime/test/wal-source.mjs` | same case as RSC-8a (after a **resolve**) | **Yes** |
| RWS-6b | …nor re-settle a `start()` that already **rejected** | `realtime/test/wal-source.mjs` | same case as RSC-8b (after a **reject**) | **Yes** |
| RWS-7 | `stop()` before the stream goes live tears down the in-flight attempt | `realtime/test/wal-source.mjs` | same case as RSC-9 | **Yes** |
| RWS-8 | Supersession and orphaned-socket guards still fire | `realtime/test/wal-source.mjs` | drive a second `connect()` while the first awaits `writer.connect()`; assert the superseded attempt closes its own writer (`end()` called) and does not overwrite `this.writer` — the `:279`/`:300` guards, unchanged | **Yes** |
| RWS-9 | Backoff policy is unchanged | `realtime/test/wal-source.mjs:648` (existing A4) | same as RSC-10 | **Yes** |
| RWS-10 | **Readiness tests pass without `INDIGODB_TEST_DATABASE_URL`** | `realtime/test/wal-source.mjs`, `source-contract.mjs`, plus an `rg` guard | executable, per the `realtime-column-projection` precedent: (a) each suite ends with `strictEqual(passed, <exact N>, "...")` instead of today's bare `console.log(\`${passed} passed\`)` (`wal-source.mjs:702`), so an omitted or silently-skipped case **shrinks the count and fails loudly**; (b) an `rg` guard asserting neither new/edited readiness file contains the string `INDIGODB_TEST_DATABASE_URL`; (c) the whole leg is run once with that variable explicitly unset | **Yes** |
| RWS-11 | DB-gated suites that previously hung no longer hang at `start()` | `realtime/test/log.mjs`, `resume.mjs`, `parity.mjs` | **Discovery, not a pass promise.** These three have never completed even once. The claim under test is narrow and only that: *they no longer block at `await source.start(...)`*. Any other failure they surface is a follow-up and does **not** make this row green by omission | No (DB-gated) |

### `realtime-live-endpoint` (3 scenarios)

| ID | Spec scenario | Test file | Assertion | Default checkout |
|---|---|---|---|---|
| EPT-1 | SSE subscription returns 503 when the source never started | `cli/test/studio-realtime-degraded.mjs` (new) | `GET /api/realtime?tables=X` → **503**, body exactly `{error:"Realtime unavailable"}`; and the response body contains **no `event: ready` frame** — asserted on the raw text, since a 503 that still wrote a `ready` frame would satisfy a status-code-only check while leaving the client's `onOpen` path reachable | **Yes** |
| EPT-2 | Log page route returns 503 when the source never started | `cli/test/studio-realtime-degraded.mjs` (new) | `GET /api/realtime/log?handle=…&offset=…` → **503**, not a paginated slice; body carries no `events`/`offset`/`hasMore` keys | **Yes** |
| EPT-3 | Non-realtime routes remain unaffected while realtime routes 503 | `cli/test/studio-realtime-degraded.mjs` (new) | **Not a formality — this is the row that proves the 503 gate did not take the server down with it, the exact regression a blunt implementation causes.** Run the *same* assertion block against two fixtures — a healthy Studio (no `@@realtime`) and the degraded one — over `GET /api/schema`, `GET /api/tables/:name` and `POST /api/query`, and require **identical status and body shape** from both. A differential assertion, so it cannot pass vacuously the way a bare "expect 200" would if the routes had been degraded together | **Yes** |

### `studio-live-view` (2 scenarios)

| ID | Spec scenario | Test file | Assertion | Default checkout |
|---|---|---|---|---|
| SLV-1 | Badge reads `error`, not `live`, when the realtime route responds 503 | `apps/studio` vitest `useLiveTable` test | Drive a **real `SseTransport`** over a stubbed `fetch` returning `503` — not an injected transport that calls `onError`, which would assume the very behaviour under test. Assert `onOpen` never fires and `status === 'error'`, never transiently `'live'` (record every `setStatus` value, not just the final one) | **Yes** |
| SLV-2 | The rest of the Studio remains usable while the badge reports error | `apps/studio` vitest | with `status === 'error'`, `fetchTableRows` still resolves and `updateTableRecords` still lands rows in the store — the error status is scoped to the badge and the refresh-on-change path, and does not gate data fetching | **Yes** |

### Row carrying no spec scenario (labelled, not counted as coverage)

| ID | Subject | Test file | Assertion | Default checkout |
|---|---|---|---|---|
| DESIGN-ONLY-1 | `engine.start()` resolves on a live source and arms the heartbeat | `realtime/test/dispatch.mjs` | existing fake source; `start()` resolves and events fan out. **No spec scenario covers this** — the landed set specifies the rejection path (RSC-14) and the resolve *timing* at the source seam (RSC-1/RWS-2), but nothing asserts the engine's own success path arms the heartbeat. Kept explicitly labelled rather than mapped to a near-miss | **Yes** |

### Coverage statement — four capabilities, 30 scenarios

- **`realtime-source-contract`: 14 of 14** scenarios have ≥1 row (scenario 8 split across RSC-8a/8b;
  RSC-14 is the new restartable requirement at `spec.md:199-217`).
- **`realtime-wal-source`: 11 of 11** scenarios have ≥1 row (scenario 6 split across RWS-6a/6b).
- **`realtime-live-endpoint`: 3 of 3** scenarios have ≥1 row (EPT-1..3).
- **`studio-live-view`: 2 of 2** scenarios have ≥1 row (SLV-1..2).
- **Total: 30 of 30 covered.** One row (DESIGN-ONLY-1) carries no spec scenario and is labelled as
  such; it is not counted toward any capability's coverage.
- Requested spec split (still open): `realtime-source-contract` scenario 8 and `realtime-wal-source`
  scenario 6 should each become two — re-settle-after-**resolve** and re-settle-after-**reject** —
  because one scenario cannot honestly claim both. Rows already anticipate the split.
- Cross-products explicitly covered: {`WalSource`, `PgNotifySource`} × {resolve-on-live,
  reject-on-initial-failure} = RSC-1/RSC-3/RSC-4+RSC-5/RSC-6. {missing slot, auth failure} ×
  {`WalSource` domain, seam domain} = RSC-4/RSC-5/RWS-3/RWS-4. {first attempt, reconnect} ×
  {success, failure} = RSC-1/RSC-4/RSC-8a/RSC-7, with RSC-8b covering reconnect-success-after-reject.
  {realtime routes, non-realtime routes} × {degraded host} = EPT-1+EPT-2/EPT-3.
- **28 of 30 scenarios run in a default checkout** (was 20 of 24; all five new endpoint/live-view
  rows and RSC-14 run unconditionally — `cli` suites are PGlite-backed, `apps/studio` uses vitest,
  `dispatch.mjs` is one of the three ungated realtime suites). The two that do not are **RSC-3**
  (`parity.mjs`, needs a real `LISTEN` connection) and **RWS-11** (`log`/`resume`/`parity`, needs a
  real replication slot); RWS-11 is discovery, not a pass promise.

RED-before-GREEN (strict TDD): every row above must first fail against unmodified sources. RSC-1/
RSC-2/RWS-2 fail by hanging — assert with an explicit `Promise.race` sentinel so the RED is a
**failed assertion, not a suite timeout**.

## Threat Matrix

Applicable — this change touches process integration (exit codes) and HTTP routing.

| Row | Applicable? | Expected behaviour | RED test |
|---|---|---|---|
| Process exit / signal handling | Applicable | `indigodb realtime` exits 1 with no port bound; no `SIGINT` handler installed on the failure path | RSC-12 |
| HTTP routing change | Applicable | Only `REALTIME_PATH`/`REALTIME_LOG_PATH` gain a 503 branch; every other route unchanged | EPT-1, EPT-2, EPT-3 (differential), RSC-13 |
| Unhandled rejection / process crash | Applicable | Detached `connect()` never crashes the host process | RSC-8b (unhandled-rejection recorder asserted empty) |
| Error message leakage | Applicable | The CLI prints the Postgres error (operator-facing, intended); the Studio's 503 body is the fixed string `"Realtime unavailable"` — no connection string, no driver detail | EPT-1, EPT-2 |
| Shell/subprocess execution | N/A | No shell invocation; `spawnSync` appears only in a test, with an argv array | — |
| VCS/PR automation, executable-file classification | N/A | Not touched | — |
| SQL injection | N/A | No SQL is constructed or altered | — |
| AuthN/AuthZ | N/A | `@@allow`/RLS and Studio session auth untouched; the 503 branch sits behind the existing auth gate | — |

## Migration / Rollout

No migration. Single revertable commit; `connect()`'s internals are unmodified, so a revert restores
prior behaviour with no state or artifact to undo.

## Open Questions

- [x] **Spec gap closed**: spec added `realtime-live-endpoint` (3 scenarios), `studio-live-view`
      (2 scenarios), and `realtime-source-contract`'s restartable requirement (`spec.md:199-217`).
      Former `DESIGN-ONLY-2/3/4` are re-keyed to RSC-14 / EPT-1+EPT-2 / SLV-1 respectively.
- [ ] **Smaller gap remaining**: nothing specifies the engine's *success* path (heartbeat armed on a
      resolved `start()`). DESIGN-ONLY-1 stays labelled rather than mapped to a near-miss. An
      optional additive `realtime-source-contract` scenario would close it; not blocking.
- [ ] **Spec split requested**: `realtime-source-contract` scenario 8 and `realtime-wal-source`
      scenario 6 each need splitting into re-settle-after-**resolve** and re-settle-after-**reject**.
      Rows RSC-8a/8b and RWS-6a/6b already anticipate it.
- [ ] `log.mjs`/`parity.mjs`/`resume.mjs` have never completed. RWS-11 is a discovery row; anything
      unrelated they surface is a follow-up, not this change's promise, and their silence must not
      be read as green.

**Recorded follow-ups (deliberately out of scope)**: narrowing `studio-server.ts:823` so schema/
table/query routes never wait on realtime; merging `feat/realtime-column-projection-2-enforcement`;
letting a recovered source clear the Studio's `realtimeAvailable` latch without a restart.
