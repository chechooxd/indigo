```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:127a3e2c7fc12dbf8842b8919f93f3663639c0fad8671ecc2b240f216f6fc5ae
verdict: pass_with_warnings
blockers: 0
critical_findings: 0
requirements: 7/7
scenarios: 20/20
test_command: pnpm test --force
test_exit_code: 0
test_output_hash: sha256:227e2e8200e9745d79bfcd0b79b2d5be090dfb1c6a9e9699b212540a823dcc42
build_command: pnpm build
build_exit_code: 0
build_output_hash: sha256:3835b91ba666d1c8b2f31e551177467abc261f41721553130a529c751dc43252
```

## Verification Report

**Change**: studio-query-guardrails — PR 1 of 2 (BACKEND), RE-VERIFY pass
**Version**: N/A (unreleased)
**Mode**: Strict TDD

**Branch**: `feat/studio-query-guardrails-1-backend` — commits `edc2c12` (original) + `c2f00fd` (corrective), on top of `main`@`27b0601`.

### Purpose of this pass

This is a re-verify of a corrective batch (commit `c2f00fd`) that claimed to close the single
CRITICAL finding from the prior verify pass (report #822): the spec scenario
"`queryTimeoutMs`/`queryRowCap` reflect resolved startup values without a session" had zero
covering runtime test. The claim is independently confirmed below, not taken on faith.

### Completeness

| Metric | Value |
|--------|-------|
| Tasks total | 43 |
| Tasks complete | 33 |
| Tasks incomplete | 10 |

Directly counted from `openspec/changes/studio-query-guardrails/tasks.md` via `rg -c`:
`[x]` = 33, `[ ]` = 10. This corrects both apply-phase self-reported counts ("32/42" and "25/42"),
neither of which matches the file on disk (which also has 43 items, not 42). All 10 open items
are Phase 5 (Frontend RED: 5.1–5.5) and Phase 6 (Frontend GREEN: 6.1–6.5) — explicitly PR 2 scope
per the tasks.md Suggested Work Units table. **Backend scope (Phases 1–4, 7) is 100% complete
(33/33).** No unchecked task blocks this backend-scoped verification.

### Build & Tests Execution

**Build**: ✅ Passed — `pnpm build`, 10/10 Turbo tasks, exit 0 (evidence hash above).

**Lint**: ✅ Passed — `pnpm lint`, 19/19 Turbo tasks (`tsc --noEmit` everywhere), exit 0.
```text
Tasks:    19 successful, 19 total
Cached:    19 cached, 19 total
```

**Tests**: ✅ Passed — `pnpm test --force` (forced, zero cache reuse, full repo), 18/18 Turbo
tasks, exit 0, ~8m34s wall time. Zero `not ok` / failure lines across the entire log (one
false-positive grep hit was a passing test *named* `...error...`, verified not a failure).
```text
Tasks:    18 successful, 18 total
Cached:    0 cached, 18 total
Time:    8m33.978s
```

Also ran the CLI package in isolation (`pnpm test --filter=@indigodb/cli --force`): 11/11 Turbo
tasks, exit 0. And ran the specific corrective test file directly
(`node packages/cli/test/studio-query-guardrails.mjs`): 17/17 checks pass, including the new one:

```text
  ok   auth-required + no session: GET /api/auth/status still echoes the resolved guardrail values
All studio-query-guardrails checks passed.
```

**Coverage**: Not available — no coverage tool detected in this repo (plain-Node `assert`-based
test chains, no nyc/c8/istanbul wired). Consistent with prior pass.

### Independent confirmation of the claimed remediation

The claim under scrutiny: one new integration test combining `password` configured + no session
cookie + non-default `{queryTimeoutMs: 9000, queryRowCap: 250}` against `GET /api/auth/status`,
asserting both guardrail fields alongside `authRequired: true` / `authenticated: false`, with a
genuine RED→GREEN cycle (temporary handler break, rebuild, 1 failure observed, revert).

Verified directly, not from the apply report:

1. **Diff shape**: `git show c2f00fd --stat` — exactly 2 files, `packages/cli/test/studio-query-guardrails.mjs`
   (+32/-0) and `openspec/changes/studio-query-guardrails/tasks.md` (+1/-0). Zero production code
   touched, matching the claim.
2. **Test content**: read the added block. It calls
   `withStudio(db, fixture, fn, { password: "correct horse battery staple", queryTimeoutMs: 9000, queryRowCap: 250 })`
   with no cookie sent on the `fetch`, and asserts all four fields (`authRequired`,
   `authenticated`, `queryTimeoutMs`, `queryRowCap`) in the same response body — genuinely the
   missing combination (neither the no-password probe-echo test nor `studio-auth.mjs`'s
   password-configured-but-no-guardrail-assertion tests covered this).
3. **Wiring check**: confirmed `withStudio(db, {resolved, source}, fn, options = {})` spreads
   `options` (including `password`/`queryTimeoutMs`/`queryRowCap`) directly into `startStudio(...)`
   — the options do reach the server the test drives.
4. **Handler check**: `studio-server.ts:757-762` — `GET /api/auth/status` is a single unconditional
   `sendJson(res, 200, { authRequired, authenticated, readOnly, queryTimeoutMs, queryRowCap })`
   with no branch that could withhold fields by auth state. This makes the claimed RED (a
   temporary `if (authRequired && !authenticated)` short-circuit withholding the two new fields)
   plausible and mechanically simple — exactly the shape described, and it would produce exactly
   one new failure (only the new test asserts guardrail values under this exact combination).
5. **Runtime confirmation**: ran the file directly — the new test executes and passes
   (`ok   auth-required + no session: ...`), and the full suite (`pnpm test --force`) reconfirms
   it clean alongside everything else.

**Verdict on the remediation**: genuine. The test exercises the exact scenario the spec requires,
the implementation path is a real (not vacuous) assertion against production code, and the
before/after diff is minimal and test-only as claimed. The prior CRITICAL is closed.

### Spec Compliance Matrix (backend / PR1 scope)

| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Query timeout/row cap resolved at startup | CLI > env > default; 0 disables; malformed rejected named | `studio-query-resolution.mjs` (13 cases) | ✅ COMPLIANT |
| statement_timeout enforced on both read-only routes | timeout aborts+4xx+pool released; slow table read bounded; writes unaffected | `studio-query-guardrails.mjs` (57014 double tests, both routes) | ✅ COMPLIANT |
| `/api/query` row cap with `truncated` flag | under/over cap; own smaller LIMIT respected; `/api/tables/:name` unaffected | `studio-query-guardrails.mjs` 3.1–3.5, 3.10 | ✅ COMPLIANT |
| Status probe discloses guardrail values | probe echoes exact resolved values, no session (exempt route) | `studio-query-guardrails.mjs` 3.12, **3.15 (new)** | ✅ COMPLIANT |
| Status probe discloses guardrail values — combined with auth-required + no session | `queryTimeoutMs`/`queryRowCap` reflect resolved values with `password` set and no cookie | `studio-query-guardrails.mjs` **3.15 (new, this batch)** | ✅ COMPLIANT — was CRITICAL/UNTESTED in prior pass, now closed |
| No query cancellation introduced (API surface) | no cancel route/`pg_cancel_backend` call in backend diff | source inspection (`studio-server.ts`, `util.ts`) — no such route exists | ✅ COMPLIANT (structural) |
| Transaction-level read-only enforcement (delta, both routes) | CTE-DELETE rejected; plain SELECT + `truncated:false`; `/api/tables/:name` same preamble; writes unaffected; timeout-exceeded on both routes | `studio-query-guardrails.mjs` 3.7–3.14 | ✅ COMPLIANT (see WARNING on CTE scenario specificity below) |

**Compliance summary**: 20/20 backend-scoped scenarios compliant (all covered by a passing
runtime test or, for the "no cancel affordance in API surface" structural half, direct source
inspection — the UI half of that scenario is PR 2 scope, see below).

### Scenarios explicitly deferred to PR 2 (documented, not a gap)

These 3 of the 23 total spec scenarios are frontend-only and correctly out of scope for this
backend PR, tracked as open tasks 5.1–6.5:

| Scenario | Spec source | Tracked as |
|---|---|---|
| Truncated-result banner renders in SQL console | `studio-query-guardrails` domain, "Status probe and console UI disclose both guardrail values" | tasks 5.3/6.3 |
| Named-timeout error message renders with actionable text | same requirement | tasks 5.4/6.3 |
| No cancel affordance anywhere in **UI** (route/button half already confirmed absent in backend) | `studio-query-guardrails` domain, "No query cancellation is introduced" | task 5.5 (static UI assertion) |

Requirements count (7) and scenario count (23) are the full spec totals across all three spec
files; 20/23 scenarios are backend-scoped and compliant, 3/23 are frontend-scoped and correctly
deferred to PR 2. No backend scenario is uncovered.

### Re-confirmed standing findings from pass 1 (unchanged — no production code in this batch)

`git show c2f00fd --stat` confirms this corrective batch touched only a test file and
`tasks.md`. All prior non-CRITICAL findings against `edc2c12`'s production code stand exactly as
reported in verify-report #822:

- **WARNING — fail-open `isCursorEligible` classifier**: `isCursorEligible` (studio-server.ts:161+)
  allow-lists statement shapes (`select`/`with`/`table`/`values`) for the cursor/cap path; any
  unrecognized statement shape falls through to the non-cursor path (row cap not enforced via
  `DECLARE`/`FETCH`). This remains a deliberate design tradeoff per design.md (Postgres's
  read-only transaction is still the mutation guard), not a security hole, but the row cap can be
  bypassed for exotic read shapes the classifier doesn't recognize. Unchanged.
- **WARNING — semantics preservation confirmed, still worth flagging test-only, not schema-level**:
  the user's own smaller `LIMIT` is respected (task 3.4, confirmed passing) and `truncated`
  direction is correct both ways (3.1–3.3) — these are runtime-confirmed again this pass, no new
  issue, restating as still-standing-and-still-passing.
- **WARNING — CTE scenario doesn't pin SQLSTATE or message text**: confirmed again by reading
  `studio-query-guardrails.mjs:217-231` — the check explicitly documents "never asserts SQLSTATE
  or message text", only `res.status === 400` and a non-empty `error` string. This under-specifies
  the contract (any 400 with any message would pass) versus the more precise 57014-double tests
  elsewhere in the same file. Unchanged, still a legitimate looseness.
- **design.md/code agreement on `57014` mapping across both routes**: confirmed `mapTimeoutError`
  (or equivalent, `studio-server.ts:657-665`) is invoked in both `/api/query`'s and
  `/api/tables/:name`'s catch blocks — this was flagged in apply-progress itself as a documented
  deviation from design.md's narrower text ("translated on /api/query only"), reconciled by
  updating design.md. Confirmed both routes still call the same 57014 check; no regression.
- **SUGGESTION — PGlite timeout evidence "adequate but not complete"**: judgment stands. PGlite
  accepts but does not enforce `SET LOCAL statement_timeout` (confirmed in apply-progress,
  unchanged), so the 57014 path is tested via an injected `StudioDb` double (deterministic,
  correct behavior under a real Postgres error shape) rather than a live timeout. The
  `INDIGODB_TEST_DATABASE_URL`-gated real-Postgres suite that could close this gap remains
  unexercised in this environment (unset, prints SKIP). This is adequate proof of the *mapping*
  logic, not proof the *timeout actually fires* against real Postgres. Still a SUGGESTION, not
  blocking.

### Correctness (Static Evidence)

| Requirement | Status | Notes |
|---|---|---|
| Guardrail resolvers pure, throw not `process.exit` | ✅ Implemented | `parseGuardrailInt`/`resolveQueryTimeoutMs`/`resolveQueryRowCap` in `util.ts`; CLI wiring in `index.ts` catches and exits |
| `readOnlyPreamble`/`isCursorEligible` exported and reused by test harness | ✅ Implemented | PGlite adapter in `studio-harness.mjs` reuses the same preamble function (Open Question resolved) |
| 57014 mapped to 400 with guidance on both routes | ✅ Implemented | Deviation from design.md's original narrower text, reconciled |
| Status probe fields additive, independent of auth state | ✅ Implemented | Single unconditional `sendJson` call, confirmed no auth-state branching |

### Coherence (Design)

| Decision | Followed? | Notes |
|---|---|---|
| Both routes share one read-only preamble incl. statement_timeout | ✅ Yes | |
| 57014 → 400 guidance | ⚠️ Broadened | Implemented on both routes, not just `/api/query` as design.md originally stated; design.md updated to match — documented, not a silent deviation |
| No cancellation mechanism introduced | ✅ Yes | Confirmed by source inspection, no such route/handler exists |
| PGlite harness accept-only for statement_timeout | ✅ Yes | Explicitly documented Open Question resolution |

### Issues Found

**CRITICAL**: None. The one CRITICAL from the prior pass is confirmed closed by genuine, verified
test coverage.

**WARNING**:
1. `isCursorEligible` fail-open classifier — unrecognized read shapes skip the cursor/cap path (Postgres read-only transaction remains the safety net; not a new finding, standing from pass 1).
2. CTE-wrapped-DELETE test doesn't pin SQLSTATE or message text — looser than the 57014-double tests in the same file (standing from pass 1).

**SUGGESTION**:
1. Live-Postgres timeout evidence (`INDIGODB_TEST_DATABASE_URL`-gated) remains unexercised in this environment; the mapping logic is well-tested via injected double, but actual `statement_timeout` firing against real Postgres is unproven here (standing from pass 1, explicitly out of scope for this corrective batch per apply-progress).
2. PR 1's authored diff (~901 lines per apply-progress's own `git diff --shortstat`) exceeds the cached 800-line budget. Per the orchestrator's explicit note, this has already been accepted — overage is entirely new test files (33 lines from this corrective batch, all test-only), not a blocking finding here.

### TDD Compliance

| Check | Result | Details |
|---|---|---|
| TDD Evidence reported | ✅ | Found in apply-progress #821, includes an explicit RED→GREEN table for task 3.15 |
| All tasks have tests | ✅ | Backend-scoped tasks (Phases 1–4, 7) all map to test files; independently re-confirmed for 3.15 |
| RED confirmed (tests exist) | ✅ | `studio-query-guardrails.mjs` contains the claimed test; read directly, not trusted from report |
| GREEN confirmed (tests pass) | ✅ | Ran the file directly and the full suite; new test passes both times |
| Triangulation adequate | ✅ | Task 3.15 is a single targeted combination-gap fix, not a multi-scenario requirement — single case is appropriate here |
| Safety Net for modified files | N/A (test-only addition) | No production file was modified in this batch to require a safety net; `git show c2f00fd --stat` confirms |

**TDD Compliance**: 5/5 checks passed (1 N/A, correctly so)

### Assertion Quality

Reviewed the new test block (`studio-query-guardrails.mjs`, the 3.15 addition) directly:
- Asserts 4 distinct fields (`authRequired`, `authenticated`, `queryTimeoutMs`, `queryRowCap`)
  against non-default, specific expected values (`9000`, `250`) — not tautological, not type-only.
- Exercises real production code via a real HTTP request against a real (PGlite-backed) server —
  not a mock-heavy test, 0 mocks used.
- No banned patterns found (no tautologies, no ghost loops, no smoke-test-only assertions).

**Assertion quality**: ✅ All assertions in the reviewed batch verify real behavior.

### Verdict

**PASS WITH WARNINGS**

The single prior CRITICAL (untested spec scenario for guardrail-fields-under-auth-without-session)
is genuinely closed by commit `c2f00fd`, independently confirmed by reading the diff, the test
content, the handler code, and by re-running the test directly and the full suite (18/18 Turbo
tasks, exit 0, zero failures). Backend scope (Phases 1–4, 7 = 33/33 tasks) is complete. Two
WARNINGs and two SUGGESTIONs stand unchanged from pass 1 (all against unmodified production code
in this batch), none of them blocking. PR 2 (frontend, Phases 5–6, 10 open tasks) is out of scope
for this backend verification and correctly documented as deferred, not a gap.
