# Proposal: Dependency Audit Gate

## Intent

`release-engineering` (`853aa22`) built IndigoDB's changesets, publish metadata, and release
cohort guard, but descoped its dependency-audit gate (`87d54bb`) for two verified defects:

1. **The real repository failed the gate immediately** — `pnpm audit --audit-level=high` exited 1
   because `apps/studio` carried the `shadcn` CLI in runtime `dependencies` solely to `@import
   "shadcn/tailwind.css"` (pulling 27 high/critical advisories into `@indigodb/studio` and
   transitively into `@indigodb/cli`), alongside 6 outdated dev-only dependencies (`vitest`/
   `tinypool`, `vite`, `browserslist`, `js-yaml`, `nanoid`, `source-map-js`) whose patched
   versions already exist upstream.
2. **The documented pressure valve could not suppress GHSA-only advisories** — `ignoreCves`
   matches CVE identifiers only, leaving advisories with `cves: []` (such as
   `GHSA-5p4m-2wfm-xmqj`) unsuppressible. Live verification on `pnpm@10.28.1` confirms
   `pnpm.auditConfig.ignoreGhsas` in root `package.json` suppresses GHSA-only advisories cleanly.

This change triages all high/critical advisories in the real repository down to zero, wires the
fast-fail `pnpm audit --audit-level=high` gate into `.githooks/pre-push` ahead of the ~8-minute
`build -> lint -> test` loop, documents both `ignoreCves` and `ignoreGhsas` valves in the hook
and `RELEASING.md`, and proves both the fixture suite AND the real unmodified repository pass.

## Scope

### In Scope
- Remove `shadcn` from `apps/studio/package.json` `dependencies` and inline the MIT-licensed
  Tailwind custom-variant rules it supplied into `apps/studio/src/styles/shadcn-variants.css`.
- Upgrade/refresh the 6 outdated dev-only packages (`vitest` to `^4.1.12`, which drops `tinypool`,
  plus lockfile patch refreshes for `vite`, `browserslist`, `js-yaml`, `nanoid`, `source-map-js`)
  so `pnpm audit --audit-level=high` exits 0 on the real repo with empty ignore lists.
- Wire `pnpm audit --audit-level=high` as the first step in `.githooks/pre-push` (after
  `SKIP_PREPUSH=1` and the deletion-only check, before `build -> lint -> test`).
- Add `pnpm.auditConfig: { ignoreCves: [], ignoreGhsas: [] }` to root `package.json` and document
  both valves in `.githooks/pre-push` and `RELEASING.md`.
- Add `scripts/test-audit-gate.mjs` (opt-in via `INDIGODB_TEST_AUDIT=1`, `SKIP` by default so
  `pnpm test` stays offline-safe) proving high-fail, moderate-pass, CVE ignore, GHSA-only ignore,
  `SKIP_PREPUSH=1`, and deletion-only short-circuit against the real `.githooks/pre-push`.

### Out of Scope
- Auditing moderate/low advisories as hard failures (too much dev-transitive churn).
- Re-enabling `.github/workflows-disabled/ci.yml` or npm provenance.
- Publishing to npm.
- Any `crates/` change (no `build:wasm` rerun needed).

## Capabilities

### New Capabilities
- `dependency-audit-gate`: fail-fast `pnpm audit --audit-level=high` gate in `.githooks/pre-push`
  with CVE + GHSA pressure valves and verified zero high/critical baseline on the real repo.

### Modified Capabilities
- None.

## Rollback Plan

Revert the branch commits. Every piece reverts cleanly: restore `"shadcn": "^4.13.0"` and the
CSS import, revert `pnpm-lock.yaml` + `vitest` version, revert `.githooks/pre-push`, root
`package.json`, `RELEASING.md`, and remove `scripts/test-audit-gate.mjs`.

## Success Criteria

- [ ] `pnpm audit --audit-level=high` exits 0 unmodified at the IndigoDB repo root with empty
      `ignoreCves` and `ignoreGhsas`.
- [ ] `INDIGODB_TEST_AUDIT=1 node scripts/test-audit-gate.mjs` passes all scenarios, including
      GHSA-only suppression via `ignoreGhsas`.
- [ ] `pnpm build && pnpm lint && pnpm test` passes cleanly (including Studio and React under
      Vitest 4).
