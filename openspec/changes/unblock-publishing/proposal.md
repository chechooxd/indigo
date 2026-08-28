# Proposal: Unblock publishing of @indigodb/studio

## Intent

`packages/cli` depends on `@indigodb/studio` as a normal `workspace:*` dependency, but
`apps/studio/package.json` carries `"private": true`. A private package can never be
resolved from a registry, so the dependency chain of `@indigodb/cli` is unpublishable at
its root. This change removes that hard blocker and makes the Studio SPA tarball
well-formed (`dist/` only, no `src/`, no stray files), which is the prerequisite for the
later release-engineering epic.

## Scope

### In Scope
- `apps/studio/package.json`: remove `"private": true`.
- `apps/studio/package.json`: add `"files": ["dist"]`, matching the `@indigodb/compiler`
  precedent (the only existing correct allowlist in the repo).
- Confirm (no edit expected) that `@indigodb/studio` stays a plain `dependencies` entry in
  `packages/cli/package.json`.
- Verification that `npm pack --dry-run` for `@indigodb/studio` contains the built SPA
  (index.html, JS/CSS bundles, woff2 fonts, inlined compiler WASM) and nothing else.

### Out of Scope (explicit non-goals)
- **This change does NOT make `npm install @indigodb/cli` work end-to-end.** `packages/cli`
  itself has no `files` field; since `dist/` is gitignored repo-wide, its own tarball would
  ship `src/` and omit `dist/`. That is the next blocker after this one.
- The same missing-`files` defect in `ast`, `parser`, `core`, `migrator`, `generator`,
  `realtime`, `client` — the broader "Release engineering" epic.
- Changesets, `publishConfig.access`, `engines` floor, npm provenance, dependency-audit job.
  No `.changeset/` or publish pipeline exists yet and none is created here.
- Any change to `packages/cli/src/studio-server.ts`. Its `resolveStudioDist()` try/catch plus
  `FALLBACK_PAGE`/API-only degradation already handles a missing dist and stays as the
  fallback for `INDIGODB_STUDIO_DIST` misconfiguration and dev-without-build.

## Capabilities

### New Capabilities
- `studio-package-publishability`: `@indigodb/studio` is publishable and its tarball contains
  exactly the built SPA required by the CLI's Studio server.

### Modified Capabilities
- None.

## Approach

Exploration Option A (root-cause metadata fix). Two-key edit to one JSON file. No runtime,
build, or server code changes. Publishability is asserted by packing the tarball and
inspecting its file list, not by publishing to a registry.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/studio/package.json` | Modified | Drop `private`, add `files: ["dist"]` |
| `packages/cli/package.json` | Unchanged | Verified only — dependency shape stays as-is |
| `packages/cli/src/studio-server.ts` | Unchanged | Existing fallback already sufficient |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Reader assumes CLI install now works | High | Non-goals state the CLI `files` gap explicitly |
| Tarball ships unintended files | Low | `files: ["dist"]` allowlist + `npm pack --dry-run` check |
| Publishing an unfinished SPA publicly | Med | No publish happens here; metadata only |
| `dist/` gitignored, so a stale/absent build packs empty | Med | Pack check must run after `pnpm build` |

## Rollback Plan

Revert the single commit touching `apps/studio/package.json`. Restoring `"private": true`
returns the package to unpublishable; no consumer, build output, or runtime path depends on
the removed flag.

## Dependencies

- None. Zero-dependency epic, promoted first in the reordered Phase 6 work list.

## Success Criteria

- [ ] `apps/studio/package.json` has no `private` key and has `"files": ["dist"]`.
- [ ] After `pnpm build`, `npm pack --dry-run` in `apps/studio` lists `dist/**` plus
      `package.json`/README only — no `src/`, no `node_modules`.
- [ ] `pnpm build`, `pnpm lint`, `pnpm test` stay green.
- [ ] `indigodb studio` still serves the built SPA locally (no regression in dist resolution).
- [ ] Proposal record names the CLI `files` gap as the next required item.

## Proposal question round

Execution mode is `auto` (non-interactive), so these assumptions were taken without asking.
Flag any that are wrong before `sdd-apply`:
1. Publishing `@indigodb/studio` publicly is acceptable now (pre-1.0 SPA source is already in
   a repo the team intends to publish from).
2. Shipping the SPA inside the CLI install is preferred over an opt-in
   `optionalDependencies` + API-only default (Option B was rejected as a false fix).
3. `files: ["dist"]` is the intended allowlist — no README/LICENSE requirement beyond npm's
   automatic inclusions.
