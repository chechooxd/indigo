# Apply Progress: Redact bound parameter values from client statement logging

**Mode**: Strict TDD (RED -> GREEN -> REFACTOR, plus mandatory two-sided mutation proof)
**Status**: 20/20 tasks complete. Ready for verify.

## Completed Tasks

### Phase 1: RED
- [x] 1.1 Scenario 1 case (log:true, no extensions, non-empty sentinel)
- [x] 1.2 Scenario 2 case (log:false and log omitted)
- [x] 1.3 Scenario 3 case (sql-rewriting extension, sentinel passed through)
- [x] 1.4 Scenario 4 case (empty params -> `(0 params)`)
- [x] 1.5 Scenario 5 case (`$transaction`/`$withSession` path)
- [x] 1.6 Multi-shape params case (Date, null, array, Buffer)
- [x] 1.7 Base executor still receives real values case
- [x] 1.8 Confirmed RED: rows 1, 3, 5 failed on sentinel-membership assertion; row 4 flipped on the `(0 params)` constant; row 6 flipped on uniform-placeholder assertion; rows 2 and 7 already passed unchanged

### Phase 2: GREEN
- [x] 2.1 Added module-scope `redactParams(params: unknown[]): string` in `client.ts` (not exported)
- [x] 2.2 `wrapLog` now emits `redactParams(params)` in argument position 2
- [x] 2.3 Updated `log?: boolean` doc comment at `client.ts:56-62`
- [x] 2.4 Updated `wrapLog` doc comment
- [x] 2.5 Updated `extensions` doc comment ("with parameter values redacted")

### Phase 3: Mutation proof + verification
- [x] 3.1 Temporarily reverted `wrapLog` to raw `params`
- [x] 3.2 Confirmed rows 1, 3, 5 turned red **on their own sentinel-membership assertion** (error messages named the leaked sentinel `hunter2-SENTINEL`), not a `TypeError`
- [x] 3.3 Confirmed rows 2, 7 stayed green under the revert (unaffected); rows 4, 6 flipped red as expected (they depend on the redaction branch too, not just the sentinel)
- [x] 3.4 Restored the `redactParams` call; re-ran `node packages/client/test/extensions.mjs` -> all cases green (existing `:98-115` unchanged + 7 new cases)
- [x] 3.5 Ran `pnpm build && pnpm lint && pnpm test` (see Work Unit Evidence) -> green

### Phase 4: Spec landing
- [x] 4.1 Confirmed `openspec/changes/client-log-redaction/specs/client-query-extensions/spec.md` reuses the exact title `### Requirement: Extension composition order and wrapLog placement`
- [x] 4.2 Did not touch `openspec/specs/client-query-extensions/spec.md` (canonical merge is `sdd-archive`'s job)

## Files Changed

| File | Action | What Was Done |
|------|--------|---------------|
| `packages/client/src/client.ts` | Modified | Added module-scope `redactParams`; `wrapLog` emits redacted placeholders instead of raw params; updated 3 doc comments (`log?:` option, `wrapLog`, `extensions`) |
| `packages/client/test/extensions.mjs` | Modified (additive) | Appended 7 new hermetic test cases after existing suite; `:98-115` untouched |
| `openspec/changes/client-log-redaction/tasks.md` | Modified | All 20 tasks marked `[x]` |

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1.1-1.7/2.1-2.2 | `packages/client/test/extensions.mjs` | Unit (hermetic, stubExecutor) | Pre-existing 20 checks passing before edit | Written first; confirmed red (1,3,4,5,6 failed) | Implemented `redactParams` + wrapLog call; all 27 checks passed | 7 scenario combinations from design's Testing Strategy table (no-extension, disabled, rewrite, empty, transaction, mixed-shape, base-executor) | No further refactor needed — single small helper, single call-site change |

## Mutation Proof (mandatory, two-sided)

Reverted `wrapLog` locally to `console.log("[indigodb]", sql, params)`, rebuilt, ran `node packages/client/test/extensions.mjs`:
- Row 1 (`bound parameter values never appear...no extensions`): **RED** — `Error: expected the sentinel to be absent from stdout; found it in: [["[indigodb]","SELECT 1",["hunter2-SENTINEL"]]]`
- Row 3 (`redaction holds when an extension rewrites sql`): **RED** — same sentinel-membership failure, sentinel found in captured stdout
- Row 5 (`redaction holds inside $transaction/$withSession`): **RED** — same sentinel-membership failure inside `$transaction`
- Row 2 (`log: false and log omitted`): stayed **GREEN** (unaffected — no log line emitted either way)
- Row 4 (`empty params print the (0 params) constant`): flipped **RED** (`got: ` empty string instead of `(0 params)`) — expected, this row depends on the redaction branch's constant, not just the sentinel
- Row 6 (`redacted placeholders render identically regardless of shape`): flipped **RED** (raw `Date`/array/Buffer values printed) — expected, same reason as row 4
- Row 7 (`base executor still receives real values`): stayed **GREEN** (unaffected — asserts the stub, not stdout)

All 5 failures were assertion failures naming the leaked value or wrong constant, never a `TypeError` or crash. Restored the `redactParams` call, rebuilt, re-ran: all 27 checks green again.

## Work Unit Evidence

| Evidence | Result |
|---|---|
| Focused test command and exact result | `node packages/client/test/extensions.mjs` -> `@indigodb/client extensions: all checks passed` (27/27, 7 new + 20 pre-existing) |
| Runtime harness command/scenario and exact result | `pnpm clean && pnpm build --force`: 11/11 tasks successful. `pnpm lint`: 21/21 successful. `pnpm test`: 20/20 tasks successful, exit code 0, including `@indigodb/cli`'s full suite (24/24 files), workspace pack-contents guard, release cohort guard, and the realtime DB-gate check. `@indigodb/realtime`'s Postgres-gated suites printed no gate violation (`INDIGODB_TEST_DATABASE_URL` unset, correctly skipped). |
| Rollback boundary | Single commit `07e18c9` on branch `client-log-redaction` reverts `client.ts` (`redactParams` + `wrapLog` + 3 doc comments), the additive `extensions.mjs` block, `tasks.md`'s checkboxes, and the 4 previously-untracked planning artifacts (`proposal.md`, `exploration.md`, `design.md`, `specs/client-query-extensions/spec.md`) together, in one revert. |

## Deviations from Design

None — implementation matches design exactly: three-argument shape preserved, module-scope non-exported helper, uniform `<redacted>` placeholder regardless of parameter type, `(0 params)` constant for empty arrays, redaction covers both `this.exec` and `$withSession`/`$transaction` paths identically.

## Issues Found

None. The `types.ts` citation correction from design.md was independently re-verified: `rg 'log\?:' packages/client/src/types.ts` returns nothing; the option lives only in `client.ts:56-62`.

## Workload / PR Boundary

- Mode: single PR (only work unit; forecast: Low risk, ~120-160 lines, no chaining)
- Current work unit: `client-log-redaction-single-pr`
- Boundary: this apply batch starts from the RED test authoring and ends with the committed fix + spec-delta landing checkpoint + all tasks marked complete
- Estimated review budget impact: 203 changed lines (33 in `client.ts`, 176 additive+... in `extensions.mjs`, net insertions/deletions 203 total per `git diff --stat`) — comfortably under both the 400-line default and the 800-line project budget

## Status

20/20 tasks complete. Ready for verify.
