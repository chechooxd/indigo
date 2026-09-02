# Tasks: Realtime SSE backpressure

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | `packages/realtime/src/engine.ts` ~+80/−8; `packages/realtime/test/dispatch.mjs` ~+215; spec (already authored) ~129 |
| Estimated total (code + test, excluding already-landed spec) | ≈ 295 authored lines |
| 400-line budget risk | Low |
| 800-line session budget risk | Low — well under budget as a single PR |
| Chained PRs recommended | No |
| Chain strategy | N/A — single PR |
| Delivery strategy | auto-chain (single link) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: N/A (single PR)
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Fake `res` gains `writableLength`/`end`/`refuse` support; all RED tests for RSB-1..RSB-11 authored and confirmed failing | PR 1 | `node packages/realtime/test/dispatch.mjs` | N/A — no DB, fake `ServerResponse`/`RealtimeSource` only | Revert new `check()` blocks in `dispatch.mjs`; no production code touched yet |
| 2 | `send()`/`evict()` implemented in `engine.ts`, 4 write sites rerouted, both loops snapshotted; all RED tests turn GREEN | PR 1 (same) | `node packages/realtime/test/dispatch.mjs` | N/A — no DB | Revert `engine.ts`; `send()`/`evict()` are pure additive indirection over 4 call sites |
| 3 | RSB-4 mutation proof, `ran` count finalized, docs (RSB-8), cross-package verification | PR 1 (same) | `node packages/realtime/test/dispatch.mjs` then `pnpm clean && pnpm build --force && pnpm lint && pnpm test` | N/A | N/A — verification only |

This ships as a **single PR**. Focused test command for the whole change:
`node packages/realtime/test/dispatch.mjs`.

## Phase 1: RED — fake `res` upgrade + failing tests for RSB-1, RSB-3, RSB-6, RSB-7, RSB-10, RSB-11

- [x] 1.1 In `packages/realtime/test/dispatch.mjs`, replace `fakeSubscriber()` with the design's
      version: add `writableLength` (mutable, defaults to `0`), `refuse` mode, `hwm` (default
      `65536`), track `written`/`ended`, expose `isEnded()` and `drain(n)`. `write(chunk)` returns
      `false` when `refuse` is `true`; otherwise pushes the chunk, increments `writableLength` by
      `Buffer.byteLength(chunk)`, and returns `writableLength < hwm`. `end(chunk)` pushes an
      optional trailing chunk and sets `ended = true`. Keep the existing `req.on() {}` no-op.
      Every engine constructed by a new test below MUST pass an explicit small `maxBufferedBytes`
      (e.g. `1000`) — no test writes a megabyte.
- [x] 1.2 RED — RSB-1 (heartbeat subject to the same cap): engine with `heartbeatMs: 5,
      maxBufferedBytes: 1000`; subscriber registered at `writableLength: 5000`; `await start()`,
      `await sleep(40)`; assert no `:ping` frame in `written`, `isEnded()` is `true`,
      `engine["subscribers"].size === 0`. Confirm this FAILS against the untouched tree — `:177`
      writes `:ping\n\n` unconditionally and never calls `end()`, so both assertions fail.
- [x] 1.3 RED — RSB-3 (over-cap subscriber evicted instead of written to): subscriber at
      `writableLength: 5000` vs `maxBufferedBytes: 1000`; `emit(event)`; assert no `event: change`
      frame in `written`, `isEnded()`, `subscribers.size === 0`; a second `emit()` leaves
      `written.length` unchanged. Also covers RSB-5 (connection closed / removed from registry) —
      same assertions, no second engine needed. Confirm this FAILS today: no eviction exists, the
      frame is written, `end()` is never called, and the second `emit()` writes a second frame.
- [x] 1.4 RED — RSB-6 (eviction proceeds even if the overflow frame cannot be flushed): subscriber
      built with `refuse: true` AND `writableLength: 5000`; `emit(event)`; assert
      `written.length === 0` (not even the overflow frame landed) yet `isEnded()` is `true` and
      `subscribers.size === 0`. Confirm this FAILS today — nothing calls `end()` and nothing removes
      the subscriber.
- [x] 1.5 RED — RSB-7 (eviction invokes `onError`): construct the engine with a capturing `onError`;
      trigger an over-cap eviction; assert `onError` was called exactly once, the argument is an
      `Error`, and `err.message.includes("[backpressure] SSE subscriber evicted")`. Confirm this
      FAILS today — `onError` is only ever invoked from `source.start`'s error path, so the capture
      array is empty.
- [x] 1.6 RED — RSB-10 (eviction mid-`dispatch()` does not skip a later subscriber): register THREE
      subscribers to the same table in order A, B, C (`maxBufferedBytes: 1000`), with B at
      `writableLength: 5000` and A/C at `0`. One `emit(event)`. Assert A and C each received exactly
      one `event: change` frame, B received none, B is evicted, and `subscribers.size === 2`.
      **Do not fold this into a two-subscriber fixture** — with only two subscribers the skip is
      unobservable, because a healthy subscriber must sit AFTER the evicted one in iteration order
      for the defect to be visible. Confirm this FAILS today — B is never evicted, so
      `subscribers.size` is `3` and B holds a frame it should not.
- [x] 1.7 RED — RSB-11 (eviction mid-heartbeat does not skip a later subscriber): same A/B/C fixture
      as 1.6, `heartbeatMs: 5`, `await sleep(40)`; assert A and C each received a `:ping` frame, B
      received none, B is evicted, `subscribers.size === 2`. Same "do not fold into two subscribers"
      constraint as 1.6, applied to the heartbeat loop. Confirm this FAILS today — the heartbeat loop
      at `:177` writes to all three and evicts none.
- [x] 1.8 Run `node packages/realtime/test/dispatch.mjs` and confirm tasks 1.2–1.7 fail exactly as
      predicted (not for an unrelated reason, e.g. a typo in the fixture). Record the failing output
      as evidence before moving to Phase 2.

## Phase 2: GREEN — implement the bounded write path in `engine.ts`

- [x] 2.1 Add `export const DEFAULT_MAX_BUFFERED_BYTES = 1_048_576;` and
      `RealtimeEngineOptions.maxBufferedBytes?: number` with the doc comment from design's
      Interfaces section (cap semantics + the raw-`subscribe()` no-resync note, RSB-8's home).
      Store the resolved value as `options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES` with no
      range validation (design decision 7 — an invalid cap is loud via `onError`, not a constructor
      throw).
- [x] 2.2 Add `private send(sub: Subscriber, frame: string): boolean`: `if
      (!this.subscribers.has(sub)) return false;` (re-entrancy guard) → probe
      `sub.res.writableLength ?? 0` against the cap → if over cap, call `this.evict(sub, buffered)`
      and return `false` → otherwise `sub.res.write(frame)` (return value still discarded per
      design decision 2) and return `true`.
- [x] 2.3 Add `private evict(sub: Subscriber, buffered: number): void`: `if
      (!this.subscribers.delete(sub)) return;` (idempotence guard — `evict()` must be safe to call
      twice, since `res.end()` fires `req.on("close")` at `:239-241`, which deletes the same `sub`)
      → best-effort `try { sub.res.write("event: overflow\n\n") } catch {}` → `try { sub.res.end()
      } catch {}` → `this.options.onError?.(new Error(\`[backpressure] SSE subscriber evicted: ...\`))`
      with buffered bytes, the cap, and the subscriber's `tables` in the message.
- [x] 2.4 Reroute all four write sites (heartbeat `:177`, `ready` `:237`, `wake` `:407`, `change`
      `:411`) to call `this.send(sub, frame)` instead of `sub.res.write(frame)` directly. No call
      site outside `send()` may call `res.write()` on a subscriber's response (RSB-full-coverage
      requirement).
- [x] 2.5 Snapshot both iteration loops (heartbeat loop and `dispatch()`'s fan-out loop):
      `for (const sub of [...this.subscribers]) { ... }`. This is what makes RSB-10/RSB-11 pass —
      combined with the `send()`/`evict()` idempotence guards from 2.2/2.3, eviction mid-broadcast
      neither skips nor double-writes a remaining subscriber.
- [x] 2.6 Confirm `dispatch()`'s signature is untouched: `private dispatch(event: RealtimeEvent):
      void`, no `async`, no `await`, no queue, no drain listener. This is a hard constraint, not a
      style preference — see design's "Two input corrections" section.
- [x] 2.7 Confirm `stop()` is left unmodified — it keeps its own `res.end()` + `clear()` loop and
      does NOT route through `evict()` (design decision 11: routing shutdown through `evict()` would
      emit one `onError` per subscriber on every clean shutdown).
- [x] 2.8 Run `node packages/realtime/test/dispatch.mjs` — confirm tasks 1.2, 1.3, 1.4, 1.5, 1.6,
      1.7 now all pass (GREEN).

## Phase 3: RED/GREEN — remaining scenarios (RSB-2, RSB-4)

- [x] 3.1 RSB-2 — write the test now (implementation already exists from Phase 2, so this row is
      GREEN by construction, not RED): subscriber A over cap, subscriber B healthy, one
      `emit(event)`; **immediately after `emit()` returns, with no `await` in between**, assert B
      has its `event: change` frame, A has none, A is evicted, B is still registered. **This
      synchrony assertion passes against the untouched tree today and is a regression guard for a
      future async drift in `dispatch()`, not a RED scenario** — label it as such in the test's
      comment. The "A evicted / A has no frame" half of this same case IS RED against the untouched
      tree (fails until Phase 2 lands); confirm both halves pass now that Phase 2 is done.
- [x] 3.2 RSB-4 — write the negative-control test: subscriber at `writableLength: 999` vs
      `maxBufferedBytes: 1000`; `emit(event)`; assert the `event: change` frame IS written,
      `!isEnded()`, subscriber still registered; a second `emit()` also lands. **State explicitly in
      the test's comment that this passes against the untouched tree by construction and is
      therefore not RED** — its only proof of value comes from the mutation task below (3.3).
- [x] 3.3 **Mandatory mutation task for RSB-4.** Confirm the negative control actually bites:
      1. Temporarily flip the probe in `send()` from `buffered > cap` to `buffered >= cap` (mutation
         A). Run `node packages/realtime/test/dispatch.mjs`. Confirm 3.2 FAILS. Record the observed
         failure output.
      2. Revert mutation A. Temporarily change the probe from reading `sub.res.writableLength` to
         acting on `sub.res.write(frame)`'s boolean return value instead (mutation B — the rejected
         alternative from design decision 1). Run the suite again. Confirm 3.2 FAILS (or, if it does
         not fail with this fixture's `hwm`, note precisely why and strengthen the fixture until it
         does — an unbitten mutation is a finding about the test, not a reason to move on).
      3. Revert mutation B, restoring the shipped `send()` implementation exactly. Run the full
         suite once more and confirm every case is GREEN.
      4. Record all three observed results (mutation A outcome, mutation B outcome, final clean run)
         directly in this task's checklist entry before checking it off. A mutation whose outcome is
         not written down did not happen.
      - **Observed results:**
        - **Fixture strengthening (finding, recorded per the mandatory instruction):** the
          `writableLength: 999` fixture alone did NOT distinguish `>` from `>=` — at
          `buffered = 999, cap = 1000`, both `999 > 1000` and `999 >= 1000` evaluate to `false`, so
          neither operator evicts. A companion check (`RSB-4b`) was added asserting a subscriber
          buffered at EXACTLY `maxBufferedBytes` (`1000`, not `999`) is also not evicted — this is
          the boundary value where `>` and `>=` actually disagree. Additionally, RSB-4/RSB-4b's fake
          `hwm` was pinned to `maxBufferedBytes` (`1000`, not the default `65536`) so the fixture is
          sensitive to mutation B too (see below).
        - **Mutation A** (`buffered > this.maxBufferedBytes` → `buffered >= this.maxBufferedBytes`):
          ran `node packages/realtime/test/dispatch.mjs`. Result: `RSB-4b` FAILED —
          `AssertionError: a subscriber buffered at exactly the cap must still receive the frame`
          (16/17 checks passed, 1 failed). `RSB-4` (cap − 1) still passed, exactly as predicted,
          because `999 > 1000` and `999 >= 1000` agree. Mutation reverted; re-ran the suite —
          17/17 green, confirming the revert was exact.
        - **Mutation B** (probe changed from `sub.res.writableLength` before the write, to acting on
          `sub.res.write(frame)`'s boolean return value after writing): ran the suite. Result: BOTH
          `RSB-4` and `RSB-4b` FAILED (9/17 passed, 8 failed — every eviction-expecting case also
          failed, since with the fake's default `hwm: 65536` write() never returns `false` at the
          cap values used elsewhere in this suite, so eviction stopped happening entirely). Specific
          RSB-4/RSB-4b failures: `AssertionError: a subscriber at cap - 1 must not be evicted` and
          `AssertionError: a subscriber buffered at exactly the cap must not be evicted` — both
          fixtures had `hwm` pinned to `1000` (see fixture-strengthening note above), so writing the
          ~90–100 byte frame on top of `writableLength: 999`/`1000` pushed `write()`'s own internal
          counter past its `hwm`, making `write()` return `false` and triggering an incorrect
          eviction of a non-stalled subscriber. Mutation reverted.
        - **Final clean run** (shipped `send()` restored exactly): `node
          packages/realtime/test/dispatch.mjs` → `17 check(s) passed.` / `PASSED`, `ran` reachability
          guard (`strictEqual(ran, 17, ...)`) satisfied.

## Phase 4: Documentation-only coverage (RSB-8) and reachability guard

- [x] 4.1 RSB-8 has **no executable test** — do not write one. A grep-for-a-sentence assertion tests
      the string, not the guarantee, and asserting that `subscribe()` lacks resync would pin a
      `packages/client` behavior this change does not touch. Coverage is: (a) the spec's
      `### Requirement: Raw subscribe() consumers are a documented lossy path under eviction`
      section (already authored), and (b) the `maxBufferedBytes` doc comment added in task 2.1,
      which must state the `.live()`/`useLiveTable` refetch-on-reconnect vs. raw `subscribe()`
      no-resync distinction verbatim (per design's Interfaces section). Verify both are present;
      mark this task done once confirmed, with no test file changes.
- [x] 4.2 Set the final `ran` count from an actual counted run, not from the design's provisional
      arithmetic. Add `strictEqual(ran, <N>, "expected exactly <N> check() cases in
      dispatch.mjs")` as the new trailing guard, appended after the existing untouched
      `strictEqual(ran, 6, ...)` line (leave that line exactly as-is — it is
      `realtime-column-projection`'s RCP-13 guard). Run the suite, read the actual `ran` value from
      output, and set both the assertion's number and its message string to match — they must agree
      with each other and with the counted total (this repo has previously shipped a guard whose
      message contradicted its own number after a merge).
- [x] 4.3 Confirm `scripts/check-realtime-projection-db-gate.mjs` still passes without modification —
      `dispatch.mjs` is already in its `GUARDED_FILES` fixed list (`:18-22`), and no new test file
      was created, so no guard edit should be needed. Run the script directly (or via whatever
      command invokes it) and verify green; do not assume, verify.

## Phase 5: Cross-package verification

- [x] 5.1 Run `pnpm clean && pnpm build --force && pnpm lint && pnpm test` from the repo root. Use
      `--force`, never plain `clean && build` — Turbo restores a cached `dist/` wholesale and a bare
      `clean && build` resurrects stale output in this repo.
- [x] 5.2 Confirm `node packages/realtime/test/dispatch.mjs` is green standalone (the focused command
      for this change) and that the full `pnpm test` run from 5.1 is also green.
- [x] 5.3 Re-confirm `scripts/check-realtime-projection-db-gate.mjs` passes on the final tree (repeat
      of 4.3, now against the fully built/linted tree).
- [x] 5.4 Update `openspec/changes/realtime-sse-backpressure/proposal.md` Success Criteria checkboxes
      to checked, referencing this `tasks.md` as evidence, and note that the original
      "`dispatch()` stays sync, verified by a typecheck-level guard" criterion was replaced per the
      design's documented correction (no typecheck guard exists; RSB-2's runtime synchrony assertion
      plus review-time constraint stand in its place).
