# Package Publish Metadata Specification

## Purpose

Every publishable unit currently has no `publishConfig` and no `engines` field (both
verified absent by grep across `**/package.json`), so a scoped `@indigodb/*` package
would fail on registry-side access restrictions by default, and no Node floor reaches an
npm consumer even though root declares `>=22` (`package.json:18-20`, non-enforcing and
non-propagating). This capability makes both fields explicit per manifest.

## Requirements

### Requirement: publishConfig.access is set per manifest, not once at the root

Each of the 11 publishable manifests MUST declare
`"publishConfig": { "access": "public" }` directly in its own `package.json`. This MUST
NOT be expressed only at the root or only in a shared/hoisted config, because
`publishConfig` is a `package.json`-scoped field read by npm/pnpm at publish time per
package, not a workspace-level setting.

#### Scenario: Every one of the 11 manifests declares public access

- GIVEN the 11 manifests in `packages/{ast,compiler,parser,core,migrator,generator,
  client,realtime,react,cli}/package.json` and `apps/studio/package.json`
- WHEN each manifest is inspected
- THEN each one individually contains `publishConfig.access === "public"`
- AND the root `package.json` contains no `publishConfig` field

#### Scenario: npm pack --dry-run reflects public access for a scoped package

- GIVEN `@indigodb/client`'s manifest declares `publishConfig.access: "public"`
- WHEN `npm pack --dry-run` runs inside `packages/client`
- THEN the dry-run output does not report a restricted-access failure for the `@indigodb`
  scope

### Requirement: engines floor is set per manifest, matching the root baseline

Each of the 11 publishable manifests MUST declare `"engines": { "node": ">=22" }`,
matching the root's existing floor (`package.json:18-20`). This field MUST be present on
the published package itself, because the root `engines` field does not propagate to an
npm consumer who installs an individual `@indigodb/*` package independently of this
monorepo.

#### Scenario: Every one of the 11 manifests declares the Node floor

- GIVEN the 11 publishable manifests
- WHEN each manifest is inspected
- THEN each one individually contains `engines.node === ">=22"`

#### Scenario: A consumer installing one package outside the monorepo sees the floor

- GIVEN `@indigodb/core` is packed via `npm pack --dry-run`
- WHEN the resulting tarball's `package.json` is inspected
- THEN it contains `engines.node === ">=22"` independent of the root workspace manifest

### Requirement: engine-strict enforcement is a separate, explicit decision

The system MUST NOT introduce a root `.npmrc` with `engine-strict=true` as a side effect
of adding `engines` fields. Enforcing the floor against contributors' local installs is a
distinct decision that MUST be made explicitly, not shipped incidentally by this
capability.

#### Scenario: No .npmrc is introduced by adding engines fields

- GIVEN this capability is applied (11 manifests gain `engines`)
- WHEN the repository root is inspected for `.npmrc`
- THEN no `.npmrc` file exists, and `pnpm install` on a contributor machine with an older
  Node version still only warns (`EBADENGINE`), it does not fail
