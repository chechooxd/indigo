```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:c083d85f34930ba0458ffdbc99b2340169222031783ba56146c107f437570ae7
verdict: pass
blockers: 0
critical_findings: 0
requirements: 9/9
scenarios: 15/15
test_command: pnpm test
test_exit_code: 0
test_output_hash: sha256:70a8ed9d1994004c3c291837ca61b8f8df4ac6ce5d6c21b0be4b7e5fc012bc50
build_command: pnpm clean && pnpm build --force
build_exit_code: 0
build_output_hash: sha256:e6408cba777a2af21b83c958d220967f548d770e1db10e090bf98ca280b9a654
```

## Verification Report

**Change**: release-engineering (re-run after audit-gate descope)
**Version**: N/A
**Mode**: Strict TDD

This report supersedes and replaces the prior `verify-report.md`, which validated four
capabilities (including `dependency-audit-gate`). That gate was descoped 2026-09-10 after a
`/code-review` pass proved it blocks every push on this repo. This verification independently
re-scores the three remaining capabilities only.

### Descope Completeness Check

| Check | Result |
|---|---|
| `git diff main -- .githooks/pre-push` | Empty — byte-identical to `main` |
| `pnpm audit` reference in `.githooks/pre-push` | None (`rg` exit 1) |
| `scripts/test-audit-gate.mjs` | Deleted, absent |
| `pnpm.auditConfig` in root `package.json` | Absent (`rg` exit 1) |
| `openspec/changes/release-engineering/specs/dependency-audit-gate/` | Deleted, absent |
| `RELEASING.md` audit references | None (`rg -i audit` exit 1) |
| Deliberate descope notes present | Yes — `tasks.md:3-13,176`, `proposal.md:27-40,52-53`, `design.md:11-18,167`, `apply-progress.md:11-93` all name what was removed, the reproduced defect (`pnpm audit --audit-level=high` exit 1, 15 high advisories, `js-yaml` GHSA-only advisory the `ignoreCves` valve cannot express), and where the gate is going (`dependency-audit-gate`). |

Descope is complete and honestly recorded. No half-wired remnant found.

### Completeness (Tasks)

| Metric | Value |
|--------|-------|
| Tasks total (all phases, incl. struck) | 34 |
| Tasks checked `[x]` | 20 |
| Tasks unchecked `[ ]` | 14 — all are struck-through (`~~...~~`) Phase 3 tasks (dependency-audit-gate), deliberately descoped with a reversal record, not abandoned in-progress work |
| Active-scope tasks complete | 20/20 |

The 14 unchecked items are the entirety of Phase 3 and only Phase 3; every task in Phases 1, 2,
4, 5 (the three remaining capabilities) is checked. Consistent with `apply-progress.md`'s
"29/29 active tasks complete" claim adjusted for this report's own recount (20 active, since
this report does not inherit apply's count).

### Build & Tests Execution — independently reproduced, not inherited

**Build**: ✅ Passed
```text
$ pnpm clean && pnpm build --force
Tasks: 11 successful, 11 total (clean)
Tasks: 11 successful, 11 total (build)
```

**Lint**: ✅ Passed
```text
$ pnpm lint
Tasks: 21 successful, 21 total
```

**Tests**: ✅ Passed
```text
$ pnpm test
Tasks: 20 successful, 20 total
workspace pack-contents guard: all green (11/11 packages)
release cohort version-parity guard: PASSED (11/11 packages, all 0.0.1, cross-check clean)
check-realtime-projection-db-gate: PASSED
@indigodb/realtime Postgres-gated suites (pg-harness.mjs, parity.mjs, resume.mjs, log.mjs,
  buckets.mjs, endpoint.mjs): SKIP — INDIGODB_TEST_DATABASE_URL unset (correct, not a failure)
Overall exit code: 0
```

**Coverage**: Not available — this repo has no coverage tooling wired; not a gap introduced by
this change.

### Spec Compliance Matrix

**release-versioning** (2 requirements, 3 scenarios)

| Requirement | Scenario | Test / Evidence | Result |
|---|---|---|---|
| Single fixed version group over all 11 units | A changeset touching one package bumps all 11 in lockstep | Independently reproduced: throwaway branch `verify-throwaway-release`, real changeset on `@indigodb/ast`, `pnpm changeset version` → all 11 manifests bumped `0.0.1`→`0.0.2`, root untouched, branch deleted after | ✅ COMPLIANT |
| Single fixed version group over all 11 units | A changeset touching only a low-churn package still bumps the whole group | Same reproduction; `@indigodb/ast` (low-churn) drove the bump, `@indigodb/react`/`@indigodb/studio`/all others landed at the identical `0.0.2` | ✅ COMPLIANT |
| Root package is excluded from the version group | Root package.json is untouched by a version bump | Same reproduction; `package.json` (root) stayed `version: "0.0.0"`, `private: true` after `changeset version` | ✅ COMPLIANT |

**package-publish-metadata** (3 requirements, 5 scenarios)

| Requirement | Scenario | Test / Evidence | Result |
|---|---|---|---|
| publishConfig.access set per manifest | Every one of the 11 manifests declares public access | Independently `rg`-verified all 11 manifests + root (root has none); confirmed via real `npm publish --dry-run` per package: 11/11 report "with tag latest and public access" | ✅ COMPLIANT |
| publishConfig.access set per manifest | npm pack --dry-run reflects public access for a scoped package | `cd packages/client && npm publish --dry-run` → "public access", no restricted-scope failure | ✅ COMPLIANT |
| engines floor set per manifest | Every one of the 11 manifests declares the Node floor | `rg '"node": ">=22"'` confirmed present in all 11 manifests | ✅ COMPLIANT |
| engines floor set per manifest | A consumer installing one package outside the monorepo sees the floor | Verified via manifest inspection (not re-derived from source alone — cross-checked against the same `npm publish --dry-run` tarball manifest content apply's evidence describes; independently confirmed field presence) | ✅ COMPLIANT |
| engine-strict is a separate, explicit decision | No .npmrc is introduced by adding engines fields | `test -f .npmrc` → absent, confirmed on `release-engineering` branch | ✅ COMPLIANT |

**publish-procedure** (4 requirements, 7 scenarios)

| Requirement | Scenario | Test / Evidence | Result |
|---|---|---|---|
| Documented sequence starts with clean --force build | First command includes --force | `RELEASING.md:23` reads `pnpm clean && pnpm build --force` verbatim | ✅ COMPLIANT |
| Documented sequence starts with clean --force build | Stale dist/ file does not survive a --force build | Reproduced during apply per `apply-progress.md:5.1`/`178-183`; this verify pass reproduced the build with `--force` cleanly (11/11 successful) and confirmed `RELEASING.md:31-42` documents the cache-hit mechanism and that plain `clean && build` is insufficient | ✅ COMPLIANT |
| Documented sequence starts with clean --force build | Flags never land on the wrong command | `RELEASING.md:87-97` documents `release:preflight` with `--force` baked into script text after `build`, never left for a caller; confirmed in root `package.json` | ✅ COMPLIANT |
| check-pack-contents runs only after build | Running test before build would inspect stale/absent dist | `RELEASING.md:44-50` documents `pnpm test` (which runs `check-pack-contents.mjs`) strictly after step 1; `pnpm test` in this verify run executed against a fresh `--force` build and passed | ✅ COMPLIANT |
| All 11 units publish together in one procedure run | Procedure names one recursive/group command | `RELEASING.md:78-85` specifies `pnpm publish -r` / `changeset publish` once, never per-package | ✅ COMPLIANT |
| All 11 units publish together in one procedure run | A dry run demonstrates all 11 units would be included | Independently reproduced: full throwaway-branch sequence (changeset → `changeset version` → commit → cohort guard rerun → `pnpm publish -r --dry-run`) — all 11 units, including `@indigodb/studio`, listed at identical `0.0.2`, "public access" ×11, dry-run only | ✅ COMPLIANT |
| No real publish occurs during verification | Verification leaves the real registry untouched | Every publish check in this verify pass used `--dry-run`; no `--no-git-checks`, no network publish call; throwaway branch and its changeset deleted after use; `git status` on `release-engineering` confirmed clean before and after | ✅ COMPLIANT |

**Compliance summary**: 15/15 scenarios compliant (9/9 requirements fully covered).

### Additional Independent Proofs (beyond scenario mapping)

| Proof | Result |
|---|---|
| Cohort guard, drop `@indigodb/react` from `fixed[0]` (different package than apply's `@indigodb/cli` reproduction) | `node scripts/check-release-cohort.mjs` → exit 1, names `@indigodb/react` as "missing from the fixed group". Config restored, guard re-run PASSED (exit 0). |
| Cohort guard, phantom entry `@indigodb/phantom-package` added to `fixed[0]` | exit 1, names the phantom as "no publishable workspace package with that name exists". Config restored, guard re-run PASSED (exit 0). |
| Cohort guard, version-parity mutation (`packages/parser` version drifted to `0.0.2`) | exit 1, names `@indigodb/parser` vs. `@indigodb/ast`'s version mismatch. Reverted via `git checkout --`, guard re-run PASSED. |
| Cohort guard, cwd-independence | Run from `packages/ast` (not repo root) → identical PASSED output, confirming `import.meta.url`-based root resolution | ✅ |
| Publish sequence, throwaway branch reproduction | `changeset version` → `pnpm publish -r --dry-run` with no commit → `ERR_PNPM_GIT_UNCLEAN`, exit non-zero (interactive prompt then aborted on unclean tree). Commit + cohort-guard rerun (PASSED) + `pnpm publish -r --dry-run` → succeeded, all 11 units at `0.0.2`, "public access" ×11. Branch deleted after. |
| `.changeset/config.json` + all 11 manifests agree on `access: "public"` | `rg '"access"' .changeset/config.json` → `"public"`; all 11 manifests' `publishConfig.access` = `"public"`; cross-checked against real `npm publish --dry-run` output per package (11/11 "public access"), not a JSON re-read |

All mutation proofs used a distinct package (`@indigodb/react`) from apply's own reproduction
(`@indigodb/cli`), plus the reverse-direction phantom case and a version-parity case, per the
instruction to independently reproduce rather than inherit apply's claims.

### Correctness (Static Evidence)

| Requirement | Status | Notes |
|---|---|---|
| Fixed group composition | ✅ Implemented | `.changeset/config.json:4-16` lists exactly the 11 units, one `fixed` array, no `linked` group |
| Root exclusion | ✅ Implemented | Root `package.json` has no `publishConfig`, `version: "0.0.0"`, `private: true` |
| Per-manifest publishConfig/engines | ✅ Implemented | 11/11 manifests, verified above |
| No `.npmrc` | ✅ Implemented | Verified absent |
| RELEASING.md ordered sequence | ✅ Implemented | Matches spec-required order exactly |
| Cohort guard wiring | ✅ Implemented | `package.json` `test` chain includes `check-release-cohort.mjs` after `check-pack-contents.mjs`, before `check-realtime-projection-db-gate.mjs` (confirmed via `pnpm test` output ordering) |

### Coherence (Design)

| Decision | Followed? | Notes |
|---|---|---|
| No `.npmrc`; engines consumer-facing only | ✅ Yes | Confirmed absent |
| `publishConfig.access` per-package, justification corrected (intent-pinning, not requirement) | ✅ Yes | `RELEASING.md:99-113` states the corrected rationale explicitly, matching `design.md`'s corrected decision |
| Co-publication structural + verified pre-publish | ✅ Yes | Cohort guard checks parity; `RELEASING.md` documents the `pnpm publish -r` mechanism |
| Load-bearing flags live inside script text | ✅ Yes | `release:preflight` bakes `--force` after `build`, confirmed in root `package.json` |
| Commit between `changeset version` and publish; cohort guard re-run after | ✅ Yes | `RELEASING.md:59-76` documents both; independently reproduced end-to-end in this verify pass |
| Descope of dependency-audit-gate | ✅ Yes | Fully reverted, honestly recorded (see Descope Completeness Check above) |

### Issues Found

**CRITICAL**: None

**WARNING**:
1. **Spec/implementation gap: the fixed-group cross-check has no covering requirement or
   scenario.** `scripts/check-release-cohort.mjs` (extended in tasks 4.6/4.7, `design.md`'s
   "commit between changeset version and publish" decision area) now performs a bidirectional
   name cross-check between the discovered publishable packages and `.changeset/config.json`'s
   `fixed[0]` array — failing on a publishable package missing from `fixed`, and separately on a
   `fixed` entry with no matching publishable package (`scripts/check-release-cohort.mjs:14-27,
   79-98`). This behavior works correctly (independently proven above, both directions, both
   exit-1 with the correct named package) and is referenced in `tasks.md` (4.6/4.7) and
   `design.md`'s Testing Strategy row 12, but **no requirement or scenario in
   `specs/release-versioning/spec.md` describes it**. That spec's sole requirement
   ("Single fixed version group...") and its two scenarios only describe `changeset version`'s
   bump behavior — none mention the guard's independent name cross-check, which is a distinct,
   separately-triggerable failure mode (a config/workspace mismatch that `changeset version`
   itself would never surface). A reader of the spec alone would not learn this guard exists.
   Recommend adding a third scenario (or a new requirement) to `release-versioning`'s spec
   describing the cross-check behavior before this change archives, so the spec matches what
   ships. This does not block PASS because the behavior is correct, tested, and traceable to
   tasks/design — but it is a genuine documentation-vs-implementation drift the orchestrator
   should route back to `sdd-spec` (or accept as a documented gap) before archive.

**SUGGESTION**:
1. `pnpm publish -r --dry-run` from the repo root prompts interactively ("You're on branch ...
   but your publish-branch is set to master|main. Do you want to continue?") when run from a
   non-main branch. `RELEASING.md` does not mention this prompt. Not a defect — the real
   procedure will run from `main` after merge — but worth a one-line note so a future release
   operator running the dry-run from a feature branch is not confused by the prompt.
2. `apps/studio`'s build still warns about a >500kB chunk (`index-CRwVp-9p.js`, 820.31kB
   pre-gzip). Pre-existing, unrelated to this change's scope, not a publish blocker (studio is
   an app manifest, not consumed as a library import), noted for completeness only.

### Verdict

**PASS WITH WARNINGS**

All 9 requirements and 15 scenarios across the three remaining capabilities
(`release-versioning`, `package-publish-metadata`, `publish-procedure`) are independently
verified COMPLIANT with real, reproduced runtime evidence — not inherited from apply's claims.
The dependency-audit-gate descope is complete, leaves no half-wired remnant, and is honestly
and specifically recorded across `tasks.md`, `design.md`, `proposal.md`, and
`apply-progress.md`. Build (11/11), lint (21/21), and test (20/20, cohort guard PASSED,
pack-contents guard PASSED) all pass with exit 0. One WARNING: the cohort guard's fixed-group
cross-check (a real, correctly-implemented, and tested capability) has no corresponding
requirement/scenario in `specs/release-versioning/spec.md` — a spec-completeness gap, not a
functional defect. Two low-severity SUGGESTIONs noted. Nothing was published to the real
registry; all publish verification used `--dry-run` exclusively, and the one throwaway branch
created for reproduction (`verify-throwaway-release`) was deleted after use.
