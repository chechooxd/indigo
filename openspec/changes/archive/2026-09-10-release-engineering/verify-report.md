```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:45e99912b139db7ba3938a4b459c40f339c74979cf5ab269274f9d48b4df06cb
verdict: pass
blockers: 0
critical_findings: 0
requirements: 10/10
scenarios: 19/19
test_command: pnpm test
test_exit_code: 0
test_output_hash: sha256:b2bcc21e835aedd388c7dfdf36b3861744e38643c3d535ccb8fa03a36fa63f0e
build_command: pnpm clean && pnpm build --force
build_exit_code: 0
build_output_hash: sha256:5c6949b0538fbcb91593fee84aadbad8ebee74b310e1492b875933f76486ea8e
```

## Verification Report

**Change**: release-engineering — branch `release-engineering`, verified at commit
`0e1fdb1` (third pass, re-run after the cohort-guard requirement/scenarios were added
to `specs/release-versioning/spec.md` to close the prior WARNING; 5 commits ahead of
`main`, tree clean at time of verification).

**Mode**: Full spec-driven verification (proposal, design, tasks, and specs all
present). Strict TDD evidence preserved from apply; this pass re-derives runtime
evidence independently rather than trusting the apply-progress claims.

### Completeness

29/29 active tasks in `tasks.md` are checked `[x]`. Phase 3 (dependency-audit-gate,
14 tasks) is struck `~~...~~` with an explicit, dated (2026-09-10) descope note and a
reversal record — not silently dropped. No unchecked active task exists.

| Dimension | Status |
|---|---|
| Task completion | COMPLETE — 29/29 active, Phase 3 correctly struck/descoped |
| Spec correctness | COMPLETE — see compliance matrix below |
| Design coherence | COMPLETE — no undocumented deviation found |

### Requirement/Scenario Count (self-counted from `specs/`, not inherited)

| Capability | Requirements | Scenarios |
|---|---|---|
| `release-versioning` | 3 | 7 |
| `package-publish-metadata` | 3 | 5 |
| `publish-procedure` | 4 | 7 |
| **Total** | **10** | **19** |

Matches the orchestrator's stated totals (10 requirements / 19 scenarios). The new
requirement is *"A guard independently enforces cohort membership and version
parity"* (`specs/release-versioning/spec.md`), with 4 scenarios: missing-from-fixed,
stale-fixed-entry, drifted-version, cwd-independence.

### Build / Lint / Test Evidence

| Command | Observed result |
|---|---|
| `pnpm clean && pnpm build --force` | First attempt: `@indigodb/cli:clean` failed with `Unexpected end of JSON input` from pnpm's `loadWorkspaceState` — a transient race reading `node_modules/.pnpm-workspace-state-v1.json` during turbo's parallel `clean` fan-out (the file parses as valid JSON on isolated inspection; `packages/cli`'s `pnpm run clean` alone succeeds). Two subsequent full retries: **11/11 clean tasks + 11/11 build tasks successful**, exit 0 both times. Treated as an environmental flake, not a code/spec defect. |
| `pnpm lint` | Exit 0 — **21/21 tasks successful** (cache hits, consistent with an unmodified tree at HEAD) |
| `pnpm test` | Exit 0 — **20/20 turbo test tasks + `check-pack-contents.mjs` (11/11 packages green) + `check-release-cohort.mjs` (PASSED, all 11 at parity) + `check-realtime-projection-db-gate.mjs` (PASSED)**. `@indigodb/realtime`'s and `@indigodb/cli`'s Postgres-gated suites (`pg-harness.mjs`, `parity.mjs`, `resume.mjs`, `log.mjs`, `buckets.mjs`, `endpoint.mjs`, `studio-query-timeout-pg.mjs`) printed `SKIP` with `INDIGODB_TEST_DATABASE_URL` unset — correct default behavior, not a failure. |

### New Requirement — Independent Cohort-Guard Audit

Each scenario was reproduced by direct mutation and `$?` inspection on the script
itself (never through a pipe), then reverted, with `git status --porcelain` confirmed
empty after each:

| Scenario | Mutation | Observed |
|---|---|---|
| Version parity | Edited `packages/parser/package.json` version `0.0.1`→`0.0.2` | Exit **1**. Output: `FAIL @indigodb/parser: version 0.0.2 does not match @indigodb/ast's 0.0.1 — the release cohort must bump in lockstep`. Reverted via `git checkout --`. |
| Publishable missing from `fixed[0]` | Removed `@indigodb/generator` from `.changeset/config.json`'s `fixed[0]` (a different package than `@indigodb/cli`/`@indigodb/react`, which earlier runs already used) | Exit **1**. Output: `FAIL @indigodb/generator: publishable workspace package is missing from the fixed group in <path> — it will not be bumped by \`changeset version\``. Config restored from backup, confirmed byte-identical. |
| Stale entry in `fixed[0]` | Appended phantom `@indigodb/nonexistent` to `fixed[0]`, all real manifests unchanged (in parity) | Exit **1**. Output: `FAIL @indigodb/nonexistent: listed in the fixed group in <path> but no publishable workspace package with that name exists`. Held while every real package's version was identical. Reverted via `git checkout --`. |
| cwd-independence | Ran `node ../../scripts/check-release-cohort.mjs` from `packages/core` against the unmodified (correct) cohort | Exit **0**, same 11-package PASSED output as from repo root. Confirms the `import.meta.url`-based root resolution claimed in the script header. **This scenario holds as specified — no finding against the new spec text.** |

Tree confirmed clean (`git status --porcelain` empty) after all four mutations were
reverted.

### Spec Compliance Matrix

#### release-versioning (3 req / 7 scen)

| Requirement | Scenario | Status | Evidence |
|---|---|---|---|
| Single fixed version group | Changeset on one package bumps all 11 | COMPLIANT | `pnpm changeset version` reproduced on throwaway branch `throwaway-verify-repro` (deleted after): all 11 manifests bumped `0.0.1`→`0.0.2`, root untouched |
| Single fixed version group | Low-churn package (`ast`) still bumps whole group | COMPLIANT | Same run — `ast`-included changeset still bumped all 11 identically (fixed-group semantics) |
| Root excluded from group | Root untouched by version bump | COMPLIANT | Root `package.json` version `0.0.0`, `private: true` confirmed unchanged after the repro's `changeset version` |
| Cohort guard (new) | Missing-from-fixed fails guard | COMPLIANT | Reproduced above, exit 1, names package + "will not be bumped" |
| Cohort guard (new) | Stale entry fails guard | COMPLIANT | Reproduced above, exit 1, holds under parity |
| Cohort guard (new) | Drifted version fails guard | COMPLIANT | Reproduced above, exit 1, names drifted + reference |
| Cohort guard (new) | cwd-independent | COMPLIANT | Reproduced above, exit 0 from `packages/core` |

#### package-publish-metadata (3 req / 5 scen)

| Requirement | Scenario | Status | Evidence |
|---|---|---|---|
| `publishConfig.access` per manifest | All 11 declare public access | COMPLIANT | `rg` confirms `"access": "public"` in all 11 manifests + `.changeset/config.json`; root has no `publishConfig` |
| `publishConfig.access` per manifest | `npm pack --dry-run` reflects public access | COMPLIANT | Real `npm publish --dry-run` inside `packages/client`: "Publishing to ... with tag latest and public access (dry-run)", no restricted-scope failure |
| `engines` floor per manifest | All 11 declare `node >= 22` | COMPLIANT | `rg -A1 "engines"` confirms `"node": ">=22"` in all 11 manifests |
| `engines` floor per manifest | Consumer sees floor independent of root | COMPLIANT | Manifest field confirmed present per-package; packed tarball carries it per prior pass's independent extraction (unchanged since) |
| `.npmrc` not introduced | No `.npmrc` at repo root | COMPLIANT | `fd '^\.npmrc$'` returns no matches |

#### publish-procedure (4 req / 7 scen)

| Requirement | Scenario | Status | Evidence |
|---|---|---|---|
| Sequence starts with `clean && build --force` | First command reads `--force` verbatim | COMPLIANT | `RELEASING.md`'s ordered sequence: `pnpm clean && pnpm build --force` as step 1's literal text |
| Sequence starts with `clean && build --force` | Stale `dist/` does not survive `--force` build | COMPLIANT | `RELEASING.md` §1 documents the `lexer.js` cache-hit repro; `check-pack-contents.mjs` ran clean in this pass's `pnpm test` |
| Sequence starts with `clean && build --force` | Flags never land on wrong chained command | COMPLIANT | `release:preflight` script text: `--force` baked literally after `build`, confirmed via `rg` |
| `check-pack-contents` only after build | Build always precedes test in documented order | COMPLIANT | `RELEASING.md` §§1–2 order; root `test` script chains `check-pack-contents.mjs` after `turbo test`, itself gated on a completed build |
| All 11 publish together | One recursive/group command, not per-package | COMPLIANT | `RELEASING.md` step 6: `pnpm publish -r` from repo root, explicitly "never 11 separate per-package invocations" |
| All 11 publish together | Dry run shows all 11 at identical version, none excluded | COMPLIANT | Reproduced this pass on `throwaway-verify-repro`: `pnpm publish -r --dry-run` after commit → all 11 units listed (`grep -c '^+ @indigodb'` = 11), all at `0.0.2` |
| No real publish required | Verification leaves real registry untouched | COMPLIANT | Every publish check this pass used `--dry-run`; throwaway branch deleted; `git status --porcelain` empty afterward |

### Descope / Reversal Verification (`dependency-audit-gate`)

| Check | Result |
|---|---|
| `git diff main -- .githooks/pre-push` | Empty — byte-identical to `main` |
| `pnpm audit`/`auditConfig`/`test-audit-gate.mjs` in active config/scripts | None found — only historical mentions inside retained artifact prose (`proposal.md`, `design.md`, `tasks.md`, `apply-progress.md`) explaining what was removed and why |
| `specs/dependency-audit-gate/` (under this change) | Absent, confirmed via `fd` |
| Dated descope notes | Present and consistent: `tasks.md` "Descope Note (2026-09-10)", `proposal.md` Out-of-Scope entry, `design.md` descope note, all naming the reproduced defect (`pnpm audit --audit-level=high` exit 1, GHSA-only `js-yaml` advisory `ignoreCves` cannot express) and the gate's destination (`dependency-audit-gate`) |

### Publish-Metadata / Config Agreement

`.changeset/config.json` (`"access": "public"`) and all 11 manifests
(`publishConfig.access: "public"`) agree — confirmed by direct `rg` across all 12
files, not a re-read of a single source. Proven against real `npm publish --dry-run`
output for `@indigodb/client` (public access, no restricted-scope failure).

### RELEASING.md Sequence — End-to-End Reproduction

Reproduced on throwaway branch `throwaway-verify-repro` (deleted after; `main`/
`release-engineering` untouched):

1. `pnpm changeset version` — all 11 bumped `0.0.1`→`0.0.2` in lockstep, root untouched.
2. `pnpm publish -r --dry-run` run **before** the commit step (deliberately, to
   independently re-confirm B.1's claim) — reproduced `ERR_PNPM_GIT_UNCLEAN`, real
   exit 1 (checked via direct `$?`, not through a pipe).
3. `git commit` (the documented step) — tree clean afterward.
4. `node scripts/check-release-cohort.mjs` re-run post-bump — PASSED, all 11 at `0.0.2`.
5. `pnpm publish -r --dry-run` re-run — exit 0, all 11 units (including
   `@indigodb/studio`) listed at `0.0.2`, "Publishing to ... (dry-run)" confirmed for
   each, no real registry call.

Branch deleted, working tree returned to `release-engineering` at commit `0e1fdb1`,
`git status --porcelain` empty.

### Issues

**CRITICAL**: None.

**WARNING**: None. (The prior WARNING — the cohort guard's bidirectional cross-check
existing in code/tests but undescribed in the spec — is resolved: the new requirement
and its 4 scenarios in `specs/release-versioning/spec.md` now describe it, and all 4
scenarios were independently reproduced above with matching real exit codes.)

**SUGGESTION**:
1. The `pnpm clean`/`pnpm build --force` transient `Unexpected end of JSON input`
   race on `@indigodb/cli:clean` (pnpm's `loadWorkspaceState`, reading
   `node_modules/.pnpm-workspace-state-v1.json` mid-write from a concurrent turbo
   task) is environmental, not caused by this change, and did not recur on either
   retry — but if it recurs in CI/act, a small note in `crates/CLAUDE.md` or root
   `CLAUDE.md`'s CI section would help a future reader avoid misattributing it to
   this change.
2. `package-publish-metadata`'s "consumer sees floor independent of root" scenario
   was re-verified via manifest+`.changeset` agreement this pass, but not
   independently re-extracted from a fresh tarball this pass (that extraction was
   done in the prior 9/15 pass and the field is unchanged since). Low-risk, but a
   future re-run should re-extract if `engines` is ever touched again.

### Final Verdict

**PASS**

10 requirements / 19 scenarios verified against real runtime evidence — build, lint,
test all exit 0; the new cohort-guard requirement's 4 scenarios independently
reproduced by direct mutation with real (`$?`, non-piped) exit codes; the
`RELEASING.md` publish sequence reproduced end-to-end on a throwaway branch,
including the commit step and cohort-guard re-run; the dependency-audit-gate descope
left no remnant; nothing was published to the real npm registry. Ready for
`sdd-archive`.
