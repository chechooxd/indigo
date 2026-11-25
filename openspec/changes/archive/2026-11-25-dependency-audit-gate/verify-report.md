# Verify Report: dependency-audit-gate

**Date**: 2026-11-25
**Branch**: `dependency-audit-gate`
**Verdict**: PASS — archive-ready

## Task Completion

All 12 tasks across Phases 1-4 complete (`tasks.md`).

## Real-Repository Audit Proof (per `#1251`)

- Before triage: `pnpm audit --audit-level=high` exited `1` (121 total: 33 high, 3 critical; 27
  via `apps/studio`'s runtime `shadcn` dependency, 9 via outdated dev deps).
- After removing `shadcn` (inlining its MIT custom variants into
  `apps/studio/src/styles/shadcn-variants.css`), upgrading `vitest` to `^4.1.12` (dropping
  `tinypool`), and refreshing 4 patched transitive dev deps (`js-yaml`, `nanoid`, `browserslist`,
  `source-map-js`):
  - `pnpm audit --audit-level=high` at repo root with `ignoreCves: []`, `ignoreGhsas: []`:
    **exit 0** (22 total: 7 low, 15 moderate, **0 high, 0 critical**).
  - `node_modules` shrunk by 236 packages (`Packages: +19 -236`).

## Fixture & Mutation Proofs

| Scenario | Result |
|---|---|
| High advisory (`ansi-regex@3.0.0`) fails before `build` | PASS (RED before hook edit: `exit=0, buildRan=true`; GREEN after: `exit=1, buildRan=false`) |
| `ignoreCves` suppresses CVE-bearing advisory (`CVE-2021-3807`) | PASS (`exit=0`, all markers) |
| GHSA-only advisory (`js-yaml@4.1.0`, `GHSA-5p4m-2wfm-xmqj`, `cves: []`) fails with `ignoreCves`-only | PASS (`exit=1, buildRan=false`) |
| `ignoreGhsas` suppresses GHSA-only advisory | PASS (`exit=0`, all markers) |
| Moderate-only advisory (`xml2js@0.4.19`) passes `--audit-level=high` | PASS (`exit=0`, all markers) |
| `SKIP_PREPUSH=1` bypasses audit and `build`/`lint`/`test` | PASS (`exit=0`, no markers) |
| Deletion-only ref skips audit and `build`/`lint`/`test` | PASS (`exit=0`, no markers) |
| Default `node scripts/test-audit-gate.mjs` (env unset) | PASS (`SKIP`, exit 0) |
| Mutation proof (commented out `exit 1` in `.githooks/pre-push`) | BIT — both high-fail and GHSA-only-fail went RED (`5/7 passed`), reverted cleanly |

## Build / Lint / Test

- `pnpm --filter @indigodb/studio build`: exit 0 (`dist/assets/index-*.css` built with inlined variants)
- `pnpm --filter @indigodb/studio test`: exit 0 (34/34 files, 281/281 tests under Vitest 4.1.12, `pack-contents: OK`)
- `pnpm --filter @indigodb/react test`: exit 0 (2/2 files, 12/12 tests under Vitest 4.1.12, `browser-safety: ok`)
- `pnpm lint`: exit 0 (21/21 Turbo tasks)
- Root guards (`check-pack-contents`, `check-release-cohort`, `check-realtime-projection-db-gate`, `test-audit-gate` default SKIP): exit 0
