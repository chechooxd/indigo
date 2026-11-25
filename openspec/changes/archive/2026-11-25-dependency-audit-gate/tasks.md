# Tasks: Dependency Audit Gate

## Phase 1: RED Proof Suite

- [x] 1.1 Write `scripts/test-audit-gate.mjs` covering all hook scenarios (high-fail before build,
      moderate-pass, `ignoreCves`, GHSA-only `ignoreGhsas`, `SKIP_PREPUSH=1`, deletion-only).
- [x] 1.2 Run `INDIGODB_TEST_AUDIT=1 node scripts/test-audit-gate.mjs` against the unmodified
      `.githooks/pre-push` and confirm RED (high-severity fixture currently proceeds to build).

## Phase 2: Triage Real Repository Dependencies to Zero High/Critical Advisories

- [x] 2.1 Create `apps/studio/src/styles/shadcn-variants.css` with the MIT-licensed custom
      variants/keyframes from `shadcn/tailwind.css`, update `apps/studio/src/index.css` to import
      it, and remove `shadcn` from `apps/studio/package.json`.
- [x] 2.2 Bump `vitest` to `^4.1.12` in `apps/studio/package.json` and
      `packages/react/package.json`, and refresh patched transitive dev deps (`vite`,
      `browserslist`, `js-yaml`, `nanoid`, `source-map-js`) via `pnpm install` / `pnpm update`.
- [x] 2.3 Run `pnpm audit --audit-level=high` unmodified at the repo root and confirm exit 0.

## Phase 3: Wire Gate, Config, and Docs (GREEN)

- [x] 3.1 Add `pnpm.auditConfig: { ignoreCves: [], ignoreGhsas: [] }` to root `package.json` and
      append `node scripts/test-audit-gate.mjs` to root `scripts.test`.
- [x] 3.2 Add the fail-fast `pnpm audit --audit-level=high` step to `.githooks/pre-push` (after
      `SKIP_PREPUSH=1` and deletion-only check, before `build -> lint -> test`), referencing both
      `ignoreCves` and `ignoreGhsas` in the failure guidance.
- [x] 3.3 Document the audit gate and both `ignoreCves`/`ignoreGhsas` valves in `RELEASING.md`.
- [x] 3.4 Run `INDIGODB_TEST_AUDIT=1 node scripts/test-audit-gate.mjs` and confirm all scenarios
      GREEN.

## Phase 4: Mutation Proof & Full Verification

- [x] 4.1 Mutation proof: temporarily comment out the `exit 1` in `.githooks/pre-push`'s audit
      block, run `INDIGODB_TEST_AUDIT=1 node scripts/test-audit-gate.mjs`, confirm the high-fail
      scenario goes RED, then revert.
- [x] 4.2 Run `pnpm clean && pnpm build --force && pnpm lint && pnpm test` and confirm exit 0
      (including Studio and React tests under Vitest 4 and `test-audit-gate.mjs` default SKIP).
- [x] 4.3 Run `pnpm audit --audit-level=high` unmodified at the repo root and confirm exit 0.
- [x] 4.4 Write `verify-report.md` and `archive-report.md`, merge canonical spec, archive, and
      fast-forward `main` + delete branch.
