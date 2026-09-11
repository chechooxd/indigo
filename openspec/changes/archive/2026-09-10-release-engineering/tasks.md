# Tasks: Release Engineering

## Descope Note (2026-09-10)

The dependency-audit gate (`dependency-audit-gate` capability: the `.githooks/pre-push` audit
block, `pnpm.auditConfig`, `scripts/test-audit-gate.mjs`, and Phase 3 below) was removed from
this change. A `/code-review` pass found it blocks every push on this repo as landed —
`pnpm audit --audit-level=high` exits 1 with 15 high-severity advisories, 14 pre-existing in
`apps/studio`'s tooling tree and the 15th (`js-yaml`) introduced by this change itself, and the
documented `ignoreCves` valve cannot suppress that 15th one because its advisory is GHSA-only
(`ignoreCves` matches CVE-only; `ignoreGhsas` is the field that would have worked). The gate
moves to its own `dependency-audit-gate` change. All former Phase 3 tasks are struck below, not
deleted, so the history of what was attempted and why it was pulled stays visible.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~180-260 (11 manifests × ~5 lines each ≈ 55-65; `.changeset/config.json` ≈ 15; root `package.json` ≈ 10; `scripts/check-release-cohort.mjs` ≈ 60-80; `RELEASING.md` ≈ 60-90) |
| 800-line budget risk (this project's override, Engram #270) | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
800-line budget risk: Low

**File-count note**: 11 manifests + 4 other files = 15 touched paths, which looks large by file
count alone. Judged on lines against the 800-line budget for this project, the total sits well
under half the budget — each manifest edit is ~5 lines. File count alone does not justify a
split; no chaining decision is needed before apply.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Fixed-version changeset group | Single PR | `changeset version` on throwaway branch | Real: throwaway branch + `changeset version` | delete `.changeset/`, revert branch |
| 2 | Publish metadata on 11 manifests | Single PR | `npm pack --dry-run` per package | Real: dry-run per manifest | drop `publishConfig`/`engines` per file |
| 4 | Cohort guard + root wiring | Single PR | `node scripts/check-release-cohort.mjs` | Real: drifted-manifest and drifted-fixed-group fixtures | delete script, revert `test`/`release:preflight` |
| 5 | RELEASING.md + full dry-run, commit step, guard re-run | Single PR | `pnpm publish -r --dry-run` after commit | Real: repo-root dry-run on throwaway branch | delete `RELEASING.md` |

## Phase 1: Fixed Versioning (release-versioning)

- [x] 1.1 RED: on a throwaway branch, add one changeset touching only `@indigodb/ast`; run
      `changeset version` with no `.changeset/config.json` fixed group present; confirm only
      `@indigodb/ast` bumps (proves the lockstep gap — spec scenario 2).
- [x] 1.2 GREEN: create `.changeset/config.json` with exactly one `fixed` group listing all 11:
      `@indigodb/{ast,compiler,parser,core,migrator,generator,client,realtime,react,cli}` +
      `@indigodb/studio`. No `linked`/independent group for any of these.
- [x] 1.3 Rerun 1.1's changeset + `changeset version`; confirm all 11 manifests bump to the
      identical new version and root `package.json` (`version: "0.0.0"`, `private: true`) is
      untouched. Revert the throwaway branch/changeset afterward (row 9 teardown).
- [x] 1.4 Add `@changesets/cli` to root `package.json` devDependencies (permanent).

## Phase 2: Publish Metadata (package-publish-metadata) — probe-gated

- [x] 2.1 Probe: run `npm pack --dry-run` inside `packages/client` (pre-edit) and inside an
      untouched sibling package. **Expected**: both report public access — this is NOT a halt,
      it confirms npm's current default and is recorded as evidence in `RELEASING.md` (5.5).
      **Halt only if** the edited-candidate package reports non-public after 2.2.
- [x] 2.2 Add `"publishConfig": { "access": "public" }` and `"engines": { "node": ">=22" }` to
      each of the 11 manifests: `packages/{ast,compiler,parser,core,migrator,generator,client,
      realtime,react,cli}/package.json` and `apps/studio/package.json`. Root `package.json`
      MUST gain neither field.
- [x] 2.3 Verify row 8: `npm pack --dry-run` in each of the 11 package directories reports
      public access and `engines.node === ">=22"` in the packed manifest — never a re-read of
      the source JSON. Confirm no restricted-access failure for the `@indigodb` scope.

## Phase 3: Dependency Audit Gate — DESCOPED, moved to `dependency-audit-gate`

- [ ] ~~3.1 Verify the real `pnpm.auditConfig.ignoreCves` field name against `pnpm audit --help`
      / pnpm docs before any later step documents it (design's open question). Record the
      confirmed name for use in 3.4 and 5.5.~~
- [ ] ~~3.2 RED (row 1 gap): seed a temp fixture workspace with a known high-severity advisory
      (own `package.json` + lockfile, marker-only `build`/`lint`/`test` scripts); feed
      synthetic content-push stdin ref lines into the **current** `.githooks/pre-push` (no
      audit block yet); confirm it proceeds to `build` and the marker file IS created —
      proves the gap the new block closes.~~
- [ ] ~~3.3 GREEN: insert the audit block into `.githooks/pre-push` after line 49 (the
      deletion-only short-circuit `fi`) and before the `for step in build lint test` loop at
      line 55: run `pnpm audit --audit-level=high`; on non-zero exit, print a message naming
      both `ignoreCves` and `SKIP_PREPUSH=1`, then `exit 1` without running the loop.~~
- [ ] ~~3.4 Add `pnpm.auditConfig.ignoreCves: []` (verified field name from 3.1) to root
      `package.json`.~~
- [ ] ~~3.5 Create `scripts/test-audit-gate.mjs`: builds the temp fixture workspace from 3.2,
      invokes the real `.githooks/pre-push` with synthetic stdin, tears down the tempdir after
      each scenario, never touches the repo's own lockfile. Gate the whole suite on an opt-in
      `INDIGODB_TEST_AUDIT=1` env var (unset → print `SKIP`, exit 0), following the
      `INDIGODB_TEST_DATABASE_URL` precedent.~~
- [ ] ~~3.6 Row 1 (rerun against 3.3's hook): high advisory + content push → hook exits non-zero
      and the `build` marker file is absent.~~
- [ ] ~~3.7 Row 2: high advisory + deletion-only refs → hook exits 0; assert `pnpm audit` was
      never invoked (short-circuit at :46-49 precedes the audit block).~~
- [ ] ~~3.8 Row 3: high advisory + `SKIP_PREPUSH=1` → exit 0, skip message printed, audit never
      invoked.~~
- [ ] ~~3.9 Row 4 (negative control): moderate-only advisory + content push, `--audit-level=high`
      → exit 0, all four steps run.~~
- [ ] ~~3.10 Row 5: clean fixture tree + content push → build, lint, test markers all created in
      order.~~
- [ ] ~~3.11 Row 6: add the seeded advisory's ID to `pnpm.auditConfig.ignoreCves` → exit 0;
      remove the entry → exit 1 restored (same advisory, same run).~~
- [ ] ~~3.12 Row 7: simulate an unreachable registry (invalid `--registry` or offline env) +
      content push → exit 1, message names both `ignoreCves` and `SKIP_PREPUSH=1`.~~
- [ ] ~~3.13 Mutation proof (two-sided, non-crash): flip `--audit-level` to `moderate` in the
      hook, rerun 3.9's fixture — row 4 must now fail on the audit-exit marker (not a
      `TypeError`). Flip to `critical`, rerun 3.6's fixture — row 1 must now fail to trigger
      (exit 0, build marker present), proving `high` was load-bearing. Revert `--audit-level`
      to `high` after both checks.~~
- [ ] ~~3.14 Wire `scripts/test-audit-gate.mjs` into root `package.json` `test` chain (same
      pattern as `check-realtime-projection-db-gate.mjs`), so it runs (and self-skips without
      the env var) under `pnpm test`.~~

**Reversal record**: `.githooks/pre-push` was restored byte-for-byte to `main`'s version
(`git diff main -- .githooks/pre-push` is empty). `pnpm.auditConfig` was removed from root
`package.json`. `scripts/test-audit-gate.mjs` was deleted and unwired from the `test` chain.
`openspec/changes/release-engineering/specs/dependency-audit-gate/` was deleted. Every reference
in `RELEASING.md` was removed.

## Phase 4: Cohort Guard (release-versioning cohort discipline)

- [x] 4.1 RED: manually drift one non-private workspace package's `version` field; confirm
      nothing in the current `pnpm test` chain catches it (no cohort guard exists yet).
- [x] 4.2 GREEN: create `scripts/check-release-cohort.mjs` — resolves repo root from
      `import.meta.url` (precedent: `scripts/check-pack-contents.mjs:25`, read-only reference),
      walks every non-private workspace package, asserts identical `version`, exits 1 naming
      both the drifted package and a reference package on mismatch.
- [x] 4.3 Row 10: rerun 4.1's drift against the new script directly; confirm exit 1 names both
      packages. Revert the drift.
- [x] 4.4 Chain `scripts/check-release-cohort.mjs` into root `package.json` `test` (after
      `check-pack-contents.mjs`, before `check-realtime-projection-db-gate.mjs`).
- [x] 4.5 Add `"release:preflight": "pnpm clean && pnpm build --force && pnpm lint && pnpm
      test"` to root `package.json` scripts, `--force` baked literally into the script text
      (never passed by a caller — pnpm appends caller flags to the last chained command).
- [x] 4.6 RED (row 12, apply-phase fix): drop one publishable package from
      `.changeset/config.json`'s `fixed` array while leaving its `version` matching the rest;
      confirm the unmodified `check-release-cohort.mjs` still PASSES — proves the guard only
      checks version parity, not fixed-group membership. Revert the drift.
- [x] 4.7 GREEN: extend `scripts/check-release-cohort.mjs` to cross-check the discovered
      publishable package names against `.changeset/config.json`'s `fixed[0]` array in both
      directions — a publishable package missing from `fixed`, and a `fixed` entry with no
      matching publishable package — exiting 1 and naming both sides of the mismatch. Rerun
      4.6's mutation (and the reverse-direction phantom-entry case) against the new script;
      confirm exit 1 names the specific mismatched package each time. Revert both mutations.

## Phase 5: Publish Procedure Verification (publish-procedure)

- [x] 5.1 Row 11: with a stale Turbo-cached `dist/` entry present, run `pnpm clean && pnpm
      build` (no `--force`) and confirm `check-pack-contents.mjs` reports strays; then run
      `pnpm clean && pnpm build --force` and confirm no strays.
- [x] 5.2 Row 8b / full-cohort dry-run: after Phase 2, run `pnpm publish -r --dry-run` (or
      `npm pack --dry-run` per package) from the repo root; confirm all 11 units, including
      `@indigodb/studio`, appear at the identical fixed version, none silently excluded.
- [x] 5.3 Threat-matrix RED: run `scripts/check-release-cohort.mjs` from a subdirectory (not
      repo root) to confirm cwd-independent root resolution.
- [x] 5.5 Create `RELEASING.md`: document the ordered sequence `pnpm clean && pnpm build
      --force` → `pnpm lint && pnpm test` → `changeset version` → commit the version bump →
      re-run the cohort guard → `changeset publish` (or `pnpm publish -r`) as ONE all-11
      operation, `--force` verbatim in step one; document `SKIP_PREPUSH=1`; state explicitly
      that `.npmrc` is deliberately NOT created (per Decision 1 — it would be a side-channel
      for `engine-strict` and a once-per-repo `access=public` neither of which this change
      ships) and that `publishConfig.access` is intent-pinning per manifest, not a publish
      prerequisite (npm's default is already public for new packages, per 2.1's evidence).
- [x] 5.6 **Explicit non-task**: do NOT create a root `.npmrc`. No checkbox action beyond 5.5's
      documentation — recorded here so it is not "helpfully" added later.
- [x] 5.7 RED (apply-phase fix): on a throwaway branch, run `changeset version` then
      immediately `pnpm publish -r --dry-run` with no commit in between; confirm
      `ERR_PNPM_GIT_UNCLEAN` is reproduced. GREEN: commit the version bump, re-run
      `check-release-cohort.mjs`, then rerun `pnpm publish -r --dry-run`; confirm it succeeds.
      Document this exact sequence in `RELEASING.md` (5.5). Revert the throwaway branch.

## Key Risks / Notes

- Phase 3 (dependency-audit-gate) is descoped to its own change — see the Descope Note above.
  `pnpm.auditConfig.ignoreCves` and `ignoreGhsas` are that change's problem now, not this one's.
- 2.1's probe halt condition is corrected from the original design: both packages reporting
  public is the expected, non-halting outcome.
- 4.6/4.7 and 5.7 are apply-phase fixes from a `/code-review` pass on the three remaining
  findings: the cohort guard now cross-checks the `fixed` group by name, and `RELEASING.md`
  documents the commit step `pnpm publish` needs after `changeset version`, plus the guard
  re-run after it.
