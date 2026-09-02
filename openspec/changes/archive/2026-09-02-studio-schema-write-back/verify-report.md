# Verification Report: studio-schema-write-back

**Change**: studio-schema-write-back (three stacked PRs: #1a `5cdfa22`+`f807c51`, #1b `86334b1`+`71014f0`,
#2 `7f4aa81`+`9e20388`, all on top of `main`@`760d30b`)
**Mode**: Full artifact verification (proposal + specs + design + tasks + apply-progress), Strict TDD active.
**Verdict**: **PASS WITH WARNINGS**

## Completeness

| Check | Result |
|---|---|
| Tasks checked | 84/84 checkbox lines (80 main tasks + 4 required mutation sub-tasks 2.6b/2.8b/2.10b/2.23b), 0 unchecked |
| All claimed tasks landed in a commit | Confirmed — `git show --stat` on all 6 commits accounts for every file tasks.md attributes to that phase; no orphaned task/file mismatch found |
| Proposal Success Criteria | 6/6 checked, each with an evidence reference that resolves to real code/tests |

## Build/Test Evidence (run directly, this session)

| Command | Result |
|---|---|
| `node packages/cli/test/studio-schema-source.mjs` | **PASS** — `@indigodb/cli studio-schema-source: all green`, reachability guard `ran === 5` (see Finding W1 below) |
| `node packages/cli/test/studio-schema-write.mjs` | **PASS** — `@indigodb/cli studio-schema-write: all green`, reachability guard `ran === 19` |
| `pnpm --filter @indigodb/studio test` | **PASS** — 24/24 files, 153/153 tests |
| `pnpm --filter @indigodb/studio lint` (`tsc -b --noEmit`) | **PASS**, clean exit, confirmed the `-b` form is actually in `package.json` |
| `pnpm clean && pnpm build --force && pnpm lint && pnpm test` (root gate) | **PASS** — 18/18 Turbo tasks, `pack-contents` guard green, no errors in the full log (3890 lines inspected) |

## Scenario Coverage (37/37 claimed)

Cross-checked every scenario in all five spec files (`studio-schema-write`, `studio-editor-diagnostics`,
`studio-server-security`, `studio-readonly-mode`, `studio-audit-log`) against the Scenario Coverage Map
in `tasks.md` and the actual test files/source. All 37 have a concrete, runtime-executed covering test
(CLI suites for server-side scenarios; Vitest for UI scenarios; SD-3 explicitly typecheck-only, not
runtime — correctly excluded from the vitest pass count per task 3.25, confirmed by reading
`markers.test.ts`'s `@ts-expect-error` case). No gaps found. Full row-by-row mapping in `tasks.md` was
spot-checked against source for the highest-risk rows (SW-1/4/6/7/8/9/11/16, SD-1/2/5/6/7) by reading
the actual implementation, not just trusting the map.

## Adversarial Checks

### Mutation proofs — independently re-run (not just trusted from apply-progress)

Re-ran the two mutations judged weakest, against a rebuilt `dist/` (the test suites import from
`../dist/studio-server.js`, not `src/` — a rebuild is required for a source mutation to take effect;
this is a real gotcha, not a false-negative in the original proof):

- **2.10b** (duplicated-sentinel "use first match" instead of refuse): mutated `reattachDatasource`'s
  `>= 2` branch to fall through to the splice. After `pnpm --filter @indigodb/cli build`, re-ran
  `studio-schema-write.mjs`: `FAIL PUT: a duplicated sentinel line is refused with 400 ... — Error:
  expected 400, got 200`. Matches the apply-progress claim exactly. Reverted, rebuilt, confirmed clean
  (0 diff, both suites green again).
- **2.6b** (drop version-type check + make staleness comparison falsy-bypassable): same treatment.
  After rebuild: `FAIL PUT: a missing version field is refused with 400 ... — Error: expected 400, got
  200`. Matches the apply-progress claim. Reverted, rebuilt, confirmed clean.

Both bite as claimed. No evidence of a self-blind negative control in this change.

### 409 conflict — buffer survival proven, not just banner presence

`ERDDesignerPage.test.tsx`'s SD-5 case asserts the editor's rendered value is **byte-identical** to the
pre-save edited buffer (`ORIGINAL_SOURCE + '\nmodel Bar {}'`) after the 409 response, in addition to the
banner's `role="alert"` text. This is a real survival proof, not a banner-only check. Read `handleSave`
in `ERDDesignerPage.tsx`: the `409` branch only sets `saveBanner`, never touches `dslCode` — matches.

### Validation errors — zero markers, verified in the actual UI code path

Read `useERDParser.ts`: `validate(schema)` runs before `resolve()`; a non-empty result is classified as
`{source: 'validate', message, model, field}` with no `line`/`column` fields at all — never derived from
a text search. Read `diagnostics.ts`: `toMarkers` accepts only `PositionalDiagnostic[]` (all four
position fields required, non-optional) and `isPositional` is a real type guard checking all four fields
are defined — a `validate`-source diagnostic structurally cannot pass it. `markers.test.ts` backs this
with a runtime `isPositional` check (`false` for a position-less diagnostic) plus the SD-3
`@ts-expect-error` compile guard. `DiagnosticsPanel.tsx` renders `"No source location available"`
(`data-testid="no-source-location"`) for any non-positional entry — no fabricated line/column path
exists anywhere in this chain.

### SD-3 — confirmed typecheck-only, not counted as runtime coverage

`markers.test.ts` contains one `@ts-expect-error` line with no runtime assertion around it; task 3.25
explicitly says this file "is a compile-time guard only, verified by 3.26, not counted in this run's
pass count." Confirmed correct framing — `pnpm --filter @indigodb/studio lint` is what actually gates it.

## Disclosed Deviations — judged

1. **Local `SchemaParseErrorDetail` instead of importing `ParseErrorDetail`.** Read both definitions
   side by side (`packages/parser/src/index.ts:30-34` vs `apps/studio/src/lib/api.ts:66-71`) — fields,
   optionality, and types are identical (`message: string; line?/column?/endLine?/endColumn?: number`).
   Justified: `@indigodb/core` (the only package `apps/studio` depends on) does not re-export
   `ParseErrorDetail`. **Not currently caught by an automated structural check** — a future change to
   `ParseErrorDetail`'s shape in `@indigodb/parser` would not fail any test in this repo; it would only
   surface as a runtime shape mismatch. Non-blocking (SUGGESTION, see S1).
2. **Undo-reload renders independently of the 409 banner, not nested inside it.** Confirmed in
   `ERDDesignerPage.tsx`: the `saveBanner` block (409/error) and the `preReloadBuffer !== null` block are
   two separate, sibling JSX blocks, not nested. `ERDDesignerPage.test.tsx`'s SD-6 case exercises the
   real sequence (409 → Reload → assert disk text applied → Undo reload → assert original buffer
   restored) and passes. The literal spec scenario ("A concurrent external edit is caught before
   overwrite" / SD-6 in design's table) only requires Reload + Undo to work as described; it does not
   mandate DOM nesting. Judged: correctly resolved, matches both the claimed bug rationale (nesting hides
   Undo exactly when Reload clears the banner) and the passing test.

## Cross-Slice Integrity

- **`AuthStatus.schemaWritable` ripple**: diffed `5cdfa22..7f4aa81` for every touched pre-existing test
  literal (`App.test.tsx`, `useAuthStore.test.ts`, `studio-audit.mjs`'s byte-identical-probe key list).
  Every change is a mechanical addition of the new field to an existing object literal or an expected-key
  array; no existing assertion was loosened, removed, or had its expected value changed. The
  `studio-audit.mjs` key-count assertion was in fact strengthened (six keys → seven, both still an exact
  match, not a subset check).
- **PR #1a's GET-only verb guard vs PR #1b's PUT handler**: `studio-server.ts:1203` matches only
  `req.method === "GET"` for `/api/schema/source`; the PUT handler is a separate, later `if` block at
  `:1232`. Re-ran `studio-schema-source.mjs`'s GET-only case after the full stack was built — still green
  ("every other verb on /api/schema/source is refused and serves no source at all"). Not regressed.

## Counts and Messages

- **Finding (WARNING, W1)**: `packages/cli/test/studio-schema-source.mjs`'s reachability guard is
  `strictEqual(ran, 5, "expected exactly 5 check() cases in studio-schema-source.mjs")` — confirmed
  correct by direct execution (5 `check()` calls, 5 passes, guard holds). The filesystem
  `apply-progress.md` documents the 4→5 progression accurately in its Phase 1 section (lines ~177), but
  one later cross-phase summary line (`apply-progress.md:547`, in the Phase 2/3 "both prior CLI suites
  re-run unmodified" recap) states **"Phase 1a, 6 cases"** — off by one against the actual, currently
  passing guard. This is a documentation inconsistency in a summary recap line, not a functional defect:
  the guard itself, the test file, and every other reference to this count are correct. Does not affect
  test pass/fail status or coverage.
- `studio-schema-write.mjs`'s guard (`ran === 19`) is consistent everywhere it is mentioned (tasks.md,
  apply-progress.md, this session's live run).
- All Route Contract / audit-reason strings (`stale`, `redaction-conflict`, `schema-invalid`,
  `read-only`, `io-error`, `not-found`, `invalid-request`) were observed directly in this session's live
  stdout capture (root gate log) and match the spec's named reasons exactly.

## TDD Compliance

| Check | Result | Details |
|---|---|---|
| TDD Evidence reported | ✅ | Full RED/GREEN/TRIANGULATE/SAFETY NET/REFACTOR tables present in `apply-progress.md` for all three phases |
| All tasks have tests | ✅ | 80/80 numbered tasks map to a test file or an explicit structural/regression task |
| RED confirmed (tests exist) | ✅ | `studio-schema-source.mjs`, `studio-schema-write.mjs`, and the six new/modified `apps/studio` test files all exist and were read directly |
| GREEN confirmed (tests pass) | ✅ | All suites re-run in this session, all green |
| Triangulation adequate | ✅ | `splitDatasource` 4-fixture property test, `reattachDatasource`'s 5 distinct branches each independently tested, `saveSchemaSource`'s discriminated union covered by 200/409/422/other branches |
| Safety Net for modified files | ✅ | `studio-server.ts`, `util.ts`, `useAuthStore.ts`, `api.ts` all had pre-existing suites (`studio-server.mjs`, `studio-readonly.mjs`, `studio-audit.mjs`, `App.test.tsx`) re-run green before/after |
| Required mutations (4/4) | ✅ | 2.6b and 2.10b independently reproduced this session; 2.8b and 2.10b's siblings' methodology (temporarily loosen a `400` branch, expect a specific assertion failure, revert) is identical and consistently documented in `apply-progress.md` for 2.8b/2.23b as well |

**TDD Compliance**: 7/7 checks passed

## Assertion Quality

Scanned the new/modified test files (`studio-schema-source.mjs`, `studio-schema-write.mjs`,
`useERDParser.test.tsx`, `DslEditorToolbar.test.tsx`, `ERDDesignerPage.test.tsx`, `markers.test.ts`,
`api.test.ts`, `useAuthStore.test.ts`) for banned patterns (tautologies, ghost loops, assertion-free
production-code calls, smoke-test-only render+toBeInTheDocument, orphan empty-collection checks).

No tautologies or ghost loops found. Every assertion reached exercises production code
(`splitDatasource`, `reattachDatasource`, the HTTP routes, `useERDParser`, `toMarkers`/`isPositional`,
`saveSchemaSource`). SD-5/6/7's assertions check concrete values (byte-identical buffer text, specific
diagnostic entry counts, specific button states) rather than presence-only checks.

**Assertion quality**: ✅ All assertions verify real behavior

## Issues

### CRITICAL
None.

### WARNING
- **W1**: `apply-progress.md:547` states "Phase 1a, 6 cases" for `studio-schema-source.mjs`; the actual,
  passing reachability guard is `ran === 5`. Documentation-only inconsistency in a cross-phase summary
  line — does not affect any test result, coverage claim, or code path. Recommend a one-line correction
  before archive, but it is not a blocker.

### SUGGESTION
- **S1**: `apps/studio/src/lib/api.ts`'s `SchemaParseErrorDetail` is manually kept structurally identical
  to `@indigodb/parser`'s `ParseErrorDetail` with no automated check (no shared type import, no
  structural-assignability test). A future shape change to `ParseErrorDetail` would not fail any test in
  this repo. Consider either re-exporting `ParseErrorDetail` from `@indigodb/core` in a later change, or
  adding a cheap compile-time structural-assignability assertion (e.g. a `satisfies`/assignability check)
  in `apps/studio` to catch drift early.

## Final Verdict

**PASS WITH WARNINGS** — 0 CRITICAL, 1 WARNING, 1 SUGGESTION. All 37 spec scenarios have runtime-proven
coverage, all 84 task checkboxes correspond to real, committed, currently-passing code, both re-examined
mutation proofs bite exactly as claimed after an independent rebuild, the two disclosed deviations are
justified and tested, cross-slice ripple changes are mechanical and non-weakening, and the full root gate
(`pnpm clean && pnpm build --force && pnpm lint && pnpm test`) passes cleanly. The sole issue (W1) is a
one-line documentation miscount with no functional impact — safe to proceed to archive after an optional
doc fix.
