# Release Versioning Specification

## Purpose

Define a single fixed-version group, managed by Changesets, covering all 11 publishable
units so that a `ResolvedSchema`-incompatible cross-package install cannot occur. No
`.changeset/` config exists today (verified absent); this is a new capability.

## Requirements

### Requirement: Single fixed version group over all 11 publishable units

The system MUST define exactly one Changesets `fixed` group in `.changeset/config.json`
containing `@indigodb/ast`, `@indigodb/compiler`, `@indigodb/parser`, `@indigodb/core`,
`@indigodb/migrator`, `@indigodb/generator`, `@indigodb/client`, `@indigodb/realtime`,
`@indigodb/react`, `@indigodb/cli`, and `@indigodb/studio` (`apps/studio`, a workspace
member per `pnpm-workspace.yaml:1-3`). The system MUST NOT define any `linked` or
independent group for any of these 11 units.

#### Scenario: A changeset touching one package bumps all 11 in lockstep

- GIVEN a changeset file exists that bumps only `@indigodb/core`
- WHEN `changeset version` runs locally
- THEN all 11 manifests (`packages/{ast,compiler,parser,core,migrator,generator,client,
  realtime,react,cli}/package.json` and `apps/studio/package.json`) are bumped to the same
  new version number
- AND no manifest outside this set of 11 is modified

#### Scenario: A changeset touching only a low-churn package still bumps the whole group

- GIVEN a changeset file bumps only `@indigodb/ast` (a pure-types, low-churn package)
- WHEN `changeset version` runs locally
- THEN `@indigodb/react`, `@indigodb/studio`, and every other of the 11 units are bumped
  to the identical new version, not left at their prior version

### Requirement: Root package is excluded from the version group

The root `package.json` (`private: true`, `version: "0.0.0"`, `package.json:3-5`) MUST NOT
be a member of the fixed group and MUST NOT be bumped by `changeset version`.

#### Scenario: Root package.json is untouched by a version bump

- GIVEN `changeset version` runs locally after one or more changesets exist
- WHEN the command completes
- THEN root `package.json`'s `version` field remains `0.0.0` and its `private` field
  remains `true`

### Requirement: A guard independently enforces cohort membership and version parity

`changeset version` is the only thing that bumps the cohort, and it cannot report a unit it
was never told about. The system MUST therefore carry a guard, independent of the changesets
tool, that runs inside `pnpm test` and fails non-zero when the declared `fixed` group and the
real publishable workspace set disagree, or when the cohort's versions have drifted.

The guard MUST check three things and MUST name the offending package in every failure:

1. **Version parity** — every non-private workspace package carries the identical `version`.
2. **Missing from the group** — a publishable workspace package absent from
   `.changeset/config.json`'s `fixed[0]`. This is the case version parity alone cannot catch:
   a newly added 12th package carries a matching version today and would simply be left behind
   by the *next* `changeset version`, so a parity-only guard prints PASSED right up until a
   release silently drops it.
3. **Stale group entry** — a name in `fixed[0]` matching no publishable workspace package
   (renamed, removed, or mistyped).

The guard MUST resolve the repository root from its own module location rather than the
caller's working directory, so it behaves identically wherever it is invoked.

#### Scenario: A publishable package missing from the fixed group fails the guard

- GIVEN every workspace package carries the identical version
- AND one publishable package has been removed from `.changeset/config.json`'s `fixed[0]`
- WHEN the guard runs
- THEN it exits **1** (not merely printing a failure line while exiting 0)
- AND the output names that package and states it will not be bumped by `changeset version`

#### Scenario: A fixed-group entry with no matching package fails the guard

- GIVEN `fixed[0]` contains a name that matches no publishable workspace package
- WHEN the guard runs
- THEN it exits **1** and the output names that stale entry
- AND this holds even when every real package's version is in parity

#### Scenario: A drifted version fails the guard even when group membership is correct

- GIVEN `fixed[0]` exactly matches the publishable workspace set
- AND one manifest's `version` has been edited to differ from the rest
- WHEN the guard runs
- THEN it exits **1** and the output names both the drifted package and the reference it
  disagrees with

#### Scenario: The guard is cwd-independent

- GIVEN the guard is invoked from a subdirectory rather than the repository root
- WHEN it runs against an otherwise-correct cohort
- THEN it resolves the same repository root and exits 0, rather than failing to locate
  `.changeset/config.json` or the workspace manifests
