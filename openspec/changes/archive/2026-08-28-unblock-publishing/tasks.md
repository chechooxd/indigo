# Tasks: Unblock publishing of @indigodb/studio

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~50-70 (2-line package.json edit + ~50-line new guard test) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | single-pr |
| Chain strategy | size-exception |

Decision needed before apply: Yes
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Make `@indigodb/studio` publishable and guard the tarball shape | PR 1 | `pnpm build --filter=@indigodb/studio && pnpm --filter @indigodb/studio test` | `npm pack --dry-run` in `apps/studio` after build | Revert the single commit; restores `"private": true` with no consumer impact |

## Phase 1: Package Metadata

- [x] 1.1 In `apps/studio/package.json`, remove the `"private": true,` line.
- [x] 1.2 In `apps/studio/package.json`, add `"files": ["dist"]` immediately after `"type": "module"`, matching `packages/compiler/package.json`'s placement convention.
- [x] 1.3 Confirm no `exports` field is added or present in `apps/studio/package.json` (would break `require.resolve("@indigodb/studio/package.json")` in `packages/cli/src/studio-server.ts:135`).

## Phase 2: Pack-Contents Guard (RED → GREEN)

- [x] 2.1 RED: Create `apps/studio/test/pack-contents.mjs` that runs `npm pack --dry-run --json` in `apps/studio`, parses `[0].files[].path`, and asserts every path matches `^dist/` except exactly `package.json`; run it against current `apps/studio/package.json` (still `private`/no `files`) to confirm it fails or is inapplicable before Phase 1 lands.
- [x] 2.2 GREEN: In `pack-contents.mjs`, add the assertion that `dist/index.html` is present in the packed list (catches empty/stale `dist/` per spec scenario "dry-run pack before a build").
- [x] 2.3 GREEN: In `pack-contents.mjs`, make the script exit `1` and print the offending paths when any packed path is outside `dist/` (excluding `package.json`) or `dist/index.html` is missing; exit `0` otherwise.
- [x] 2.4 Run `pnpm build --filter=@indigodb/studio` then `node apps/studio/test/pack-contents.mjs` directly and confirm it passes against the Phase 1 `package.json`.

## Phase 3: Wire Into Test Script

- [x] 3.1 In `apps/studio/package.json`'s `"scripts"."test"`, change to `"vitest run && node test/pack-contents.mjs"`, preserving the existing `vitest run` step.
- [x] 3.2 Confirm `apps/studio`'s Turbo `test` task still declares `dependsOn: ["build"]` with `dist/**` outputs (no change expected — verify only) so the guard always runs against a fresh `dist/`.

## Phase 4: Verification

- [x] 4.1 Run `pnpm build`, `pnpm lint`, `pnpm test` from the repo root and confirm all three are green with no new failures.
- [x] 4.2 Run `npm pack --dry-run` inside `apps/studio` after `pnpm build` and manually confirm the reported file list is exactly `dist/**` plus `package.json` (no `src/`, no `node_modules/`, no README/LICENSE since neither exists).
- [x] 4.3 Run `indigodb studio` (or exercise `packages/cli/src/studio-server.ts`'s `resolveStudioDist()` path directly) and confirm the SPA still serves from `dist/`, and that misconfiguring `INDIGODB_STUDIO_DIST` still triggers the `FALLBACK_PAGE`/API-only degradation unchanged.
