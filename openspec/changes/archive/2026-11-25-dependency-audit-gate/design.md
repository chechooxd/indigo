# Design: Dependency Audit Gate

## Technical Approach

Two coordinated tracks: (1) eliminate the 36 existing high/critical advisories in the real
repository so the gate lands against a clean zero-exception baseline, and (2) wire the fail-fast
audit check into `.githooks/pre-push` with both CVE and GHSA escape valves verified by live
fixtures and mutation proofs.

## Architecture Decisions

### Decision 1: Inline `shadcn/tailwind.css` custom variants and drop `shadcn` from `apps/studio`

| Option | Tradeoff | Decision |
|---|---|---|
| Move `shadcn` to `devDependencies` | Still keeps 27 high/critical advisories in `pnpm audit --audit-level=high` (CLI pulls `@modelcontextprotocol/sdk`, `@dotenvx/dotenvx`, `systeminformation`, `undici`) | Rejected |
| Suppress 27 advisories via `ignoreGhsas` | Permanent security blind spot for a CLI tool never imported at runtime; `@indigodb/cli` consumers would still download 100+ unneeded packages | Rejected |
| Inline the MIT-licensed `@custom-variant` / keyframe rules into `apps/studio/src/styles/shadcn-variants.css` and remove `shadcn` | Zero runtime bloat for `@indigodb/cli` consumers, eliminates 27 advisories cleanly, CSS output preserved identically | **Chosen** |

**Verified usage**: `grep -rn "shadcn" apps packages` confirms `apps/studio/src/index.css:4`
(`@import "shadcn/tailwind.css";`) is the ONLY code reference to `shadcn`. Components in
`apps/studio/src/components/ui/` use `data-open`, `data-closed`, `data-disabled`,
`data-horizontal`, and `data-vertical`.

### Decision 2: Upgrade `vitest` to `^4.1.12` (drops `tinypool`) and refresh patched dev deps

| Option | Tradeoff | Decision |
|---|---|---|
| Override `tinypool` to `>=2.1.2` under Vitest 3 | Major-version override under Vitest 3 risks subtle worker pool breakage | Rejected |
| Upgrade `vitest` to `^4.1.12` (verified peerDep `vite: "^6.0.0 \|\| ^7.0.0 \|\| ^8.0.0"`, zero `tinypool` dependency) + refresh patch versions of `vite`, `browserslist`, `js-yaml`, `nanoid`, `source-map-js` | Eliminates all 9 remaining high/critical advisories cleanly without overrides or ignores | **Chosen** |

### Decision 3: Pressure valve supports both `ignoreCves` and `ignoreGhsas`

Live probe on `pnpm@10.28.1` confirmed `pnpm.auditConfig.ignoreGhsas` in root `package.json`
suppresses GHSA-only advisories (`cves: []`, e.g. `js-yaml@4.1.0`'s `GHSA-5p4m-2wfm-xmqj`) and
exits 0. Both `ignoreCves: []` and `ignoreGhsas: []` are declared explicitly in root
`package.json` so the shape is self-documenting, while staying empty at launch because the real
repo has zero high/critical advisories.

### Decision 4: Hook ordering and offline test default

`.githooks/pre-push` runs `pnpm audit --audit-level=high` immediately after `SKIP_PREPUSH=1` and
the deletion-only check, and BEFORE `for step in build lint test` so a vulnerable dependency fails
in seconds rather than after ~8 minutes. `scripts/test-audit-gate.mjs` is wired into root `test`
but prints `SKIP` and exits 0 unless `INDIGODB_TEST_AUDIT=1` is set (matching the
`INDIGODB_TEST_DATABASE_URL` convention so `pnpm test` stays network-free by default).

## File Changes

| File | Action | Description |
|---|---|---|
| `apps/studio/src/styles/shadcn-variants.css` | Create | MIT-licensed Tailwind custom variants previously imported from `shadcn/tailwind.css` |
| `apps/studio/src/index.css` | Modify | Import `./styles/shadcn-variants.css` instead of `shadcn/tailwind.css` |
| `apps/studio/package.json` | Modify | Remove `shadcn` from `dependencies`; bump `vitest` to `^4.1.12` |
| `packages/react/package.json` | Modify | Bump `vitest` to `^4.1.12` |
| `pnpm-lock.yaml` | Modify | Drop `shadcn` tree, upgrade `vitest` and patched transitive dev deps |
| `package.json` (root) | Modify | Add `pnpm.auditConfig` (`ignoreCves: []`, `ignoreGhsas: []`) and wire `scripts/test-audit-gate.mjs` into `test` |
| `.githooks/pre-push` | Modify | Add fail-fast `pnpm audit --audit-level=high` step before `build -> lint -> test` |
| `RELEASING.md` | Modify | Document the audit gate and both `ignoreCves` / `ignoreGhsas` valves |
| `scripts/test-audit-gate.mjs` | Create | Real-hook fixture test suite (opt-in on `INDIGODB_TEST_AUDIT=1`) |

## Testing Strategy

1. **Fixture proofs (`INDIGODB_TEST_AUDIT=1 node scripts/test-audit-gate.mjs`)** against the REAL
   `.githooks/pre-push`:
   - High-severity CVE fixture (`ansi-regex@3.0.0`, `CVE-2021-3807`) → hook exits non-zero,
     `BUILD_MARKER` absent.
   - Same fixture with `pnpm.auditConfig.ignoreCves: ["CVE-2021-3807"]` → hook exits 0,
     `BUILD_MARKER`, `LINT_MARKER`, `TEST_MARKER` all written.
   - GHSA-only high-severity fixture (`js-yaml@4.1.0` with `GHSA-5p4m-2wfm-xmqj`, `cves: []`, plus
     its two companion GHSAs) → fails without `ignoreGhsas`, passes with `ignoreGhsas`, proves
     `ignoreCves`-only cannot suppress the GHSA-only advisory.
   - Moderate-only fixture (`xml2js@0.4.19`) → hook exits 0 (`--audit-level=high` negative
     control) and runs `build`/`lint`/`test`.
   - `SKIP_PREPUSH=1` on high-severity fixture → hook exits 0, no audit failure, no markers.
   - Deletion-only push (`0000...` local SHA) on high-severity fixture → hook exits 0, "nothing
     to verify", no markers.
2. **Real-repository gate proof (mandatory per `#1251`)**: run `pnpm audit --audit-level=high`
   unmodified at the repo root and record exit 0.
3. **Mutation proofs**: temporarily weaken `.githooks/pre-push` (e.g. drop the audit block or
   remove `exit 1`) and confirm `test-audit-gate.mjs` goes red on the high-severity scenario;
   revert and re-verify green.
