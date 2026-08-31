# Verification Report: studio-environment-badge (PR 1 of 2 — BACKEND)

**Change**: `studio-environment-badge`
**Scope verified**: Phases 1–2 only (tasks 1.1–1.3, 2.1–2.4). Phases 3–5 (frontend
`AuthStatus`/`useAuthStore` contract, `EnvironmentBadge`, `Header` wiring, final cross-package
verification) are PR 2 scope, deliberately unstarted, and are NOT counted as gaps here.
**Branch**: `feat/studio-environment-badge-1-backend` — commits `e14acd0` (implementation) +
`9e87e64` (spec wording amendment), on `main` @ `370be7d`.
**Mode**: Full artifacts (proposal + specs + design + tasks + apply-progress) available for the
verified scope; Strict TDD active.

## Completeness — Task Checklist (Phases 1–2 only)

| Task | Status | Evidence |
|---|---|---|
| 1.1 RED — `studio-environment-resolution.mjs` | ✅ complete | file exists, 16 assertions, covers design rows 1–13 |
| 1.2 GREEN — `resolveStudioEnvironment` in `util.ts` | ✅ complete | `packages/cli/src/util.ts:317-343` |
| 1.3 GREEN — `--env` CLI wiring in `index.ts` | ✅ complete | resolved after `loadEnv()`, catch→exit(1)→threaded into `startStudio` |
| 2.1 RED — `studio-environment.mjs` probe echo/null/pre-auth | ✅ complete | design rows 14–16 |
| 2.2 RED — non-enforcement suite + Gap A | ✅ complete | design rows 17–18 + Gap A (3 routes) |
| 2.3 GREEN — server/API wiring | ✅ complete | `studio-server.ts`: `StudioOptions.environment`, probe field, startup log line |
| 2.4 — test chain wiring | ✅ complete | `packages/cli/package.json` `test` script includes both new suites |

Phase 3 (3.1–3.4), Phase 4 (4.1–4.5), Phase 5 (5.1): `[ ]` unchecked in `tasks.md` — correctly
unstarted, PR 2 scope. Not flagged.

## Runtime Evidence (executed directly, not trusted from claims)

| Command | Result |
|---|---|
| `pnpm build` (forced, uncached) | ✅ 10/10 tasks successful |
| `pnpm lint` (forced, uncached — `apps/studio` lint is real `tsc -b --noEmit`) | ✅ 19/19 tasks successful |
| `pnpm test` (forced, uncached, full monorepo) | ✅ 18/18 tasks successful, exit 0 |
| `node packages/cli/test/studio-environment-resolution.mjs` (isolated re-run) | ✅ 16/16 checks `ok`, exit 0 |
| `node packages/cli/test/studio-environment.mjs` (isolated re-run) | ✅ 8/8 checks `ok`, exit 0 |

All commands were re-executed in this verification session, not taken from `apply-progress`
claims. No `FAIL` lines observed anywhere.

## Spec Compliance Matrix (backend-scope requirements)

| Spec scenario | Layer | Covering test | Status |
|---|---|---|---|
| Neither set → `null` (resolver) | Unit | row 3 | ✅ PASS |
| Neither set → probe `environment: null` | Integration | "reports environment: null when unset" | ✅ PASS |
| `--env` beats `INDIGODB_ENV` | Unit | row 1 | ✅ PASS |
| `INDIGODB_ENV` used when flag absent | Unit | row 2 | ✅ PASS |
| Each recognised label resolves + reaches probe verbatim | Unit+Integration | rows 4–6, "echoes environment exactly" | ✅ PASS |
| Unrecognised valid label (`qa`) accepted, not thrown | Unit | row 7 | ✅ PASS |
| Case-insensitive recognition, verbatim casing (`Production`) | Unit (backend half only) | row 13 | ✅ PASS — backend correctly stores/returns verbatim; case-fold recognition is UI-side, PR 2 scope (honest split, confirmed) |
| Whitespace trimmed before recognition | Unit | row 12 | ✅ PASS |
| Empty/whitespace-only rejected, names actual source | Unit | rows 8–9 (both `--env` and `INDIGODB_ENV` paths asserted with source-specific regex) | ✅ PASS |
| Over-length rejected; exactly 32 accepted (inclusive boundary) | Unit | row 10 — **both directions present**: 33 throws AND 32 accepted | ✅ PASS |
| Interior control char rejected (newline, tab) | Unit | row 11 (both variants) | ✅ PASS |
| Probe reports `environment` pre-auth, no session | Integration | "answers environment pre-auth" | ✅ PASS |
| Not an enforcement input — writes/readOnly/guardrails unaffected | Integration | row 17 | ✅ PASS |
| **Gap A** — login/authenticated-route/query respond identically with/without `--env` | Integration | 3 paired-request tests (`runPair`, dual-server) | ✅ PASS — genuine identity proof (status + full JSON body diff across two independent servers), not a weaker "no error" assertion |
| `{environment, readOnly:true}` combo — probe reports both, 403 for read-only reason only | Integration | row 18 | ✅ PASS |
| (delta) `environment` field additive on `/api/auth/status`, unaffected by auth config | Integration | pre-auth test + row 17/18 | ✅ PASS |

Frontend-only scenarios (badge rendering, truncation, `EnvironmentBadge` tone map, `Header`
wiring, `useAuthStore`/`AuthStatus` contract, collision regression with `ReadOnlyBanner`) are
correctly out of scope for this PR and untested here — that is PR 2's job, not a PR 1 gap.

## Scrutiny Items (explicitly requested)

1. **Inclusive 32-code-unit boundary**: PROVEN both directions. `studio-environment-resolution.mjs`
   asserts `"a".repeat(33)` throws AND `"a".repeat(32)` is accepted and returned unchanged, in two
   separate `check()` blocks. This is the symmetric pair the epic previously missed — not missed
   here.
2. **Never throws on unrecognised name**: PROVEN. Row 7 asserts `resolveStudioEnvironment("qa",
   undefined)` returns `"qa"` (no throw). The implementation's open label set is real — no closed
   enum, no regression from the amended proposal decision.
3. **Trimming reaches the probe**: PROVEN at the resolver layer (`" staging " → "staging"`, row
   12) and end-to-end is implicit — `startStudio` receives whatever `resolveStudioEnvironment`
   returned and threads it unchanged to the probe (verified by code inspection: no further
   transformation between `index.ts`'s `environment` variable and `studio-server.ts`'s
   `sendJson`). No dedicated integration test sends `INDIGODB_ENV=" production "` through a live
   server and reads the probe, but this is provable by inspection since the value only crosses one
   untransformed assignment (`const environment = options.environment ?? null`). Not a gap given
   the resolver-level proof plus the identity-preserving code path; noted as a **SUGGESTION**, not
   a CRITICAL — a full end-to-end trim assertion would remove even this inference step.
4. **Verbatim casing**: PROVEN both at resolver level (row 13, `"Production"` returned
   `"Production"`) and at the probe (row 18/17 exercise `"production"` lowercase only, but the
   resolver-level proof plus the same untransformed pass-through code path covers the wire
   contract). Same reasoning as (3) — SUGGESTION-level, not blocking.
5. **Non-enforcement / Gap A**: PROVEN, and PROVEN STRONGLY. `runPair` spins up two independent
   real HTTP servers (one with `--env production`, one without) against separate PGlite databases,
   sends the identical request to both, and asserts `status`, cookie presence, and the full
   `JSON.stringify` body are byte-identical. This is a genuine symmetric-identity proof, not a
   weaker "still 200" or "no crash" assertion — it would catch even a subtle change like an extra
   response field or a reordered key that a hash of "still works" would miss (`JSON.stringify` on
   parsed objects is order-dependent for object key insertion order, which matches the server's
   literal `sendJson` call sites — this is an appropriately strict check, not an over-strict
   false-positive risk, since both servers run the identical code path).
6. **Strict TDD honesty**: assessed below.

## TDD Compliance

| Check | Result | Details |
|---|---|---|
| TDD Evidence reported | ✅ | Present in `apply-progress` (#830), both resolver and server/API rows |
| All tasks have tests | ✅ | 5/5 backend-scope tasks (1.1–1.3, 2.1–2.4 collapse to RED/GREEN pairs) have covering test files |
| RED confirmed (tests exist) | ✅ | Both `.mjs` files exist and were independently re-executed |
| GREEN confirmed (tests pass) | ✅ | 16/16 + 8/8 checks pass on fresh re-execution in this session |
| Triangulation adequate | ✅ | Resolver: 16 assertions across 13 design rows (rows 8, 10, 11 each triangulated into 2 cases); server/API: 8 checks across rows 14–18 + 3-route Gap A |
| Safety Net for modified files | ⚠️ | `apply-progress` reports final full-suite green (`pnpm test` 18/18) but does not explicitly report a pre-modification baseline run for `index.ts`/`studio-server.ts` before edits — WARNING, not CRITICAL, since the final full-suite pass is real evidence and no regression exists |

**TDD Compliance**: 5/6 checks fully passed, 1 WARNING (missing explicit pre-edit safety-net record, not a missing safety net in practice).

### Assertion Quality Audit

Scanned both test files line by line.

- No tautologies (`expect(true).toBe(true)` equivalents) — every `check()`/`assert()` calls
  either `resolveStudioEnvironment` directly or drives a real `fetch()` against a live server.
- No ghost loops — no assertions inside `for`/`forEach` over a possibly-empty collection.
- No smoke-test-only patterns — every integration check asserts specific values (`status ===`,
  `environment ===`, `readOnly ===`, exact response bodies), not just "did not throw."
- No implementation-detail coupling (no CSS class or internal-state assertions — this is
  backend-only, N/A by construction).
- No excessive mocking — the integration suite uses a real HTTP server + real (in-process,
  PGlite) Postgres via `withStudio`/`withDatabase`, not mocks; mock/assertion ratio is 0.
- Row 8's two `check()` blocks are a genuine triangulated pair (flag path vs env path), not
  duplicated assertions.

**Assertion quality**: ✅ All assertions verify real behavior. 0 CRITICAL, 0 WARNING.

### Test Layer Distribution

| Layer | Tests | Files | Tools |
|---|---|---|---|
| Unit | 16 | 1 (`studio-environment-resolution.mjs`) | plain Node `assert` |
| Integration | 8 | 1 (`studio-environment.mjs`) | real HTTP (`fetch`) + PGlite-backed `withStudio` harness |
| E2E | 0 | 0 | N/A (no browser/CLI-subprocess layer touched in this PR) |
| **Total** | **24** | **2** | |

### Quality Metrics

**Linter/Type Checker**: ✅ No errors — `pnpm lint` (forced, uncached) 19/19 tasks pass, including
`apps/studio`'s real `tsc -b --noEmit`, confirming this backend-only PR does not (yet) break the
frontend typecheck — expected, since `AuthStatus.environment` is not widened until PR 2.

## Correctness / Design Coherence

| Design decision | Code match | Notes |
|---|---|---|
| `resolveStudioEnvironment` pure, throws (never `process.exit`) | ✅ | `util.ts:317-343` |
| Trim before length/control-char check; NOT case-folded | ✅ | `validateEnvironmentLabel` trims once, returns trimmed verbatim |
| 32-code-unit inclusive bound, C0/DEL rejection | ✅ | exact match to design's decision text |
| Error names only the actual offending source | ✅ | matches spec's `9e87e64` amendment exactly; proven by row 8's source-specific regex assertions |
| Resolved after `loadEnv()`, `--read-only` pattern not `--host` module-load default | ✅ | `index.ts` action body |
| `environment?: string` on `StudioOptions`, `environment: string | null` on wire | ✅ | `options.environment ?? null` |
| Never read by any auth/read-only/guardrail check | ✅ | confirmed by `grep` — only 3 references (option destructure, probe payload, startup log) |
| Startup log line `Environment: <label> | (unset)` | ✅ | present |

No design deviations found in the verified scope.

## Diff Size vs Budget

`git diff --numstat 370be7d..e14acd0 -- packages/cli` totals **492** changed lines (additions +
deletions), not the 629 claimed in `apply-progress` — a WARNING-level reporting discrepancy in the
apply artifact, not a code defect. Both figures are comfortably under the 800-line budget for this
PR slice, so this does not change the verdict.

## Issues

### CRITICAL
None.

### WARNING
1. `apply-progress`'s reported diff line count (629) does not match the actual `git diff --numstat`
   total for `packages/cli` (492). Both are well under the 800-line PR budget; this is a reporting
   accuracy issue in the apply artifact, not a code or test defect.
2. `apply-progress`'s TDD Cycle Evidence table does not explicitly record a pre-modification
   safety-net run for the two modified files (`index.ts`, `studio-server.ts`) before Phase 1/2
   edits — only the final full-suite green is reported. Not a functional gap (the final suite is
   real, independently re-executed evidence), but the explicit pre-edit baseline step described in
   Strict TDD verify guidance was not itemized.

### SUGGESTION
1. No dedicated integration test sends a value through `INDIGODB_ENV` with surrounding whitespace
   or mixed casing through a *live server* to the probe — trimming/verbatim-casing end-to-end
   coverage is currently resolver-level plus code-path inspection (the value crosses exactly one
   untransformed assignment between resolution and the wire). A future PR could add one live-server
   round-trip test for `" production "` / `"Production"` to remove even this inference step, though
   it is not required to close a real gap.

## Verdict

**PASS** — 0 CRITICAL, 2 WARNING (both non-blocking reporting-accuracy items), 1 SUGGESTION.

Backend scope (Phases 1–2, tasks 1.1–1.3 and 2.1–2.4) is complete, spec-compliant, and covered
by re-executed passing runtime tests. `pnpm build`, `pnpm lint`, and `pnpm test` all pass with a
real, forced (uncached) run across the full monorepo. The five scrutiny items from the
orchestrator brief are all satisfied: the inclusive-boundary pair is proven both directions, the
open-label-set behavior is proven, trimming and verbatim casing are proven at the resolver layer
with a traceable pass-through code path to the wire, and Gap A's non-enforcement claim is proven
by a genuine dual-server identical-response comparison rather than a weaker "still works"
assertion. No scenario in the backend's spec scope was found without a covering, currently-passing
runtime test.
