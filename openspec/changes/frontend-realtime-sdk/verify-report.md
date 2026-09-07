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
