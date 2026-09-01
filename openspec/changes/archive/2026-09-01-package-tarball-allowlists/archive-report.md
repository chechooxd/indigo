# Archive Report: Workspace-Wide Tarball Allowlists

**Change**: `package-tarball-allowlists`
**Archived**: 2026-09-01
**Route**: delegated-direct (not a full SDD phase chain — see Notes)

## Executive Summary

Eight of ten publishable packages declared no npm `files` allowlist, so their tarballs shipped
`src/`, `test/`, `tsconfig.json`, Turbo's `.turbo/*.log` build output and — in two cases — a local
tool directory. `@indigodb/migrator` packed 191 files / 642 kB where 25 files / 222 kB is the
whole package.

Fixed by declaring `"files": ["dist"]` on all eight, plus a guard
(`scripts/check-pack-contents.mjs`, wired into the root `test` script) so it cannot silently
regress.

## A correction to the archived risk this came from

`unblock-publishing` (archived 2026-08-28) flagged this in its risk section, but with the **wrong
mechanism and the wrong severity**. It stated that npm would fall back to the monorepo root
`.gitignore` and therefore exclude `dist/`, so "every one of those packages would publish broken"
and `npm install @indigodb/cli` "would not work today".

Verified with `npm pack --dry-run` before acting: **npm reads ignore files only from inside the
package directory, never the monorepo root.** `dist/` shipped fine and installs would have worked.
The defect was real but it was bloat and leakage, not breakage — a hygiene item, not a release
blocker. Acting on the recorded claim without re-deriving it would have produced a correct fix
attached to a false rationale.

## Measured impact

| Package | Before | After |
|---------|--------|-------|
| `@indigodb/migrator` | 191 files / 642 kB | 25 / 222 kB |
| `@indigodb/client` | 102 / 840 kB | 54 / 321 kB |
| `@indigodb/cli` | 58 / 745 kB | 25 / 254 kB |
| `@indigodb/realtime` | 48 / 368 kB | 25 / 108 kB |

`@indigodb/compiler` (`["dist","wasm"]`) and `@indigodb/studio` (`["dist"]`) already conformed and
were untouched — they are the precedent this generalises.

## The guard, and why it checks two things

`scripts/check-pack-contents.mjs` enumerates non-private workspace packages, requires a non-empty
`files` array, runs `npm pack --dry-run --json`, and rejects any packed path outside the declared
roots plus npm's automatic inclusions.

It **also** requires each package's own `main` and `bin` targets to be present in the tarball. That
second check exists because the first one alone has a hole: an allowlist naming the wrong directory
(`files: ["src"]`) produces no stray paths and would pass, while shipping a package that cannot be
imported. Validating against each package's *own* declared roots rather than a hardcoded `dist` is
also what lets `compiler`'s `wasm/` through without a special case.

It is wired into the root `test` script rather than per-package because `@indigodb/ast` and
`@indigodb/parser` have no `test` script of their own and could not host a per-package check.

## Verification

Both regression shapes proven by mutation, then reverted:

| Mutation | Result |
|----------|--------|
| Remove `files` from `migrator` | FAIL — "no `files` allowlist" |
| Set `migrator`'s `files` to `["src"]` | FAIL — "does not ship its own entry point(s): dist/index.js" |

`pnpm build` 10/10, `pnpm lint` 19/19, `pnpm test --force` 18/18, exit 0. Guard green across all
ten packages.

## Spec merged into the source of truth

`openspec/specs/package-tarball-allowlists/spec.md` — **NEW** capability, 4 requirements.

## Notes

- `apps/studio/test/pack-contents.mjs` was deliberately kept. The new guard supersedes it in
  coverage, but that per-package check is required normatively by `studio-package-publishability`;
  removing it would be a spec change, not a cleanup.
- Publish tooling remains unconfigured: no changesets, no versioning workflow, no `npm publish`
  pipeline. This change makes the tarballs correct; it does not publish them.
- Route note: this went delegated-direct rather than through a proposal/design phase chain. The
  mechanism was already settled by `unblock-publishing`'s precedent, so durable planning artifacts
  would have reduced no ambiguity. Proposal, spec and tasks were written because the change
  establishes a normative capability — not because the route demanded them.
