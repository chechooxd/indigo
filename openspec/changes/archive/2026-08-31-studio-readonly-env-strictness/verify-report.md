```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:c6dfdb79ad143b89750a189dc25710dbb266544fb6615510e23e607574ae6235
verdict: pass
blockers: 0
critical_findings: 0
requirements: 1/1
scenarios: 7/7
test_command: pnpm test
test_exit_code: 0
test_output_hash: sha256:877350dc4569a3ec6f6ae60d2df4f57b4fa800c215b14a710d1da98b1d0a15ba
build_command: pnpm build
build_exit_code: 0
build_output_hash: sha256:edd48599fa209a7d5d898053944fd1a6feea5f9e53f781dd3a626e4275a08717
```

## Verification Report

**Change**: studio-readonly-env-strictness
**Version**: commit `c75c7e2` on branch `fix/studio-readonly-env-strictness`, off `main`
**Mode**: Strict TDD

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total | 22 |
| Tasks complete | 22 |
| Tasks incomplete | 0 |

Counted directly with `rg -c "^\- \[x\]"` / `rg -c "^\- \[ \]"` against `tasks.md`: 22 checked, 0 unchecked.

Diff stat independently reproduced (`git diff --numstat main c75c7e2`): `index.ts` +13/-7, `util.ts`
+28/-19, `studio-readonly-resolution.mjs` +111/-37 → **215 insertions / 63 deletions**, matching the
apply-progress claim exactly. Well under the 800-line review budget for this change.

### Build & Tests Execution

**Build**: ✅ Passed
```text
$ pnpm build
 Tasks:    10 successful, 10 total
Cached:    10 cached, 10 total
```

**Lint**: ✅ Passed
```text
$ pnpm lint
 Tasks:    19 successful, 19 total
Cached:    19 cached, 19 total
```
(`tsc --noEmit` across all 19 packages — this is the mechanism that would have caught a stray
`isReadOnlyEnv` import anywhere in the workspace; it stayed clean.)

**Tests**: ✅ 18/18 package test tasks passed, exit 0
```text
$ pnpm test
 Tasks:    18 successful, 18 total
Cached:    18 cached, 18 total
```
`@indigodb/cli`'s chain includes `studio-readonly-resolution.mjs`, confirmed by direct grep of the
log: `cli resolveStudioReadOnly: all green` — **23/23 checks passed**. Also ran the file standalone
outside the cached Turbo run to get uncached, real-time confirmation:
```text
$ node packages/cli/test/studio-readonly-resolution.mjs
... (23 "ok" lines) ...
cli resolveStudioReadOnly: all green
EXIT=0
```

**Independent end-to-end reproduction** (built CLI, empty temp cwd, no schema/`.env`):
```text
$ INDIGODB_STUDIO_READONLY=yes indigodb studio
❌ INDIGODB_STUDIO_READONLY must be "1", "0", "true", or "false", got: "yes"
exit=1

$ INDIGODB_STUDIO_READONLY=yes indigodb studio --read-only
❌ INDIGODB_STUDIO_READONLY must be "1", "0", "true", or "false", got: "yes"
exit=1   ← flag does NOT suppress the malformed-env error

$ INDIGODB_STUDIO_READONLY=false indigodb studio
❌ Schema file not found: .../schema.indigo   (validation passed, failed later for unrelated reason)
exit=1

$ INDIGODB_STUDIO_READONLY=1 indigodb studio
❌ Schema file not found: .../schema.indigo   (validation passed, failed later for unrelated reason)
exit=1
```
This matches the orchestrator-supplied evidence byte-for-byte and was reproduced independently, not
taken on faith.

**Coverage**: ➖ Not available (no coverage tool wired into `@indigodb/cli`'s plain-Node test chain)

### Spec Compliance Matrix

Spec: `openspec/changes/studio-readonly-env-strictness/specs/studio-readonly-mode/spec.md`
(1 MODIFIED requirement, 7 scenarios — read from disk, not from the stale Engram copy).

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| Read-only flag resolved once at startup | Default preserves existing write behavior | `studio-write.mjs`, `studio-auth.mjs`, `studio-auth-preflight.mjs` (unmodified, ran green in full suite) | ✅ COMPLIANT |
| ″ | CLI flag or exact-match "on" env values enable read-only mode | `studio-readonly-resolution.mjs`: `(undefined,"1")→true`, `(undefined,"true")→true`, `(true,undefined)→true` | ✅ COMPLIANT |
| ″ | Exact-match "off" env values keep read-only disabled | same file: `(undefined,"0")→false`, `(undefined,"false")→false` | ✅ COMPLIANT |
| ″ | Unset env var and no flag leaves read-only off | same file: `(undefined,undefined)→false` | ✅ COMPLIANT |
| ″ | Malformed env values cause a loud startup failure | same file: 7-value rejection loop (`TRUE`,`True`,`yes`,`""`,`" 1 "`,`1.0`,`on`) + 2 message-content checks + `spawnSync` wiring check (real process, exit 1, stderr matches) | ✅ COMPLIANT — verified end-to-end, both unit and process level |
| ″ | The CLI flag adds read-only but never suppresses env validation (positive direction) | same file: `(false,"1")→true` (env still enables with flag explicitly false); `(true,undefined)→true` | ✅ COMPLIANT |
| ″ | A malformed env value is rejected even when the flag is passed | same file: `(true,"yes")→throws` (unit); independently reproduced at process level with `--read-only` flag (see evidence above) | ✅ COMPLIANT |

**Compliance summary**: 7/7 scenarios compliant.

### Correctness (Static Evidence)

| Requirement | Status | Notes |
|------------|--------|-------|
| Env branch resolved before flag OR (no short-circuit trap) | ✅ Implemented | `util.ts` diff shows `envReadOnly` computed into a local first via `if/else if/else throw`, **then** `return optionReadOnly === true \|\| envReadOnly`. Confirmed by direct diff read, not claim. |
| Resolver stays pure, never calls `process.exit` | ✅ Implemented | Only `throw new Error(...)`; no `process.exit` in `util.ts`. |
| Resolver call moved inside `index.ts`'s try/catch | ✅ Implemented | Diff shows `readOnly` declared as `let` before the `try`, assigned as the **first** line inside it, ahead of `queryTimeoutMs`/`queryRowCap`/`environment`/`auditLog`. Previously it sat entirely outside the try block. |
| `isReadOnlyEnv` fully deleted | ✅ Implemented | `rg -n "isReadOnlyEnv"` across the repo (excluding `.git`, `node_modules`) returns zero production hits — only: (a) this change's own SDD artifacts describing the removal, (b) 3 already-archived change folders documenting prior history, (c) the test file's own negative assertion (`strictEqual(m.isReadOnlyEnv, undefined)`) and a historical doc-comment line. No `apps/studio` reference exists, confirming point 4 of the scrutiny list. |
| `--read-only` help text updated | ✅ Implemented | Names all four accepted values and the reject-and-exit behavior. |
| Error message shape | ✅ Implemented | `` `INDIGODB_STUDIO_READONLY must be "1", "0", "true", or "false", got: ${JSON.stringify(envValue)}` `` — matches design verbatim, `JSON.stringify` makes `""` / `" 1 "` distinguishable. |

### Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| `isReadOnlyEnv` removed, not retyped/renamed | ✅ Yes | Deleted outright; folded into `resolveStudioReadOnly`'s env branch. |
| Rejection message mirrors `resolveStudioAuditLog`, value echoed via `JSON.stringify` | ✅ Yes | Byte-identical shape confirmed in diff. |
| Malformed env fails even when `--read-only` passed (no short-circuit) | ✅ Yes | Both the unit test (`(true,"yes")→throws`) and my independent process-level reproduction confirm this. This was the single highest-risk implementation trap called out in design, and it did not ship broken. |
| Signature unchanged (`(boolean\|undefined, string\|undefined) => boolean`, now throwing) | ✅ Yes | No signature change; `index.ts` call site needed no new argument. |
| Test Migration Plan (24→23 checks, `"0"`/`"false"` become accepted-disable, 7 others become rejections) | ✅ Yes | See "Test Migration Audit" below — independently recounted, nothing lost. |
| Row 16 wiring test: new `spawnSync` pattern, run in empty temp cwd | ✅ Yes | Confirmed present, confirmed it passes, confirmed (via apply-progress + my own reproduction) that it is a genuine regression detector for "call sits outside the try/catch" — see Wiring Test Audit below. |

### Test Migration Audit (proposal vs. design vs. shipped)

The proposal claimed a blanket "flip every malformed check from → false to → throws." Design's Test
Migration Plan table correctly overrode this for `"0"`/`"false"`. I recounted the actual old and new
test files independently rather than trusting either document:

**Old file** (`git show main:packages/cli/test/studio-readonly-resolution.mjs`), distinct malformed
values across both loops (deduplicated): `TRUE`, `True`, `yes`, `0`, `false`, `""`, `" 1 "`, `1.0`,
`on` — **9 distinct values**, `24` total checks (3 positives + 9 `isReadOnlyEnv` malformed + 6 combos
+ 6 `resolveStudioReadOnly` malformed, with overlap between the two malformed loops).

**New file**: same 9 distinct values are still present. `0`/`false` → 2 accepted-disable checks
(`→ false`, same expectation as before, correct per design). The remaining 7 (`TRUE`, `True`, `yes`,
`""`, `" 1 "`, `1.0`, `on`) → 1 merged rejection loop (`→ throws`). **Zero values dropped.**
23 total checks (3 positive + 2 accepted-disable + 7 rejection-loop + 2 message-content + 6 combo +
1 flag-never-suppresses + 1 isReadOnlyEnv-absence + 1 wiring) = 23, matching apply-progress's
"22 resolver + 1 wiring" claim (22 resolver-level + 1 wiring = 23; the report's own summary line
undercounts by one relative to its own math, but the file itself and the executed run both show 23
"ok" lines — verified directly, not from the report's prose).

**Conclusion**: the proposal's blanket claim was correctly overridden by design and correctly
implemented. No near-miss coverage was lost in the migration.

### Wiring Test Audit (Scrutiny point 3)

- This is a genuinely new pattern for `packages/cli/test` — confirmed no other file in that
  directory uses `spawnSync` against the built CLI (only this one does, per its own header comment
  and my own read of the file).
- The RED-story claim ("`❌ Schema file not found...` instead of the env-validation message, proving
  the call was outside the try") is architecturally consistent with the diff: before the change, the
  call sat as a `const` statement fully outside the `try` block, so a throw there would have been an
  *uncaught exception* — Node would print a stack trace and exit with a non-1 status or a different
  message shape entirely, not the clean `❌ Schema file not found` message (which comes from a
  **different**, later, in-`try` resolver — `loadSchema`). I did not re-run the RED state myself
  (that would require reverting the fix), but the diff structure makes the reported RED behavior
  plausible and internally consistent, and apply-progress's TDD Cycle Evidence table records it
  directly. This is accepted as documented TDD evidence, not independently re-derived.
- Would this test catch a regression where someone moves the call back outside the try/catch? Yes —
  if `readOnly = resolveStudioReadOnly(...)` moved back outside the try, an uncaught `Error` thrown
  during module-level command action execution in commander would propagate up rather than being
  caught and turned into a clean `console.error` + `process.exit(1)`. The `spawnSync` check asserts
  both `status === 1` **and** `stderr` matches `/INDIGODB_STUDIO_READONLY/` — an uncaught exception
  would very likely produce `status` other than exactly `1` (Node's uncaught-exception exit code is
  typically 1 as well, actually, so the `status === 1` assertion alone would NOT distinguish clean
  exit from a crash) — but the **stderr content assertion** would still likely differ (an uncaught
  exception prints a full stack trace with `Error: INDIGODB_STUDIO_READONLY must be...` at the top,
  which *would* still match the regex `/INDIGODB_STUDIO_READONLY/`). This means the test's
  regression-catching power for "moved back outside try/catch" specifically is weaker than it looks
  at first glance — both a clean catch and an uncaught throw would likely produce stderr matching
  that regex and exit status 1 in Node. This is a real, if narrow, gap: it strongly proves "env
  validation happens before Studio does anything else," but proves less about "the throw is caught
  cleanly rather than crashing" than its own comment claims. Flagged as WARNING below.

### Assertion Quality

All 23 checks in `studio-readonly-resolution.mjs` call `resolveStudioReadOnly` (or spawn the real
CLI) and assert a distinct value via `strictEqual`/`throws`. No tautologies, no orphan empty checks
without a companion, no ghost loops (the malformed-value loop is over a fixed, non-empty literal
array, and each iteration registers an independent `check()` call — not a single assertion inside a
loop over a runtime-derived collection that could be empty). No smoke-test-only patterns, no
CSS/implementation-detail coupling, no mocks.

**Assertion quality**: ✅ All assertions verify real behavior

### TDD Compliance
| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | Present in apply-progress #845, with a full TDD Cycle Evidence table |
| All tasks have tests | ✅ | 22/22 tasks map to concrete checks in `studio-readonly-resolution.mjs` |
| RED confirmed (tests exist) | ✅ | Test file exists, read in full, contents match apply-progress's description |
| GREEN confirmed (tests pass) | ✅ | 23/23 checks pass on independent re-run (both cached Turbo run and standalone re-run) |
| Triangulation adequate | ✅ | 7-value rejection loop, 2 accepted-disable, 3 positive, 6 combo, 1 flag-override, 1 export-absence, 1 wiring — well beyond single-case per behavior |
| Safety Net for modified files | ✅ | `util.ts`/`index.ts` are modifications of existing, already-tested files; the full `pnpm test` run (which includes every pre-existing `@indigodb/cli` suite) is the safety net and it passed 18/18 |

**TDD Compliance**: 6/6 checks passed

### Test Layer Distribution
| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | 22 | 1 (`studio-readonly-resolution.mjs`) | plain Node `assert` |
| Integration | 0 | 0 | — |
| E2E (process-level) | 1 | 1 (same file, `spawnSync` check) | `node:child_process` |
| **Total** | **23** | **1** | |

### Changed File Coverage
Coverage analysis skipped — no coverage tool detected in `@indigodb/cli`'s plain-Node test chain.

### Quality Metrics
**Linter**: ➖ Not applicable as a standalone linter (this repo's "lint" is `tsc --noEmit`, reported above under Build & Tests — clean, 19/19 packages)
**Type Checker**: ✅ No errors (`pnpm lint` = `tsc --noEmit` across the workspace, clean)

### Issues Found

**CRITICAL**: None.

**WARNING**:
1. The `spawnSync` wiring test (Task 3.1, design row 16) asserts `status === 1` and
   `stderr` matches `/INDIGODB_STUDIO_READONLY/`, but Node's default uncaught-exception exit code
   is also `1`, and an uncaught `Error` thrown outside the try/catch would still print
   `Error: INDIGODB_STUDIO_READONLY must be...` to stderr as part of its stack trace — which would
   also satisfy the regex. This means the test proves "validation happens before binding" solidly,
   but its power to specifically catch a future regression of "the call moved back outside the
   try/catch" (clean catch vs. uncaught crash) is narrower than its own header comment implies. A
   tighter assertion (e.g. `stderr` must NOT contain `at resolveStudioReadOnly` / a JS stack trace,
   or must start with the literal `❌ ` prefix `index.ts`'s catch block uses) would close this gap.
   Not blocking — the test still correctly proves the core spec requirement (exit non-zero before
   binding, message names the variable), and this was already the design's own explicitly documented
   choice of assertion shape.

**SUGGESTION**:
1. The `(true,"yes")→throws` unit check (Task 1.7) proves the resolver itself never suppresses a
   malformed env under the flag, but the `spawnSync` wiring test only exercises the no-flag case. A
   second `spawnSync` variant with `["studio", "--read-only"]` plus a malformed env would give
   process-level (not just unit-level) proof of scrutiny point 7 as well. I reproduced this
   end-to-end manually during this verification and it holds, but it is not part of the permanent
   regression suite.
2. `apply-progress`'s own summary line ("22 resolver + 1 wiring") is arithmetically consistent
   (22+1=23) — no correction needed here; flagged only because my first read momentarily
   miscounted it as "23 resolver + 1 wiring." No action needed.

### Verdict

**PASS WITH WARNINGS**

Both halves of every symmetric pair are covered (on/off, accepted/rejected, flag-alone/env-alone/
combo, flag-with-valid-env/flag-with-malformed-env). The short-circuit trap was avoided (env
resolved into a local before the OR). The throw is genuinely wired inside the try/catch and
verified end-to-end, independently reproduced with real process spawns, including with the
`--read-only` flag present. `isReadOnlyEnv` has zero remaining production references. The Test
Migration Plan was followed correctly (not the proposal's incorrect blanket claim), with zero
near-miss values lost — independently recounted. `pnpm build`, `pnpm lint`, and `pnpm test` are
all green (exit 0), and the migrated test file passed 23/23 both inside the cached workspace run
and re-run standalone. The only issue found is a WARNING about the precision of one regression
assertion in the new `spawnSync` wiring test — it still correctly proves the spec's actual
requirement, so it does not block archive.
