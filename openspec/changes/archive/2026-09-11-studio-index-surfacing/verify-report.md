```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:27da1b30c6ce78b8441e49625499f25632ff19a30806ac94d6d615862295cc18
verdict: pass
blockers: 0
critical_findings: 0
requirements: 6/6
scenarios: 16/16
test_command: pnpm test
test_exit_code: 0
test_output_hash: sha256:d2570fa93eeb517574c2995e5371813e04bea153ef686aa3c273fe68e189cdfa
build_command: pnpm clean && pnpm build --force
build_exit_code: 0
build_output_hash: sha256:ececbf5f891023805a0f291fde427d57c25b00dfba98d68351219a1ea97bfc30
```

## Verification Report

**Change**: studio-index-surfacing
**Version**: N/A (pre-archive; canonical `studio-docs-ddl` capability not yet merged)
**Mode**: Strict TDD

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total | 22 |
| Tasks complete | 22 |
| Tasks incomplete | 0 |

### Build & Tests Execution
**Build**: ✅ Passed
```text
pnpm clean && pnpm build --force → 11/11 Turbo tasks successful (0 cached, forced rebuild).
Studio's `tsc -b && vite build` succeeded (2294 modules transformed).
```

**Tests**: ✅ All passed
```text
pnpm test → 20/20 Turbo tasks successful. Studio: 30/30 test files including the new
src/features/docs/lib/ddl-generator.test.ts (13/13 tests — 2 adapter-boundary + 10 scenario
rows + 1 @map identifier-correspondence invariant; apply-progress.md's "12/12" undercounts by
one test, see WARNING). CLI: 24/24 files. `@indigodb/realtime` Postgres-gated suites correctly
print SKIP (no INDIGODB_TEST_DATABASE_URL). pack-contents + version-parity guards green.
```

**Coverage**: N/A — no coverage tool configured in this workspace; not flagged as a failure.

### Independent Reproduction

- **`@map` invariant test bites.** Surgical one-line edit to `ddl-generator.ts:63`
  (`physicalName(col)` → `col.name`), rebuilt nothing needed (vitest transpiles on the fly), ran
  `pnpm --filter @indigodb/studio exec vitest run src/features/docs/lib/ddl-generator.test.ts`.
  Result: exactly 1 failure — `generateTableDDL — @map identifier correspondence (invariant) >
  every PRIMARY KEY / CREATE INDEX identifier appears as a rendered column line, with @map on
  both a PK column and an indexed column` — `AssertionError: expected [ 'authorId', 'slug' ] to
  include 'author_id'`, at `ddl-generator.test.ts:263`. An assertion diff, never a `TypeError`.
  All other 12 tests stayed green. Reverted with `git checkout --`; `git status --porcelain`
  confirmed empty before and after.
- **Fabrication absence confirmed**: `rg -n "idx_|Create optimized index"` across
  `ddl-generator.ts`, `ddl-generator.test.ts`, and the built `apps/studio/dist/assets/*.js`
  bundle returns zero matches outside the test file's `not.toContain` negative assertions.
- **Negative cases hold** (via passing test rows 1, 2, 9): no-index table renders no
  `CREATE INDEX`; absent `type` renders no `USING`; absent PK renders no `PRIMARY KEY`.
- **Composite PK renders exactly one table-level clause**: row 8 asserts
  `pkMatches` (regex `/PRIMARY KEY/g`) `.toHaveLength(1)` and the exact
  `PRIMARY KEY (tenantId, userId)` string — passing.
- **Vacuous-pass guard confirmed**: the `@map` invariant test asserts
  `expect(referenced.length).toBeGreaterThan(0)` (`ddl-generator.test.ts:261`) before the
  per-identifier loop, so an empty-clause fixture would fail that guard rather than passing
  trivially.

### Spec Compliance Matrix
| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| Resolved index data survives the adapter boundary | Indexes reach the adapted Table | `ddl-generator.test.ts > resolvedToTables index mapping > scenario: indexes reach the adapted Table` | ✅ COMPLIANT |
| Resolved index data survives the adapter boundary | A table with no indexes maps to an empty array | `ddl-generator.test.ts > resolvedToTables index mapping > scenario: a table with no indexes maps to an empty array` | ✅ COMPLIANT |
| Rendered DDL contains no fabricated index statement | No indexes renders no CREATE INDEX | `row 1`, `row 2` | ✅ COMPLIANT |
| Rendered DDL contains no fabricated index statement | One index renders exactly one statement | `row 3` | ✅ COMPLIANT |
| Rendered DDL contains no fabricated index statement | Composite index preserves column order | `row 5` | ✅ COMPLIANT |
| Rendered DDL contains no fabricated index statement | Unique index renders CREATE UNIQUE INDEX | `row 4` | ✅ COMPLIANT |
| Rendered DDL contains no fabricated index statement | Index columns unrelated to PK render as declared | `row 3`, `row 7` | ✅ COMPLIANT |
| `USING <method>` only when index declares a type | Absent type renders no USING clause | `row 3` | ✅ COMPLIANT |
| `USING <method>` only when index declares a type | Explicit non-btree type renders its USING clause | `row 6` | ✅ COMPLIANT |
| PK clauses derive from `table.primaryKey`, never hardcoded | Non-id primary key renders correctly | `row 7` | ✅ COMPLIANT |
| PK clauses derive from `table.primaryKey`, never hardcoded | Composite primary key marks every column | `row 8` | ✅ COMPLIANT |
| Every PK/index identifier corresponds to a rendered column line | A `@map`ped PK column renders the physical name consistently | `@map identifier correspondence > ...` (mutation-proven) | ✅ COMPLIANT |
| Every PK/index identifier corresponds to a rendered column line | A `@map`ped indexed column renders the physical name consistently | `@map identifier correspondence > ...` (mutation-proven) | ✅ COMPLIANT |
| Docs-view DDL never fabricates schema data | Zero indexes shows no fabricated index | `row 1`, `row 2` | ✅ COMPLIANT |
| Docs-view DDL never fabricates schema data | A real index shows exactly that index | `row 3`, `row 5` | ✅ COMPLIANT |
| Docs-view DDL never fabricates schema data | Primary-key reference matches the declared schema | `row 7` | ✅ COMPLIANT |

**Compliance summary**: 16/16 scenarios compliant

### Correctness (Static Evidence)
| Requirement | Status | Notes |
|------------|--------|-------|
| `Table.indexes` field | ✅ Implemented | `types.ts:56`, optional `ResolvedIndex[]`, doc comment narrows PK fallback scope (`types.ts:44-50`) |
| Adapter maps `table.indexes` | ✅ Implemented | `schema-adapter.ts:96`, assigned by reference |
| Fabricated index deleted | ✅ Implemented | `ddl-generator.ts` — no `idx_`/`-- Create optimized index` string anywhere |
| `usingClause` takes the index object | ✅ Implemented | `ddl-generator.ts:33-35`, no `??`/`||` default surface |
| Table-level `PRIMARY KEY` | ✅ Implemented | `ddl-generator.ts:53-71`, one clause, `primaryKeyColumns` falls back to `isPK`-flagged columns only when `table.primaryKey` absent, never hardcodes `id` |
| Column lines render physical name consistently | ✅ Implemented | `ddl-generator.ts:20-22,63` (`physicalName`), fixed in `fab2f85` — this is the regression-and-fix pair named in the brief |

### Coherence (Design)
| Decision | Followed? | Notes |
|----------|-----------|-------|
| `Table.indexes` mirrors `ResolvedIndex` structurally, optional/undefaulted | ✅ Yes | `types.ts:56` |
| `usingClause` takes the index object, no default surface | ✅ Yes | `ddl-generator.ts:33-35` |
| Index names emitted only when declared | ✅ Yes | `ddl-generator.ts:40` |
| PRIMARY KEY table-level, never invents `id` | ✅ Yes | `ddl-generator.ts:53-56,70-72` |
| Fixture is real `parse`+`resolve`, not mocked, except two renderer-only rows | ✅ Yes | `ddl-generator.test.ts:28-38`, rows 2/9 hand-built as designed |

### Judgment Calls

**1. Is `physicalName`'s `col.dbName ?? col.name` fallback a fabrication?**
No. `ResolvedColumn.dbName` (`ir.ts:30`) is a required `string`, computed by the compiler as
`@map` override else the field name (`crates/indigo-compiler/src/resolve.rs:30-32`,
`field_db_name`) — **unconditionally populated** for every column that passes through the real
`parse`+`resolve` pipeline. `schema-adapter.ts:76` assigns `dbName: col.dbName` straight through,
so on the real/authoritative data path the `?? col.name` branch in `physicalName` is dead code —
it never fires. The only path where it fires is a hand-built mock `Table` (test rows 2/9, and
Studio's static `mockData.ts`) that never declared any mapping at all; for that data there is no
divergence to paper over — `name` is the only identifier the data has, which is definitionally
identical to what `dbName` would compute (no `@map` was ever expressed, so "override, else name"
reduces to "name"). This mirrors `ResolvedColumn.dbName`'s own canonical rule (`ir.ts:29-30`),
not a substitution for missing information. Verdict: not a fabrication — it is inert on the path
that matters and correct-by-construction on the path where it fires.

**2. Do the spec deltas actually require what shipped?**
Yes, and precisely. `studio-docs-ddl`'s fifth requirement — "Every identifier a `PRIMARY KEY` or
`CREATE INDEX` clause references corresponds to a rendered column line" — names exactly the
regression fixed in `fab2f85`: it requires `table.primaryKey`/`ResolvedIndex.columns` (physical)
and column lines to use the same identifier, explicitly citing the `@map` divergence as the
failure mode. Per `apply-progress.md` and the tasks/design history, this requirement (and its two
scenarios) were added after the renderer regression was found and fixed — the earlier spec draft
was silent on physical/field-name correspondence, which is exactly why the regression shipped
green in the first pass. The spec now closes that gap explicitly.

**3. Does the `studio-ui-honesty` ADDED requirement collide with existing titles?**
No collision confirmed. Canonical `openspec/specs/studio-ui-honesty/spec.md` has 10 existing
requirement titles (grep-verified); the delta's ADDED requirement is titled "Docs-view DDL never
fabricates schema data" — not present among the 10. Canonical count goes 10 → 11 at archive, as
required.

### Out of Scope (confirmed named, not evaluated as findings)
`TableHeroBanner.tsx:34`, `ColumnsSpecTable.tsx:51`, `RelationsPanel.tsx:57`,
`useDocBrowser.ts:59` — named in `proposal.md` "Deferred Follow-Ups" and `tasks.md` "Out of
Scope" as a separate follow-up change. Not implemented here, not flagged as findings.

### Issues Found
**CRITICAL**: None
**WARNING**: `apply-progress.md` reports the focused suite as "12/12 passed" (tasks 4.2, and the
Full Verification table) but the actual file contains 13 tests (2 adapter-boundary + 10 scenario
rows + 1 `@map` identifier-correspondence invariant test). The suite itself is fully green and
the miscount does not affect correctness — the `@map` invariant test exists, runs, passes, and
was independently mutation-proven in this verification — but the apply-phase evidence undercounts
by one test everywhere it cites "12/12". Cosmetic, not blocking.
**SUGGESTION**: None

### Verdict
PASS
All 22/22 tasks complete, 6/6 requirements and 16/16 scenarios compliant with passing runtime
tests, build and lint green, fabrication independently confirmed absent, and the `@map` invariant
independently mutation-proven to fail on its own assertion — one cosmetic apply-progress count
discrepancy (12 vs 13 tests) noted as WARNING only.
