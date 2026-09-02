# Apply Progress: Schema printer fidelity — PR 1 (Phase 1)

**Change**: `schema-printer-fidelity` · **Phase**: `sdd-apply` (PR 1 of the `stacked-to-main` chain)
**Mode**: Strict TDD (active) · **Branch**: `feat/schema-printer-fidelity-1` (based on `main`@`968f8de`)

## Scope

Phase 1 only (`## Phase 1: PR 1 — @@allow, @@realtime(columns:), TableGroup`), tasks 1.1–1.23.
Phase 2 (relations) and Phase 3 (cross-package verification) are explicitly out of scope for this
batch and are untouched — `tasks.md` still shows them as `[ ]`.

## Completed Tasks (23/23)

- [x] 1.1 Regression guard (baseline before any edit)
- [x] 1.2 RED — `@@realtime(columns:)` non-empty list unit test
- [x] 1.3 RED — `@@realtime(columns: [])` empty-list unit test (load-bearing negative control)
- [x] 1.4 GREEN — `printTable`'s `realtimeColumns` branch
- [x] 1.5 RED — `@@allow` multiple rules in IR order + claim operand
- [x] 1.6 GREEN — `printAllowOperand`/`printAllowRule`, wired into `printTable`
- [x] 1.7 RED — field operand prints schema field name, not mapped `dbName`
- [x] 1.8 GREEN + mutation proof (fieldNameFor swap) — see Mutation Proofs below
- [x] 1.9 RED/confirm — `write`/`all` sugar never re-collapsed (18-allow-rules.indigo unit assertion)
- [x] 1.10 GREEN (no fix needed — 1.6's per-rule iteration already correct)
- [x] 1.11 RED — `TableGroup` blocks print after model/enum blocks
- [x] 1.12 GREEN — `printTableGroup`, wired into `printSchema`
- [x] 1.13 RED — 04-tablegroup-edge.indigo "last group wins" overlap round-trip
- [x] 1.14 GREEN (no fix needed — verbatim array-order emission already reproduces the overlap)
- [x] 1.15 RED — TableGroup source (not derived `table.color`/`table.group`) drives printing
- [x] 1.16 GREEN (no fix needed — `printTableGroup` already reads only `group.*`)
- [x] 1.17 `normalizeForRoundTrip` rewrite — deleted `tableGroups`/`color`/`group`/`allow`/`realtimeColumns` exclusions; kept `foreignKeys`/`relations` (PR 2) and index re-bucketing (permanent)
- [x] 1.18 Full fixture round-trip loop — 04/18/20 now pass on real printed text
- [x] 1.19 Confirmed inline comment on the index-rebucketing line names `indexes` and the reason
- [x] 1.20 MUTATION (required) — re-added `allow` deletion, confirmed RED, reverted — see below
- [x] 1.21 Added `19-rejected-allow.indigo` and `21-rejected-realtime-columns.indigo` to `UNPRINTABLE_FIXTURES`, each with a written per-fixture reason
- [x] 1.22 Reachability guard — round-trip log line reports `18/21` (matches expectation: 21 total − 3 permanent exclusions)
- [x] 1.23 Full `node packages/core/test/print.mjs` green (55/55 checks)

## Files Changed

| File | Action | What Was Done |
|------|--------|----------------|
| `packages/core/src/print.ts` | Modified | Added `printAllowOperand`, `printAllowRule` (new, per design D6 — does NOT extend `printAttributeValue`); added `printTableGroup`; added `realtimeColumns` branch in `printTable` (emits `@@realtime(columns: [...])`, including `[]`, before falling back to bare `@@realtime`); wired `allow` rules and `tableGroups` blocks into `printTable`/`printSchema` respectively, in D7's block-attribute order (`@@map → @@unique → @@index → @@realtime → @@allow → @@note`) |
| `packages/core/test/print.mjs` | Modified | Added unit tests for `@@realtime(columns:)` (non-empty + empty), `@@allow` (order, claim operand, field-operand mapping, write/all expansion via fixture), `TableGroup` (order, overlap round-trip, source-of-truth); rewrote `normalizeForRoundTrip` docstring + body to delete 5 of 7 prior exclusions (kept `foreignKeys`/`relations` for PR 2, kept index re-bucketing permanently); extended `UNPRINTABLE_FIXTURES` to 3 entries with per-fixture reasons; updated the throw-confirmation loop comment |

No other files were touched. `packages/cli/src/util.ts` and `packages/migrator/test/pull-roundtrip.mjs` remain byte-unmodified (confirmed via `git status`/`git diff --stat` and by `pull-roundtrip.mjs` staying green in the root test run).

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1.2/1.3/1.4 | `packages/core/test/print.mjs` | Unit | ✅ 36/36 (baseline, task 1.1) | ✅ Written, confirmed failing (both assertions threw/failed) | ✅ Passed after `printTable` branch added | ✅ 2 cases (non-empty + empty list) | ➖ None needed |
| 1.5/1.6 | `packages/core/test/print.mjs` | Unit | ✅ (above) | ✅ Written, confirmed failing | ✅ Passed after `printAllowOperand`/`printAllowRule` added | ✅ 2 operand kinds (field, claim) × order assertion | ➖ None needed |
| 1.7/1.8 | `packages/core/test/print.mjs` | Unit | ✅ (above) | ✅ Written, confirmed failing (false-negative in first draft fixed — see Issues below) | ✅ Passed | ✅ Mutation proof (see below) is the triangulating case | ➖ None needed |
| 1.9/1.10 | `packages/core/test/print.mjs` | Unit (fixture-derived) | ✅ (above) | N/A — confirmed already-correct behavior, no production change needed | ✅ Passed on first run | ➖ Single (three-action expansion is one scenario) | ➖ None needed |
| 1.11/1.12 | `packages/core/test/print.mjs` | Unit | ✅ (above) | ✅ Written, confirmed failing | ✅ Passed after `printTableGroup` + `printSchema` wiring | ➖ Single (structural — one block shape) | ➖ None needed |
| 1.13/1.14 | `packages/core/test/print.mjs` | Fixture round trip | ✅ (above) | ✅ Written, confirmed failing (tableGroups zeroed by normalizer) | ✅ Passed once normalizer exclusion for `tableGroups` was removed (1.17) | ➖ Single (04-tablegroup-edge is the one fixture testing this) | ➖ None needed |
| 1.15/1.16 | `packages/core/test/print.mjs` | Unit | ✅ (above) | ✅ Written, confirmed failing | ✅ Passed on first run (no fix needed) | ➖ Single | ➖ None needed |
| 1.17/1.18 | `packages/core/test/print.mjs` | Fixture round trip (18 fixtures) | ✅ (above) | N/A — refactor of comparison logic | ✅ All 18 in-scope fixtures pass | ✅ Exercises 04/18/20 specifically (the 3 newly unblinded by the deletions) | ✅ Docstring rewritten to name exactly 2 remaining categories |
| 1.20 | `packages/core/test/print.mjs` | Fixture round trip | ✅ (above) | N/A — mutation-testing task | N/A | N/A | ✅ Mutation → RED confirmed → reverted (see Mutation Proofs) |
| 1.21 | `packages/core/test/print.mjs` | Fixture round trip + throw-confirmation loop | ✅ (above) | ✅ Written (fixtures added to `UNPRINTABLE_FIXTURES` + throw-loop), confirmed failing before add (both fixtures failed round trip with `IndigoPrintError`, not caught) | ✅ Passed once added to both the exclusion set and throw-confirmation loop | ➖ 2 fixtures, 2 distinct throw sites (`printAllowOperand` vs. `@@realtime(columns:)` branch) | ➖ None needed |

### Test Summary
- **Total tests written this batch**: 12 new `check(...)` blocks (2 realtime, 3 allow, 3 tableGroup, 1 fixture-derived allow-expansion; plus 3 pre-existing fixture-round-trip/throw-loop entries whose behavior changed as a side effect of 1.17/1.21, not new `check` calls)
- **Total tests passing**: 55/55 in `packages/core/test/print.mjs` (up from 36/36 baseline)
- **Layers used**: Unit (9 new), fixture round trip (3 new fixtures now exercised: 04, 18, 20), throw-confirmation (2 new: 19, 21)
- **Mutation proofs**: 2 (task 1.8's `fieldNameFor` swap; task 1.20's `allow` re-deletion) — both detailed below
- **Pure functions created**: 3 (`printAllowOperand`, `printAllowRule`, `printTableGroup`) — all side-effect-free, deterministic

## Mutation Proofs

### Task 1.8 — `fieldNameFor` → raw `dbName` swap in `printAllowOperand`

- **Mutation**: replaced `` `this.${fieldNameFor(table, op.name)}` `` with `` `this.${op.name}` `` in the `field` case.
- **Command**: `pnpm build --filter=@indigodb/core && node packages/core/test/print.mjs`
- **Observed result**: RED — `FAIL @@allow: field operand prints the schema field name, not the mapped dbName`. Output showed `@@allow(read, auth.userId == this.owner_id)` (the raw `dbName`), which the assertion `out.includes("this.owner_id") === false` correctly rejected.
- **Reverted**: yes, confirmed GREEN again after revert (55/55).

### Task 1.20 — re-added `allow` deletion to `normalizeForRoundTrip` while `printTable` still emits `@@allow`

- **Mutation**: destructured `allow` out of `t` before spreading `rest` in `normalizeForRoundTrip`, restoring the pre-PR normalizer-drop behavior for that one field.
- **Command**: `node packages/core/test/print.mjs` (no rebuild needed — test-file-only change)
- **Observed result**: RED — `FAIL round trip: 18-allow-rules.indigo`. Diff showed the actual (re-resolved) side carrying a populated `allow` array while the expected (normalized) side had it stripped — exactly the "printer prints it, normalizer still hides it" failure mode task 1.20 exists to prove is detectable.
- **Reverted**: yes, confirmed GREEN again after revert (55/55).

## Deviations from Design

None — implementation matches design. One clarification: the design's interface sketch shows
`printAllowRule(table: ResolvedTable, rule: AllowRule)` (rule carries its own `action`), while
task 1.6's prose describes `printAllowRule(table, action, rule)`. Implemented per the **design**
interface (rule-only signature) since `AllowRule.action` already exists on the IR type and the
design's exact interface block is the authoritative signature; task prose is descriptive, not a
literal signature spec. Behavior is identical either way.

## Issues Found

- First draft of task 1.7's test asserted `out.includes("owner_id") === false`, which is a false
  negative: the column's own `@map("owner_id")` legitimately contains that substring regardless of
  the allow-operand fix. Corrected to assert `this.owner_id` specifically (the allow-operand
  shape), which correctly isolates what task 1.7/1.8 verify. Caught before GREEN was declared —
  no incorrect task was marked complete.
- Round-trip fixtures 19/21 transiently failed between task 1.4/1.6 landing and task 1.21 adding
  them to `UNPRINTABLE_FIXTURES` — this is expected sequencing (the printer now correctly throws
  on their dangling references before the exclusion catches it) and was not treated as a
  regression; confirmed resolved once 1.21 landed.

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `node packages/core/test/print.mjs` → `print: all green` (55/55 checks; 18/21 fixtures round-trip in scope, 3 exclusions each with a pinned throw) |
| Runtime harness command/scenario and exact result | N/A — `printSchema` is a pure `(ResolvedSchema) -> string` function per design's Threat Matrix (no routing/shell/subprocess/process-integration boundary). Root gate substitutes: `pnpm clean && pnpm build --force` (18/18 tasks successful) → `pnpm lint` (19/19 successful) → `pnpm test` (18/18 successful, exit 0, ~9m8s), plus `node packages/compiler/test/parity.mjs` (all green, no golden drift) and `node packages/migrator/test/pull-roundtrip.mjs` (all green, confirms orphan-FK path untouched) |
| Rollback boundary | Revert `packages/core/src/print.ts` to drop `printAllowOperand`/`printAllowRule`/`printTableGroup` and the `realtimeColumns`/`allow`/`tableGroups` wiring in `printTable`/`printSchema`; revert `packages/core/test/print.mjs`'s `normalizeForRoundTrip` to restore the five deleted exclusions and drop 19/21 from `UNPRINTABLE_FIXTURES` (leave 05). PR 2 (Phase 2, not started) has not touched relation code, so this revert is clean and isolated to these two files |

## Root Gate (task 1.23-equivalent, full repo)

```
pnpm clean && pnpm build --force   → 18/18 tasks successful (Time: 23.795s)
pnpm lint                          → 19/19 tasks successful (tsc --noEmit / tsc -b --noEmit)
pnpm test                          → 18/18 tasks successful, exit code 0 (Time: 9m8.106s)
node packages/compiler/test/parity.mjs   → all green (no snapshot drift; confirms 19/20/21 fixture parity)
node packages/migrator/test/pull-roundtrip.mjs (via `pnpm test`) → all green, unmodified
```

`fixtures/snapshots/` regeneration: **not needed** — `parity.mjs` passed unmodified against the
current WASM artifact for all 21 fixtures including the two new/reclassified ones (19, 20, 21).

## Workload / PR Boundary

- Mode: stacked-to-main, PR 1 of 2
- Current work unit: Unit 1 (`@@allow`, `@@realtime(columns:)`, `TableGroup`, block-attribute
  reorder, `UNPRINTABLE_FIXTURES` +19/+21, `normalizeForRoundTrip` half-rewrite)
- Boundary: starts from the pre-change baseline (36/36 tests green, 20/21 fixtures in scope) and
  ends with 55/55 tests green, 18/21 fixtures in scope, PR 1's five normalizer exclusions fully
  deleted. Phase 2 (relations) and Phase 3 (cross-package verification/proposal sign-off) are
  untouched and remain `[ ]` in `tasks.md`.
- Estimated review budget impact: ~292 changed lines (52 in `print.ts`, 240 in `print.mjs` —
  slightly above the design's ~265 authored-line estimate for PR 1, still well inside the 800-line
  review budget)

## Status

23/23 Phase 1 tasks complete. Ready for verify (Phase 1 slice) or for `sdd-apply` to continue with
Phase 2 on its own stacked branch.
