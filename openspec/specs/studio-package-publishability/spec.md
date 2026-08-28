# Studio Package Publishability Specification

## Purpose

`@indigodb/studio` is a `workspace:*` dependency of `@indigodb/cli`. A package
carrying `"private": true` can never resolve from a registry, which makes the
CLI's dependency chain unpublishable at its root. This capability makes
`@indigodb/studio` publishable and constrains its npm tarball to exactly the
built SPA the CLI's Studio server needs — nothing else.

## Requirements

### Requirement: Package Is Publishable

`apps/studio/package.json` MUST NOT declare `"private": true`.

#### Scenario: private key is absent

- GIVEN `apps/studio/package.json`
- WHEN its JSON keys are inspected
- THEN no `private` key is present in the file

#### Scenario: package resolves as a normal registry dependency

- GIVEN `packages/cli/package.json` lists `@indigodb/studio` as a plain
  `dependencies` entry (not `optionalDependencies`)
- WHEN `@indigodb/studio` is no longer private
- THEN nothing about the CLI's dependency declaration needs to change for
  `@indigodb/studio` to be a valid, publishable dependency of `@indigodb/cli`

### Requirement: Tarball Allowlist Is Declared

`apps/studio/package.json` MUST declare `"files": ["dist"]`.

#### Scenario: files field matches the compiler precedent

- GIVEN `apps/studio/package.json`
- WHEN its `files` field is inspected
- THEN it is exactly `["dist"]`, matching the existing allowlist pattern used
  by `@indigodb/compiler`

### Requirement: Packed Tarball Contains Only the Built SPA

The `@indigodb/studio` npm tarball MUST contain only `dist/**` build output
plus npm's automatic inclusions (`package.json`, `README`), and MUST NOT
contain source files, dev config, or `node_modules`.

#### Scenario: dry-run pack after a build lists only expected files

- GIVEN `pnpm build` has been run so `apps/studio/dist/` contains the built
  SPA (`index.html`, JS/CSS bundles, `.woff2` fonts, inlined compiler WASM)
- WHEN `npm pack --dry-run` is run inside `apps/studio`
- THEN the reported file list contains only entries under `dist/` plus
  `package.json` and `README`
- AND the list contains no `src/` path and no `node_modules/` path

#### Scenario: dry-run pack before a build packs an empty or stale allowlist

- GIVEN `apps/studio/dist/` is absent or stale (a build was never run, or ran
  against older source) because `dist/` is gitignored repo-wide
- WHEN `npm pack --dry-run` is run inside `apps/studio` without a preceding
  `pnpm build`
- THEN the reported file list reflects whatever is currently on disk under
  `dist/` (empty or stale), not the current source
- AND this is expected allowlist behavior, not a defect in the `files` field —
  the pack check MUST always run after `pnpm build` to be meaningful

### Requirement: CLI Studio Server Dist Resolution Is Unaffected

Making `@indigodb/studio` publishable MUST NOT change the behavior of
`packages/cli/src/studio-server.ts`'s existing dist resolution and fallback
path.

#### Scenario: built dist is served exactly as before

- GIVEN `@indigodb/studio` has had `private` removed and `files: ["dist"]`
  added, with no edits to `packages/cli/src/studio-server.ts`
- WHEN `indigodb studio` is run and `apps/studio/dist/` exists (resolved via
  `require.resolve("@indigodb/studio/package.json")` or
  `INDIGODB_STUDIO_DIST`)
- THEN the CLI serves the built SPA exactly as it did before this change,
  with no observable regression

#### Scenario: fallback page still degrades gracefully on missing dist

- GIVEN `apps/studio/dist/` is missing or `INDIGODB_STUDIO_DIST` is
  misconfigured
- WHEN `indigodb studio` starts
- THEN `resolveStudioDist()`'s existing try/catch still triggers the
  `FALLBACK_PAGE`/API-only degradation, unchanged by this capability

### Requirement: Build, Lint, and Test Remain Green

Removing `private` and adding `files` MUST NOT break the monorepo's build,
lint, or test pipeline.

#### Scenario: workspace verification passes unchanged

- GIVEN the two-key edit to `apps/studio/package.json` is applied
- WHEN `pnpm build`, `pnpm lint`, and `pnpm test` are run from the repo root
- THEN all three complete successfully with no new failures attributable to
  this change
