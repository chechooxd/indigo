# Proposal: Workspace-Wide Tarball Allowlists

## Context

Follow-up to the archived `unblock-publishing` (Road to 1.0, Phase 6), which made
`@indigodb/studio` publishable and flagged — loudly, in its own risk section — that every other
package shared "the identical missing-`files` bug".

That risk was recorded with the wrong mechanism, and the wrong severity. It claimed npm would fall
back to the monorepo root `.gitignore` and therefore exclude `dist/`, making the packages
"publish broken". Verified with `npm pack --dry-run`: **npm only reads `.npmignore`/`.gitignore`
inside the package directory, never the monorepo root**, so `dist/` ships fine and
`npm install @indigodb/cli` would have worked.

The real defect is different: without a `files` allowlist, nothing is excluded either.

## Intent

Eight of ten publishable packages declared no `files` field, so their tarballs carried `src/`,
`test/`, `tsconfig.json`, Turbo's `.turbo/*.log` build output — one of them 75 kB of test logs —
and in two cases a local tool directory. Measured before the fix:

| Package | Files | Unpacked | Extra directories shipped |
|---------|-------|----------|---------------------------|
| `@indigodb/migrator` | 191 | 642 kB | `src`, `test`, `.turbo` |
| `@indigodb/client` | 102 | 840 kB | `src`, `test`, `.turbo` |
| `@indigodb/cli` | 58 | 745 kB | `src`, `test`, `.turbo`, `.claude-flow` |
| `@indigodb/realtime` | 48 | 368 kB | `src`, `test`, `.turbo`, `.claude-flow` |

Not a release blocker — a hygiene one. It ships internal build logs to users, roughly triples the
download, and publishes source and tests nobody asked for.

## Scope

### In Scope
- `"files": ["dist"]` on `ast`, `cli`, `client`, `core`, `generator`, `migrator`, `parser`,
  `realtime` — every one resolves `main`, `exports` and (for `cli`) `bin` entirely from `dist/`,
  and none carries a non-`dist` runtime asset.
- `scripts/check-pack-contents.mjs`, wired into the root `test` script, as a lasting guard.

### Out of Scope — deliberate non-goals
- **`@indigodb/compiler` and `@indigodb/studio` are untouched.** Both already declare allowlists
  (`["dist", "wasm"]` and `["dist"]`); they are the precedent this change generalises.
- **`apps/studio/test/pack-contents.mjs` stays.** The new guard supersedes it in coverage, but that
  per-package check is required normatively by `studio-package-publishability`. Removing it is a
  spec change, not a cleanup.
- Publish tooling, versioning, changesets, provenance, `npm publish` itself. Still unconfigured,
  still a separate item.
- The `.gitignore`/`.npmignore` strategy. An allowlist is strictly safer than a denylist and
  matches the existing precedent; swapping approaches is not on the table here.

## Capabilities

### New Capabilities
- `package-tarball-allowlists`: every publishable workspace package declares an allowlist, packs
  nothing outside it, and ships its own entry points — enforced by a runtime guard.
