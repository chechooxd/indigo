# Design: Bound SSE write buffering in `RealtimeEngine`

Verified live against `main` @ `7eb1621`: `engine.ts:32-48` (`RealtimeEngineOptions`), `:96-101`
(`Subscriber`), `:120` (`subscribers` is a `Set`), `:176-181` (heartbeat), `:183-197` (`stop`),
`:234-241` (`handleRequest` tail), `:397-413` (`dispatch`), `wal-source.ts:509-558`
(`flushCommit`: `onEvent` at `:551`, `await acknowledge` at `:556`),
`packages/client/src/realtime.ts:69-121` (`SseTransport.run`/`readStream`),
`test/dispatch.mjs:57-78` (fake `res`), `:283` (`strictEqual(ran, 6)`),
`scripts/check-realtime-projection-db-gate.mjs:18-22` (fixed file list),
`packages/cli/src/index.ts:252` and `studio-server.ts:821` (both hosts construct the engine with
`{connectionString, schema}` only — **no `onError`, no options beyond those two**).

## Two input corrections, verified before designing

1. **`ready` (`:237`) is NOT written before registration.** `this.subscribers.add(sub)` is
   `engine.ts:235`; the `res.write` is `:237`. The subscriber is already registered. So `ready`
   needs no special case and routes through `send()` identically to the other three sites. (A
   fresh response reports `writableLength ≈ 0`, so it is never evicted in practice; uniformity is
   for the "no direct `res.write` outside the helper" requirement, not for a real overflow case.)
2. **The proposal's success criterion "`dispatch()` stays sync, verified by a typecheck-level
   guard" is not achievable.** Changing `private dispatch(e): void` to `async ... Promise<void>`
   still typechecks: the only call site is `this.source.start((event) => this.dispatch(event))`
   (`:157`), and TS permits a value-returning callback where `void` is expected. There is no
   compiler error to trip. That criterion is replaced by RSB-2's runtime synchrony assertion plus
   a review-time constraint. Stated rather than silently carried forward.

## Technical Approach

One private choke point. All four writes become `this.send(sub, frame)`. `send()` probes
`sub.res.writableLength` **before** writing; over `maxBufferedBytes` → `evict()`; otherwise
`res.write(frame)` (return value still discarded — see decision 2). `dispatch()` stays
`private dispatch(event: RealtimeEvent): void`, with no `await`, no queue, no drain listener, and
no new per-subscriber state. `Subscriber` is unchanged.

    heartbeat :177 ─┐
    ready     :237 ─┤
    wake      :407 ─┼──▶ send(sub, frame)
    change    :411 ─┘        │
                             ├─ !subscribers.has(sub) ──────────▶ return false   (re-entrancy)
                             ├─ (res.writableLength ?? 0) > cap ─▶ evict(sub) ──▶ return false
                             └─ res.write(frame) ───────────────▶ return true

    evict(sub): subscribers.delete(sub) ─(false ⇒ already gone, return)
                → try res.write("event: overflow…")  [best-effort, errors swallowed]
                → try res.end()                      [errors swallowed]
                → onError(new Error("[backpressure] SSE subscriber evicted: …"))

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| 1 | Probe source | `res.writableLength` read **before** the write | the boolean return of `res.write()` | `write()` returns `false` at `writableHighWaterMark` = **65536 (64 KiB, measured on Node v22.23.2, not the 16 KiB in older docs)**. Evicting on `false` would evict on an ordinary 64 KiB burst. `writableLength` is the actual buffered byte count and is comparable against a cap 16x above that watermark. Probing before means one oversized frame cannot self-evict a healthy socket |
| 2 | `write()`'s return value | still discarded | act on it | With decision 1 it carries no eviction signal; consuming it would only re-add the 64 KiB threshold through the back door |
| 3 | Probe is not payload bytes | documented as an upper bound, never as "pending SSE payload" | claim byte equality with the frames | Measured: a 100-byte `write()` on a fresh `ServerResponse` yields `writableLength = 270` — HTTP chunk framing and header bytes are included. The probe is therefore **conservative by a small constant**; against a 1 MiB cap that is noise. The guarantee is "socket-buffered bytes ≤ cap + one frame + framing", not "SSE payload ≤ cap" |
| 4 | `send()` signature | `private send(sub: Subscriber, frame: string): boolean` — `true` = written, `false` = evicted or already gone | `send(res, frame)` | Eviction needs the `Subscriber` identity to remove from the registry. Returning `boolean` lets `dispatch()` skip work after eviction without any control-flow inversion; `dispatch()` ignores it today and still returns `void` |
| 5 | Iteration safety | Both loops iterate a **snapshot**: `for (const sub of [...this.subscribers])`; `send()` opens with `if (!this.subscribers.has(sub)) return false;`; `evict()` opens with `if (!this.subscribers.delete(sub)) return;` | rely on `Set` iteration tolerating deletion of the current element | ECMAScript `Set` iteration *is* well-defined under concurrent deletion, so the naive form happens to work — which is exactly why the bug ships green when someone later swaps the container or adds a re-add path. The snapshot plus the two idempotence guards make the invariant local and readable, costs one array per tick, and also makes `evict()` safe to call twice (`res.end()` fires `req.on("close")` at `:239-241`, which deletes the same `sub`) |
| 6 | Config surface | `RealtimeEngineOptions.maxBufferedBytes?: number`, default `DEFAULT_MAX_BUFFERED_BYTES = 1_048_576`; **no CLI flag, no host change** | a `--max-buffered-bytes` flag on `indigodb realtime` and a studio-server option | Neither host passes any option beyond `{connectionString, schema}` today (`index.ts:252`, `studio-server.ts:821`). Adding two flags for a value with no observed tuning need widens the public surface and the test matrix for nothing. The option is on the engine, so it is injectable in tests and by embedders — which is the entire testability requirement. A flag is a later, additive change |
| 7 | Invalid cap | `options.maxBufferedBytes ?? DEFAULT` with no range validation | clamp / throw on `0` or negative | A negative or zero cap evicts everyone on the first frame — loud and immediately diagnosable via decision 8's `onError` line. Throwing at construction adds a failure mode to two hosts that never set the value |
| 8 | Observability | Reuse `onError` with a plain `Error` whose message starts with the literal `[backpressure] SSE subscriber evicted:` and carries buffered bytes, the cap and the subscriber's `tables` | a new exported `SubscriberEvictedError` class; a counter/metrics seam | The spec requires `onError`. Neither host supplies one, so both land on the engine default `console.error("[indigodb realtime]", err.message)` (`:138`) — meaning the **message alone must be self-describing**, and it is. A greppable stable prefix gives operators counting without a new exported type or a metrics API this repo has nowhere else |
| 9 | Overflow frame | `event: overflow` written best-effort inside `try{}`, errors swallowed, **after** the registry removal and **before** `res.end()` | make delivery a precondition; skip the frame | `SseTransport.handleFrame` (`realtime.ts:149`) drops unknown event names silently, so the frame is safe on every shipped client and worthless as a contract. Removal-first ordering is what makes "eviction proceeds even if the frame cannot be flushed" (RSB-6) structurally true rather than a hope |
| 10 | What the client observes | `res.end()` → `readStream` sees `done: true` → reconnect → `onOpen(reconnected=true)` → full refetch | drop frames on an open connection | Eviction is lossless for `.live()` and `useLiveTable` because both **refetch from scratch on reconnect**, not because of replay: `REALTIME_LOG_PATH` has zero client call sites. Leaving the stream open-and-silent repeats the `realtime-start-contract` defect-3 failure this repo already shipped once |
| 11 | `stop()` unchanged | `stop()` keeps its own `res.end()` + `clear()` loop; it does **not** route through `evict()` | unify them | Shutdown is not an eviction: routing it through `evict()` would emit one `onError` per subscriber on every clean shutdown, turning the operator signal into noise |
| 12 | Heartbeat unchanged in lifecycle | evicting every subscriber does not clear the interval | stop the timer when empty | The engine is still started and may take new subscribers; the timer is already `unref()`'d (`:180`) |

## Interfaces

```ts
// engine.ts
export const DEFAULT_MAX_BUFFERED_BYTES = 1_048_576; // 1 MiB — 16x the measured 64 KiB
                                                     // writableHighWaterMark on Node v22.23.2

export interface RealtimeEngineOptions {
  // …existing…
  /** Per-subscriber socket-buffer cap in bytes, probed before every frame.
   *  Over cap ⇒ the subscriber is evicted (stream ended) and reported via `onError`.
   *  NOTE: `.live()`/`useLiveTable` refetch on reconnect and are unaffected; a raw
   *  `RealtimeModelDelegate.subscribe()` caller has NO automatic resync and misses
   *  events after an eviction until it supplies its own (documented limitation). */
  maxBufferedBytes?: number;
}

private send(sub: Subscriber, frame: string): boolean;
private evict(sub: Subscriber, buffered: number): void;
private dispatch(event: RealtimeEvent): void;   // signature UNCHANGED — hard constraint
```

`dispatch()` must stay synchronous: `WalSource.flushCommit` calls `onEvent(event)` at
`wal-source.ts:551` and only then `await service.acknowledge(commitLsn)` at `:556`. Making
`dispatch()` async couples subscriber I/O to replication ack and converts a bounded heap problem
into an unbounded replication-slot/disk problem. This is a constraint, not a preference.

## File Changes

| File | Action | Description | Authored lines |
|---|---|---|---|
| `packages/realtime/src/engine.ts` | Modify | `DEFAULT_MAX_BUFFERED_BYTES`, `maxBufferedBytes` option + field + doc, `send()`, `evict()`, 4 call sites rerouted, 2 loops snapshotted | ~+80 / −8 |
| `packages/realtime/test/dispatch.mjs` | Modify | fake `res` gains `writableLength`/`end`/refuse mode + 9 new checks + final `strictEqual(ran, 17)` | ~+215 |
| `openspec/changes/.../specs/realtime-sse-backpressure/spec.md` | (exists) | written by `sdd-spec` | ~129 |
| `packages/cli/src/index.ts`, `studio-server.ts` | **None** | decision 6 — no flag, default cap, default `onError` | 0 |

Total authored ≈ **265 (code+test) / ~395 including the spec**. `400-line budget risk: Low`
against this session's 800-line budget. `Chained PRs recommended: No`.
`Decision needed before apply: No`. Single PR; no slice boundary needed.

## Testing Strategy

All coverage goes **into `packages/realtime/test/dispatch.mjs`** — it is already in
`check-realtime-projection-db-gate.mjs`'s `GUARDED_FILES` (`:18-22`), so no guard edit is needed
and the "runs without a database" guarantee is enforced automatically. A new file would be
unguarded and would additionally require editing that fixed list; the existing fake
`ServerResponse`/fake `RealtimeSource` pattern is exactly what these scenarios need.

**Reachability guard.** The existing `strictEqual(ran, 6)` at `:283` is left **untouched** (it is
`realtime-column-projection`'s RCP-13 positional guard; editing it would put an archived
capability's guarantee at risk for no gain). Today 8 checks run in total — 6 before that line,
plus RSC-14 and DESIGN-ONLY-1 after it, both currently unguarded. The 7 new checks append at the
end of the file, followed by a **new** final `strictEqual(ran, 17, "expected exactly 17 check()
cases in dispatch.mjs")`. 6 + 2 + 7 = 15.

**How the fake simulates a backed-up socket** (the crux — the current fake at `:57-78` has
neither `writableLength` nor `end`):

```js
function fakeSubscriber(urlPath = "/", { writableLength = 0, refuse = false, hwm = 65536 } = {}) {
  const written = []; let ended = false;
  const res = {
    status: null, headers: null,
    writableLength,                                   // mutable own property, like a real stream
    writeHead(s, h) { res.status = s; res.headers = h; },
    write(chunk) {
      if (refuse) return false;                       // socket accepts nothing at all (RSB-6)
      written.push(chunk);
      res.writableLength += Buffer.byteLength(chunk); // never drains unless drain() is called
      return res.writableLength < hwm;                // mirrors the measured 64 KiB watermark
    },
    end(chunk) { if (chunk !== undefined) written.push(chunk); ended = true; },
  };
  return { req: { url: urlPath, on() {} }, res, written,
           isEnded: () => ended, drain: (n) => { res.writableLength = Math.max(0, res.writableLength - n); } };
}
```

`writableLength` rising monotonically per write and falling only on an explicit `drain(n)` is what
makes "stalled" reproducible without any timing dependence. Registry membership is asserted via
`engine["subscribers"].size` — private-field access is already house style in this file
(`engine["heartbeat"]`, `:334-335`). Every new engine is constructed with a small explicit
`maxBufferedBytes` (e.g. `1000`) so no test writes a megabyte.

| ID | Spec scenario | Test (file + case) | How it FAILS against the untouched tree |
|---|---|---|---|
| RSB-1 | Heartbeat is subject to the same cap | `dispatch.mjs` — engine with `heartbeatMs: 5`, `maxBufferedBytes: 1000`, subscriber at `writableLength: 5000`; `await start()`, `await sleep(40)`; assert no `:ping` frame was written, `isEnded()`, `subscribers.size === 0` | `:177` writes `:ping\n\n` unconditionally and never calls `end()`. A `:ping` frame **is** recorded and `isEnded()` is `false` → fails on both assertions |
| RSB-2 | Stalled subscriber does not delay dispatch to others | `dispatch.mjs` — sub A over cap, sub B healthy, one `emit(event)`; **immediately after `emit()` returns, with no `await` in between**, assert B has its `event: change` frame, A has none, A is evicted, B still registered | Today A also receives the frame and is never evicted → the "A has none" and "A evicted" assertions fail. (The synchrony half passes today and is a regression guard for a future async drift — labelled as such, not claimed as RED) |
| RSB-3 | Over-cap subscriber evicted instead of written to | `dispatch.mjs` — `writableLength: 5000` vs cap `1000`; `emit()`; assert no `change` frame, `isEnded()`, `subscribers.size === 0`; second `emit()` → `written.length` unchanged | No eviction exists: the frame is written, `end()` is never called, and the second `emit()` writes a second frame → fails on three assertions |
| RSB-4 | Cap − 1 is **not** evicted (negative control) | `dispatch.mjs` — `writableLength: 999` vs cap `1000`; `emit()`; assert the `change` frame is written, `!isEnded()`, still registered; a second `emit()` also lands | **This test PASSES against the untouched tree and is therefore not RED — stated plainly rather than dressed up.** Its bite comes from mutation, not from today's tree: flipping the probe from `>` to `>=`, or from `writableLength` to `write()`'s boolean, must make it fail. The tasks phase MUST run that mutation and record the result; without it this row proves nothing |
| RSB-5 | Evicted subscriber's connection is closed | folded into RSB-3's `isEnded()` + `subscribers.size === 0` assertions (same eviction, no second engine needed) | same as RSB-3 |
| RSB-6 | Eviction proceeds even if the overflow frame cannot be flushed | `dispatch.mjs` — subscriber built with `refuse: true` **and** `writableLength: 5000`; `emit()`; assert `written.length === 0` (not even the overflow frame landed), yet `isEnded()` and `subscribers.size === 0` | Nothing calls `end()` today and nothing removes the subscriber → both assertions fail |
| RSB-7 | Eviction invokes `onError` | `dispatch.mjs` — engine constructed with a capturing `onError`; assert exactly one call, `err instanceof Error`, and `err.message.includes("[backpressure] SSE subscriber evicted")` | `onError` is only ever called from `source.start`'s error path today; the array is empty → fails |
| RSB-8 | Docs state the raw `subscribe()` gap | **No executable test.** Prose in the spec plus the `maxBufferedBytes` doc comment in `engine.ts` (see Interfaces) | **Unprovable by test and marked as such.** A grep-for-a-sentence assertion would test the string, not the guarantee; asserting that `subscribe()` lacks resync would pin a `packages/client` behavior this change does not touch. Verified at review |
| RSB-10 | Eviction mid-`dispatch()` does not skip a later subscriber | `dispatch.mjs` — THREE subscribers to the same table registered in order A, B, C; B at `writableLength: 5000`, A and C at `0`, cap `1000`; one `emit(event)`; assert A **and** C each received exactly one `event: change` frame, B received none, B is evicted and `subscribers.size === 2` | Today B is never evicted, so `subscribers.size` is 3 and B holds a frame it should not → fails. Two subscribers cannot express this case: the skip only becomes observable when a healthy subscriber sits AFTER the evicted one in iteration order |
| RSB-11 | Eviction mid-heartbeat does not skip a later subscriber | `dispatch.mjs` — same A/B/C fixture, `heartbeatMs: 5`, `await sleep(40)`; assert A and C each received `:ping` and B none, B evicted, `subscribers.size === 2` | Same as RSB-10 against the heartbeat loop at `:177`, which today writes to all three and evicts none → fails |
| RSB-9 | Suite passes in a default checkout | Structural: all seven cases live in `dispatch.mjs`, already in `GUARDED_FILES`; none references `INDIGODB_TEST_DATABASE_URL`; `strictEqual(ran, 17)` catches an omitted or skipped case | This row *is* the assertion — `check-realtime-projection-db-gate.mjs` already enforces it for `dispatch.mjs`, and the new `ran` guard is the anti-shrink half |

**Adversarial pass — what does not bite.** RSB-4 (passes today by construction; mutation-proved
only) and the synchrony half of RSB-2 (passes today; regression guard only) are the two rows that
are *not* RED. Both are named above rather than counted as coverage. Every other row fails on the
untouched tree on at least two independent assertions, so a partial implementation cannot turn one
green by accident. 10 of 11 spec scenarios have an executable test; RSB-8 is documentation and is
declared unprovable.

## Threat Matrix

No routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary is introduced — those rows are `N/A`. Two rows are applicable:

| Row | Applicable | Safe behavior | RED test |
|---|---|---|---|
| Resource exhaustion / unbounded memory | Yes | a stalled subscriber's socket buffer never exceeds `maxBufferedBytes` + one frame + HTTP framing; it is then removed and its stream ended | RSB-1, RSB-3, RSB-6 |
| Denial of service via eviction storm | Yes | a healthy or merely busy subscriber (below cap, including cap − 1) is never evicted; the cap sits 16x above the measured 64 KiB watermark so ordinary bursts cannot trip it | RSB-4 (mutation-proved), RSB-2 |
| Sensitive-data disclosure | Yes | the `event: overflow` frame carries **no** row data, no table payload and no cap value — it is a bare signal; `onError`'s message is server-side only | asserted in RSB-6 (`written` contains no event data) |

## Migration / Rollout

No migration. No DDL, no wire-format break (`SseTransport` drops unknown event names,
`realtime.ts:149`), no client change, no new dependency, no host change. Default-on with a 1 MiB
cap: an existing deployment whose subscribers are healthy sees byte-identical behavior, because
`writableLength` on a draining socket sits near zero. Single-commit revert restores unguarded
`res.write()`.

## Open Questions

- [ ] Non-blocking: no **global** ceiling across all subscribers — N stalled subscribers can still
      hold N × 1 MiB. Per-subscriber only, as the proposal scoped it. A global ceiling needs an
      eviction-ordering policy (oldest? largest?) and is a separate change.
- [ ] Non-blocking, carried from the proposal: raw `RealtimeModelDelegate.subscribe()` auto-resync
      stays deferred (a `packages/client` change). Eviction makes the pre-existing gap fire more
      often; documented in decision 8's doc comment and in the spec, not closed here.
- [x] Resolved: `ready` needs no special case — the subscriber is registered at `:235`, one line
      before the write at `:237`.
- [x] Resolved: the proposal's "typecheck-level guard" for synchronous `dispatch()` is not
      achievable; replaced by RSB-2 plus a review-time constraint.

---

## Orchestrator amendment (post-authoring)

The spec gained a requirement after this design was launched, so the design was written against 9
scenarios and the spec now carries 11. Added above: **RSB-10** and **RSB-11**, covering
`### Requirement: Eviction during a broadcast MUST NOT disturb the remaining subscribers`.

The mechanism this design already chose (row 5: snapshot iteration plus the two idempotence guards)
satisfies that requirement — nothing about the approach changes. What was missing was **coverage**.
Row 5 itself notes that ECMAScript `Set` iteration is well-defined under deletion of the current
element, so the naive form happens to work today; that is precisely the condition under which the
invariant is real but untested, and a later container swap or added re-add path breaks it silently.

Both new rows are genuinely RED against the untouched tree — not because iteration is broken today,
but because no eviction happens at all, so `subscribers.size` and the per-subscriber frame counts
both come out wrong. They additionally serve as the regression guard row 5's reasoning implies.

**The three-subscriber fixture is load-bearing.** With two subscribers the skip is unobservable: a
healthy subscriber must sit AFTER the evicted one in iteration order for the defect to appear. Any
attempt to fold these into an existing two-subscriber case defeats them.

**The `ran` count is provisional.** It was raised 15 → 17 arithmetically. Per this repo's history of
count drift across merges, the apply phase MUST set it from an actual counted run and align the
assertion message with the number, rather than trusting this figure.
