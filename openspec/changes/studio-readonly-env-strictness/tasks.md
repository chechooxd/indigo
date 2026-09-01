# Tasks: Studio read-only env var rejects malformed values

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~150-180 (util.ts ~30, index.ts ~15, test file rewrite ~100-130) |
| 800-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | auto-chain |
| Chain strategy | pending (not needed — single PR) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
800-line budget risk: Low

Single PR justified: one resolver rewrite in one file, one call-site move, one test file
migration — three tightly-coupled files, no independent shippable slice, well under budget.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Full change (resolver + wiring + tests) | PR 1 | `node packages/cli/test/studio-readonly-resolution.mjs` | `pnpm build --filter=@indigodb/cli && node packages/cli/test/studio-readonly-resolution.mjs` | `git revert`, or restore `isReadOnlyEnv` + OR-shaped body per design.md Rollback |

## Phase 1: RED — Migrate and extend the resolution test file

- [x] 1.1 In `packages/cli/test/studio-readonly-resolution.mjs`, drop `isReadOnlyEnv` import; import `throws` alongside `strictEqual`.
- [x] 1.2 Re-express the 3 `isReadOnlyEnv` positive checks as `resolveStudioReadOnly(undefined, v)` (`"1"`, `"true"`, `undefined` → `true`/`true`/`false`) — spec scenario "CLI flag or exact-match on env values enable" + "Unset env var and no flag leaves off".
- [x] 1.3 Add accepted-disable checks: `resolveStudioReadOnly(undefined, "0") === false` and `resolveStudioReadOnly(undefined, "false") === false` — spec scenario "Exact-match off env values keep read-only disabled".
- [x] 1.4 Add a single merged rejection loop over `"TRUE"`, `"True"`, `"yes"`, `""`, `" 1 "`, `"1.0"`, `"on"` asserting `throws(() => resolveStudioReadOnly(undefined, v), /INDIGODB_STUDIO_READONLY/)` — spec scenario "Malformed env values cause a loud startup failure".
- [x] 1.5 Add message-content checks: one throw asserts `/must be "1", "0", "true", or "false"/`; one throw on `" 1 "` asserts the quoted echo `/" 1 "/` — same scenario, message-shape sub-cases.
- [x] 1.6 Keep the 6 existing flag/env combo checks (rows 6-10 of design's table) plus add `resolveStudioReadOnly(false, "1") === true` (env still enables) if not already present — spec scenario "The CLI flag adds read-only but never suppresses env validation".
- [x] 1.7 Add `throws(() => resolveStudioReadOnly(true, "yes"))` — flag passed AND malformed env still rejects — spec scenario "A malformed env value is rejected even when the flag is passed" (this is the negative/absence case: mutation "short-circuit on `optionReadOnly === true`" must make this fail).
- [x] 1.8 Add `const m = await import("../dist/util.js"); strictEqual(m.isReadOnlyEnv, undefined)` — negative case: mutation "keep `isReadOnlyEnv` exported" must make this fail.
- [x] 1.9 Run `pnpm build --filter=@indigodb/cli && node packages/cli/test/studio-readonly-resolution.mjs` — confirm RED (throw-expecting checks fail against current lenient resolver; import-absence check fails since `isReadOnlyEnv` is still exported).

## Phase 2: GREEN — Rewrite the resolver

- [x] 2.1 In `packages/cli/src/util.ts`, delete `isReadOnlyEnv` and its doc comment.
- [x] 2.2 Rewrite `resolveStudioReadOnly`: resolve the env branch into a local FIRST (`"1"`/`"true"` → `true`, `"0"`/`"false"` → `false`, `env !== undefined` and unmatched → `throw new Error(\`INDIGODB_STUDIO_READONLY must be "1", "0", "true", or "false", got: ${JSON.stringify(env)}\`)`), THEN `return optionReadOnly === true || envResult`. Do NOT short-circuit on `optionReadOnly === true` before parsing env (design's flagged implementation trap).
- [x] 2.3 Replace the doc comment to state: pure, throws (never `process.exit`), env validated even when the flag is passed.
- [x] 2.4 Run `pnpm build --filter=@indigodb/cli && node packages/cli/test/studio-readonly-resolution.mjs` — confirm GREEN for all Phase 1 checks.

## Phase 3: RED — Wiring coverage (row 16, new spawn pattern)

- [x] 3.1 In `packages/cli/test/studio-readonly-resolution.mjs`, add a new check using `spawnSync` (import from `node:child_process`) that runs `process.execPath ["dist/index.js", "studio"]` with `INDIGODB_STUDIO_READONLY: "yes"` in `env`, `cwd` set to a fresh empty temp dir (`node:fs.mkdtempSync`), asserting `status === 1` and stderr matches `/INDIGODB_STUDIO_READONLY/` — spec requirement "exit non-zero before Studio binds to a port".
- [x] 3.2 Run the file — confirm this check fails RED (call currently sits outside the try/catch in `index.ts`, so the process crashes with an uncaught exception/non-matching exit path instead of the clean catch).

## Phase 4: GREEN — Move resolution inside the try/catch

- [x] 4.1 In `packages/cli/src/index.ts`, move `const readOnly = resolveStudioReadOnly(...)` inside the existing try block (~line 377), as the first resolution before `queryTimeoutMs`.
- [x] 4.2 Update the surrounding comment to state the env var is now validated inside this try/catch and can throw.
- [x] 4.3 Update `--read-only` help text (~line 308) to name all four accepted values and the reject-on-anything-else behavior.
- [x] 4.4 Run `pnpm build --filter=@indigodb/cli && node packages/cli/test/studio-readonly-resolution.mjs` — confirm all checks including row 16 are GREEN.

## Phase 5: Verification / Cleanup

- [x] 5.1 Run `pnpm build && pnpm lint && pnpm test` from repo root — confirm no other consumer referenced `isReadOnlyEnv` (lint catches any miss) and full suite is green.
- [x] 5.2 Grep repo for `isReadOnlyEnv` to confirm zero remaining references outside git history.
- [x] 5.3 Confirm `openspec/specs/studio-readonly-mode/spec.md` reflects the amended requirement (already done in commit `f118011` — no further edit expected).
