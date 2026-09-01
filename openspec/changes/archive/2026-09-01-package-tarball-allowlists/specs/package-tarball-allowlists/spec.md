# Package Tarball Allowlists Specification

## Purpose

Every publishable workspace package MUST constrain its npm tarball to what consumers actually need
at runtime. Without a `files` allowlist npm excludes nothing from the package directory: `src/`,
`test/`, `tsconfig.json`, Turbo's `.turbo/*.log` build output and stray tool directories all ship.
The monorepo root `.gitignore` does NOT prevent this — npm reads ignore files only from inside the
package directory — so the allowlist is the only mechanism that applies.

## Requirements

### Requirement: Every publishable package declares an allowlist

Each non-private workspace package under `packages/*` and `apps/*` MUST declare a non-empty
`files` array in its `package.json`. A package with no allowlist MUST fail the workspace guard.

#### Scenario: A package without an allowlist fails the guard

- GIVEN a non-private workspace package whose `package.json` has no `files` field
- WHEN `node scripts/check-pack-contents.mjs` runs from the repo root
- THEN the guard reports that package as a failure and exits non-zero
- AND the message states that the tarball would ship `src/`, `test/` and `.turbo/` logs

#### Scenario: Private packages are skipped, not failed

- GIVEN a workspace package marked `"private": true`
- WHEN the guard runs
- THEN it is reported as skipped and does not count as a failure

### Requirement: Tarballs contain nothing outside the allowlist

A packed tarball MUST contain only paths under the package's declared allowlist roots, plus npm's
automatic inclusions (`package.json`, `README*`, `LICENSE*`, `CHANGELOG*`).

#### Scenario: No package ships source, tests, build logs or tool directories

- GIVEN `pnpm build` has run so every `dist/` is current
- WHEN the guard runs
- THEN every package's packed file list contains no `src/`, `test/`, `.turbo/`, `.claude-flow/`
  or `tsconfig.json` path

#### Scenario: A package-specific non-dist asset is honoured

- GIVEN `@indigodb/compiler`, whose allowlist is `["dist", "wasm"]` because the committed WASM
  artifact is a runtime asset
- WHEN the guard runs
- THEN its `wasm/` paths are accepted, because the guard validates against each package's own
  declared roots rather than a hardcoded `dist`

### Requirement: The allowlist ships the package's own entry points

An allowlist MUST cover every path the package resolves at runtime — its `main` and each `bin`
target. "Nothing extra shipped" is only half the contract: an allowlist naming the wrong directory
produces no stray paths and would otherwise pass while shipping a package that cannot be imported.

#### Scenario: An allowlist pointing at the wrong directory fails

- GIVEN a package whose `main` is `./dist/index.js` but whose `files` is `["src"]`
- WHEN the guard runs
- THEN it fails, naming the entry point missing from the tarball
- AND the message distinguishes the two causes: a wrong allowlist, or a stale `dist/`

#### Scenario: An empty or unbuilt dist fails rather than publishing nothing

- GIVEN a package whose `dist/` has not been built
- WHEN the guard runs
- THEN it fails rather than reporting an empty tarball as acceptable

### Requirement: The guard runs as part of the standard test command

The guard MUST be reachable from the repo's normal verification path, so a regression is caught
without anyone remembering to run it. It MUST cover packages that have no `test` script of their
own — `@indigodb/ast` and `@indigodb/parser` have none, so a per-package check cannot reach them.

#### Scenario: pnpm test exercises the guard

- GIVEN a developer runs `pnpm test` from the repo root
- WHEN the workspace test tasks complete
- THEN the guard runs afterwards and its failure fails the command
