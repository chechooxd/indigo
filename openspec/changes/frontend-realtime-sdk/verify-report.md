```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:0ef0d06cd1434517eb3c05870f874535921f14967dfe76022ca65104dce416fa
verdict: pass
blockers: 0
critical_findings: 0
requirements: 1/1
scenarios: 4/4
test_command: "node packages/client/test/realtime-manager.mjs"
test_exit_code: 0
test_output_hash: sha256:761bc7eb3b08ea9c1735e3f1078c5ce59e87b8455a11aa960361b00112312773
build_command: "pnpm --filter @indigodb/client build"
build_exit_code: 0
build_output_hash: sha256:89948fcb7a1c622191f596a88e2f8925842e3151dbf40d8c548de4a41fe13738
```

# Verification Report — frontend-realtime-sdk (Phase 2)

## Verification Report

**Change**: `frontend-realtime-sdk`
**Phase scored**: Phase 2 only (Slice 2 — `RealtimeConnectionManager` open-state fix, D1), tasks 2.1–2.9.
**Commit**: `5b4af4b` on `feat/realtime-manager-open-state`, off `main` @ `ee4d652` (Phase 1 merged, verified PASS).
**Mode**: Strict TDD. Phase 1 is merged and previously verified PASS (preserved below, not re-audited).
Phases 3–6 are unimplemented and are **not** scored here.
**Skills loaded**: `vercel-react-best-practices` (paths-injected) — not directly applicable to this
phase's scope (`packages/client/src/realtime.ts`, no React/JSX code), consulted for completeness only.

---

### Task Completeness

| Metric | Value |
|--------|-------|
| Tasks total (Phase 2) | 9 |
| Tasks complete | 9 |
| Tasks incomplete | 0 |

All 9 checkboxes (2.1–2.9) are `[x]` in `tasks.md` and land in commit `5b4af4b` with real
substance — confirmed by direct `git show 5b4af4b -- packages/client/src/realtime.ts` inspection,
not by trusting the checkbox alone.

### Scenario → T-row → Task Mapping (Phase 2 slice)

| Scenario | T-row | Task | Covering test | Result |
|---|---|---|---|---|
| First open no longer swallowed | T8 | 2.1 | `realtime-manager.mjs > 2.1` | ✅ COMPLIANT |
| Late join on open channel → onOpen(false) | T9 | 2.2 | `realtime-manager.mjs > 2.2` | ✅ COMPLIANT |
| Replay never fires onResync | T10 | 2.3 | `realtime-manager.mjs > 2.3` | ✅ COMPLIANT |
| Genuine reconnect → onOpen(true) + resync | T11 | 2.4 | `realtime-manager.mjs > 2.4` | ✅ COMPLIANT |

The mapping table's Phase 2 rows hold exactly as written: all four `client-live-queries` scenarios
resolve to a task, each task resolves to exactly one covering test, and each test passed at
runtime (re-run fresh below, not replayed from the apply report). `client-live-queries/spec.md`
contains exactly **1 Requirement / 4 Scenarios** — the entirety of Phase 2's spec surface — and all
four are compliant.

Tasks 2.5 (error-channel replay, T12) and 2.6 (refcount invariant, T13) carry no spec scenario of
their own — they are D1-mandated scaffolding/regression proofs, correctly listed among the tasks
document's declared "13 T-rows kept as design-mandated scaffolding with no spec scenario." Both are
real, load-bearing behavior (verified below), not invented tasks.

---

### Build & Tests Execution

**Build**: ✅ Passed
```text
$ pnpm --filter @indigodb/client build
> @indigodb/client@0.0.1 build
> tsc
(exit 0, no output)
```

**Tests**: ✅ 6 passed / 0 failed / 0 skipped (`realtime-manager.mjs`)
```text
$ node packages/client/test/realtime-manager.mjs
@indigodb/client: RealtimeConnectionManager open-state (D1)
  ok   2.1: first onOpen(false) reaches all listeners (no longer swallowed)
  ok   2.2: subscribing to an already-open channel replays onOpen(false) synchronously before subscribe() returns
  ok   2.3: replaying an already-open channel to a late subscriber never fires onResync
  ok   2.4: a genuine reconnect fires onOpen(true) and exactly one onResync per listener
  ok   2.5: a listener joining an errored channel is replayed the exact same stored Error instance
  ok   2.6: refcount unchanged — one connect for N listeners, close only on the last unsubscribe

All checks passed.
```

**Regression** (`live.mjs`, must stay green and unmodified): ✅ 37 passed / 0 failed / 1 skipped
(14.1, `INDIGODB_TEST_DATABASE_URL` unset → correctly reported `skip`, never counted as pass).
Confirmed `git diff ee4d652..HEAD -- packages/client/test/live.mjs` is **zero lines** — byte-identical
to Phase 1's merged base, independently re-confirmed in this verify pass (not only accepted from the
orchestrator's prior finding).

Also re-ran (regression, unaffected by this change):
- `node packages/client/test/realtime-entry.mjs` — 3/3 pass (browser-safety import-graph guard).
- `pnpm --filter @indigodb/client lint` (`tsc --noEmit`) — clean, 0 errors.

**Coverage**: ➖ Not available — no coverage tool configured in this package (plain-Node
`node test/*.mjs`, no c8/nyc/istanbul wired into `package.json`).

---

### Spec Compliance Matrix

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| `RealtimeConnectionManager` replays current channel state to a listener joining an already-open channel | A listener joining an already-open channel is told it is live without waiting for a reconnect | `realtime-manager.mjs > 2.2` | ✅ COMPLIANT |
| (same Requirement) | The first subscriber on a fresh channel now receives its own open signal | `realtime-manager.mjs > 2.1` | ✅ COMPLIANT |
| (same Requirement) | A genuine reconnect still reports reconnected=true to every listener | `realtime-manager.mjs > 2.4` | ✅ COMPLIANT |
| (same Requirement) | onOpen replay is additive and does not trigger onResync | `realtime-manager.mjs > 2.3` | ✅ COMPLIANT |

**Compliance summary**: 4/4 scenarios compliant (1/1 Requirement, `client-live-queries` spec —
the only spec delta Phase 2 touches).

---

### D1 Conformance — Detailed

| D1 element | Required | Implemented | Verdict |
|---|---|---|---|
| `TableChannel` state model | `state: "connecting"\|"live"\|"error"`, `everOpened: boolean`, `lastError: Error \| null` | `realtime.ts:164-178` — exact three fields, exact three-state union | ✅ Match |
| `ChannelListener.onOpen` | Optional `onOpen?(reconnected: boolean)` | `realtime.ts:195` — optional, correct signature | ✅ Match |
| `onOpen` fan-out no longer early-returns | `if (!reconnected) return;` becomes an **inner** guard immediately before `l.onResync?.()`, not deleted | `realtime.ts:236-242`: loop calls `l.onOpen?.(reconnected)` unconditionally for every listener, then `if (reconnected) l.onResync?.()` | ✅ Match |
| `onError` fan-out | Sets `state="error"`, `lastError=error`, fans out unchanged | `realtime.ts:244-248` | ✅ Match |
| Replay on subscribe | Listener added **first**, then a snapshot of `state`/`lastError` taken **before** any callback runs is replayed synchronously; `live`→`onOpen(false)`, `error`→`onError(lastError)`, `connecting`→nothing; **never** `onResync` | `realtime.ts:254-271`: `activeChannel.listeners.add(listener)` precedes the snapshot; snapshot taken once, replay branches match exactly; no `onResync` call anywhere in the replay path | ✅ Match |
| `reconnected: false` on replay | Deliberate — no gap to fill for a late joiner | `listener.onOpen?.(false)` at `realtime.ts:267` | ✅ Match |
| Refcount / channel-key / `close()` semantics | Unchanged | `subscribe()`'s `if (!channel)` creation guard and the unsubscribe closure's `listeners.size === 0` → `close()` + `channels.delete(table)` are untouched from the pre-`5b4af4b` shape | ✅ Match |
| `.live()` observes zero behavior change | `test/live.mjs` must stay green, unmodified | Confirmed zero-line diff + fresh green re-run (see above) | ✅ Match |

**`onResync`'s trigger condition, old vs. new — explicit comparison** (D1's central promise):

*Before (`ee4d652`, `git show ee4d652:packages/client/src/realtime.ts` around the `onOpen` handler):*
```ts
onOpen: (reconnected) => {
  if (!reconnected) return;
  for (const l of listeners) l.onResync?.();
},
```
*After (`5b4af4b`):*
```ts
onOpen: (reconnected) => {
  newChannel.state = "live";
  newChannel.everOpened = true;
  newChannel.lastError = null;
  for (const l of [...listeners]) {
    l.onOpen?.(reconnected);
    if (reconnected) l.onResync?.();
  }
},
```
The old code's `if (!reconnected) return;` filtered out the whole handler body (including the
`onResync` fan-out AND the — nonexistent at the time — `onOpen` fan-out) for a non-reconnect open.
The new code cannot reuse an early return because `onOpen` must now fire unconditionally, so the
exact same boolean test (`reconnected === true`) becomes an inline `if` immediately guarding only
the `l.onResync?.()` call. The predicate is bit-for-bit unchanged (`reconnected === true` fires
`onResync`, `reconnected === false` does not); only its syntactic form (guard clause → inline
conditional) changed, which is exactly what design.md D1 promises. This is the reason `.live()` —
which supplies no `onOpen` — is provably unaffected: the only branch it can ever observe
(`onResync`) still fires under precisely the same condition as before.

---

### Mutation Reproduction (surgical, independent of the apply report)

Per the orchestrator's pre-verified findings (adding `onResync?.()` to the live-snapshot replay
path fails exactly test 2.3 while test 2.4 stays green — reproduced and accepted, not re-run here
to avoid duplicate work), this verify pass independently reproduced **one additional** mutation the
apply agent itself flagged as insufficiently isolated: task 2.6's original RED mutation (forcing
channel recreation on every `subscribe()` call) broke 2.1/2.2/2.5 as well as its own target, because
recreating the channel object also resets the replay-state snapshot those tests depend on — that is
a genuine shared-code-path effect, not a flaw in the mutation's design, but it does mean 2.6's
original proof was not evidence-isolated on its own.

A narrower, isolated re-mutation was constructed for this verify pass instead: changed the
unsubscribe closure's `ch.listeners.size === 0` guard to `ch.listeners.size <= 1` (closes one
unsubscribe too early, touching only the close-refcount half of 2.6's claim, with zero change to
`onOpen`/replay logic):

```text
Mutated:  if (ch.listeners.size <= 1) { ch.close(); this.channels.delete(table); }
Result:   realtime-manager.mjs → FAIL 2.6 only, on its own assertion:
          "expected the connection to stay open while a listener remains"
          2.1/2.2/2.3/2.4/2.5 stayed green.
```

This mutation *did* also fail `live.mjs`'s scenario 9.3/9.4 ("the last subscriber on a table closes
the shared connection; a remaining subscriber keeps it open") — on its own assertion, not a crash.
This is the correct, expected outcome, not evidence of over-broad test coupling: 9.3/9.4 and 2.6
exercise the exact same shared refcount logic in `RealtimeConnectionManager`, which both `.live()`
and the raw manager legitimately depend on. A real regression in that logic should — and does —
break both suites; this is the cross-consumer regression fence working as designed (see below).
Mutation reverted; `git diff` confirmed clean before this report was written.

**Assertion quality**: ✅ All 6 assertions in `realtime-manager.mjs` verify real behavior — no
tautologies, no assertion-free production calls, no ghost loops, no ambient smoke tests. Every
`check()` calls `manager.subscribe(...)` (real production code) and asserts a specific observed
value (call count, boolean, or the *exact* `Error` instance for 2.5's identity check) rather than a
type-only or existence-only predicate.

---

### Late-subscriber semantics

| Joining state | Expected | Verified by | Result |
|---|---|---|---|
| `live` | Replayed `onOpen(false)` synchronously before `subscribe()` returns | `2.2` | ✅ |
| `error` | Replayed `onError(lastError)` with the exact stored `Error` instance | `2.5` | ✅ |
| `connecting` | No callback until the real transport transition | `2.1` (both listeners subscribe pre-`fireOpen`; only the transport event, not the subscribe call, produces the single observed `onOpen(false)`) | ✅ (implicit but real coverage) |
| `closed` | — | N/A | ➖ Not a coverage hole |

`TableChannel.state` is a strict `"connecting" | "live" | "error"` union — confirmed by direct read
of `realtime.ts:164-178` — there is no fourth `"closed"` state anywhere in this model. On the last
unsubscribe, the channel object is deleted from the `Map` outright (`realtime.ts:273-281`), not
transitioned to a persisted "closed" state; a subsequent `subscribe()` for the same table builds a
brand-new channel starting at `"connecting"`. A "closed"-state replay scenario is therefore
structurally inapplicable to this design, not an untested case.

---

### Cross-consumer regression (`.live()`)

`.live()` supplies no `onOpen` handler (confirmed: `rg -n "onOpen" packages/client/src/live.ts`
returns no match), so the new `onOpen` fan-out and replay branches are entirely inert from its
perspective — it cannot observe a callback it never registered. The two code paths `.live()` *does*
depend on are unchanged in trigger condition (`onResync`, proven bit-for-bit above) and structurally
untouched (refcount open-on-first/close-on-last, channel key = table name). The mutation
reproduction above independently confirms a real regression in the shared refcount path is caught
by `.live()`'s own suite (9.3/9.4), not just by the new manager suite — i.e., `.live()` gained
*more* protection from this change (a second suite exercising the same shared class), not a new
observable behavior. No `.live()` code path can newly observe a state change it could not observe
before this commit; this is safe.

---

### Correctness (Static Evidence)

| Requirement | Status | Notes |
|------------|--------|-------|
| `TableChannel.state/everOpened/lastError` | ✅ Implemented | `realtime.ts:164-178`, exact D1 shape |
| `ChannelListener.onOpen?(reconnected)` | ✅ Implemented | `realtime.ts:180-201`, optional, documented |
| Replay-on-subscribe (live/error/connecting) | ✅ Implemented | `realtime.ts:254-271` |
| `onResync` trigger condition preserved | ✅ Implemented | Explicit before/after comparison above |
| Refcount / close semantics preserved | ✅ Implemented | `realtime.ts:207-282`, untouched structure |

### Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| D1 — corrected open-state model | ✅ Yes | All eight D1 elements matched line-for-line above |
| D1 "what must not move" | ✅ Yes | `onResync` condition, refcount, channel key, `close()` all unchanged; `live.mjs` zero-diff |

---

### TDD Compliance

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | Full RED/GREEN/TRIANGULATE table found in `apply-progress` for 2.1–2.6 |
| All tasks have tests | ✅ | 6/6 RED tasks (2.1–2.6) have a dedicated `check()` case in `realtime-manager.mjs` |
| RED confirmed (tests exist) | ✅ | `realtime-manager.mjs` exists, 189 lines, 6 checks, verified by direct read |
| GREEN confirmed (tests pass) | ✅ | 6/6 pass on fresh re-run in this verify pass |
| Triangulation adequate | ✅ | Each task has its own dedicated scenario/assertion set — no shared single-case coverage across distinct behaviors |
| Safety net for modified files | ✅ | `live.mjs` (pre-existing, unmodified) re-run fresh and green as the safety net for the shared `realtime.ts` |

**TDD Compliance**: 6/6 checks passed

### Test Layer Distribution (Phase 2)

| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | 6 | 1 (`realtime-manager.mjs`) | plain Node, fake transport (no framework) |
| Integration | 0 | 0 | — |
| E2E | 0 | 0 | — |
| **Total** | **6** | **1** | |

Informational only (per strict-TDD verify rules) — a fake-transport unit suite is the correct layer
for this pure state-machine class; no SUGGESTION raised.

### Assertion Quality

✅ All assertions verify real behavior (see Mutation Reproduction section above for the detailed
audit).

### Quality Metrics

**Linter**: ✅ No errors (`pnpm --filter @indigodb/client lint` → `tsc --noEmit`, exit 0)
**Type Checker**: ✅ No errors (same command; this package's lint IS its type check)

---

### Issues Found

**CRITICAL**: None
**WARNING**: None
**SUGGESTION**: None

---

### Verdict

**PASS**

All 9 Phase 2 tasks complete with real substance in `5b4af4b`; all 4 `client-live-queries`
scenarios compliant against a fresh test run; D1 conformance verified line-by-line including the
bit-for-bit `onResync` trigger-condition proof; `live.mjs` independently reconfirmed zero-diff and
green; a surgical, isolated mutation reproduction confirms task 2.6's refcount claim on its own
assertion, and its cross-suite failure in `live.mjs` is the expected, correct behavior of a shared
regression fence rather than a test-isolation defect; late-subscriber semantics for `live`/`error`/
`connecting` are all covered, and the absence of a `closed`-state test is confirmed structurally
inapplicable rather than a coverage hole.


---

```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:0348a957d97cd1be45d67696fd55c0bb1e6e35534efdf69180e69c7fb8b643c2
verdict: pass
blockers: 0
critical_findings: 0
requirements: 6/6
scenarios: 10/10
test_command: "pnpm --filter @indigodb/realtime build && pnpm --filter @indigodb/realtime test && pnpm --filter @indigodb/cli build && node packages/cli/test/realtime-allowlist-resolution.mjs"
test_exit_code: 0
test_output_hash: sha256:6e39bbd08db875c15515270c7ae4703edb1963764802a05dea01784ace96cb7e
build_command: "pnpm exec turbo lint --filter=@indigodb/realtime --filter=@indigodb/cli --force"
build_exit_code: 0
build_output_hash: sha256:2e350ead6edd95a2da2ff47ef5a10c2da05bc2b2cd1bcdfa19a9b07086085b2a
```

# Verification Report — frontend-realtime-sdk (Phase 1)

## Verification Report

**Change**: `frontend-realtime-sdk`
**Phase scored**: Phase 1 only (Slice 1 — Origin allowlist: engine + CLI/Studio wiring), tasks 1.1–1.13.
**Commit**: `85d04da` on `feat/realtime-origin-allowlist`, off `main` @ `3bb8412`.
**Mode**: Strict TDD. Phases 2–6 are unimplemented and are **not** scored here.
**Skills loaded**: `vercel-react-best-practices` (paths-injected) — not directly applicable to this
phase's scope (`packages/realtime`/`packages/cli`, no React code), consulted for completeness only.

---

### Task Completeness

| Task | Status | Evidence |
|---|---|---|
| 1.1 | ✅ | `origin-allowlist.mjs` test "1.1" — unconfigured + Origin ⇒ 403, no CORS header |
| 1.2 | ✅ | test "1.2" — no Origin header ⇒ 200 text/event-stream regardless of config |
| 1.3 | ✅ | test "1.3" — listed origin ⇒ exact echo, `vary: origin`, never `*` |
| 1.4 | ✅ | test "1.4"/"1.4b" — mismatched + prefix/suffix threat-matrix ⇒ 403 |
| 1.5 | ✅ | test "1.5" — `handleLogRequest` obeys identical gate, before handle verification |
| 1.6 | ✅ | test "1.6"/"1.6b" — OPTIONS 204/403 mirrors the route it precedes, both paths |
| 1.7 | ✅ | `engine.ts:225-249,255-260,361-369` — `isOriginAllowed`/`corsHeaders`/`rejectOrigin`, wired into both handlers, hardcoded `"*"` removed |
| 1.8 | ✅ | `realtime-allowlist-resolution.mjs` — 7 cases for `resolveAllowedOrigins` merge/dedup/trim |
| 1.9 | ✅ | `index.ts:240,346,423-427,444` + `studio-server.ts:120-128,1098` — `--allow-origin` wired into both commands |
| 1.10 | ✅ | test "1.10" — allowed-origin subscriber's wake frame still `{table,op,lsn,seq}`, no `pk`/`new`/`old` |
| 1.11 | ✅ | 1.10 passes with zero `dispatch()` diff (confirmed via `git diff` — `dispatch()` untouched) |
| 1.12 | ✅ | `dispatch.mjs` 20/20 pass fresh; diff shows only additive `headers: {}` on the fake `IncomingMessage`, zero assertions touched |
| 1.13 | ✅ | fresh reruns below — realtime build+test, cli build+test, turbo lint, all clean |

**13/13 Phase 1 tasks complete**, all checkboxes `[x]` in `tasks.md`, matching the code state at `85d04da`.

---

### Traceability — Scenario → T-row → Task mapping (Phase 1 rows)

Verified all 9 `realtime-origin-allowlist` mapping-table rows against the actual test file:

| Scenario | Task | Verified |
|---|---|---|
| No config → no wildcard header | 1.1 | ✅ present, passing |
| No config → any origin not granted | 1.1 | ✅ present, passing (same test asserts both) |
| Originless request served even unconfigured | 1.2 | ✅ present, passing |
| Listed origin granted, exact echo | 1.3 | ✅ present, passing |
| Non-listed origin rejected | 1.4 | ✅ present, passing |
| Prefix/suffix confusion not granted | 1.4 | ✅ present, passing (test "1.4b", threat-matrix) |
| Both routes honor same allowlist | 1.5 | ✅ present, passing |
| `OPTIONS` allowed ⇒ 204, exact echo | 1.6 | ✅ present, passing |
| `OPTIONS` rejected ⇒ 403, both paths | 1.6 | ✅ present, passing (test "1.6b") |

The mapping table holds exactly for Phase 1: every named scenario has a covering test, and every
covering test is present, reachable (`ran === 9` guard at line 444 of `origin-allowlist.mjs`), and
passing on a fresh run.

---

### Build / Test Evidence (fresh, not replayed)

| Command | Result |
|---|---|
| `pnpm --filter @indigodb/realtime build` | ✅ clean |
| `node packages/realtime/test/origin-allowlist.mjs` | ✅ 9/9 pass |
| `node packages/realtime/test/dispatch.mjs` | ✅ 20/20 pass (regression, task 1.12) |
| `pnpm --filter @indigodb/realtime test` (full chain) | ✅ 21 unit + 20 (dispatch) + 9 (origin-allowlist) pass; `endpoint.mjs`, `pg-harness.mjs`, `parity.mjs`, `resume.mjs`, `log.mjs`, `buckets.mjs` **SKIPPED** — `INDIGODB_TEST_DATABASE_URL` unset. SKIPs are reported as SKIP, not counted as pass. |
| `pnpm --filter @indigodb/cli build` | ✅ clean |
| `node packages/cli/test/realtime-allowlist-resolution.mjs` | ✅ 7/7 pass |
| `node packages/cli/test/studio-server.mjs` | ✅ pass |
| `node packages/cli/test/studio-realtime-degraded.mjs` | ✅ pass |
| `node packages/cli/test/studio-auth.mjs` | ✅ pass |
| `pnpm exec turbo lint --filter=@indigodb/realtime --filter=@indigodb/cli --force` | ✅ clean (both `tsc --noEmit`) |

Note: the harness caveat about `pnpm test --force` silently no-op'ing (last-command-only `&&`
chain) was respected — every command above was invoked directly per-package/per-file, never via a
bare `pnpm test --force` at the root.

---

### Spec Compliance Matrix — `realtime-origin-allowlist` (9/9 scenarios)

| # | Scenario | Status |
|---|---|---|
| 1 | No configured origins means no wildcard CORS header | **COMPLIANT** |
| 2 | An unlisted origin's request is not granted CORS access | **COMPLIANT** |
| 3 | An originless request is served even with the allowlist unconfigured | **COMPLIANT** |
| 4 | A listed origin is granted access | **COMPLIANT** |
| 5 | A non-listed origin is not granted access | **COMPLIANT** |
| 6 | An origin that merely prefixes or suffixes a listed one is not granted access | **COMPLIANT** |
| 7 | Both routes honor the same allowlist identically | **COMPLIANT** |
| 8 | A preflight from an allowed origin returns 204 with the exact origin echoed | **COMPLIANT** |
| 9 | A preflight from a non-allowed origin is rejected on both paths | **COMPLIANT** |

### Spec Compliance — `realtime-live-endpoint` (MODIFIED CORS delta)

| Scenario | Status | Note |
|---|---|---|
| Non-`@@allow` model wake-up-only, regardless of the configured CORS origin allowlist | **COMPLIANT** | Task 1.10 exercises exactly this pairing: an allowed-origin request against a non-`@@allow` model (`Post`) still receives only `{table,op,lsn,seq}` |
| `@@allow` model: no row data / `pk` dropped from composite key / create-only `@@allow` still wake-only | **COMPLIANT (regression, unmodified)** | `dispatch.mjs` 20/20 pass fresh — B1.1a/B1.1b/B1.1c/B1.2 untouched by this phase |
| `.live()` observes wake as refetch trigger | **N/A this phase** | `test/live.mjs` unmodified is the proof; belongs to Phase 3, not in this diff |

**Requirements scored**: `realtime-origin-allowlist`'s 5 Requirements (all satisfied by the 9
scenarios above) + the 1 MODIFIED Requirement in `realtime-live-endpoint` = 6 total, 6 satisfied.
**Scenarios scored**: the 9 `realtime-origin-allowlist` scenarios + the 1 `realtime-live-endpoint`
scenario genuinely new to this phase ("Non-`@@allow` model wake-only, regardless of the configured
CORS origin allowlist" — tasks.md marks this as "the only clause actually new to this change")
= 10 total, 10 COMPLIANT. The other 4 `realtime-live-endpoint` scenarios are pre-existing,
unmodified behavior (regression-verified, not newly scored scope for this phase).

---

### Design Coherence — D7

Implementation matches `design.md` D7 exactly, line for line:
- `RealtimeEngineOptions.allowedOrigins?: string[]` — present (`engine.ts`).
- Default closed, no `Origin` header always allowed — present, exact match to D7's stated rule.
- Exact lowercase-normalized string equality, no wildcard/regex/suffix — present
  (`origin.toLowerCase()` + `Set.has`), proven by the reverted `.startsWith()` mutation below.
- Gate lives in `handleRequest` **and** `handleLogRequest`, not `attach()` — confirmed by reading
  both handler bodies; `attach()` itself is unchanged (still pure routing).
- `OPTIONS` mirrors the route it precedes (204/403, same headers) — present, both paths.
- Operator surface `--allow-origin` (repeatable) + `INDIGODB_REALTIME_ALLOWED_ORIGINS`, merged —
  present via `resolveAllowedOrigins`, union + de-dup, matching D7's "merged" language (not a
  precedence override — deliberately, and correctly, a union).

No design deviations beyond the documented `dispatch.mjs` `headers: {}` compatibility addition
(purely additive, see below).

---

### Mutation Reproduction (self-verified subset; 1.4b already verified by the orchestrator)

All mutations below were applied, confirmed to fail on the task's own named assertion, then
reverted with a clean `git diff` before the next mutation.

| Task | Mutation applied | Result |
|---|---|---|
| 1.1 | `isOriginAllowed`: added `if (this.allowedOrigins.size === 0) return true;` (open-by-default on unconfigured) | **Bit exactly test "1.1"** — response never terminated within the 2s bound (the RED-phase-designed timeout guard fired: `"response body did not end within 2000ms — likely an unexpectedly still-open stream"`), all 8 other checks unaffected |
| 1.5 | Removed the origin gate from the top of `handleLogRequest` only | **Bit exactly tests "1.5" and "1.6b"** on their own assertions (`200 !== 403`, `204 !== 403`); `handleRequest`'s own tests (1.1-1.4b, 1.6) stayed green, proving the gate loss was scoped to the one route as designed |
| 1.6 | `handleRequest`'s `OPTIONS` branch: `res.writeHead(204, ...)` → `res.writeHead(200, ...)` | **Bit exactly test "1.6"** (`200 !== 204`); 1.6b (the rejected-origin OPTIONS case) stayed green since it never reaches that line |
| 1.8 | `resolveAllowedOrigins`: flag present ⇒ return `fromFlag` only (override instead of merge) | **Bit exactly** the "flag AND env both present -> MERGED" and "duplicate origins across flag+env are de-duplicated" cases, both on their own array-diff assertions; the 5 other cases (env-only, flag-only, both-absent, trim, empty-flag) stayed green |

Every assertion failure above named the exact expected/actual mismatch (a status code, an array
diff, or an explicit "still-open stream" timeout message) — none were an unrelated crash, none
were a hang without diagnosis, and none were located off the boundary the task describes.

Task 1.4b (prefix/suffix exact-match mutation) was reproduced by the orchestrator prior to this
session and is not re-run here.

---

### Assertion Quality Audit

Scanned `packages/realtime/test/origin-allowlist.mjs` (451 lines, 9 `check()` cases) and
`packages/cli/test/realtime-allowlist-resolution.mjs` (77 lines, 7 `check()` cases).

- **No tautologies** — every assertion compares an observed HTTP status, header value, or response
  body/payload shape against an expected value tied to the scenario under test.
- **No orphan empty-collection checks, no ghost loops** — the suite drives real HTTP exchanges
  through an actual `node:http` listener + `fetch()`; there is no queryAll/filter iteration over a
  possibly-empty collection.
- **No smoke-test-only assertions** — every `check()` asserts specific behavior (status code +
  header content, or exact JSON payload shape via `deepStrictEqual`), never bare
  existence/no-crash checks.
- **No implementation-detail coupling** — assertions are on the wire contract (status, headers,
  frame body), not on internal state or mock call counts.
- **Mock/assertion ratio** — `fakeSource`/`fakeLogDb` are the two mocks in `origin-allowlist.mjs`
  against ~20 `strictEqual`/`deepStrictEqual`/`ok` assertions across 9 cases; well under the 2×
  threshold.
- **Negative-case (403) and OPTIONS-rejection assertions verified to fail on their own
  assertion, not on an unrelated crash**: confirmed directly via mutation reproduction above —
  each 403/OPTIONS-403 case fails with an explicit status-code or CORS-header diff, or (for the
  1.1 case) an explicit "still-open stream" timeout diagnostic built specifically for this
  RED-phase failure mode (`readAllWithTimeout`'s comment states this intent directly), not a
  generic crash or hang.

**Assertion quality**: ✅ All assertions verify real behavior. 0 CRITICAL, 0 WARNING.

---

### TDD Compliance

| Check | Result | Details |
|---|---|---|
| TDD Evidence reported | ✅ | Full "TDD Cycle Evidence" table present in apply-progress, 7 rows (1.1-1.6, 1.10) |
| All tasks have tests | ✅ | 13/13 tasks map to `origin-allowlist.mjs`, `realtime-allowlist-resolution.mjs`, or a verify/regression step |
| RED confirmed (tests exist) | ✅ | Both test files exist, verified by direct read |
| GREEN confirmed (tests pass) | ✅ | 9/9 + 7/7 pass fresh, this session |
| Triangulation adequate | ✅ | Each of the 9 spec scenarios has its own distinct `check()` case; 1.4 additionally triangulates a positive/negative/threat-matrix trio |
| Safety Net for modified files | ✅ | `dispatch.mjs` (modified, +6/-0) — regression suite re-run fresh, 20/20 pass; `engine.ts` (modified) — full pre-existing `realtime` test chain green |

**TDD Compliance**: 6/6 checks passed.

---

### Studio Regression Boundary — Assessment

**Claim under test**: a closed-by-default origin allowlist cannot break the Studio's embedded
`RealtimeEngine` (its browser client never configures `allowedOrigins` and relies entirely on the
originless-request always-allowed rule).

**What is proven**:
1. `studio-server.ts`'s wiring is a pure pass-through — `allowedOrigins: options.allowedOrigins`
   with zero added logic (confirmed by diff against `3bb8412`).
2. That value flows straight into `new RealtimeEngine(...)`, the exact same constructor
   `origin-allowlist.mjs`'s test "1.2" exercises for the originless-request path.
3. `isOriginAllowed`'s admission decision is evaluated purely from `req.headers.origin` — it never
   touches the DB, the WAL source, or `realtimeAvailable`. A live Postgres connection adds no
   proof value for this specific claim: the gate fires (or doesn't) before any DB code path is
   reached, DB-connected or not.
4. Studio's browser client (`useLiveTable.ts` → `SseTransport.connect`, `packages/client/src/realtime.ts:76`)
   issues a plain same-origin `fetch(url, { signal, headers: { accept: "text/event-stream" } })`
   with no `mode`/`credentials` override. Per the Fetch/HTTP `Origin` header algorithm, evergreen
   browsers omit the `Origin` header on a same-origin `GET` (it is added for cross-origin requests
   and for same-origin state-changing methods, not for a same-origin `GET`) — this is a
   well-established browser networking fact, not something a live-Postgres test would add
   evidence for.
5. The full pre-existing CLI regression suite touching this exact server (`studio-server.mjs`,
   `studio-realtime-degraded.mjs`, `studio-auth.mjs`) stays green, fresh, this session.

**What remains unproven, honestly**: a genuine live browser (not a live Postgres) hitting the
Studio's embedded route through a real tab could in principle diverge from the documented
same-origin `Origin`-omission behavior in some non-standard client (an extension, a proxy, or a
non-compliant embedded webview injecting an `Origin` header on a same-origin GET). Neither this
phase's unit tests nor a live-Postgres E2E test would close that gap — it needs a live *browser*,
not a live database. Since `INDIGODB_TEST_DATABASE_URL` specifically gates DB-backed suites, and
this claim's admission logic is DB-independent, **the missing Postgres-backed E2E run is not the
relevant gap for this specific claim** — the unit-level proof plus the wiring read constitute
sufficient evidence for "a closed-by-default allowlist cannot break the Studio's embedded engine"
as stated. It would not, by itself, prove the unrelated claim that live WAL events actually reach
a browser tab end-to-end — that is out of Phase 1's scope (D7 gates admission only, not data flow)
and remains genuinely untested in this sandbox, correctly flagged as such in apply-progress rather
than silently assumed.

**Verdict on this dimension**: sufficient for the CORS-regression claim as stated; no CRITICAL or
WARNING raised. Recorded as a SUGGESTION only, below.

---

### `dispatch.mjs`'s `headers: {}` Addition

Diffed the file against the pre-phase commit (`3bb8412`): the change is exactly `+6` lines adding
a `headers: {}` field with an explanatory comment to the fake `IncomingMessage` object, and
**zero** lines removed or modified. No existing `check()` case, assertion, or expected value was
touched. This is a genuine, minimal compatibility fix — `handleRequest` now reads
`req.headers.origin` (new in this phase) and the fake object needed the field the real
`IncomingMessage` always carries; nothing was weakened to accommodate it.

---

### CLI Surface

- `--allow-origin` (repeatable, both `realtime` and `studio` commands) — confirmed present in
  `index.ts` at both option declarations (lines 240, 346).
- `resolveAllowedOrigins(flagValues, env)` — confirmed as a pure union + de-dup (`[...new
  Set([...fromFlag, ...fromEnv])]`), matching design's "merged" language exactly (not an override
  precedence — a deliberate, correct union).
- Unset configuration (`both absent -> empty array`) really does default closed — proven directly
  by `origin-allowlist.mjs` test "1.1" (empty `allowedOrigins` ⇒ 403 for any Origin) and the CLI
  resolver's own "both absent -> empty array (closed default)" case, both passing fresh.
- De-duplication and env-entry trimming — both covered and passing (`realtime-allowlist-resolution.mjs`,
  7/7).

---

## Issues

**CRITICAL**: none.
**WARNING**: none.

**SUGGESTION**:
1. The Studio embedded-engine regression boundary rests on a well-established browser networking
   fact (same-origin GET omits `Origin`) rather than a live-browser assertion. Consider adding one
   lightweight jsdom/Playwright-level check in a later phase (e.g. alongside Phase 6's Studio
   re-base) that a same-origin `fetch` to `REALTIME_PATH` genuinely carries no `Origin` header in
   a real browser context, closing this specific residual gap with direct evidence rather than
   documented HTTP-spec behavior. Not blocking — D7's own admission logic is fully proven at the
   unit level and via wiring inspection.

---

## Final Verdict: **PASS**

Phase 1 (tasks 1.1–1.13) is complete, spec-compliant (6/6 requirements, 9/9
`realtime-origin-allowlist` scenarios + 1/1 `realtime-live-endpoint` CORS-delta requirement, all
COMPLIANT), design-coherent (D7 matched exactly), TDD-compliant (6/6 checks), and assertion
quality is clean (0 issues). All mutations sampled bite on their own named assertion. No CRITICAL
or WARNING issues found. Ready for `sdd-apply` to continue with Phase 2.

## Key Learnings

1. A closed-by-default CORS gate evaluated purely from request headers needs no live database to
   prove its admission logic — the missing Postgres E2E run is a genuine gap for data-flow claims,
   not for this specific compatibility claim.
2. A RED-phase test against an unimplemented 403 gate can leave an SSE stream open instead of
   crashing; a bounded-timeout body read with a named diagnostic message turns that hang into a
   readable, non-crashing test failure.
3. `resolveAllowedOrigins`'s union-with-de-dup design deliberately differs from a flag-overrides-env
   precedence model — both are valid CLI merge strategies, and the mutation that switched to
   override-on-flag-present was caught by two distinct test cases on their own array-diff
   assertions.
