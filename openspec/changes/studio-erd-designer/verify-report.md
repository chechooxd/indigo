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
