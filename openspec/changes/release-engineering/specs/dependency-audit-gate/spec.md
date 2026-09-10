# Dependency Audit Gate Specification

## Purpose

`.githooks/pre-push` today runs only `build → lint → test` (`.githooks/pre-push:54-63`),
with no dependency-vulnerability check anywhere in the repo. This capability adds a
hard-fail `pnpm audit` step that runs first — before the ~8-minute build/lint/test
chain — because audit needs no build output and should fail fast.

## Requirements

### Requirement: pnpm audit runs first and hard-fails the push

`.githooks/pre-push` MUST run `pnpm audit` before the existing `for step in build lint
test` loop (currently `.githooks/pre-push:54-63`). A non-zero exit from `pnpm audit` MUST
abort the push with a non-zero hook exit code, and the `build`/`lint`/`test` loop MUST NOT
run when the audit step fails.

#### Scenario: A seeded vulnerable dependency fails the push before build starts

- GIVEN a dependency with a known advisory is present in the lockfile (seeded for this
  proof)
- WHEN `git push` triggers `.githooks/pre-push` without `SKIP_PREPUSH=1`
- THEN `pnpm audit` exits non-zero, the hook exits non-zero, the push is aborted
- AND `pnpm build` is never invoked (no build output, no build log line, is produced)

#### Scenario: A clean dependency tree proceeds to the existing build/lint/test chain

- GIVEN no dependency in the lockfile has a known advisory
- WHEN `git push` triggers `.githooks/pre-push` without `SKIP_PREPUSH=1`
- THEN `pnpm audit` exits zero
- AND the hook proceeds to run `pnpm build`, then `pnpm lint`, then `pnpm test` in that
  order, unchanged from current behavior

### Requirement: SKIP_PREPUSH=1 bypasses the audit step identically to the rest of the hook

The existing `SKIP_PREPUSH=1` escape hatch (`.githooks/pre-push:28-31`) MUST continue to
skip the entire hook, including the new audit step, with no separate bypass variable
introduced for audit alone.

#### Scenario: SKIP_PREPUSH=1 skips audit along with build/lint/test

- GIVEN a seeded vulnerable dependency is present in the lockfile
- WHEN `SKIP_PREPUSH=1 git push` runs
- THEN the hook prints its skip message and exits zero
- AND `pnpm audit` is never invoked

### Requirement: A deletion-only push skips the audit step, matching existing behavior

The hook's existing all-ref-deletion short-circuit (`.githooks/pre-push:33-49`) MUST also
skip the new audit step, since there is no new code to verify.

#### Scenario: Pushing only a branch deletion does not run audit

- GIVEN the only ref being pushed is a branch deletion (all-zero local SHA)
- WHEN `git push --delete` triggers the hook
- THEN the hook reports "nothing to verify" and exits zero without invoking `pnpm audit`
