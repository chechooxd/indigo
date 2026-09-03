```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:d347a7fd9c981b9e45367e3a04b4d577491f9895b7bee70b02487e6ff53bec39
verdict: pass_with_warnings
blockers: 0
critical_findings: 0
requirements: 2/2
scenarios: 6/6
test_command: pnpm test
test_exit_code: 0
test_output_hash: sha256:71f694d3b0d4fbbce986e9acb8c4f432a84acbbfe968593cd6b6bdc83badd87a
build_command: pnpm build
build_exit_code: 0
build_output_hash: sha256:13855f4951826744b775f196d15c1d0e54610731ba6fb3f775776934f223783f
```

## Verification Report — Phase 3

**Change**: studio-erd-designer — Phase 3 (`patch engine + add table`, tasks 3.1–3.13)
**Version**: N/A
**Mode**: Strict TDD
**Scope**: diff `feat/erd-layout-persistence..feat/erd-add-table` (HEAD `98c1b17`), three commits:
`ea333ab` (PR3a, patch engine, `renameTable` only, tasks 3.1–3.4/3.6/3.8–3.10), `6cf5b57`
(docs-only forecast repair), `98c1b17` (PR3b, `addTable` + canvas wiring, tasks 3.5/3.7/3.11–3.13).
Phases 1–2 already verified PASS, not re-audited. Phases 4–6 deliberately unimplemented, not scored.

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total (Phase 3) | 13 |
| Tasks complete | 13 |
| Tasks incomplete | 0 |

All 13 checkboxes (`3.1`–`3.13`) in `openspec/changes/studio-erd-designer/tasks.md` are `[x]`,
independently confirmed against `git show --stat` for `ea333ab` and `98c1b17` and by reading the
resulting `apps/studio/src/features/erd/lib/patch.ts`, `patch.test.ts`, `ERDCanvas.tsx`, and
`ERDCanvas.test.tsx` directly rather than trusting the checkbox alone.

| Task | Commit | Evidence |
|---|---|---|
| 3.1 `applyEdits` | `ea333ab` | `patch.ts` — sorts descending, splices right-to-left |
| 3.2/3.3 overlap RED/GREEN | `ea333ab` | `patch.test.ts` "throws on overlapping edit ranges" |
| 3.4 combined fixture | `ea333ab` | `__tests__/fixtures/combined.indigo` |
| 3.5 addTable byte-diff RED | `98c1b17` | `patch.test.ts` "adding a table inserts after the last model..." |
| 3.6 `applyErdEdit` | `ea333ab` | `patch.ts` — internal `parseWithSpans` call every invocation |
| 3.7 `addTable` constructor | `98c1b17` | `patch.ts` `case 'addTable'` |
| 3.8 export-surface RED | `ea333ab` | `patch.test.ts` "exposes exactly applyEdits and applyErdEdit" |
| 3.9 parse-failed RED | `ea333ab` | `patch.test.ts` "a fresh-parse failure refuses...parse-failed" |
| 3.10 anchor-missing RED | `ea333ab` | `patch.test.ts` "a missing anchor...refuses the patch as anchor-missing" |
| 3.11 positive control RED | `98c1b17` | `patch.test.ts` "an unchanged buffer applies addTable normally" |
| 3.12 canvas wiring | `98c1b17` | `ERDCanvas.tsx` `handleAddTable`, "Agregar tabla" toolbar button |
| 3.13 Verify | `98c1b17` | apply-progress-reported and independently re-run (see below) |

### Build & Tests Execution (re-run in this pass, not trusted from apply-progress)
**Build**: PASS (`pnpm build`, exit 0, 10/10 Turbo tasks)

**Lint**: PASS (`pnpm lint`, exit 0, 19/19 Turbo tasks, `apps/studio` via `tsc -b --noEmit`)

**Tests**: PASS (`pnpm test`, exit 0, 18/18 Turbo tasks)
```text
apps/studio vitest (standalone, `pnpm --filter @indigodb/studio exec vitest run`):
  27 files passed (27), 186 tests passed (186)
patch.test.ts: 10/10
ERDCanvas.test.tsx: 6/6
```

**Coverage**: Not available — no coverage tool configured in this repo (informational only).

### Mutation proofs — independently reproduced in this pass, not taken on the apply agent's word

**Mutation 1 — addTable off-by-one anchor** (`spans.models[...].bodyClose.end` → `bodyClose.end + 1`
in `patch.ts`'s `addTable` case):
```
FAIL patch.test.ts > applyErdEdit — untouched-by-construction (D4) >
  adding a table inserts after the last model...
FAIL patch.test.ts > applyErdEdit — staleness gate (D3) >
  an unchanged buffer applies addTable normally (positive control)
Test Files  1 failed (1)
     Tests  2 failed | 8 passed (10)
```
Exactly the two tests apply-progress claimed — the byte-diff-confinement test (3.5) and the
positive control (3.11) — failed, with the exact off-by-one diffs described (extra byte consumed
from the blank line before `TableGroup`). Reverted; `git diff --stat` on `patch.ts` confirmed a
byte-identical restore, and the full 10/10 `patch.test.ts` suite was re-run green.

**Mutation 2 — removed `if (result.ok)` gate** in `ERDCanvas.tsx`'s `handleAddTable` (forwarded
`result.text` unconditionally):
```
FAIL ERDCanvas.test.tsx > ERDCanvas — add-table affordance wiring >
  a refused (not ok) result is NOT forwarded to onDslChange — the buffer stays untouched
AssertionError: expected "spy" to not be called at all, but actually been called 1 times
  1st spy call: Array [ undefined ]
Test Files  1 failed (1)
     Tests  1 failed | 5 passed (6)
```
Exactly the target test failed, called once with `undefined` — matching the claim precisely.
Reverted; `git diff --stat` on `ERDCanvas.tsx` confirmed a byte-identical restore, and both
`patch.test.ts` and `ERDCanvas.test.tsx` were re-run together, 16/16 green.

### D3 enforceability — export-surface guard confirmed against real code
`rg -n "^export" apps/studio/src/features/erd/lib/patch.ts` returns exactly `TextEdit`,
`applyEdits`, `ErdEdit`, `ErdEditResult`, `applyErdEdit` — the only value-level exports are
`applyEdits` and `applyErdEdit`; no export returns a `SpanIndex`/span, matching the module's own
header claim and the `patch.test.ts` export-surface test's assertion. `pnpm build` (real `tsc`,
not just the test) confirms this compiles as claimed.

### Test helper fidelity — `buildSpanIndex` fake parser vs real Rust/WASM
`patch.test.ts`'s `buildSpanIndex` is a regex + brace-matching locator that computes
`nameToken`/`bodyOpen`/`bodyClose` offsets directly from the fixture string, not via the real
compiler. This is a genuine divergence risk in principle — but Phase 1 (already verified PASS)
shipped `crates/indigo-compiler/tests/span_agreement.rs` (task 1.11), which cross-checks the real
Rust parser's `name_token` and `body_close` offsets against the exact values the WASM boundary
returns, over a literal recorded fixture. Both `nameToken` and `bodyClose.end` — the only two
`ModelSpan` fields Phase 3's `addTable`/`renameTable` code paths actually read — are the fields
that test cross-verifies. The remaining divergence surface (whether the *fake* locator's
brace-counting always agrees with the *real* parser's brace-counting on inputs the fixture corpus
does not cover) is real but narrow, and does not undermine the specific mutation proofs above,
which assert against independently-computed expected strings, not against `buildSpanIndex`'s own
output. Rated SUGGESTION, not a blocking finding.

### Orphan/tautological test assessment
`ERDCanvas.test.tsx` mocks `../lib/patch` entirely (real module pulls WASM, unavailable in jsdom)
and widens the `ReactFlow`/`Panel` stubs to render `children`. Assessed the four new
add-table-affordance tests individually:
- "calls applyErdEdit with the current buffer and a name that does not collide" — asserts real
  call arguments (`currentText`, `{kind:'addTable', name:'NewTable'}`) against the real
  `ERDCanvas` component's real `handleAddTable`, not the mock's own behavior. Real wiring.
- "an ok result is forwarded to onDslChange" / "a refused result is NOT forwarded" — asserts
  `ERDCanvas`'s own conditional forwarding logic, proven non-tautological by Mutation 2 above
  (removing the `if (result.ok)` gate flips the "NOT forwarded" test to fail). Real wiring.
- "picks NewTable1 when NewTable already exists" — asserts `ERDCanvas`'s own collision-avoidance
  loop over `parsedNodes`, a real prop, not a mock artifact. Real wiring.

None of the four assert anything about the mock's return value in isolation (e.g. no test merely
checks that `applyErdEdit` "was called", full stop) — every assertion is either on the exact call
arguments `ERDCanvas` computed, or on what `ERDCanvas` did with a mocked return value. Verdict:
these tests exercise real component wiring, not assertions about the mock. No orphan/tautological
test found in this batch.

### Spec Compliance Matrix

`studio-erd-editing/spec.md` has 5 requirements / 13 scenarios total; Phase 3 implements only
`renameTable` (carried over from PR3a, already covered by Phase-2-adjacent prior work) and
`addTable`. Scenarios requiring `deleteTable`, field CRUD, relation drawing, or Save-wiring
(Phases 4–6) are out of scope per this launch's explicit instruction and are not scored below.

| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Every edit is a minimal span-anchored patch | A construct the ERD does not model survives an unrelated edit untouched | `patch.test.ts` "renaming an unrelated table leaves...byte-identical" + "adding a table inserts after the last model...byte-identical" | ✅ COMPLIANT |
| A stale span is unrepresentable (D3) | The patch module's export surface excludes any span-returning function | `patch.test.ts` "exposes exactly applyEdits and applyErdEdit" | ✅ COMPLIANT |
| A stale span is unrepresentable (D3) | A missing anchor after an intervening edit refuses the patch | `patch.test.ts` "a missing anchor...refuses...anchor-missing" | ✅ COMPLIANT |
| A stale span is unrepresentable (D3) | An unchanged buffer applies the patch normally | `patch.test.ts` "an unchanged buffer applies the patch normally" + "...applies addTable normally (positive control)" | ✅ COMPLIANT |
| A stale span is unrepresentable (D3) | A manual Monaco edit above a node invalidates a pending ERD edit (shifted line numbers, fresh parse re-locates) | `patch.test.ts` "an unchanged buffer applies the patch normally" + "a missing anchor...refuses...anchor-missing" (mechanism-equivalent: fresh parse locates strictly by name, never by cached position, so a shift is transparent by construction and a removed anchor is caught) | ✅ COMPLIANT (mechanism-proven, no literal shifted-line fixture) |

**Compliance summary**: 6/6 in-scope scenarios COMPLIANT (1 proven by mechanism-equivalent tests
rather than a literal shifted-line fixture — flagged as SUGGESTION below, non-blocking).

**`addTable` — no dedicated spec scenario (known, pre-disclosed gap)**: `studio-erd-editing/
spec.md`'s Purpose paragraph lists table creation as an ERD capability ("create/rename/delete
tables..."), but no Requirement or Scenario in the spec body names `addTable` specifically — only
field-add and rename/delete are scenario'd. Confirmed by direct read: zero occurrences of
"addTable" in any `specs/*.md` file. apply-progress disclosed this gap itself and stated the
byte-diff-confinement and positive-control tests were authored directly from `design.md`'s D3/D4
language and the task list's own mutation description instead. Assessed: the tests genuinely
prove `addTable` upholds D3 (fresh-parse-only) and D4 (untouched-by-construction) — the same two
properties Requirement 1 and Requirement 3 state generically for "every ERD edit" — so the
capability is not spec-*violating*, only spec-*silent*. Rated WARNING, not CRITICAL: a future
reader auditing `studio-erd-editing/spec.md` in isolation cannot discover that `addTable` exists
or what it is supposed to do — the spec document does not name the capability at all.

### Correctness (Static Evidence)
| Requirement | Status | Notes |
|---|---|---|
| `applyEdits` overlap-detection throw | ✅ Implemented | `patch.ts:49-53` |
| `applyErdEdit` fresh-parse-every-call | ✅ Implemented | `patch.ts:92-95`, calls `parseWithSpans` inside the function body |
| `addTable` zero-width insertion anchor | ✅ Implemented | `patch.ts:128-131`, `bodyClose.end` or `currentText.length` fallback |
| Canvas wiring forwards only `ok` results | ✅ Implemented | `ERDCanvas.tsx` `handleAddTable`, mutation-proven above |
| Collision-free table naming | ✅ Implemented | `ERDCanvas.tsx` `handleAddTable`, `NewTable`/`NewTable1`/... loop over `parsedNodes` |

### Coherence (Design)
| Decision | Followed? | Notes |
|---|---|---|
| D3 — fresh parse every call, no cached span | ✅ Yes | `applyErdEdit` calls `parseWithSpans` internally on every invocation; no span-returning export exists (confirmed above) |
| D4 — untouched-by-construction | ✅ Yes | Zero-width insertion for `addTable`; overlap-throwing splice for `applyEdits`; both proven via byte-diff against the combined fixture with recorded mutation proofs |
| Design's stated non-goal ("no typecheck enforces D3") | ✅ Honestly stated | Module header and design.md both explicitly disclaim type-level enforcement; the export-surface test is named as the sole automated guard, matching reality |

### Known context — not scored as a finding
The "Agregar tabla" toolbar button (`ERDCanvas.tsx:187`) uses a hardcoded Spanish string. The
surrounding toolbar already uses hardcoded Spanish elsewhere in the same file. This matches
existing file convention rather than introducing a new deviation; `react-i18next` is wired
elsewhere in the app but not used in this file at all, before or after this change.

### Issues Found

**CRITICAL**: None.

**WARNING**:
1. `studio-erd-editing/spec.md` has no dedicated Requirement/Scenario for `addTable`, despite the
   Purpose section listing table creation as an in-scope capability and the capability being
   fully implemented and tested. Tests were derived from `design.md`'s D3/D4 language instead of a
   spec scenario. Recommend adding a scenario under Requirement 1 (or a new Requirement) before
   Phase 4/5/6 compound the same pattern for `deleteTable`/field CRUD/`addRelation`, which DO have
   their own scenarios already written — `addTable` is the one capability the spec is silent on.

**SUGGESTION**:
1. The "manual Monaco edit above a node invalidates a pending ERD edit" scenario (Req 3) has no
   literal covering test with a shifted-line-number buffer; the underlying mechanism (fresh parse
   locates by name, not position) is proven by the adjacent "unchanged buffer" and "anchor-missing"
   tests, so this is non-blocking, but a dedicated test would make the scenario's literal wording
   independently verifiable rather than inferred.
2. `buildSpanIndex` (test helper, `patch.test.ts`) is a fake regex/brace-matching span locator,
   not the real parser. The two `ModelSpan` fields it computes that Phase 3 code paths read
   (`nameToken`, `bodyClose`) are cross-verified against the real Rust/WASM parser by Phase 1's
   `span_agreement.rs` (task 1.11), which meaningfully narrows the divergence risk — but no
   automated check ties the fake helper itself to the real parser's brace-counting on inputs
   outside the recorded fixture corpus.
3. Hardcoded Spanish `title="Agregar tabla"` matches the existing file's convention (already
   Spanish-hardcoded elsewhere); worth a future pass to route through `react-i18next` alongside
   the rest of the toolbar, not a regression introduced by this change.

### Verdict
**PASS WITH WARNINGS** — all 13 Phase 3 tasks complete and traced to their commits; build/lint/
test all green and independently re-run (10/10, 19/19, 18/18 Turbo tasks; 27/27 files, 186/186
tests in standalone Studio vitest); both claimed mutation proofs independently reproduced with
exact matching failures, then reverted with a confirmed clean diff; D3's export-surface guard
confirmed against real exports; no orphan/tautological test found in the add-table wiring batch.
One WARNING (addTable lacks a dedicated spec scenario — spec-silent, not spec-violating) should be
closed before Phase 4/5/6 repeat the same authoring gap for their own edit kinds; not a blocker
for archiving Phase 3 itself.

---

```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:824a8467353b6e8986491c3ee60b5f62f1055693e2aea3538ef44e5d059d2065
verdict: pass
blockers: 0
critical_findings: 0
requirements: 6/6
scenarios: 16/16
test_command: pnpm test
test_exit_code: 0
test_output_hash: sha256:2198a6f5620c86db9c0ebe1e3dbe2ea97927026f5e59e68797c7ddd7b2280b8d
build_command: pnpm build
build_exit_code: 0
build_output_hash: sha256:c869c5e91d861f2ac9886161ce255880e473c9c2b19a6f5cbda7fbfe7a928c05
```

## Verification Report

**Change**: studio-erd-designer — Phase 2 re-verify after remediation (`studio-layout-persistence` + read-only gate extension, tasks 2.1–2.21)
**Version**: N/A
**Mode**: Strict TDD
**Scope**: `git diff feat/erd-ast-source-spans..HEAD` at `100ddf4` (branch `feat/erd-layout-persistence`). This is a SCOPED re-verify of the prior FAIL report's one CRITICAL and two WARNING findings, not a fresh full audit — items the prior verify pass already independently confirmed (single dispatcher-level `isWriteRoute` gate, `layoutSidecarPath` traversal-free derivation, zero orphan tests, three mutation proofs, 14/16 compliant scenarios) are taken as established and re-confirmed only where regression risk existed. Phases 3–6 remain deliberately unimplemented — not scored.

### Remediation commits since prior FAIL verdict
- `ed4bd7d` — `design.md`'s Testing Strategy table gained the two missing combination rows ("Schema Save × layout" and "Node drag × autosave wiring"); `specs/studio-layout-persistence/spec.md` payload prose corrected `{layout, version}` → `{positions, version}`.
- `100ddf4` — the two missing tests: `ERDDesignerPage.test.tsx`'s "a schema Save does not implicitly write layout" and `ERDCanvas.test.tsx` (new file, 2 tests).

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total (Phase 2) | 21 |
| Tasks complete | 21 |
| Tasks incomplete | 0 |

All 21 checkboxes (`2.1`–`2.21`) in `openspec/changes/studio-erd-designer/tasks.md` are `[x]`. `2.20` and `2.21` are the two new tasks added for this remediation and both cite a "confirmed FAIL, reverted" mutation in their own text.

### Build & Tests Execution (re-run in this pass, not trusted from apply-progress)
**Build**: PASS (`pnpm build`, exit 0, 10/10 Turbo tasks)

**Lint**: PASS (`pnpm lint`, exit 0, 19/19 Turbo tasks, `apps/studio` via `tsc -b --noEmit`)

**Tests**: PASS (`pnpm test`, exit 0, 18/18 Turbo tasks)
```text
@indigodb/cli studio-layout: all green (20/20 checks, counted directly from log — unchanged)
@indigodb/cli studio-audit: all green (pinned 8-key probe-set assertion, includes layoutWritable)
apps/studio vitest: 172 passed (172), 26 files passed (26) — was 169/25; net +3 tests / +1 file:
  ERDDesignerPage.test.tsx gained 1 test ("a schema Save does not implicitly write layout…")
  ERDCanvas.test.tsx is new (2 tests: drag-end reaches autosave; in-flight drag does not schedule)
```
`packages/cli/dist` was rebuilt from clean (`rm -rf packages/cli/dist && pnpm --filter @indigodb/cli build`) before this pass's test run, per the recurring staleness gotcha this repo has hit before.

**Coverage**: Not available — no coverage tool configured in this repo (informational only).

### CRITICAL closure — independently reproduced in this pass
**Claim under test**: `ERDDesignerPage.test.tsx`'s `'a schema Save does not implicitly write layout (saveLayout / PUT /api/schema/layout untouched)'` closes the prior CRITICAL.

**Traceability**: maps to `studio-layout-persistence` spec's "Writes debounced, independent of schema Save" requirement, scenario "A schema Save does not implicitly write layout" — previously UNTESTED, now covered.

**Independent mutation reproduction** (not taken on the apply agent's word): `ERDDesignerPage.tsx`'s `handleSave` success branch was patched to add `saveLayout({}, 'v1');` after `setToastMessage('Schema saved.')`, and `saveLayout` was added to the file's `lib/api` import. Result:
```
FAIL src/features/erd/__tests__/ERDDesignerPage.test.tsx > ERDDesignerPage — save flow >
  a schema Save does not implicitly write layout (saveLayout / PUT /api/schema/layout untouched)
AssertionError: expected "spy" to not be called at all, but actually been called 1 times
Test Files  1 failed (1)
     Tests  1 failed | 5 passed (6)
```
Exactly the target test failed; the other 5 in the same file stayed green. The mutation was reverted and `git diff --stat` on the file confirmed a byte-identical restore.

**Verdict**: CONFIRMED CLOSED. `ERDDesignerPage.tsx` does not import `saveLayout` at all on the unmutated tree (`rg` confirms zero references) — the test is a genuine regression guard against a future coupling, not a tautology against dead code, because the mutation above proves it bites the moment that coupling is introduced.

### WARNING #1 closure — independently reproduced in this pass
**Claim under test**: new file `ERDCanvas.test.tsx` closes the prior WARNING (debounce mechanism was unit-tested but the real `ERDCanvas.tsx` drag→`updatePosition`→`schedule` wiring had zero coverage).

**Stub-breadth assessment**: `@xyflow/react`'s `ReactFlow`, `Background`, `Controls`, `MiniMap`, `Panel` are stubbed; `ReactFlowProvider`, `useNodesState`, `applyNodeChanges`, `useReactFlow` remain the real library implementation. The `ReactFlow` stub's only role is to capture the exact `onNodesChange` callback `ERDCanvas` passes down, then the test invokes that captured callback directly with a real `NodePositionChange` shape. This exercises `ERDCanvas`'s own `onNodesChange` handler — not a re-implementation of it — and `applyNodeChanges` still runs for real inside that handler. The stub is scoped to what jsdom genuinely cannot do (pointer-drag layout math), not the wiring under test. Assessed as appropriately, not excessively, scoped.

**Independent mutation reproduction #1** (drag-end wiring): commented out `updatePosition(change.id, change.position);` inside `ERDCanvas.tsx`'s `onNodesChange`. Result:
```
FAIL src/features/erd/__tests__/ERDCanvas.test.tsx > ERDCanvas — drag-end autosave wiring >
  a drag-end position change reaches the debounced layout autosave (calls saveLayout after 500ms)
AssertionError: expected "spy" to be called 1 times, but got 0 times
Tests  1 failed | 1 passed (2)
```
Exactly the target test failed; the in-flight-drag test stayed green. Reverted; `git diff --stat` confirmed clean restore.

**Verdict**: CONFIRMED CLOSED for the drag-end→`updatePosition`→debounced-save wiring.

### Item 3 — the second `ERDCanvas` test (`dragging: true` does NOT schedule an autosave)
This assertion was added beyond the two mandated design.md rows. Assessed for orphan/tautology risk per the re-verify instructions.

**Source evidence**: `ERDCanvas.tsx`'s `onNodesChange` guards the `updatePosition` call with `change.dragging === false` specifically to avoid restarting the debounce on every intermediate drag-frame (comment at lines 106-109 states this explicitly).

**Independent mutation reproduction #2** (distinct from #1 — targets only the `dragging` gate, not the whole call): changed `change.type === 'position' && change.dragging === false && change.position` to `change.type === 'position' && change.position`, restoring the `updatePosition` call from mutation #1 first. Result:
```
FAIL src/features/erd/__tests__/ERDCanvas.test.tsx > ERDCanvas — drag-end autosave wiring >
  an in-flight drag change (dragging: true) does NOT schedule an autosave
AssertionError: expected "spy" to not be called at all, but actually been called 1 times
Tests  1 failed | 1 passed (2)
```
Exactly the second test failed; the drag-end test stayed green. Reverted; `git diff --stat` confirmed clean restore.

**Verdict**: NOT an orphan/tautological test. It is a real regression guard on the `dragging === false` gate that prevents debounce-restart thrashing during an active drag — a behavior explicitly called out in design.md's own row ("drag-end reaches `updatePosition` → `schedule`... unit-testing the debounce alone leaves the wiring uncovered") as the coupling under test, and the `dragging:true` non-trigger is the natural negative case of that same wiring, not a separately-invented scenario.

### Traceability — tasks 2.20 / 2.21
- `2.20` → `ERDDesignerPage.test.tsx`'s new test → `studio-layout-persistence` spec's "Writes debounced, independent of schema Save" requirement, scenario "A schema Save does not implicitly write layout" → `design.md` Testing Strategy row "Studio unit | **Schema Save × layout**... | vitest + fetch spy, in `ERDDesignerPage.test.tsx`" (added in `ed4bd7d`).
- `2.21` → `ERDCanvas.test.tsx` (both tests) → same spec requirement, scenario "Dragging a node persists without clicking schema Save" → `design.md` Testing Strategy row "Studio unit | **Node drag × autosave wiring**... | vitest with fake timers over `ERDCanvas`" (added in `ed4bd7d`).

Neither task nor test is orphaned: both trace to a spec requirement/scenario and a design.md-mandated combination row now present in the table.

### Spec Compliance Matrix

**`studio-layout-persistence` spec** (5 requirements, 10 scenarios)

| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Sidecar keyed by table name | Stale key for deleted table ignored | `layout-store.test.ts` | COMPLIANT |
| Sidecar keyed by table name | Missing table falls back to seed formula | `layout-store.test.ts` | COMPLIANT |
| GET/PUT mirrors version/atomic-write contract | Stale write rejected without overwrite | `studio-layout.mjs` | COMPLIANT |
| GET/PUT mirrors version/atomic-write contract | Successful write commits atomically | `studio-layout.mjs` | COMPLIANT |
| Writes debounced, independent of schema Save | Dragging persists without clicking Save | `ERDCanvas.test.tsx` "a drag-end position change reaches the debounced layout autosave" — mutation-proven in this pass | COMPLIANT (was PARTIAL) |
| Writes debounced, independent of schema Save | Schema Save does not implicitly write layout | `ERDDesignerPage.test.tsx` "a schema Save does not implicitly write layout" — mutation-proven in this pass | COMPLIANT (was UNTESTED, prior CRITICAL) |
| Writability reporting | Missing `schemaPath` → `layoutWritable:false`, PUT 404 | `studio-layout.mjs` | COMPLIANT |
| Writability reporting | Missing `schemaPath` also disables GET | `studio-layout.mjs` | COMPLIANT |
| Read-only refuses layout writes identically | Layout write in read-only refused, sidecar unchanged | `studio-layout.mjs` | COMPLIANT (mutation-proven, prior pass) |
| Read-only refuses layout writes identically | Read-only + missing `schemaPath` → 403 not 404 | `studio-layout.mjs` | COMPLIANT (mutation-proven, prior pass) |

**`studio-readonly-mode` delta spec** (1 modified requirement, 6 scenarios) — unchanged from prior pass, all 6 COMPLIANT, no regression observed.

**Compliance summary**: 16/16 scenarios fully COMPLIANT (was 14/16 with 1 PARTIAL + 1 UNTESTED).

### Spec-to-Test Traceability
- **Orphan tests**: none found, including the two new `ERDCanvas.test.tsx` tests and the one new `ERDDesignerPage.test.tsx` test — all trace to a spec requirement/scenario and a design.md Testing Strategy row.
- **Uncovered requirements**: none. Both scenarios of "Writes debounced, independent of schema Save" now have passing, mutation-proven covering tests.

### Documentation Drift — closed
`studio-layout-persistence/spec.md` now reads `{positions, version}` throughout (confirmed by direct read in this pass), matching `design.md` D6 and the implementation. Prior WARNING #2 is closed.

### Regression check — 14 previously-compliant scenarios
Re-ran the full suite (`pnpm build`, `pnpm lint`, `pnpm test`) from a clean `packages/cli/dist` rebuild; all previously-green suites (`studio-server.mjs`, `studio-schema-source.mjs`, `studio-schema-write.mjs`, `studio-layout.mjs` 20/20, `studio-write.mjs`, `studio-readonly.mjs`, `studio-audit.mjs`, and the full `apps/studio` vitest run) stayed green with no new failures and no test removed. No regression found.

### Correctness (Static Evidence) — unchanged from prior pass, re-confirmed
| Requirement | Status |
|---|---|
| `atomicWriteFile` extraction shared by both write routes | Implemented |
| `layoutSidecarPath` server-side derivation, no traversal surface | Implemented |
| `buildLayoutAuditEntry` sibling pattern | Implemented |
| `AuditOp` gains `"layout-write"` | Implemented |
| `AuthStatus.layoutWritable` propagation (client + store) | Implemented |

### Coherence (Design)
| Decision | Followed? |
|---|---|
| D6 — route shape, status codes | Yes |
| D6 — field name `positions` (not `layout`) | Yes, code AND spec.md now agree |
| `isWriteRoute` explicit-set extension, not a second gate | Yes |
| `atomicWriteFile` extraction, reused by both write routes | Yes |
| Testing Strategy mandated combination rows all present and bite | Yes — the two rows added in `ed4bd7d` are both present and both mutation-proven in this pass |

### Issues Found

**CRITICAL**: None.

**WARNING**: None.

**SUGGESTION**:
1. `Number.isFinite` in `isValidLayoutPositions` remains confirmed unreachable via any conforming HTTP client (JSON has no NaN/Infinity literal), as established in the prior verify pass. Honestly documented, no test falsely claims coverage — no action required.

### Verdict
**PASS** — the prior CRITICAL (untested "schema Save does not implicitly write layout" scenario) and both prior WARNINGs (partial drag-wiring coverage; spec.md/`{layout,version}` documentation drift) are all independently confirmed closed in this pass via source inspection, traceability, and reproduced mutation proofs (not taken on the apply agent's word). 21/21 tasks complete, 16/16 spec scenarios COMPLIANT, zero orphan tests, no regression in the 14 previously-compliant scenarios. Clear to proceed to `sdd-archive` for Phase 2.
