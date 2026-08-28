# Design: Unblock publishing of @indigodb/studio

## Technical Approach

Root-cause metadata fix (proposal Option A) against capability
`studio-package-publishability`. Two keys change in `apps/studio/package.json`:
`"private": true` is removed, `"files": ["dist"]` is added, mirroring the only
correct allowlist in the repo (`packages/compiler/package.json`). No runtime,
build, or server code changes. Publishability is proven by packing, not
publishing. The one net-new asset is a lasting pack-contents guard test, because
the tarball's shape is exactly the kind of "artifact matches intent" invariant
that silently rots with CI disabled — the same reasoning that produced
`packages/compiler/test/wasm-freshness.mjs`.

## Architecture Decisions

### Decision: `files: ["dist"]` allowlist rather than `.npmignore`

**Choice**: allowlist in `package.json`.
**Alternatives**: `.npmignore` denylist; no field at all.
**Rationale**: a denylist fails open — every new top-level directory ships until
someone notices. `@indigodb/compiler` already set the allowlist precedent, and
`npm` still auto-includes `package.json`/`README`/`LICENSE`, which is exactly the
desired extra surface. `apps/studio` currently has no README or LICENSE file, so
the tarball is `dist/**` + `package.json`.

### Decision: the pack check becomes a permanent package test, not a one-off apply step

**Choice**: new `apps/studio/test/pack-contents.mjs`, plain Node, chained into
the package's `test` script: `"test": "vitest run && node test/pack-contents.mjs"`.
**Alternatives**: manual `npm pack --dry-run` during apply only; a CI job.
**Rationale**: a manual check verifies the commit, not the invariant — the next
person to add `public/` or a stray top-level output regresses it silently. CI is
disabled repo-wide (`.github/workflows-disabled/`), so CI is not an available
guard. Turbo's `test` task already `dependsOn: ["build"]`, so `dist/` is
guaranteed present when the guard runs, and the guard costs one subprocess.

### Decision: no `main`/`exports` field is added

**Choice**: leave the package export-map-less.
**Alternatives**: add `"exports"` for tidiness.
**Rationale**: `packages/cli/src/studio-server.ts` locates the SPA via
`require.resolve("@indigodb/studio/package.json")`. Adding `exports` without an
explicit `"./package.json"` entry would make that subpath unresolvable and break
Studio serving. Out of scope and actively harmful here.

### Decision: `npm pack --dry-run --json`, not `pnpm pack` + `tar`

**Choice**: parse `npm pack --dry-run --json` → `[0].files[].path`.
**Alternatives**: `pnpm pack` then shell out to `tar -tzf`.
**Rationale**: `--dry-run --json` writes no tarball, needs no `tar` binary, and
returns a structured list. `apps/studio` declares no `prepack`/`prepare`, so the
dry run triggers no build and stays fast. `pnpm pack`'s `workspace:*` → version
rewrite affects `dependencies`, not the file list, so it buys nothing for this
assertion.

## Data Flow

    pnpm build (tsc -b --noEmit + vite build) ──→ apps/studio/dist/
                                                        │
    package.json files:["dist"] ──→ npm pack --dry-run --json
                                                        │
                                         pack-contents.mjs asserts
                                    dist/** + package.json, nothing else

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `apps/studio/package.json` | Modify | Delete line 5 `"private": true,`; add `"files": ["dist"]` after `"type": "module"` (compiler places it post-`exports`, pre-`scripts`) |
| `apps/studio/test/pack-contents.mjs` | Create | Guard: runs `npm pack --dry-run --json` in the package dir, fails if any path is outside `dist/` except `package.json`, or if `dist/index.html` is absent |
| `apps/studio/package.json` | Modify | `test` script chains the guard after `vitest run` |

## Interfaces / Contracts

Assertion contract for the guard (exit 1 with the offending paths listed):

- every packed path matches `^dist/` or equals `package.json`
- `dist/index.html` is present (catches an empty/stale build packing green)
- no `src/`, `node_modules/`, `.turbo/`, tsconfig, or dotfile paths

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Existing Studio components | Unchanged `vitest run` |
| Integration | Tarball shape | `pack-contents.mjs` in `pnpm test` |
| Manual | `indigodb studio` still resolves `dist` | Run the CLI once post-build; `resolveStudioDist()` is untouched |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file
classification, or process-integration boundary. The guard's `npm pack` call is a
fixed-argument test-time invocation with no user input.

## Migration / Rollout

No migration. Rollback = revert the commit; restoring `"private": true` returns
the package to unpublishable with no consumer impact.

## Open Questions

- [ ] None blocking. Note for the follow-up epic: `@indigodb/studio` still cannot
      be installed from a registry until its `workspace:*` deps
      (`@indigodb/client`, `@indigodb/core`) are published and given `files`
      fields — this change removes the *root* blocker only, as the proposal states.
