```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:a81245f10efa6e3354dfc74c9c9ea023ba583ce22177c954e26bee903aa36a67
verdict: pass_with_warnings
blockers: 0
critical_findings: 0
requirements: 4/4
scenarios: 4/4
test_command: node packages/client/test/readme-contract.mjs && pnpm exec turbo test --filter=@indigodb/client --force
test_exit_code: 0
test_output_hash: sha256:7dff1891cb58b2ede4de092a8fe25a2b05863305ca4feb806ea85bf20f40db17
build_command: pnpm exec turbo build lint --filter=@indigodb/client --force
build_exit_code: 0
build_output_hash: sha256:5d379b6635e328cdd01ad82a0798891ca8a941af1007dff140c40afcf4563adc
```

## Verification Report — Phase 4

**Change**: frontend-realtime-sdk
**Phase**: 4 of 6 (Slice 4 — Docs: README, TanStack recipe, non-goals)
**Commit**: `4aef7dc` on `docs/client-browser-usage`, off `main` @ `c5ebe83`
**Mode**: Strict TDD

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total (Phase 4) | 6 |
| Tasks complete | 6 |
| Tasks incomplete | 0 |

All 6 checkboxes (4.1–4.6) confirmed `[x]` in `openspec/changes/frontend-realtime-sdk/tasks.md` at `4aef7dc`, verified against `git diff main..HEAD -- openspec/changes/frontend-realtime-sdk/tasks.md`.

### Build & Tests Execution
**Build**: ✅ Passed
```text
pnpm exec turbo build lint --filter=@indigodb/client --force
Tasks: 8 successful, 8 total (cache bypass, all fresh)
```

**Tests**: ✅ 4/4 readme-contract checks passed; full `@indigodb/client` chain green
```text
node packages/client/test/readme-contract.mjs
  ok   browser section names the @indigodb/client/realtime entry point
  ok   browser section states the wake-only, no-row-data contract
  ok   browser section states the query non-goal and points to the app's own backend
  ok   TanStack recipe calls createLiveSubscription with onWake invalidating queries
all readme-contract checks passed

pnpm exec turbo test --filter=@indigodb/client --force
Tasks: 8 successful, 8 total (0 cached, all fresh)
```
Ran via `pnpm exec turbo test --force` directly (never bare `pnpm test --force`, which the harness caveat correctly warns silently no-ops because `test` is a `&&` chain and the flag lands on the last command). No Postgres-gated SKIP was misreported as a pass — this run's tail included the full realtime/live suite chain and finished exit 0.

**Coverage**: not measured — no coverage tool configured in this package; consistent with prior phases.

### Spec Compliance Matrix
| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| README names the browser entry point | README mentions browser subpath | `readme-contract.mjs > browser section names the @indigodb/client/realtime entry point` | ✅ COMPLIANT |
| README states the wake-only contract | README states wake-only, no-row-data explicitly | `readme-contract.mjs > browser section states the wake-only, no-row-data contract` | ✅ COMPLIANT |
| README states the query non-goal | README states the query non-goal | `readme-contract.mjs > browser section states the query non-goal and points to the app's own backend` | ✅ COMPLIANT |
| README includes a worked TanStack Query recipe | README's recipe invalidates via onWake | `readme-contract.mjs > TanStack recipe calls createLiveSubscription with onWake invalidating queries` | ✅ COMPLIANT |

**Compliance summary**: 4/4 scenarios compliant, all covered by a real, executed check (not prose-only).

### Correctness (Static Evidence) — accuracy audit of every factual README claim

This phase's deliverable is documentation; its correctness bar is factual accuracy against the code at `c5ebe83`, verified independently (not taken from the apply report):

| Claim | Verified against | Result |
|-------|-------------------|--------|
| `@indigodb/client/realtime`'s closure imports nothing Node-only | `packages/client/src/realtime.ts` (only `type` import from `@indigodb/realtime`, value re-export from `@indigodb/realtime/protocol`; `live.ts` imports nothing) | ✅ Accurate |
| Root entry statically imports `pg` and `node:async_hooks`; `ModelDelegate` alone drags in `async_hooks` via `delegate.ts` → `context.ts` | `src/adapters/pg.ts:13` (`import pg from "pg"`), `src/client.ts:10` and `src/context.ts:17` (`import { AsyncLocalStorage } from "node:async_hooks"`), `delegate.ts:38` imports `./context.js` | ✅ Accurate, line numbers match |
| SSE stream is wake-only for every table (no `@@allow`-scoped exception) | `git show 9798f9c` — "dispatch() now sends every SSE subscriber a data-free wake frame for every table, regardless of @@allow — the old allowModels-scoped branch is gone" | ✅ Accurate |
| Generated client imports the root entry and cannot be bundled for a browser | `packages/generator`'s emitted client imports `@indigodb/client` (root), which in turn imports `pg`/`node:async_hooks` transitively | ✅ Accurate (consistent with the package's own architecture note in CLAUDE.md) |
| `createLiveSubscription`'s documented signature/return shape | `packages/client/src/realtime.ts:467-488` — interface `LiveSubscription` has exactly `getStatus`, `getError`, `subscribe`, `retry`, `close` (5 members); `options.onWake?: () => void` (arity 0) | ✅ Accurate — README's code sample calls `getStatus()`/`subscribe()`; it does not claim an exhaustive 5-key list in prose but nothing it states is false or incomplete-to-the-point-of-misleading |

No factual claim in the new section was found to misstate the code.

### TanStack Query recipe — runnable and correctly framed
- `useQueryClient()` and `queryClient.invalidateQueries({ queryKey: [...] })` are real, current TanStack Query v5 APIs used with the correct signature shape.
- The recipe wires `onWake` strictly as a cache-invalidation trigger (`queryClient.invalidateQueries`), never as a data source — matches `LiveSubscriptionOptions.onWake`'s contract (`() => void`, no payload) and the spec's requirement that the SDK never present itself as a data feed.
- `useOrders()` in the surrounding prose is described as an ordinary `useQuery` hook that still fetches from the app's own backend — the SDK is never framed as replacing it.

### Suite strength assessment — confirming the orchestrator's reproduction

Independently reproduced with a second, different mutation than the orchestrator's (which reworded `own backend` → `application server`): replaced the wake-only heading's sentence with one that keeps the required keywords (`wake`, `no row data`) but **inverts the claim's meaning** ("it is a lie that it carries no row data, it actually streams full rows on every wake"). Result: **all 4 checks still passed.**

This confirms the honest characterization of `readme-contract.mjs`:
- **What it guarantees**: the required facts are stated *somewhere inside the correctly-scoped section* (via `extractSection()`, anchored on a `## `-level heading matched by `/browser/i` and bounded to the next `## ` heading). This does catch deletion, and it does catch relocation out of the browser section — both were independently confirmed (the orchestrator's reproduction on check 4.3, and the section-boundary logic reviewed directly).
- **What it does NOT guarantee**: semantic correctness. Because checks 4.1–4.3 are keyword/regex presence checks (`includes()`, `/no row data/i`, `/wake/i`, `/own backend/i`), a sentence containing the right words but asserting the *opposite* fact passes. Check 4.4 is meaningfully stronger than 4.1–4.3: it additionally asserts a structural/negative constraint (`onWake` callback body must call `invalidateQueries` and must NOT call `refetch()` inside the same callback), so a wrong-but-keyword-matching recipe is more likely (though not guaranteed) to trip the `refetch()` exclusion — but a rewrite that calls a third method (neither `invalidateQueries` nor `refetch()`) inside `onWake` while some other unrelated code block also happens to contain both keywords would still be caught by the `find()` step requiring both `createLiveSubscription` and `invalidateQueries` in the *same* code block, which is a real (if narrow) structural check.
- **Verdict on strength**: 4.1–4.3 are **weaker than their scenario names imply** — they prove presence, not truth. 4.4 is comparatively stronger due to its structural code-block + negative-assertion design, but is still a static-text check, not a functional test that actually executes the recipe. None of the four executes the documented code sample; a copy-paste error in the recipe that still contained both substrings would not be caught.
- This is a known, acceptable limitation for prose-verification suites (the suite's own header comment states this candidly: "the 'code' under test is prose"), but it means **the suite cannot be relied on to catch a future contributor who fixes a bug by editing the code without updating the README's now-incorrect explanation**, as long as the old keywords survive the edit.

### Coherence (Design)
| Decision | Followed? | Notes |
|----------|-----------|-------|
| Doc-only Phase 4 scope, no code changes outside `README.md`/test/package.json wiring | ✅ Yes | `git diff main..HEAD --stat` confirms exactly 4 files: `README.md`, `test/readme-contract.mjs` (new), `package.json` (1-line test-chain wiring), `tasks.md` |
| Design's File Changes table row for `packages/client/README.md` | ✅ Yes | Browser section, wake-only contract, non-goals, TanStack recipe — all present |

### TDD Compliance
| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | Found in apply-progress, all 4 RED tasks with mutation description |
| All tasks have tests | ✅ | 4/4 doc-assertion tasks (4.1–4.4) map to `readme-contract.mjs`'s 4 `check()` blocks |
| RED confirmed (tests exist) | ✅ | `readme-contract.mjs` exists at `4aef7dc`, contains exactly 4 `check()` calls matching 4.1–4.4 |
| GREEN confirmed (tests pass) | ✅ | 4/4 pass on fresh execution at `4aef7dc` |
| Triangulation adequate | ➖ | Single check per scenario — appropriate; each scenario names one distinct assertion, not multiple cases |
| Safety Net for modified files | ✅ | `README.md` and `package.json` were pre-existing, modified files; the full `@indigodb/client` chain (pre-existing 28+ tests) ran green alongside the new suite |

**TDD Compliance**: 6/6 checks passed

### Assertion Quality
No tautologies, no ghost loops over possibly-empty collections, no assertions divorced from the artifact under test (all 4 checks read the real `README.md` file and assert against real content). The suite is honestly self-scoped to prose/content assertions (documented in its own header comment) rather than disguised as behavioral tests.

**Assertion quality**: ✅ No CRITICAL issues. One WARNING carried forward from the strength assessment above (semantic-inversion blind spot on checks 4.1–4.3).

### Issues Found

**CRITICAL**: None.

**WARNING**:
1. `readme-contract.mjs` checks 4.1–4.3 are literal keyword/regex presence checks, not semantic checks. A section-scoped rewrite that keeps the required keywords while stating the opposite fact (independently reproduced: inverting the wake-only/no-row-data claim) still passes all 4 checks. This is a real, if narrow, coverage gap for future silent doc drift — not a defect in this phase's delivered scope, but a property future contributors should know about before trusting "the suite is green" as proof the README is still accurate.

**SUGGESTION**:
1. Consider strengthening 4.1–4.3 with a light negation guard (e.g., assert absence of an adjacent negation like `not`/`false`/`lie` near the matched phrase) or, longer-term, replace the wake-only/query-non-goal checks with an assertion that inspects the actual `LiveSubscriptionOptions.onWake` doc comment / `dispatch()` behavior rather than free-text prose, closing the semantic-inversion gap identified above. Not blocking — the current suite still catches the two failure modes it was designed for (deletion and relocation).

### Verdict
**PASS WITH WARNINGS** — all 6 tasks complete, all 4 spec scenarios compliant with real passing tests, build/lint/test all green, and every factual claim in the new README section independently verified true against the code at `c5ebe83`. One WARNING: the content-assertion suite's presence-only checks (4.1–4.3) do not guard against semantically-wrong-but-keyword-matching prose, a real but narrow and non-blocking gap.

---

```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:100d6b3f01cc5ac1c3de638d1ca608b66e8be0ccdd879504c83a020053b3a62d
verdict: pass_with_warnings
blockers: 0
critical_findings: 0
requirements: 9/9
scenarios: 20/20
test_command: "node packages/client/test/live-subscription.mjs"
test_exit_code: 0
test_output_hash: sha256:0353082398e9eb46581a142a334f23baef0bbd0d18b0af09466226757fa5b553
build_command: "pnpm --filter @indigodb/client build"
build_exit_code: 0
build_output_hash: sha256:7ba50d3fd6c71c4e30299100e234149d17b00aa16d647ea45f67ee6ea9fe8b90
```

# Verification Report — frontend-realtime-sdk (Phase 3)

## Verification Report

**Change**: `frontend-realtime-sdk`
**Phase scored**: Phase 3 only (Slice 3 — `createLiveSubscription` primitive + terminal error
classification, D2/D3/D4/D6), tasks 3.1–3.19.
**Commits**: `1a48bf0` (the primitive) and `f9a370f` (the `getError()` addition), on
`feat/live-subscription-primitive`, off `main` @ `b11f335`. Both inspected via `git show` and
`git diff main..HEAD`, not accepted from the apply report alone.
**Mode**: Strict TDD. Phases 1–2 are merged and previously verified PASS (preserved below,
unchanged, not re-audited). Phases 4–6 are unimplemented and are **not** scored here.
**Size**: 1,015 insertions / 55 deletions across 6 files (1,070 total changed lines; 959
code+test excluding the `tasks.md`/`spec.md` doc deltas), independently recomputed via
`git diff main..HEAD --shortstat`, matching the reported figures. This exceeds the 800-line
session budget; the owner recorded a deliberate `size:exception` in the runtime ledger rather
than retroactively splitting green, mutation-proven, coherent work. **Not re-litigated per
instruction.** Assessed instead for reviewable coherence below.
**Skills loaded**: `vercel-react-best-practices` (paths-injected) — this phase's scope
(`packages/client/src/realtime.ts`, plain TS, no React/JSX) is outside that skill's domain;
consulted for completeness only, no applicable rule triggered.

---

### Task Completeness

| Metric | Value |
|--------|-------|
| Tasks total (Phase 3) | 19 (3.1–3.19) |
| Tasks complete | 19 |
| Tasks incomplete | 0 |

All 19 checkboxes are `[x]` in `tasks.md`. 3.1–3.18 land in `1a48bf0` with real substance
(`git show 1a48bf0 --stat`: 772 lines across `realtime.ts`, `live-subscription.mjs`,
`realtime-entry.mjs`, `package.json`, `tasks.md`). Task 3.19 (`getError()`) was added to
`tasks.md` and implemented entirely in the second commit `f9a370f` (not `1a48bf0`) — confirmed
by direct commit inspection. Per the orchestrator's brief, `f9a370f` was authored by the
orchestrator, not the apply agent; `apply-progress` predates it and does not describe it, so this
report verifies task 3.19 against the code and `f9a370f`'s commit message directly rather than
trusting apply-progress prose for that task.

### Scenario → T-row → Task Mapping (Phase 3 slice)

The mapping table at the top of `tasks.md` (`### realtime-live-subscription (14 scenarios,
MODIFIED)`) lists 20 data rows for this capability — the section header's scenario count (14) is
now **stale** (it was not bumped when the six `getError()` rows were added by `f9a370f`); the row
count is correct (`awk` count: 20 non-header/separator rows). This is a cosmetic documentation
inconsistency, not a coverage gap — flagged as a SUGGESTION below.

| Scenario | T-row | Task | Covering test | Result |
|---|---|---|---|---|
| Return shape carries no row data (5 keys incl. `getError`) | T25 | 3.11 | `live-subscription.mjs > 3.11` | ✅ COMPLIANT |
| getError() is null before any error | T25 | 3.19 | `live-subscription.mjs > 3.19a` | ✅ COMPLIANT |
| A terminal error is retrievable with its classification | T21 | 3.19 | `live-subscription.mjs > 3.19b` | ✅ COMPLIANT |
| A transient error is retrievable as non-terminal | T22 | 3.19 | `live-subscription.mjs > 3.19c` | ✅ COMPLIANT |
| Repeated getError() calls return one identical object | T25 | 3.19 | `live-subscription.mjs > 3.19d` | ✅ COMPLIANT |
| getError() is cleared on the next successful open | T25 | 3.19 | `live-subscription.mjs > 3.19e` | ✅ COMPLIANT |
| retry() clears the retrievable error | T23 | 3.19 | `live-subscription.mjs > 3.19f` | ✅ COMPLIANT |
| Constructed but unsubscribed is inert at idle (incl. zero-connect) | T15 | 3.1 | `live-subscription.mjs > 3.1` | ✅ COMPLIANT |
| First subscribe() connecting→live | T17 | 3.3 | `live-subscription.mjs > 3.3` | ✅ COMPLIANT |
| No duplicate callback per identical status | T17 | 3.4 | `live-subscription.mjs > 3.4` | ✅ COMPLIANT |
| Transport error stays error (terminal, no self-recovery) | T17 | 3.3 | `live-subscription.mjs > 3.3` | ✅ COMPLIANT |
| Non-2xx that is not 5xx/408/429 is terminal, halts retry | T21 | 3.13 | `live-subscription.mjs > 3.13` (404 only, see D6 note below) | ✅ COMPLIANT |
| 5xx / stream end / TypeError stay transient | T22 | 3.14 | `live-subscription.mjs > 3.14` (500 + stream-end + TypeError) | ✅ COMPLIANT |
| retry() from error re-opens | T23 | 3.9 | `live-subscription.mjs > 3.9` | ✅ COMPLIANT |
| retry() while live is a no-op | T23 | 3.9 | `live-subscription.mjs > 3.9` | ✅ COMPLIANT |
| Burst of wakes → exactly one onWake | T18 | 3.5 | `live-subscription.mjs > 3.5` (real 5-wake burst, not two spaced wakes) | ✅ COMPLIANT |
| Wakes >window apart → two calls | T18 | 3.7 | `live-subscription.mjs > 3.7` | ✅ COMPLIANT |
| close() twice does not throw | T24 | 3.10 | `live-subscription.mjs > 3.10` | ✅ COMPLIANT |
| Wake in flight at close never fires | T24 | 3.10 | `live-subscription.mjs > 3.10` | ✅ COMPLIANT |
| Import under Node, no DOM globals | T26 | 3.16 | `realtime-entry.mjs` (2 new checks) | ✅ COMPLIANT |

All 20 `realtime-live-subscription` scenarios (the spec's entire capacity — `spec.md` counted
directly: `rg -c "^### Requirement:"` = 9, `rg -c "^#### Scenario:"` = 20, matching the brief's
"was 8/14, now 9/20" growth) resolve to a task, each task resolves to at least one covering test,
and every test passed at runtime (re-run fresh below, not replayed). The six new `getError()`
scenarios (`f9a370f`) are all covered by the six new `3.19a`–`3.19f` checks — confirmed by direct
line-by-line comparison of each spec `Scenario:` block against its matching `check()` assertions
in `live-subscription.mjs`.

Tasks 3.2, 3.6, 3.8, 3.12, 3.15, 3.17, 3.18 carry no distinct spec-scenario row of their own in
the mapping table (3.2/3.6/3.8 are additional interface behavior beyond the spec's Requirement
text, explicitly noted as scaffolding in the task list itself; 3.12/3.15/3.17/3.18 are GREEN/Verify
steps, not RED assertions) — consistent with the tasks document's own declared scaffolding
convention (see Phase 2's report for the precedent).

---

### Build & Tests Execution

**Build**: ✅ Passed (re-run fresh in this verify pass)
```text
$ pnpm --filter @indigodb/client build
> @indigodb/client@0.0.1 build
> tsc
(exit 0, no output)
```

**Tests**: ✅ 20 passed / 0 failed / 0 skipped (`live-subscription.mjs`, re-run fresh)
```text
@indigodb/client: createLiveSubscription (D2/D3/D4/D6)
  ok   3.1 .. 3.11, 3.19a .. 3.19f, createWakeDebouncer standalone check (18 checks)
@indigodb/client: SseTransport terminal/transient classification (D6)
  ok   3.13, 3.14 (2 checks)
All checks passed.
```

**Regression** (`live.mjs`, `realtime-manager.mjs` — must stay green and byte-identical to
`main`):
- `git diff main..HEAD -- packages/client/test/live.mjs packages/client/test/realtime-manager.mjs`
  → **0 lines** — independently re-confirmed in this verify pass, not only accepted from the
  orchestrator's prior finding.
- `node packages/client/test/realtime-manager.mjs` — fresh, ✅ 6/6 pass.
- `node packages/client/test/live.mjs` — fresh, ✅ 40 passed / 0 failed / 1 skipped (`14.1`,
  `INDIGODB_TEST_DATABASE_URL` unset → correctly reported `skip`, never counted as pass).
- `node packages/client/test/realtime-entry.mjs` — fresh, ✅ 5/5 pass (2 new task-3.16 checks +
  3 pre-existing).
- `pnpm --filter @indigodb/client lint` (`tsc --noEmit`) — clean, 0 errors.

Full-repo `pnpm exec turbo test --force` and `pnpm exec turbo lint --force` are accepted from the
orchestrator's already-verified findings per the brief (full suite green, 18/18 tasks, Postgres-gated
suites correctly `SKIP`) and were not re-run in full in this pass; the package-scoped commands
above were re-run independently as the load-bearing spot-check for this phase's changed files.

**Coverage**: ➖ Not available — no coverage tool configured in this package.

---

### Spec Compliance Matrix

`realtime-live-subscription/spec.md`: **9 Requirements / 20 Scenarios**, 20/20 compliant (see
mapping table above for the per-scenario breakdown; all COMPLIANT).

---

### D6 Terminal/Transient Classification — Detailed

`isTransientHttpStatus` (`realtime.ts:71-73`): `status === 408 || status === 429 || (status >= 500
&& status < 600)`. Everything else non-2xx is terminal by the `!isTransientHttpStatus` branch in
`SseTransport.connect` (`realtime.ts:104-114`); a `fetch` rejection (`TypeError`) never reaches
this function at all — it is caught in the outer `catch` and always routed through `onError` only
(never `onTerminal`), so it can never be classified terminal regardless of cause. Stream-end falls
through to the reconnect path with no `onTerminal` call either. This logic is bit-for-bit correct
against D6's stated boundary (400/401/403/404/410 terminal; 500/502/408/429/stream-end/TypeError
transient).

**Boundary cases actually exercised at runtime** (via the real `SseTransport` over a mocked
`global.fetch`, task 3.13/3.14):

| Case | Classification | Exercised? |
|---|---|---|
| 404 | terminal | ✅ `3.13` |
| 500 | transient | ✅ `3.14` |
| stream end | transient | ✅ `3.14` |
| fetch `TypeError` | transient | ✅ `3.14` (explicitly asserts `terminals.length === 0`, "even though CORS can produce one") |
| 400, 401, 403, 410 | terminal | ⚠️ not runtime-exercised — proven only by code inspection of `isTransientHttpStatus`'s exhaustive boolean logic |
| 408, 429, 502 | transient | ⚠️ not runtime-exercised — same |

**WARNING**: the D6 boundary is exercised end-to-end for exactly two HTTP values (404 as the
terminal representative, 500 as the transient floor) plus stream-end and `TypeError`. The two
values immediately adjacent to the terminal/transient line that carry the highest off-by-one risk
— `408` and `429`, both explicitly named in the spec text as staying transient despite being
"close" to the 4xx terminal range — are **not** independently asserted by any test, nor is
`isTransientHttpStatus` unit-tested directly (it is not exported). The function itself is a
three-term boolean (`===408 || ===429 || 500‑599`) simple enough that code inspection gives real
confidence, and 3.14's `500` case does prove the `>=500 && <600` branch works at its floor, but
`429`/`408` are the two values where a plausible mutation (e.g. `status >= 500` alone, dropping
408/429) would silently miscategorize two named-in-spec cases and go undetected by the current
suite. Recommend adding two direct assertions (408, 429 stay transient) in a follow-up, or
promoting `isTransientHttpStatus` to an exported, directly unit-tested pure function. Not
CRITICAL: the current tests do prove the general shape of the classifier and the two most load-
bearing endpoints (the terminal default-case boundary at 404, and the transient 5xx floor at 500).

---

### D3 Debounce — Detailed

`createWakeDebouncer` (`realtime.ts:402-421`): `if (timer !== null) return;` — a pending timer is
never reset by a later wake. Verified two ways:
- `3.5` fires a genuine 5-wake burst (`for (let i = 0; i < 5; i++) { fireWake(); await sleep(5); }`)
  inside one 40ms window and asserts exactly one `onWake`, timed to the *first* wake — not two
  widely spaced wakes, a real burst.
- The standalone `createWakeDebouncer: first-wake-armed, never re-armed within the burst` check
  drives the debouncer directly (not through the primitive) with a wake at `t=0` and a second wake
  at `t=window/2`, asserting exactly one fire — this directly targets the anti-starvation property
  in isolation, avoiding the "two spaced wakes" tautology risk the brief called out.
- `3.6` (sustained wakes every `debounceMs/2` for 5 windows) proves the debouncer is **not**
  globally starved (≥2 fires across a sustained burst), the complementary property to "never
  re-armed."
- `3.7` (wakes >window apart trigger two independent calls) and `3.8` (`debounceMs: 0` bypasses the
  window synchronously) round out the configurability/default claims.

All D3 claims (first-wake-armed, never-re-armed-within-a-burst, configurable, `<=0` disables) are
covered by genuine, non-tautological assertions.

---

### D4 Lazy Start — Detailed

`3.1` asserts BOTH `sub.getStatus() === "idle"` AND `fake.calls.connect === 0` — the fake
transport's `connect()` call counter, not just the status string. This directly proves "zero
connections opened," not merely that the status label reads idle while a connection was silently
opened underneath. ✅ Confirmed non-tautological.

---

### D2 Conformance — Detailed

- `realtime.ts` imports `LIVE_DEBOUNCE_MS` from `./live.js` (pre-existing import, unchanged
  direction). `live.ts` has zero imports from `./realtime.js` (confirmed: `grep "^import"
  packages/client/src/live.ts` returns nothing referencing `realtime`). **No import cycle
  introduced.**
- `createWakeDebouncer` is a separate ~20-line function (12 lines of executable logic plus
  documentation comments) duplicating `live.ts`'s `scheduleRefetch`'s first-wake-armed timer
  pattern — consistent with D2's "duplicate the ~8-line debouncer" prediction; the small overage
  is comment/documentation, not logic divergence. No larger architectural divergence found; the
  two debouncers remain independently testable and swappable.

---

### `RealtimeConnectionManager.reviveChannel()` — Judged

The apply agent's addition beyond design's explicit File Changes list. Read directly
(`realtime.ts:349-363`): closes the channel's current transport connection, resets
`state`/`lastError`/`lastErrorTerminal`, and re-opens via `transport.connect()` on the **same**
channel object — critically, it does **not** clear `channel.listeners`, so every listener already
attached to that channel (i.e., every `createLiveSubscription`/`.live()` consumer sharing the
table) stays attached and receives the fresh connection's `onOpen`/`onError`/`onTerminal` fan-out
through the shared, extracted `buildHandlers(channel)` (also reused for the initial `subscribe()`
open path — the refactor is additive, not a new code path).

**The argument is sound.** A naive per-primitive `unsubscribe()` + `subscribe()` implementation of
`retry()` would only revive the underlying transport connection when the retrying primitive
happens to be the channel's *last* remaining listener (since `unsubscribe()` only calls
`ch.close()` when `listeners.size === 0`); with 2+ listeners sharing a channel (the exact scenario
D1's own manager exists to support), a naive implementation would silently degrade to a no-op —
re-adding the same listener to the same still-open (and, if genuinely terminal, still-broken)
channel object, never actually reopening the transport. `reviveChannel()` is the correct,
general-purpose implementation of D6's own stated text ("`retry()` is channel-level — it revives
every listener sharing that table's channel, not only the caller").

**Safe for Phase 2's already-verified behavior**: `buildHandlers()` extraction is refactor-only —
identical fan-out logic to before, now shared by two call sites instead of duplicated. Phase 2's
regression fence (`realtime-manager.mjs`) was re-run fresh in this pass (6/6 green, see above),
independently confirming D1's onOpen/onResync/replay semantics are untouched by this addition.

---

### Regression Boundary — `.live()` and D6's Terminal Stop

**WARNING** (the most substantive finding in this phase): `.live()` shares its underlying
`RealtimeConnectionManager` channel with any `createLiveSubscription` primitive on the same table
(both go through `manager.subscribe(table, listener)`), and the terminal-stop behavior lives at
the **transport/channel** level (`SseTransport.connect`'s `run()` loop `return`s permanently on a
terminal HTTP status), not at the primitive level. Before this slice, ANY non-2xx response
(including 404) fell through to the generic `throw` → `catch` → `handlers.onError()` → sleep →
retry path, so `.live()` retried forever with exponential backoff regardless of the HTTP status.
After this slice, a terminal status (e.g. a moved/removed endpoint returning 404, or 401/403) makes
the channel's transport loop `return` and **never attempt another connection**, for every listener
on that channel — including a `.live()` consumer that has no exposed `retry()` in its own public
API (`createLiveQuery`'s returned shape is `{rows, status, unsubscribe}` — no `retry`).

Concretely: `.live()`'s own `ChannelListener.onError` (`live.ts:369`) only forwards the error to
the caller-supplied `handlers.onError` callback; it does not itself call anything that would
re-open the channel, and `.live()`'s own `status` field is driven by its data-fetch state machine,
not the transport's open/closed state. So a `.live()` consumer that previously received periodic
(backed-off) `onError` calls forever on a persistent 404 now receives exactly **one** `onError`
call and then silence forever — the underlying channel is permanently dead until the `.live()`
instance itself is torn down and a fresh one created (a new `subscribe()` call builds a brand-new
channel).

This is a genuine, previously-unobserved behavior change for `.live()`, not merely a documentation
gap: `live.mjs` has no scenario exercising a terminal-classified HTTP status at all (its own error
tests, e.g. `3.1`–`3.3`/`8.1`/`8.2`, exercise handle-mint/decode and `runScoped`/nesting-guard
failures — application-layer errors, not transport-layer HTTP status codes), so this cross-consumer
effect is **structurally untested for `.live()`**, only for the primitive directly. Practically,
this is very likely the *intended*, safer behavior (D6 is explicit that a permanently-broken
endpoint should stop being hammered), and it does not regress anything `live.mjs`'s existing suite
actually asserts — but it is a real, silent widening of what `.live()` callers can now observe (a
permanently-stalled connection with no in-band recovery), and it was not called out in
`design.md`'s D1/D6 text as a cross-consumer consequence. Recommend a follow-up `live.mjs`
regression scenario asserting `.live()`'s behavior on a terminal-classified transport error
(at minimum, that its `onError` handler still fires exactly once and no further connect attempts
are made — matching, not contradicting, the new contract) before or during Phase 5/6 sign-off,
since Phase 6 (Studio's `useLiveTable` re-base) also shares this channel path.

**Not CRITICAL**: no currently-scored spec scenario is violated (this behavior is entirely outside
`.live()`'s own spec surface, which this phase does not modify), `live.mjs` stays green and
unmodified, and the change is a strict narrowing of retry activity in the terminal case, not a
correctness regression. Flagged as WARNING because it is an unreviewed, untested cross-consumer
side effect of a channel-level design decision.

---

### Assertion Quality Audit (`live-subscription.mjs`, `realtime-entry.mjs` additions)

Scanned all 20 `check()` blocks plus the 2 new `realtime-entry.mjs` checks (task 3.16):
- No tautologies (`grep` for `expect(true)`/literal-vs-literal assertions: zero matches).
- No assertion-free production-code calls — every `check()` drives `createLiveSubscription`,
  `createWakeDebouncer`, or the real `SseTransport` and asserts on the resulting state.
- No ghost loops (no `for`/`forEach` over a possibly-empty collection guarding an assertion).
- `3.11`'s TS-level guard (excess-property rejection via a type annotation, cross-checked with a
  runtime key-enumeration assertion per the apply report's TDD table) combines a compile-time and
  a runtime check rather than relying on either alone.
- Mock/assertion ratio: the fake transport (`makeFakeTransport()`) is a single lightweight fake per
  test, not a heavy mock library; assertion count per check is 1–4, no mock-heavy tests.

**Assertion quality**: ✅ All assertions verify real behavior — no tautologies, no ghost loops, no
smoke-test-only checks.

**Fake-transport isolation caveat** (per the brief): `makeFakeTransport()`'s `handlers` reference
is scoped **per fake-transport instance** (a `let handlers` closed over inside the factory
function), not a module-level global — each `check()` call creates its own fresh
`makeFakeTransport()`. A mutation that calls `transport.connect()` an extra time within a single
test *would* overwrite that instance's `handlers` and collaterally affect `fireOpen`/`fireError`
calls made afterward in the same test — this is expected behavior for a single-channel fake (only
one channel/connection is meant to exist per table), not a test-isolation defect, and is
consistent with the mutation-collateral pattern already distinguished in the apply report's TDD
table (e.g. 3.1/3.3 sharing the same eager-open root cause).

---

### Mutation Reproduction (cross-checked against the orchestrator's pre-verified findings)

Accepted without re-running (per the brief, already independently observed by the orchestrator):
- The genuine RED/GREEN on `f9a370f`: `onTerminal` initially set `rawErrorTerminal = false` (a
  copy-paste slip from the `onError` handler immediately above it in the diff), 3.19b failed on
  its own terminal-classification assertion, the one-line fix (`rawErrorTerminal = true`) made it
  pass. Confirmed by reading the final `onTerminal: () => { rawErrorTerminal = true; }` in
  `realtime.ts:565` — the shipped code matches the described fix, not the described bug.
- Mutation A (rebuild the error snapshot on every `readError()` call instead of caching):
  fails only `3.19d` (referential identity) — consistent with `readError()`'s actual
  implementation (`realtime.ts` `readError`), which only rebuilds `errorSnapshot` when `cause` or
  `terminal` actually changed, guarding referential stability across repeat calls.
  Mutation B (`clearError()` as a no-op): fails exactly `3.19e` (clear-on-open) and `3.19f`
  (clear-on-retry) — consistent with `clearError()` being called from both `onOpen` and `retry()`
  and nowhere else.

Both are structurally consistent with the final source read in this pass; no independent
re-execution was needed to trust them given direct code inspection agrees with the claimed
mutation/assertion pairing.

---

### TDD Compliance

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | Present in `apply-progress` for 3.1–3.18; task 3.19's mutations documented directly in `f9a370f`'s `tasks.md` diff (three named mutations: rebuild-on-read, no-op `clearError`, `onTerminal` copy-paste bug) |
| All tasks have tests | ✅ | 19/19 tasks have a covering test |
| RED confirmed (tests exist) | ✅ | `live-subscription.mjs` (524 lines, 20 checks) + `realtime-entry.mjs` (+26 lines, 2 checks) both exist and were read directly |
| GREEN confirmed (tests pass) | ✅ | 20/20 + 5/5 pass on fresh re-run in this verify pass |
| Triangulation adequate | ✅ | Each of 3.1–3.19 has its own dedicated `check()`; the six `getError()` scenarios each get their own case (3.19a–f), not folded into one |
| Safety Net for modified files | ✅ | `live.mjs`/`realtime-manager.mjs` re-run fresh and green, zero-diff vs `main` |

**TDD Compliance**: 6/6 checks passed.

### Test Layer Distribution

| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | 25 | 2 (`live-subscription.mjs`, `realtime-entry.mjs` additions) | plain Node `assert` |
| Integration | 0 | — | not installed |
| E2E | 0 | — | not installed |
| **Total** | **25** | **2** | |

This matches the rest of the repo's plain-Node unit-test convention; no SUGGESTION raised (unit
coverage is appropriate for a transport-agnostic primitive with no rendering surface).

### Quality Metrics

**Linter**: ✅ No errors (`tsc --noEmit`). **Type Checker**: ✅ No errors (same command).

---

### Issues Found

**CRITICAL**: None.

**WARNING**:
1. D6's HTTP boundary is runtime-exercised at only two representative values (404 terminal, 500
   transient) plus stream-end/TypeError; `408`/`429` — the two values named in the spec text as
   staying transient near the terminal boundary — and the other named-terminal codes (400/401/403/
   410) are proven only by static inspection of `isTransientHttpStatus`, not by a direct runtime
   assertion. Recommend two more direct boundary tests or exporting/unit-testing the classifier.
2. `.live()` now inherits D6's channel-level terminal-stop (no further connect attempts ever) for
   any table it shares with a terminal-classified error, with no way to recover short of tearing
   down and re-creating the `.live()` instance — a real, previously-nonexistent behavior widening
   that is untested by `live.mjs`'s own suite (which has no transport-layer HTTP-status scenario)
   and unmentioned in `design.md`'s cross-consumer text. Not a spec violation for this phase, but
   should get an explicit `live.mjs` regression scenario before Phase 6 (Studio re-base) leans on
   the same shared channel.

**SUGGESTION**:
1. `tasks.md`'s `### realtime-live-subscription (14 scenarios, MODIFIED)` section header is stale
   — the six `getError()` scenarios added by `f9a370f` bring the actual row count to 20, but the
   header text was not updated. Cosmetic only; the row content itself is correct and complete.

---

### Verdict

**PASS WITH WARNINGS**

All 19 Phase 3 tasks (3.1–3.19) complete with real substance across both commits; all 20
`realtime-live-subscription` scenarios (9 Requirements) compliant against a fresh test run;
D2/D3/D4 conformance verified with non-tautological, real-burst/real-counter assertions;
`reviveChannel()`'s design deviation judged sound and safe, backed by a re-run of Phase 2's
regression fence; `live.mjs`/`realtime-manager.mjs` independently reconfirmed zero-diff and green.
Two WARNINGs are raised — an under-exercised D6 HTTP boundary (two representative values proven
at runtime, not the full named set) and a genuine, untested cross-consumer behavior widening for
`.live()` inheriting D6's terminal-stop — neither blocks this phase's own spec compliance, but
both should be addressed (a boundary test addition; a `live.mjs` regression scenario) before or
during the Phase 5/6 work that will lean further on this shared channel path. One cosmetic
SUGGESTION (stale section-header scenario count) noted.

---

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
