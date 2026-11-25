# Archive Report: dependency-audit-gate

**Date Archived**: 2026-11-25
**Branch**: `dependency-audit-gate`
**Verdict**: PASS — 5/5 requirements, 7/7 fixture scenarios, real repo unmodified exit 0

## Summary

Landed the dependency-audit gate spun out from `release-engineering` (`87d54bb`), resolving both
defects that previously forced its descope:
1. Eliminated all 36 high/critical advisories in the real repository without any suppressions by
   removing the unused runtime `shadcn` CLI dependency from `apps/studio` (inlining its MIT-licensed
   Tailwind custom variants into `apps/studio/src/styles/shadcn-variants.css`), upgrading `vitest`
   to `^4.1.12` (dropping `tinypool`), and refreshing patched transitive dev deps (`vite`,
   `browserslist`, `js-yaml`, `nanoid`, `source-map-js`).
2. Wired fail-fast `pnpm audit --audit-level=high` into `.githooks/pre-push` ahead of
   `build -> lint -> test`, with both `pnpm.auditConfig.ignoreCves` and
   `pnpm.auditConfig.ignoreGhsas` declared in root `package.json`, documented in `RELEASING.md`,
   and proven against live CVE and GHSA-only fixtures (`scripts/test-audit-gate.mjs`).

## Spec Merge

- NEW canonical spec: `openspec/specs/dependency-audit-gate/spec.md` (5 requirements, 7 scenarios),
  copied byte-identically from the change's delta spec.
