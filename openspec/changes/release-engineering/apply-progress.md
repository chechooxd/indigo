# Apply Progress: Release Engineering

## Status

29/29 active tasks complete (32 original minus 3 Phase 3 tasks now struck as
descoped, plus 2 new Task-B fix tasks). Phase 3 (dependency-audit-gate) removed
entirely per maintainer-approved descope. Three confirmed review findings in the
remaining scope fixed. Committed to branch `release-engineering`
(commit `87d54bb`, on top of `992900c`/`9c2ae64`). Ready for `sdd-verify`.

## Batch 2: Descope + Fix (this session, 2026-09-10)

### Why

A `/code-review` pass at high effort found the dependency-audit gate as landed
blocks every push on this repo: `pnpm audit --audit-level=high` exits 1 with 53
vulnerabilities (15 high), 14 pre-existing in `apps/studio`'s tooling tree and the
15th (`js-yaml` via `@changesets/cli`) introduced by this change itself. The
documented `pnpm.auditConfig.ignoreCves` valve cannot even suppress that 15th one
— its advisory (`GHSA-5p4m-2wfm-xmqj`) is GHSA-only (`cves: []`), and `ignoreCves`
matches CVE-only; `ignoreGhsas` is the field that covers it, and this change never
wired it. The maintainer decided to split the gate into its own change.

### Task A — audit gate removed completely

- [x] `.githooks/pre-push` restored to exactly `main`'s pre-change state —
      `git diff main -- .githooks/pre-push` is empty.
- [x] `pnpm.auditConfig` removed from root `package.json`.
- [x] `scripts/test-audit-gate.mjs` deleted and unwired from the root `test` chain.
- [x] `openspec/changes/release-engineering/specs/dependency-audit-gate/` deleted.
- [x] Every audit-gate reference removed from `RELEASING.md`.
- [x] Phase 3 tasks in `tasks.md` struck (`~~...~~`, checkbox reset to `[ ]`) with a
      reversal record, not deleted. Design's Testing Strategy rows 1–7 and the
      audit-gate decision/data-flow line/file-changes row removed from `design.md`.
- [x] `proposal.md`, `design.md`, `tasks.md` updated to describe three deliverables
      (release-versioning, package-publish-metadata, publish-procedure) with an
      explicit, dated descope note naming the reproduced defect and the gate's move
      to its own `dependency-audit-gate` change.

### Task B — three confirmed findings fixed

- [x] **B.1 Publish sequence aborts at step 4.** Reproduced on a throwaway branch
      (`throwaway-release-repro`, deleted after): `changeset version` → `pnpm
      publish -r --dry-run` with no commit in between → `ERR_PNPM_GIT_UNCLEAN`,
      exit 1. Fix: added a documented `git commit` step between `changeset version`
      and publish (not `--no-git-checks` — committing the bump is the honest
      record). Reran the full sequence with the commit step: `pnpm publish -r
      --dry-run` succeeded, all 11 units listed at the bumped version (`0.0.2` in
      the throwaway repro).
- [x] **B.2 Cohort guard never re-runs after the only step that can break parity.**
      `RELEASING.md` and `design.md`/`proposal.md` now document the guard (or full
      `pnpm test`) re-running after `changeset version` + commit, before publish.
- [x] **B.3 Cohort guard never cross-checked the publishable set against `fixed`.**
      Strict TDD: RED — temporarily dropped `@indigodb/cli` from
      `.changeset/config.json`'s `fixed` array (version left matching); the
      unmodified guard still printed PASSED, proving the gap. Reverted. GREEN —
      extended `scripts/check-release-cohort.mjs` with a bidirectional name
      cross-check (publishable-missing-from-fixed, and fixed-entry-missing-
      publishable), each failure naming the specific package and the config path.
      Reran both mutation directions (drop `@indigodb/cli`; add a phantom
      `@indigodb/nonexistent` entry) against the new script: both failed with the
      specific asserted message, neither crashed. Reverted `.changeset/config.json`
      to clean; guard reruns PASSED afterward.

### Verification (foreground, this session)

| Command | Result |
|---|---|
| `pnpm clean && pnpm build --force` | 11/11 tasks successful |
| `pnpm lint` | 21/21 successful (cached) |
| `pnpm test` | 20/20 turbo tasks + pack-contents guard all green + cohort guard PASSED + realtime db-gate PASSED (no audit-gate step; it no longer exists) |
| `git diff main -- .githooks/pre-push` | empty |
| `pnpm audit --audit-level=high` | exit 1, 53 vulnerabilities/15 high (unchanged) — confirmed hook no longer invokes it (`rg "pnpm audit" .githooks/pre-push` → no match) |
| Cohort-guard mutation proof (B.3) | RED: unmodified guard PASSED despite dropped `@indigodb/cli` from `fixed`. GREEN: new guard failed naming `@indigodb/cli` (missing-from-fixed) and separately failed naming `@indigodb/nonexistent` (phantom-in-fixed). Config restored; guard PASSED clean afterward. |
| Publish-sequence proof (B.1) | RED: `ERR_PNPM_GIT_UNCLEAN`, exit 1, no commit between version and publish. GREEN: commit + cohort-guard rerun + `pnpm publish -r --dry-run` → exit 0, all 11 units listed. Throwaway branch deleted after. |

Nothing published to the real registry — dry-run only, throwaway branch deleted.

### Files changed (Batch 2)

| File | Action |
|---|---|
| `.githooks/pre-push` | Modified — audit block removed, byte-identical to `main` |
| `package.json` (root) | Modified — `pnpm.auditConfig` and `test-audit-gate.mjs` chain entry removed |
| `scripts/test-audit-gate.mjs` | Deleted |
| `scripts/check-release-cohort.mjs` | Modified — fixed-group cross-check added |
| `RELEASING.md` | Modified — audit-gate section removed; commit step + cohort-guard re-run documented |
| `openspec/changes/release-engineering/specs/dependency-audit-gate/spec.md` | Deleted |
| `openspec/changes/release-engineering/proposal.md` | Modified — descope note, 3-deliverable scope |
| `openspec/changes/release-engineering/design.md` | Modified — descope note, audit decisions/rows removed, B.1/B.2 design decision added |
| `openspec/changes/release-engineering/tasks.md` | Modified — Descope Note, Phase 3 struck, tasks 4.6/4.7/5.7 added |

Committed as `87d54bb` on branch `release-engineering`. Not pushed, no PR opened.

---

## Batch 1 (original implementation, prior session)

32/32 tasks complete. All 5 phases implemented, verified, and committed to branch
`release-engineering` (commit `9c2ae64`). Ready for `sdd-verify`.

## Mode

Strict TDD (RED/GREEN proofs run as real commands against real artifacts — throwaway
git worktree for changesets, real seeded-advisory fixture workspaces for the audit
gate, a real Turbo cache-hit reproduction for the stale-dist guard — never mocked).

## Defect fixed on resume

`.changeset/config.json` carried `"access": "restricted"` while all 11 manifests
declared `publishConfig.access: "public"` — a direct self-contradiction inherited from
the interrupted prior attempt. Fixed to `"access": "public"`. Also reverted incidental
`"files": ["dist"]` → multi-line reformatting churn on 9 manifests (kept the diff to
exactly the two new fields per file).

## Completed Tasks (all phases)

### Phase 1: Fixed Versioning
- [x] 1.1 RED (corrected shape, see Deviations): asymmetric changeset (ast=minor) with
      no fixed group → ast diverges to `0.1.0` while cascade-bumped dependents land at
      `0.0.2`, root stays `0.0.0`. Proven on a throwaway `git worktree` off `main`
      (`/tmp/rel-throwaway`), torn down after.
- [x] 1.2 `.changeset/config.json` created, one `fixed` group, all 11 units, `access: "public"`.
- [x] 1.3 GREEN: same asymmetric changeset with the fixed group present → all 11 bump
      to identical `0.1.0`, root untouched. Worktree torn down, branch deleted.
- [x] 1.4 `@changesets/cli` in root devDependencies (already present pre-resume).

### Phase 2: Publish Metadata
- [x] 2.1 Probe: edited `packages/client` reports "public access" via `npm publish
      --dry-run`; untouched sibling `packages/ast` (git-stashed to pre-edit state)
      reports "default access" — both non-restricted, confirmed non-halting per the
      corrected design decision.
- [x] 2.2 `publishConfig.access: "public"` + `engines.node: ">=22"` on all 11 manifests
      (already present pre-resume; formatting churn reverted).
- [x] 2.3 Verified via real `npm pack` + tarball extraction (not source re-read) on all
      11 units: every packed manifest shows `access: public`, `engines.node: ">=22"`.

### Phase 3: Dependency Audit Gate
- [x] 3.1 `pnpm.auditConfig.ignoreCves` confirmed as the real field name — row 6 of the
      fixture suite empirically suppresses/restores the gate using exactly this field.
- [x] 3.2 RED confirmed against the original (pre-change) hook via `git show
      HEAD:.githooks/pre-push`: high-severity fixture still reaches `build` (marker
      created), proving the gap.
- [x] 3.3 Audit block inserted in `.githooks/pre-push` after line 49 (`fi`, end of
      deletion-only short-circuit), before line 55 (`for step in build lint test`).
- [x] 3.4 `pnpm.auditConfig.ignoreCves: []` added to root `package.json`.
- [x] 3.5 `scripts/test-audit-gate.mjs` created: temp fixture workspaces, real hook
      invocation, synthetic stdin, teardown after each scenario, gated on
      `INDIGODB_TEST_AUDIT=1` (unset → SKIP, exit 0).
- [x] 3.6–3.10 Rows 1–5 all green (see Work Unit Evidence below).
- [x] 3.11 Row 6: `ignoreCves` entry suppresses; removing it restores the failure, same
      advisory, same run.
- [x] 3.12 Row 7: unreachable registry (`npm_config_registry` pointed at a closed port)
      fails closed, message names both `ignoreCves` and `SKIP_PREPUSH=1`.
- [x] 3.13 Mutation proof, two-sided, real runs:
      - `--audit-level=moderate` → row 4 (moderate-only fixture) now FAILS on the audit
        marker (`pnpm audit --audit-level=moderate` message), not a crash.
      - `--audit-level=critical` → row 1 (high-only fixture) now does NOT trigger (exit
        0, all three markers present), proving `high` was load-bearing.
      - Hook reverted to `--audit-level=high` after both checks (byte-identical diff
        confirmed via `diff` against the pre-mutation copy).
- [x] 3.14 `scripts/test-audit-gate.mjs` wired into root `package.json` `test` chain,
      after `check-realtime-projection-db-gate.mjs`.

### Phase 4: Cohort Guard
- [x] 4.1 Confirmed no pre-existing guard (script did not exist before this task).
- [x] 4.2 `scripts/check-release-cohort.mjs` created: `import.meta.url` root
      resolution, walks `packages/*` + `apps/*`, asserts identical version across
      non-private packages.
- [x] 4.3 Drifted `packages/ast` to `0.0.2` → guard FAILs naming all 10 mismatched
      packages against the reference; reverted via `git checkout --` (which also wiped
      the publishConfig/engines edit — caught and restored).
- [x] 4.4 Chained into root `package.json` `test`, after `check-pack-contents.mjs`,
      before `check-realtime-projection-db-gate.mjs`.
- [x] 4.5 `release:preflight` script added, `--force` baked literally into the text.

### Phase 5: Publish Procedure Verification
- [x] 5.1 Real Turbo cache-hit reproduction: seeded `packages/parser/dist/lexer.js`,
      force-cached it via a real build, then `clean && build` (no `--force`) restored
      it from cache; `clean && build --force` did not. **Deviation**: `check-pack-
      contents.mjs` did NOT flag the stray (it only enforces the `files` allowlist
      boundary, not staleness) — documented explicitly in `RELEASING.md` rather than
      silently assumed to match the task's original expectation.
- [x] 5.2 `npm pack --dry-run` on all 11 units confirms identical version (`0.0.1`),
      `@indigodb/studio` included, none excluded.
- [x] 5.3 Both `check-release-cohort.mjs` and `test-audit-gate.mjs` (10/10) rerun from
      `packages/ast` / `packages/core` subdirectories — identical results, cwd-independent.
- [x] 5.4 Empty-stdin and first-push (all-zero remote sha) ref shapes covered as
      dedicated scenarios inside `test-audit-gate.mjs`, both green.
- [x] 5.5 `RELEASING.md` created: ordered sequence, `--force` verbatim in step one,
      `ignoreCves` valve documented under its verified field name, `SKIP_PREPUSH=1`
      documented, `.npmrc` non-creation stated explicitly with rationale.
- [x] 5.6 Non-task honored: no `.npmrc` created (verified absent post-implementation).

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command | `INDIGODB_TEST_AUDIT=1 node scripts/test-audit-gate.mjs` → `10/10 passed` |
| Runtime harness | Real `.githooks/pre-push` invoked via `bash` against real temp fixture workspaces (own package.json + lockfile), synthetic stdin ref lines, real `pnpm audit`/`pnpm install` network calls, teardown after each scenario |
| Rollback boundary | `.changeset/`, the 11 manifest field pairs, the audit block in `.githooks/pre-push`, `scripts/check-release-cohort.mjs`, `scripts/test-audit-gate.mjs`, `RELEASING.md` each revert independently per the design's rollout plan |

## Deviations from Design/Tasks

1. **Task 1.1's RED scenario as literally stated does not reproduce.** With no fixed
   group, `updateInternalDependencies: "patch"` cascades a bump to every package
   reverse-transitively depending on the changed one — in this repo's graph, that is
   all 11 (everything ultimately depends on `@indigodb/ast`), so a same-bump-type
   changeset on `ast` alone still lands all 11 at an *identical* version by accident,
   not by guarantee. Reproduced the actual gap instead with an asymmetric bump
   (`ast: minor`, cascade: `patch`), which does diverge (`0.1.0` vs `0.0.2`). This is
   evidence-backed, not an assumption.
2. **`check-pack-contents.mjs` does not catch the stale-dist-via-cache-hit class of bug**
   (task 5.1's implicit expectation). It only enforces the `files` allowlist boundary;
   a stray file still nested under `dist/` passes silently. `RELEASING.md` documents
   this explicitly so `--force` at the build step is understood as the real guard, not
   the downstream pack check.
3. Reverted incidental `"files": ["dist"]` reformatting (one-line → three-line) on 9 of
   the 11 manifests — pure diff churn unrelated to this change's two new fields.

## Verification (run in foreground, this session)

| Command | Result |
|---|---|
| `pnpm clean && pnpm build --force` | 11/11 tasks successful |
| `pnpm lint` | 21/21 tasks successful |
| `pnpm test` | 20/20 turbo tasks successful; pack-contents guard all green; cohort guard PASSED; realtime db-gate PASSED; audit-gate suite SKIP (env unset, correct default) |
| `INDIGODB_TEST_AUDIT=1 node scripts/test-audit-gate.mjs` | 10/10 scenarios PASSED (run twice, plus once from a subdirectory) |
| Mutation proof (moderate/critical audit-level flips) | Both sides confirmed red/green as designed, hook reverted byte-identical |

Nothing published to the real npm registry. The seeded vulnerable dependencies
(`ansi-regex@3.0.0`, `xml2js@0.4.19`) never entered the real lockfile or any tracked
manifest — confirmed via `rg xml2js` across `pnpm-lock.yaml` and all manifests
(zero matches) before commit.

## Files Changed

| File | Action |
|---|---|
| `.changeset/config.json`, `.changeset/README.md` | Created |
| `packages/{ast,compiler,parser,core,migrator,generator,client,realtime,react,cli}/package.json`, `apps/studio/package.json` | Modified (publishConfig + engines) |
| `.githooks/pre-push` | Modified (audit block) |
| `package.json` (root) | Modified (test chain, release:preflight, pnpm.auditConfig, devDependency) |
| `pnpm-lock.yaml` | Modified (changesets dependency tree) |
| `scripts/check-release-cohort.mjs` | Created |
| `scripts/test-audit-gate.mjs` | Created |
| `RELEASING.md` | Created |

Committed as `9c2ae64` on branch `release-engineering`. Not pushed, no PR opened.
