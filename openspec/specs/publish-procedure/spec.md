# Publish Procedure Specification

## Purpose

Define the documented, ordered release sequence and the discipline that keeps all 11
units publishing together, given `@indigodb/cli`'s runtime (non-dev) `workspace:*`
dependency on `@indigodb/studio` (`packages/cli/package.json:32`). Verified by dry run
only; no real `npm publish` is in scope for this change.

## Requirements

### Requirement: The documented sequence starts with clean --force build

The publish procedure document MUST state the sequence
`pnpm clean && pnpm build --force` → `pnpm lint && pnpm test` → `changeset version` →
`changeset publish` (or `pnpm publish -r`), and the `--force` flag MUST appear explicitly
in the first step's command text, not only in surrounding prose. `pnpm clean` alone MUST
NOT be documented as sufficient before a publish-intent build.

#### Scenario: The documented first command includes --force

- GIVEN the publish-procedure document
- WHEN its first command is read
- THEN it reads `pnpm clean && pnpm build --force` verbatim (or equivalently split as
  `pnpm clean` immediately followed by `pnpm build --force` as two documented steps, with
  `--force` never dropped)

#### Scenario: A stale dist/ file from a prior build does not survive into a publish-intent build

- GIVEN a Turbo cache entry exists from a prior build that produced a file no longer
  emitted by current sources (matching the historical `packages/parser/dist/lexer.js` /
  `packages/core/dist/legacy/*` case)
- WHEN the documented sequence's first step (`pnpm clean && pnpm build --force`) runs
- THEN the stale file is absent from the resulting `dist/` output
- AND running `pnpm clean && pnpm build` (without `--force`) instead, as a negative check,
  is documented as insufficient — a cache hit would restore the stale file wholesale

#### Scenario: Flags are never appended after the wrong command in a chain

- GIVEN the documented sequence chains multiple `pnpm` commands with `&&`
- WHEN any step-specific flag (e.g. `--force`) is required
- THEN the flag is documented as attached to the exact command it targets, never appended
  after a later command in the same chain (pnpm appends flags only to the last chained
  command, so a misplaced flag silently no-ops)

### Requirement: check-pack-contents runs only after the build step, never standalone as proof

The publish procedure MUST sequence `pnpm test` (which runs
`scripts/check-pack-contents.mjs`, already wired at `package.json:13`) after the
`clean && build --force` step, since `check-pack-contents.mjs` inspects `dist/` output.

#### Scenario: Running test before build would inspect stale or absent dist/

- GIVEN the documented sequence
- WHEN the steps are read in order
- THEN `pnpm build --force` always precedes `pnpm test` in the documented sequence, never
  the reverse

### Requirement: All 11 units publish together in one procedure run

The publish procedure MUST document that fixed versioning alone does not guarantee
`@indigodb/cli` and `@indigodb/studio` are published in the same operation, since
`@indigodb/cli` depends on `@indigodb/studio` as a runtime `workspace:*` dependency
(`packages/cli/package.json:32`), and `require.resolve("@indigodb/studio/package.json")`
at runtime would fail for a consumer if Studio were not published alongside. The
procedure MUST specify a single all-11 publish operation (e.g. `pnpm publish -r` from the
repo root, or `changeset publish` run once with all 11 group members present), not
per-package manual publish invocations.

#### Scenario: The procedure names one recursive/group publish command, not per-package steps

- GIVEN the publish-procedure document's final step
- WHEN it is read
- THEN it specifies one command that publishes all 11 units together (e.g.
  `pnpm publish -r` from the repo root) rather than listing 11 separate `npm publish`
  invocations

#### Scenario: A dry run demonstrates all 11 units would be included

- GIVEN `npm pack --dry-run` (or the changesets equivalent) is run per the documented
  procedure
- WHEN the dry-run output is collected across the 11 units
- THEN every one of the 11 units (including `@indigodb/studio`) appears in the dry-run
  output at the identical fixed version, and none is silently excluded

### Requirement: No real publish occurs as part of verifying this procedure

The publish procedure MUST be verifiable entirely through `npm pack --dry-run` and local
`changeset version`, and MUST NOT require or trigger an actual `npm publish` to the real
registry as part of its verification.

#### Scenario: Verification leaves the real registry untouched

- GIVEN the publish procedure is exercised for verification
- WHEN `npm pack --dry-run` and `changeset version` are run locally
- THEN no network call to the npm registry's publish endpoint occurs, and no version of
  any of the 11 units exists on the real registry as a result
