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
