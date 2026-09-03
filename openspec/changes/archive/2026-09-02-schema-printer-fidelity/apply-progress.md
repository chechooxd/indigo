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

---

# Phase 2 + Phase 3 — PR 2: Relations, and cross-package verification

**Branch**: `feat/schema-printer-fidelity-2`, stacked on `feat/schema-printer-fidelity-1` (tip
`ab58f75`). PR 1's 23/23 tasks (above) are unchanged and confirmed still green before this batch
started (safety net: `node packages/core/test/print.mjs` → 55/55 checks passing, baseline).

## Task 2.1 — Design-correction guard (read, not a test)

Confirmed before writing any code: the FK-holder discriminator is
`rel.inverse !== true && rel.fkColumns.length > 0`, implemented as `isRelationHolder(rel)` in
`print.ts`. Verified live against `12-relation-naming.indigo` (task 2.3's manual swap-and-revert,
recorded below) that `fkColumns.length > 0` alone is the wrong discriminator and throws.

## Files Changed

| File | Action | What Was Done |
|------|--------|---------------|
| `packages/core/src/print.ts` | Modified | Added `arrayEq`, `isRelationHolder`, `claimForeignKeys`, `printRelationField`; rewrote `printFieldLines` to take `schema`/`fkFor` and append relation rows after scalar columns in the same aligned block; wired `printTable` to call `claimForeignKeys` and build the FK comment list from `orphans` instead of `table.foreignKeys`; narrowed the module docstring (task 2.26) |
| `packages/core/test/print.mjs` | Modified | Added 9 new `check(...)` blocks under a new "Relations" section (T6-T11 coverage); rewrote `normalizeForRoundTrip` to its final one-exclusion form (deleted `foreignKeys: []`/`relations: []`); updated `05-relations.indigo`'s exclusion-reason comment (task 2.21) to name `printRelationField` as the new throw site |
| `openspec/changes/schema-printer-fidelity/proposal.md` | Modified | Checked all 7 Success Criteria boxes with evidence pointers (task 3.4) |
| `openspec/changes/schema-printer-fidelity/tasks.md` | Modified | Marked all Phase 2 (29) and Phase 3 (6) tasks `[x]` |

`packages/migrator/test/pull-roundtrip.mjs` and `packages/cli/src/util.ts` — **confirmed
byte-unmodified** (`git diff --stat` empty for both, task 3.3).

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 2.2/2.3/2.4 | `packages/core/test/print.mjs` | Unit + fixture (08, 12) | ✅ 55/55 (baseline) | ✅ Written, confirmed failing (both fixture-round-trip text assertions threw/failed against pre-`claimForeignKeys` tree) | ✅ Passed after `claimForeignKeys`/`printRelationField`/`printFieldLines` wiring | ✅ Two fixtures (self-relation holder, name-paired inverse vs. holder) | ➖ None needed |
| 2.5/2.6 | `packages/core/test/print.mjs` | Unit | N/A (GREEN-TODAY guard, per design) | N/A — confirmed passes against current tree before AND after `claimForeignKeys` lands (all-orphan path unconditionally true when `relations` is empty) | ✅ Passed both before and after | ➖ Single (guard, not new coverage) | ➖ None needed |
| 2.7/2.8 | `packages/core/test/print.mjs` | Unit | ✅ (above) | ✅ Written, confirmed failing (`@relation(` half failed — nothing emitted yet) | ✅ Passed once claiming wired into `printTable` | ➖ Single | ➖ None needed |
| 2.9/2.10 | `packages/core/test/print.mjs` | Unit | ✅ (above) | ✅ Written, confirmed failing | ✅ Passed on first run (no fix needed — non-holder branch already emits `attrs = []`) | ➖ Single | ➖ None needed |
| 2.11/2.12/2.13 | `packages/core/test/print.mjs` | Unit | ✅ (above) | ✅ Written, confirmed failing (no throw at all pre-implementation) | ✅ Passed after ambiguity throw added, message pinned to `"matches"` | ✅ Mutation proof (below) is the triangulating case | ➖ None needed |
| 2.14/2.15 | `packages/core/test/print.mjs` | Unit | ✅ (above) | ✅ Written, confirmed failing | ✅ Passed after `claimedBy` map + "claimed by both" throw added | ➖ Single (distinct ambiguity direction from 2.11) | ➖ None needed |
| 2.16/2.17/2.18 | `packages/core/test/print.mjs` | Unit | ✅ (above) | ✅ Written, confirmed failing | ✅ Passed after `fk.name !== undefined` check added, message pinned to `"constraint name"` | ✅ Mutation proof (below) is the triangulating case | ➖ None needed |
| 2.19/2.20 | `packages/core/test/print.mjs` | Unit | ✅ (above) | ✅ Written, confirmed failing (initial draft had a false-positive substring collision, corrected — see Issues below) | ✅ Passed on first correct run (no production fix needed) | ➖ Single (ordering — one scenario) | ➖ None needed |
| 2.21 | `packages/core/test/print.mjs` (comment only) | N/A | N/A | N/A — comment-only, no behavior change | N/A | N/A | ➖ None needed |
| 2.22/2.23 | `packages/core/test/print.mjs` | Fixture round trip (21 fixtures total, 3 excluded) | ✅ (above) | N/A — refactor of comparison logic (deletion) | ✅ All 18 in-scope fixtures pass, including 07/08/12/13 newly unblinded | ✅ Exercises every relation-bearing fixture in the corpus | ✅ Docstring rewritten to name the single final exclusion |
| 2.24 | `packages/core/test/print.mjs` | Structural diff | N/A | N/A | ✅ Confirmed `normalizeForRoundTrip`'s final body matches the design's quoted target exactly — one `indexes` re-bucketing line, its inline comment, nothing else | N/A | N/A |
| 2.25 | `packages/core/test/print.mjs` | Fixture round trip | ✅ (above) | N/A — mutation-testing task | N/A | N/A | ✅ Mutation → RED confirmed → reverted (see Mutation Proofs) |
| 2.26 | `packages/core/src/print.ts` (docstring) | N/A | N/A | N/A — prose change | N/A | N/A | ✅ Narrowed truthfully, `db-pull-relation-synthesis` named |
| 2.27 | `packages/migrator/test/pull-roundtrip.mjs` | Integration (PGlite) | N/A | N/A — regression guard, unmodified file | ✅ Ran standalone (`node packages/migrator/test/pull-roundtrip.mjs`) → all green, both assertions (`!includes("@relation")`, `includes("@fk(")`) pass unchanged | N/A | N/A |
| 2.28 | `packages/core/test/print.mjs` (console output) | N/A | N/A | N/A — reachability guard | ✅ Confirmed: `console.log` reports `18/21 fixtures in scope`; `UNPRINTABLE_FIXTURES` has exactly 3 entries (05, 19, 21), each with its own per-fixture reason comment | N/A | N/A |
| 2.29 | `packages/core/test/print.mjs` | Full suite | ✅ 55/55 (baseline) | N/A | ✅ 63/63 checks green (55 baseline + 8 new relation checks, one net-new after the T11 test fix) | N/A | N/A |

### Test Summary
- **Total tests written this batch**: 9 new `check(...)` blocks under "Relations" (2.2/2.3 combined into one fixture-round-trip check each for 08/12, plus T8/T7/T9-inverse/T9-ambiguous/T9-claimed-by-both/T10/T11 — 9 total new `check` calls)
- **Total tests passing**: 63/63 in `packages/core/test/print.mjs` (up from 55/55 PR-1 baseline)
- **Layers used**: Unit (7 new), fixture round trip (2 new relation-bearing fixtures directly asserted: 08, 12; plus 07/13 newly unblinded as a side effect of 2.22's deletion)
- **Mutation proofs**: 4 total this batch — task 2.3's discriminator regression guard, task 2.13's ambiguity-throw closure, task 2.18's FK-name-throw closure, task 2.25's final-exclusion closure (all detailed below)
- **Pure functions created**: 3 (`isRelationHolder`, `claimForeignKeys`, `printRelationField`) — all side-effect-free (`claimForeignKeys` builds local `Map`s, no external state)

## Mutation Proofs

### Task 2.3 — discriminator regression guard: `fkColumns.length > 0` alone (dropping `inverse !== true`)

- **Mutation**: replaced `return rel.inverse !== true && rel.fkColumns.length > 0;` with
  `return rel.fkColumns.length > 0;` in `isRelationHolder`.
- **Command**: `pnpm build --filter=@indigodb/core && node packages/core/test/print.mjs`
- **Observed result**: RED — `FAIL relation: holder vs. name-paired-inverse discriminator
  (12-relation-naming.indigo)`. The failure was not a soft assertion mismatch but an uncaught
  `IndigoPrintError`: `Table "User": column with physical name "authorId" has no matching field —
  cannot print`, thrown from inside `printRelationField`'s `fieldNameFor` call — exactly the
  failure mode the design's correction #1 predicts (`User.authoredPosts`'s back-filled `fkColumns`
  wrongly qualifying it as a holder, then `fieldNameFor(User, "authorId")` throwing because
  `authorId` lives on `Post`).
- **Reverted**: yes, confirmed GREEN again after revert (63/63).

### Task 2.13 — ambiguity-throw closure: pick-first instead of throwing on `matches.length > 1`

- **Mutation**: commented out the `if (matches.length > 1) throw ...` block in `claimForeignKeys`.
- **Command**: `pnpm build --filter=@indigodb/core && node packages/core/test/print.mjs`
- **Observed result**: RED — `FAIL relation: ambiguous claim (one relation matches 2 FKs) throws,
  message pinned` — `Missing expected exception: expected throw naming ambiguous 'matches'`. No
  throw occurred; a pick-first implementation would have silently claimed `matches[0]`.
- **Reverted**: yes, confirmed GREEN again after revert.

### Task 2.18 — FK-name-throw closure: removed the `fk.name !== undefined` check

- **Mutation**: commented out the `if (fk.name !== undefined) throw ...` block in
  `claimForeignKeys`.
- **Command**: `pnpm build --filter=@indigodb/core && node packages/core/test/print.mjs`
- **Observed result**: RED — `FAIL relation: claimed FK carrying name throws, message pinned to
  constraint name` — `Missing expected exception: expected throw naming 'constraint name'`. The
  named FK would have been silently claimed and printed with its `name` invisibly dropped.
- **Reverted**: yes, confirmed GREEN again after revert.

### Task 2.25 — final normalizer closure: re-adding a deleted exclusion (`relations: []`)

- **Mutation**: added `relations: []` back into `normalizeForRoundTrip`'s per-table spread
  (after the fully-restored, one-exclusion state from task 2.22).
- **Command**: `node packages/core/test/print.mjs` (test-file-only change, no rebuild needed)
- **Observed result**: RED — immediate failure on every relation-bearing fixture:
  `01-cli-template`, `02-studio-initial`, `03-quirks-values`, `07-referential-actions`,
  `08-self-relation`, `12-relation-naming`, `13-ambiguous-relations` all failed
  `deepStrictEqual`, each diffing on a populated `relations` array on the actual (re-resolved)
  side against the zeroed expected side — exactly the "printer prints it, normalizer still hides
  it" failure mode this task exists to prove is detectable, now demonstrated across 7 fixtures
  simultaneously (a stronger proof than PR 1's task 1.20, which affected 1 fixture).
- **Reverted**: yes, confirmed GREEN again after revert (63/63).

## Deviations from Design

None — implementation matches design. `claimForeignKeys`'s exact interface signature (`{ fkFor,
orphans }`) and `printRelationField`'s exact algorithm (holder/non-holder branches, argument
order: relationName positional first, then `fields:`, then `references:`, then `onDelete:`/
`onUpdate:`) match the design's Interfaces section verbatim.

## Issues Found

- First draft of the T11 ordering test ("relation fields print after all scalars") used a
  hardcoded padded string (`"author     User"`) copied from the design's two-relation
  `12-relation-naming` walkthrough, but the test's own fixture has only one relation field, so the
  computed column alignment padding differs (fewer characters to pad against). This produced a
  false RED unrelated to the actual behavior under test. Corrected to search for stable,
  padding-independent substrings (`"authorId Int"` for the last scalar, `"@relation(fields:
  [authorId]"` for the relation clause) — this isolates the ordering assertion (task 2.19's actual
  intent) from incidental column-width arithmetic. Caught before GREEN was declared; no incorrect
  task was marked complete on the flawed assertion.
- **Task 2.28's own text has an off-by-one arithmetic error** (pre-existing in `tasks.md`, not
  introduced by this batch): it states "20/20 round-trippable fixtures minus the three permanent
  exclusions ... = 17/20 in scope", but the fixtures directory genuinely contains **21** `.indigo`
  files (confirmed via `ls fixtures/*.indigo | wc -l`), not 20. With 3 exclusions the correct math
  is 21 − 3 = **18/21**, which is exactly what `console.log` reports and what PR 1's own
  `apply-progress.md` already recorded ("18/21 fixtures round-trip in scope") — PR 1's task 1.22
  text has the identical typo ("18/20 after 1.21"). This is reported per the task instructions
  ("if a task is wrong or unimplementable as written, say so with evidence and stop — do not
  silently redesign") rather than silently corrected: the code and its dynamically-computed
  console output are correct (21 total, 3 excluded, 18 in scope); only the task-file prose in both
  1.22 and 2.28 undercounts the corpus by one file. No code change was made in response — the
  guard's actual behavior (task's real intent) is satisfied.

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `node packages/core/test/print.mjs` → `print: all green` (63/63 checks; 18/21 fixtures round-trip in scope, 3 exclusions each with a pinned throw) |
| Runtime harness command/scenario and exact result | N/A — `printSchema` is a pure `(ResolvedSchema) -> string` function per design's Threat Matrix. Cross-package integration substitute: `node packages/migrator/test/pull-roundtrip.mjs` → all green, unmodified (task 2.27/3.3), and `node packages/compiler/test/parity.mjs` → all green, no snapshot drift (task 3.2) |
| Rollback boundary | Revert `packages/core/src/print.ts` to drop `claimForeignKeys`/`printRelationField`/`isRelationHolder`/`arrayEq` and the `printFieldLines`/`printTable` wiring (relation printing reverts to the `// @fk(…)` comment for every FK); revert `packages/core/test/print.mjs`'s `normalizeForRoundTrip` to restore the `foreignKeys: []`/`relations: []` exclusions. PR 1's `@@allow`/`@@realtime(columns:)`/`TableGroup` output and normalizer deletions are untouched by this revert |

## Root Gate (task 3.1, full repo)

```
pnpm clean                          → 10/10 tasks successful
pnpm build --force                  → 10/10 tasks successful (Time: 23.611s)
pnpm lint                           → 19/19 tasks successful (tsc --noEmit / tsc -b --noEmit)
pnpm test                           → 18/18 tasks successful, exit code 0 (Time: 8m46.605s)
node packages/compiler/test/parity.mjs        → all green (no snapshot drift; task 3.2)
node packages/migrator/test/pull-roundtrip.mjs → all green, unmodified (task 2.27/3.3)
```

`fixtures/snapshots/` regeneration: **not needed** — `parity.mjs` passed unmodified against the
current WASM artifact for all 21 fixtures (task 3.2).

`packages/cli/src/util.ts` and `packages/migrator/test/pull-roundtrip.mjs`: confirmed
byte-unmodified via `git diff --stat` (task 3.3, empty output for both files).

## Phase 3 — Cross-package verification

- [x] 3.1 Root gate run as above — all green.
- [x] 3.2 `node packages/compiler/test/parity.mjs` — all green, no golden/snapshot regeneration
      needed, confirmed against the actual final diff (not merely assumed from the design).
- [x] 3.3 `packages/cli/src/util.ts` and `packages/migrator/test/pull-roundtrip.mjs` confirmed
      byte-unmodified (`git diff --stat` empty for both).
- [x] 3.4 `proposal.md` Success Criteria — all 7 boxes checked with evidence pointers (see diff
      above).
- [x] 3.5 **Explicitly recorded**: this change does **not** fix `db pull`'s FK loss.
      `packages/cli/src/introspect.ts:350` still hardcodes `relations: []` for every introspected
      table — confirmed unchanged in this diff (`introspect.ts` was not touched by either PR).
      `packages/migrator/test/pull-roundtrip.mjs` (task 2.27) continues to pin the `// @fk(…)`
      fallback as the correct, deliberate representation for that path — not a bug, a documented
      gap. Follow-up: **`db-pull-relation-synthesis`** (relation-field-name synthesis for
      introspected schemas — deferred, not started in this change).
- [x] 3.6 **Explicitly out-of-scope** (matching the proposal's Non-Goals, not silently dropped):
      - Relation-field-name synthesis for introspected (`db pull`) schemas — deferred to
        `db-pull-relation-synthesis`.
      - Re-collapsing expanded `@@allow` `write`/`all` aliases back to their authored sugar — the
        printer always emits the expanded 3/4-line form; a "preserve authored alias" IR field
        would be a separate change (proposal's decision #3).
      - Any change to `fixtures/snapshots/` or the WASM artifact — none was needed or made; `crates/
        indigo-compiler` (Rust) was not touched by either PR.

## Workload / PR Boundary

- Mode: stacked-to-main, PR 2 of 2 (final slice)
- Current work unit: Unit 2 (`claimForeignKeys`, `printRelationField`, ambiguity + FK-`name`
  throws, `05-relations.indigo` comment update, `normalizeForRoundTrip` final exclusion,
  docstring narrowing) + Phase 3 (cross-package verification, proposal sign-off)
- Boundary: starts from PR 1's baseline (55/55 tests green, 18/21 fixtures in scope, PR 1's five
  normalizer exclusions fully deleted) and ends with 63/63 tests green, still 18/21 fixtures in
  scope (same 3 permanent exclusions — no new ones added), PR 2's final two normalizer exclusions
  deleted (down to the single permanent `indexes` re-bucketing exclusion). All 58/58 tasks across
  both phases are now `[x]`.
- Estimated review budget impact: 408 changed lines total this batch (153 in `print.ts` — net
  additions after removing the old un-schema'd `printFieldLines` signature and old `fkLines`
  wiring, 255 in `print.mjs`), somewhat above the design's ~305 authored-line estimate for PR 2 but
  still well inside the 800-line review budget (`review_budget_lines: 800`).

## Status

58/58 tasks complete across both phases (Phase 1: 23/23, Phase 2: 29/29, Phase 3: 6/6). Root gate
green end-to-end. Ready for `sdd-verify`.
