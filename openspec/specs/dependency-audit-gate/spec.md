# Dependency Audit Gate Specification

## Purpose

`.githooks/pre-push` runs `build -> lint -> test` with no dependency vulnerability gate. This
capability adds a fail-fast `pnpm audit --audit-level=high` check before the ~8-minute
build/lint/test chain, with documented CVE and GHSA suppression valves, and requires the real
repository's dependency tree to pass unmodified.

## Requirements

### Requirement: pnpm audit runs first and hard-fails the push on high or critical advisories

`.githooks/pre-push` MUST run `pnpm audit --audit-level=high` before the existing
`for step in build lint test` loop. A non-zero exit from `pnpm audit` MUST abort the push with a
non-zero exit code, and `build`/`lint`/`test` MUST NOT run.

#### Scenario: A seeded high-severity dependency fails the push before build starts

- GIVEN a lockfile containing a dependency with a known `high` advisory (not suppressed)
- WHEN `.githooks/pre-push` runs for a non-deletion ref without `SKIP_PREPUSH=1`
- THEN `pnpm audit --audit-level=high` exits non-zero and the hook exits non-zero
- AND `pnpm build`, `pnpm lint`, and `pnpm test` are never invoked

#### Scenario: A moderate-only advisory proceeds to build, lint, and test

- GIVEN a lockfile whose only advisory is `moderate` (no `high` or `critical` advisories)
- WHEN `.githooks/pre-push` runs for a non-deletion ref without `SKIP_PREPUSH=1`
- THEN `pnpm audit --audit-level=high` exits zero
- AND the hook proceeds to run `pnpm build`, `pnpm lint`, and `pnpm test` in order

### Requirement: pnpm.auditConfig suppresses triaged advisories by both CVE and GHSA

Root `package.json` MUST expose `pnpm.auditConfig` with both `ignoreCves` and `ignoreGhsas`
arrays, and the hook's failure message MUST direct maintainers to those fields rather than
lowering `--audit-level`.

#### Scenario: A CVE-bearing advisory is suppressed via ignoreCves

- GIVEN a fixture workspace containing a high advisory with a CVE identifier
- WHEN that CVE is listed in `pnpm.auditConfig.ignoreCves`
- THEN `.githooks/pre-push` passes the audit step and runs `build`, `lint`, and `test`

#### Scenario: A GHSA-only advisory (empty cves) is suppressed via ignoreGhsas

- GIVEN a fixture workspace containing a high advisory with `cves: []` (GHSA-only)
- WHEN its GHSA identifier is listed in `pnpm.auditConfig.ignoreGhsas` (alongside any other
  advisories on that package)
- THEN `.githooks/pre-push` passes the audit step and runs `build`, `lint`, and `test`

### Requirement: SKIP_PREPUSH=1 bypasses the audit step identically to the rest of the hook

The existing `SKIP_PREPUSH=1` escape hatch MUST continue to skip the entire hook, including the
audit step, with no separate audit-only bypass variable.

#### Scenario: SKIP_PREPUSH=1 skips audit along with build/lint/test

- GIVEN a fixture workspace with an unsuppressed high-severity advisory
- WHEN `.githooks/pre-push` runs with `SKIP_PREPUSH=1`
- THEN the hook prints its skip message and exits zero without failing on audit or running build

### Requirement: A deletion-only push skips the audit step

The hook's existing all-ref-deletion short-circuit MUST skip the audit step as well as
`build`/`lint`/`test`.

#### Scenario: Pushing only a branch deletion does not run audit

- GIVEN a fixture workspace with an unsuppressed high-severity advisory
- WHEN `.githooks/pre-push` receives only an all-zero local SHA ref line
- THEN the hook reports "nothing to verify" and exits zero without invoking `pnpm audit`

### Requirement: The real repository passes the audit gate unmodified

The IndigoDB repository's own lockfile MUST exit zero under `pnpm audit --audit-level=high`
before this change lands, without suppressing advisories left behind by unused runtime CLI
dependencies.

#### Scenario: Unmodified repo root passes pnpm audit --audit-level=high

- GIVEN the committed root `package.json` and `pnpm-lock.yaml` with `ignoreCves: []` and
  `ignoreGhsas: []`
- WHEN `pnpm audit --audit-level=high` runs at the repository root
- THEN it exits zero with zero high or critical advisories
- AND `apps/studio/package.json` does not depend on `shadcn`
