```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:e6a677c6f219bc454e6867efc5a0d914cd589a72b453dd3093c087ec64b5e01d
verdict: fail
blockers: 1
critical_findings: 1
requirements: 5/6
scenarios: 14/16
test_command: pnpm test
test_exit_code: 0
test_output_hash: sha256:38f72db50d6fa265e7710f99c700e86c81e4b11bf3204fc66aeaeeac8d39e7ee
build_command: pnpm build
build_exit_code: 0
build_output_hash: sha256:4bb3b83818130ab938c8e1a72fcfc7ef1616e6b92dac46bd7204e5d3ee6be08b
```

## Verification Report

**Change**: studio-erd-designer — Phase 2 (`studio-layout-persistence` + read-only gate extension, tasks 2.1–2.19)
**Version**: N/A
**Mode**: Strict TDD
**Scope**: `git diff feat/erd-ast-source-spans..HEAD` (14 files, 1381 insertions / 75 deletions). Phases 3–6 deliberately unimplemented — not scored.

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total (Phase 2) | 19 |
| Tasks complete | 19 |
| Tasks incomplete | 0 |

All 19 checkboxes (`2.1`–`2.19`) in `openspec/changes/studio-erd-designer/tasks.md` are `[x]`, matching the current commit `628b821`.

### Build & Tests Execution
**Build**: ✅ Passed (`pnpm build`, exit 0, 10/10 Turbo tasks)

**Lint**: ✅ Passed (`pnpm lint`, exit 0, 19/19 Turbo tasks, `apps/studio` via `tsc -b --noEmit`)

**Tests**: ✅ Passed (`pnpm test`, exit 0, 18/18 Turbo tasks)
```text
@indigodb/cli studio-layout: all green   (20/20 checks: 16 named + 4 table-driven malformed-payload cases)
@indigodb/cli studio-audit: all green    (pinned 8-key probe-set assertion, includes layoutWritable)
apps/studio vitest: 169 passed (169), 25 files passed (25) — includes layout-store.test.ts (9/9)
```
`packages/cli/dist` was rebuilt from clean (`rm -rf packages/cli/dist && pnpm --filter @indigodb/cli build`) before every test run in this verification pass — the apply-progress note about `dist/`-import staleness was followed, not merely trusted.

**Coverage**: Not available — no coverage tool configured in this repo (informational only, per skill rules).

### Mutation Proofs — independently re-run in this verify pass
| # | Mutation | Expected | Observed | Result |
|---|---|---|---|---|
| 1 | Removed `/api/schema/layout` from `isWriteRoute`'s explicit set | exactly 2 `studio-layout.mjs` failures | `FAIL PUT under readOnly:true is refused with 403…` (`got 409`) and `FAIL … gate ordering` (`got 404`); 18 others stayed green | ✅ Confirmed, restored, re-verified green |
| 2 | Made `layout-store.ts`'s `flush()` a no-op | the unmount-flush vitest case fails | `× createLayoutAutosave > flush() sends a pending save immediately…` — `expected "spy" to be called 1 times, but got 0 times`; 8/9 others stayed green | ✅ Confirmed, restored, re-verified green (9/9) |
| 3 | Removed `Number.isFinite` from the layout position validator (kept `typeof`) | claimed: does NOT bite | Re-ran `studio-layout.mjs`: all 20 still green | ✅ Confirmed — see "Reachability" note below |

Mutations 1 and 2 above independently reproduce two of the five mutation proofs apply-progress claimed (isWriteRoute-set omission, flush-on-unmount removal); both bite exactly as reported. Mutation 3 independently reproduces apply's honestly-reported non-bite.

### Reachability audit — `Number.isFinite` check (Testing Strategy focus #7)
Apply's claim that this check is unreachable via any standard HTTP path is **confirmed correct**: `putLayout()` in `studio-layout.mjs` builds its body with `JSON.stringify({positions, version})`, and `JSON.stringify({x:1, y:NaN})` produces `{"x":1,"y":null}` (verified directly: `node -e 'console.log(JSON.stringify({x:1,y:NaN}))'` → `{"x":1,"y":null}`). The server-side `typeof y !== "number"` check alone already rejects `null`, so `Number.isFinite` never gets to run on the NaN sub-case — confirmed by re-running the mutation above (all 20 checks stayed green with `Number.isFinite` removed). A raw non-JSON-stringify client sending the literal token `NaN` in the request body would also never reach the check, because `JSON.parse` throws a `SyntaxError` on bare `NaN` (invalid JSON syntax) before validation runs at all — this is a language-level guarantee (JSON has no NaN/Infinity literal), not an artifact of this codebase.
**Verdict on the check**: genuinely unreachable via any conforming HTTP client today. Recommend either (a) removing it and updating the doc comment to state the `typeof` check alone is sufficient, or (b) keeping it but adding an inline comment stating explicitly it is unreachable-by-design defense-in-depth against a hypothetical relaxed JSON parser — current state (kept, with a comment claiming "defense-in-depth" but no test asserting the unreachability itself) is acceptable and not misleading, since no test claims to cover it. No WARNING raised for this item — it is honestly documented, matches design.md's D6 wording, and its own test suite makes no false claim about it.

### Structural audit — read-only gate (Testing Strategy focus #1)
Confirmed via direct source read (`packages/cli/src/studio-server.ts`):
- `/api/schema/layout` (mutating verbs only) is a member of `isWriteRoute`'s existing explicit set (line ~877–884) alongside `/api/rows/` and `/api/schema/source` — **no second/parallel gate was added**.
- The single `if (readOnly && isWriteRoute(path, req.method ?? ""))` check (line 1144) runs once, in the dispatcher, strictly after the session-auth gate and **before** the `try { … }` block that contains every route handler (line 1195+), including `handleWriteSchemaLayout`'s own `schemaPath === undefined` check. This is dispatcher-level, structural ordering — not a per-route check a future route could omit.
- Mutation 1 above independently proves this: removing the layout route from `isWriteRoute`'s set is the *only* way to break the gate for that route, and doing so breaks exactly the two tests that assert 403 (proving no other code path enforces it).
- `layoutSidecarPath(schemaPath)` derives the sidecar path exclusively from the server-held `schemaPath` closure variable (never from `req`/`url`/request body) with a hardcoded `"schema.layout.json"` basename — confirmed no path-traversal surface: request body fields (`positions`, `version`) are validated (`isValidLayoutPositions`) and never touch path construction.

**Result**: CONFIRMED — the read-only gate is structural, single-source-of-truth, and path derivation has no traversal surface.

### Spec Compliance Matrix

**`studio-layout-persistence` spec** (5 requirements, 10 scenarios)

| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Sidecar keyed by table name | Stale key for deleted table ignored | `layout-store.test.ts > resolvePositions > ignores a stale layout key…` | ✅ COMPLIANT |
| Sidecar keyed by table name | Missing table falls back to seed formula | `layout-store.test.ts > resolvePositions > falls back to the seed formula…` | ✅ COMPLIANT |
| GET/PUT mirrors version/atomic-write contract | Stale write rejected without overwrite | `studio-layout.mjs`: "PUT is refused with 409 when the sidecar was modified externally since GET", "PUT with a mismatched version…" | ✅ COMPLIANT |
| GET/PUT mirrors version/atomic-write contract | Successful write commits atomically | `studio-layout.mjs`: "A successful PUT leaves no leftover temp file", "GET after a PUT with a stale key returns that key verbatim" | ✅ COMPLIANT |
| Writes debounced, independent of schema Save | Dragging persists without clicking Save | `layout-store.test.ts > createLayoutAutosave > calls save … once the debounce window elapses` covers the debounce *mechanism*; **no test exercises the actual drag→`updatePosition`→`schedule` wiring in `ERDCanvas.tsx`** | ⚠️ PARTIAL |
| Writes debounced, independent of schema Save | Schema Save does not implicitly write layout | **No test found** — `ERDDesignerPage.test.tsx` has zero references to `layout`/`saveLayout`/`fetchLayout`; no test asserts a Save click leaves `saveLayout`/`PUT /api/schema/layout` uncalled | ❌ UNTESTED |
| Writability reporting | Missing `schemaPath` → `layoutWritable:false`, PUT 404 | `studio-layout.mjs`: "GET /api/auth/status reports layoutWritable:false with no schemaPath, and both layout routes answer accordingly (2.2 combination)" | ✅ COMPLIANT |
| Writability reporting | Missing `schemaPath` also disables GET | same test (covers GET 404 in the same case) | ✅ COMPLIANT |
| Read-only refuses layout writes identically | Layout write in read-only refused, sidecar unchanged | `studio-layout.mjs`: "PUT under readOnly:true is refused with 403, exactly one denied 'layout-write' audit line, sidecar byte-unchanged" | ✅ COMPLIANT (mutation-proven) |
| Read-only refuses layout writes identically | Read-only + missing `schemaPath` → 403 not 404 | `studio-layout.mjs`: "PUT with readOnly:true AND no schemaPath answers 403 from the read-only gate, never 404 (gate ordering)" | ✅ COMPLIANT (mutation-proven) |

**`studio-readonly-mode` delta spec** (1 modified requirement, 6 scenarios)

| Scenario | Test | Result |
|---|---|---|
| All three row-write verbs rejected identically | Pre-existing `studio-readonly.mjs` (unchanged by this diff, in the green test chain) | ✅ COMPLIANT (pre-existing, unaffected) |
| Schema write refused by same gate | Pre-existing `studio-readonly.mjs` | ✅ COMPLIANT (pre-existing, unaffected) |
| **Layout write refused by same gate, proving inheritance** | `studio-layout.mjs` 2.10 + mutation 1 above | ✅ COMPLIANT (mutation-proven) |
| Denied write emits audit line, correct `op` per route | `studio-layout.mjs` (layout-write) + pre-existing `studio-readonly.mjs`/`studio-audit.mjs` (rows/schema-write) | ✅ COMPLIANT |
| 403 body unaffected by audit logging | Pre-existing, generic (not layout-specific) | ✅ COMPLIANT (pre-existing, unaffected) |
| **Gate runs before layout route's own `schemaPath` check** | `studio-layout.mjs` "gate ordering" test + mutation 1 above | ✅ COMPLIANT (mutation-proven) |

**Compliance summary**: 14/16 scenarios fully COMPLIANT, 1 PARTIAL, 1 UNTESTED.

### Spec-to-Test Traceability
- **Orphan tests**: none found. Every check in `studio-layout.mjs` (20/20) and `layout-store.test.ts` (9/9) maps to a named spec requirement or design.md D6 clause.
- **Uncovered requirement**: `studio-layout-persistence`'s "Requirement: Layout writes are debounced and independent of schema Save" — its second scenario ("A schema Save does not implicitly write layout") has no automated covering test anywhere in the diff.
  - **Root cause traced to design, not apply**: `design.md`'s "Testing Strategy" table is the authoritative, explicitly-mandated combination list ("a missing combination here becomes an `sdd-verify` failure"). It lists exactly one row for this feature slice touching this coupling ("Studio unit | Unknown table key × empty layout file…") and does **not** include a row for "Save does not trigger layout write" or "drag triggers layout write independent of Save". The design's "Not enforceable by any tool" section (3 items) also does not name this scenario, unlike item 3 (flush-on-unmount), which correctly IS named there and IS tested. Apply implemented exactly what tasks.md/design.md's testing table asked for — the gap originates in design's Testing Strategy table never elevating this spec-level requirement to a mandated combination row, consistent with this repo's recurring "gap starts in design, not apply" pattern.
  - **Is it actually testable?** Yes — design.md's own testing strategy uses the "vitest + fetch spy" pattern elsewhere in the same table (e.g. "Studio unit | schemaWritable:false × ERD edit affordance…") for structurally similar assertions. A test spying on `saveLayout`/`fetch("/api/schema/layout", ...)` around an existing schema-Save flow (`ERDDesignerPage.test.tsx` already exercises Save) would cover it without needing real drag-and-drop simulation.
  - **Static/architectural evidence** (not a substitute for a runtime test, but relevant context): `saveSchemaSource` is called only from `ERDDesignerPage.tsx`'s Save path; `saveLayout` is called only from `layout-store.ts`'s debounced autosave. Grep confirms zero shared call sites — the coupling the spec forbids does not exist in the current call graph. This makes an eventual regression here more a "someone couples the two later" risk than a live defect today, but the spec scenario remains formally uncovered.

### Spec/Design Documentation Drift (non-blocking)
`studio-layout-persistence/spec.md` states: *"`PUT /api/schema/layout` MUST accept `{layout, version}`"* (line 43). `design.md` D6 and the actual implementation (`packages/cli/src/studio-server.ts`, `apps/studio/src/lib/api.ts`) all consistently use the field name **`positions`**, not `layout`. Functionally harmless — design.md and code agree with each other and with the mutation-proven tests — but `spec.md`'s prose is internally inconsistent with its own change's design and implementation. Flagged as WARNING; recommend a one-line fix to `spec.md` (`{layout, version}` → `{positions, version}`) for future readers who treat spec.md as the field-name source of truth.

### Correctness (Static Evidence)
| Requirement | Status | Notes |
|---|---|---|
| `atomicWriteFile` extraction shared by both write routes | ✅ Implemented | `studio-server.ts`; existing `studio-schema-write.mjs` (19/19) stayed green through the refactor |
| `layoutSidecarPath` server-side derivation, no traversal surface | ✅ Implemented | Confirmed by direct read — see structural audit above |
| `buildLayoutAuditEntry` sibling pattern | ✅ Implemented | Mirrors `buildSchemaAuditEntry` exactly, hardcodes `op:"layout-write"`, never takes `table` |
| `AuditOp` gains `"layout-write"` | ✅ Implemented | `util.ts` |
| `AuthStatus.layoutWritable` propagation (client + store) | ✅ Implemented | `api.ts`, `useAuthStore.ts`; all literal mocks updated, caught by `tsc -b` |

### Coherence (Design)
| Decision | Followed? | Notes |
|---|---|---|
| D6 — route shape, status codes (`200/400/404/409/403`) | ✅ Yes | Matches design.md exactly |
| D6 — field name `positions` (not `layout`) | ✅ Yes (code); ⚠️ spec.md prose disagrees | See documentation-drift finding above |
| `isWriteRoute` explicit-set extension, not a second gate | ✅ Yes | Confirmed structurally |
| `atomicWriteFile` extraction, reused by both write routes | ✅ Yes | |
| Testing Strategy mandated combination rows all present and bite | ✅ Yes, for every row actually listed in design.md's table | The two uncovered spec.md scenarios were never listed as mandated rows in design.md — a design-table gap, not a deviation from a stated design decision |

### Issues Found

**CRITICAL**:
1. Spec requirement "Layout writes are debounced and independent of schema Save," scenario "A schema Save does not implicitly write layout," has no automated covering test anywhere in this diff. No test asserts that triggering a schema Save leaves `saveLayout`/`PUT /api/schema/layout` uncalled. Root cause traced to `design.md`'s Testing Strategy table never mandating this combination (see Spec-to-Test Traceability above) — not an apply-phase shortcut. Recommend either adding a `vitest + fetch spy` test (pattern already used elsewhere in this same design) before archiving Phase 2, or formally adding it to design.md's "Not enforceable by any tool" list with a stated reason if the team judges it truly out of reach.

**WARNING**:
1. Same requirement's other scenario ("Dragging a node persists without clicking schema Save") is only PARTIALLY covered: the debounce *mechanism* (`createLayoutAutosave`) is unit-tested, but the actual `ERDCanvas.tsx` drag→`updatePosition`→`schedule` wiring has zero test coverage.
2. `studio-layout-persistence/spec.md` line 43 says `PUT /api/schema/layout` accepts `{layout, version}`; design.md and the implementation both use `{positions, version}`. Non-blocking documentation drift — recommend fixing spec.md's wording.

**SUGGESTION**:
1. `Number.isFinite` in `isValidLayoutPositions` is confirmed unreachable via any conforming HTTP client (JSON has no NaN/Infinity literal). It is honestly documented as defense-in-depth in both apply-progress and the source comment, and no test falsely claims to cover it — no action required, noted for completeness per the Testing Strategy focus area.

### Verdict
**FAIL** — one spec-mandated scenario ("a schema Save does not implicitly write layout") has zero automated covering test; everything else in Phase 2's scope (19/19 tasks, all mandated design.md combination rows, the read-only gate's structural correctness, and 3 independently-reproduced mutation proofs) is genuinely green and well-tested. Recommend routing back to `sdd-apply` to add the missing spy-based test (small, scoped addition) before re-running `sdd-verify`; do not proceed to `sdd-archive` until this scenario has a passing runtime test.
