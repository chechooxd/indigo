# Verify Report: fix-migrator-correctness

**Verdict: PASS WITH WARNINGS**

## Mode

Full artifact set present (proposal, design, tasks, apply-progress, 6 spec deltas). Full completeness/correctness/coherence verification performed, plus runtime gate execution.

## Task completeness

30/30 tasks checked in `tasks.md`, cross-checked against source (not just checkboxes). All 30 verified genuinely complete by reading `migrate.ts`, `postgres.ts`, `plan.ts`, `index.ts`, `migrate-runner.ts`, `client.ts`, and their fixtures. No task found checked but unimplemented.

## Gate output (run fresh by this verify pass, not reused from apply)

### `pnpm test` (force, no cache)
All 13 Turbo test/build tasks successful. Migrator: 19 fixtures × 4 assertions each (`statements`, `diagnostics`, `migrationSql`, `pushSql`) + 3 `splitMigrationSql` unit cases — all `ok`. Generator: 3/3 enum-mapping checks `ok`.

### `pnpm build` (force, no cache)
10/10 Turbo build tasks successful, including `@indigodb/studio` (tsc -b + vite build) and `@indigodb/cli`.

### `pnpm lint` (force, no cache)
18/18 Turbo lint tasks successful (`tsc --noEmit` across every package).

### `cd crates && cargo test`
4 unit tests + 19 fixture tests, all `ok`. Unaffected by this change (no IR/compiler edits) — confirms the "crates untouched" scope claim at the runtime level, not just via diff-stat.

## Golden-harness asserted-vs-computed parity audit

**`packages/migrator/test/migrator.mjs`**: `computeActual` (in `test/lib.mjs`) returns 4 fields — `statements`, `diagnostics`, `migrationSql`, `pushSql`. All 4 are asserted via `deepStrictEqual` in `migrator.mjs` (lines 55–58) for every one of the 19 fixtures — confirmed programmatically (`jq 'has(...)'` over every `expected.json`: all 19 carry all 4 fields). The `plan.diagnostics`-computed-but-never-asserted gap the apply phase self-reported (now fixed by adding the `diagnostics` deepStrictEqual line) is genuinely closed, not just claimed — verified by reading the fixed source, not the apply-progress note.

**`packages/compiler/test/parity.mjs`**: only computes what it asserts (`schema`, `resolveSchema`, `validateSchema`, plus `errors[].line` for error fixtures) — no unasserted-computed-field class of bug present here.

**`packages/generator/test/enum-mapping.mjs`**: narrow, single-purpose harness (3 checks against one fixture) — no computed-but-unasserted field; correctly scoped to the one behavior (`dbName` in generated enum values) this change's scope owns.

## Self-reported coverage gap — confirmed closed

Apply phase (task 3.5) flagged: FK/index auto-derived-name realignment on a `@map` rename had no dedicated fixture. Commit `ea9bc14` ("test(migrator): pin dependent-object realignment on a @map rename") adds fixture `map-rename-with-dependents`: a column carrying both a single-column unique index and a foreign-key target, renamed via `@map`. Golden pins the exact sequence — `DROP CONSTRAINT` (dependent FK) → `RENAME COLUMN` → `ALTER INDEX ... RENAME TO` → `ADD CONSTRAINT` (FK re-added) — and passes under fresh `pnpm test`. Gap genuinely closed, not just checkbox-closed.

## Additional gap found by this verify pass — not self-reported

**Design decision (design.md "Enum diff" section, decision "retained with changed `dbName` → `ALTER TYPE ... RENAME VALUE`") was NOT implemented.**

- `design.md` explicitly specifies three arms for enum member diffing keyed by logical name: added → `ADD VALUE`; removed → refusal diagnostic; **retained with changed `dbName` → `ALTER TYPE ... RENAME VALUE`** (transactional, PG 10+). Design also flags this decision as beyond the spec's letter and says "drop it if review prefers strict spec scope" (design.md, Open Questions #4).
- `rg -n "RENAME VALUE" packages/migrator/` returns zero matches. `computeStatements`'s enum loop (`migrate.ts:528-549`) only handles two cases: a member name absent from `oldNames` → `ADD VALUE`; a member name absent from `nextNames` → removal diagnostic. A member whose **name is unchanged but whose `@map` (dbName) changes** falls into neither branch and produces **zero DDL and zero diagnostic** — a genuine silent no-op, in the same class of bug this entire change exists to eliminate.
- No fixture exercises this case; `enum-value-mapped` only tests a *new* mapped member being added, not an existing member's `dbName` changing.
- Because this arm was explicitly marked optional/droppable in design and is not named in any of the 6 specs' requirements, this is **not a spec violation** — it does not fail any spec scenario. Per the Decision Gates table ("Design deviation exists → WARNING unless it breaks a spec"), this is a **WARNING**, not CRITICAL.
- Separately, `apply-progress` (obs #292) states "Deviations from design: None" for Phase 3, and no equivalent statement exists for Phase 2 (where the enum-diff loop was built). That claim is now known to be inaccurate — this is an undisclosed deviation, worth surfacing to the maintainer even though it doesn't block spec compliance.

**Recommendation**: either implement the `RENAME VALUE` arm (small, contained addition to the enum loop in `computeStatements`, mirroring the existing `ADD VALUE`/removal branches) with one golden fixture, or explicitly record in the release note that an enum member's `@map`-only change is currently a silent no-op (matching the honesty standard already applied to the two documented limitations). Leaving it unimplemented AND undocumented is the actual risk, not the omission itself.

## Requirement traceability

| Spec domain | Requirement | Implementation | Covering test | Status |
|---|---|---|---|---|
| migration-ddl-ordering | FK never precedes referenced table (declaration order) | `migrate.ts` 3a/3b/3c pass split | `fk-order-declaration` | PASS |
| migration-ddl-ordering | Self-reference | same | `fk-self-reference` | PASS |
| migration-ddl-ordering | Genuine A↔B cycle | same | `fk-cycle` | PASS |
| migration-ddl-ordering | Existing table FK's new table | same | `fk-to-new-table-from-existing` | PASS |
| migration-ddl-ordering | Fixed top-level category order (all 5) | `computeStatements` ordering | `category-order-combined` | PASS |
| migration-ddl-ordering | ADD VALUE outside transaction, same file | `plan.ts` phase tag + `NO_TRANSACTION_*` markers, `splitMigrationSql` | `enum-add-value`, `splitMigrationSql` unit cases | PASS |
| migration-ddl-ordering | Re-running applied ADD VALUE is a no-op | `IF NOT EXISTS` in `createEnum`/ADD VALUE emission | Structural only (text pinned); no live PG — consistent with documented limitation | PASS (text-level) |
| migration-diff-completeness | Unambiguous `@map`-only rename → RENAME COLUMN | `matchColumns` + `remapPhysicalNames` | `map-rename-only`, `map-rename-with-dependents` | PASS |
| migration-diff-completeness | Simultaneous name+`@map` change refused | Rule R (`ambiguousColumnRemapDiagnostic`) | `map-rename-ambiguous` | PASS |
| migration-diff-completeness | PK change → DROP+ADD constraint | PK diff block in `diffTable` | `pk-change` | PASS |
| migration-diff-completeness | Enum value removal refused | `enumValueRemovedDiagnostic` | `enum-value-removed` | PASS |
| migration-safety-guards | Required column w/o default refused | NOT NULL guard in `diffTable`'s added-column loop | `not-null-no-default` | PASS |
| migration-safety-guards | Same w/ default → unguarded (regression) | same | `not-null-with-default` | PASS |
| migration-safety-guards | Optional column, no default → unguarded (regression) | same | `optional-column-added` | PASS |
| migration-golden-tests | Fixture = schema pair + approved expectation | 19 fixtures, all with `prev`/`next`/`expected.json` | harness itself | PASS |
| migration-golden-tests | Harness fails loudly on divergence | `deepStrictEqual` + non-zero exit | verified via harness code + a fresh green run | PASS |
| migration-golden-tests | Explicit, reviewable regeneration | `test/regen-goldens.mjs`, no auto-regen path | code inspection | PASS |
| migration-golden-tests | Wired into workspace `pnpm test` | `package.json` `"test": "node test/migrator.mjs"` | `pnpm test` output (migrator task ran) | PASS |
| migration-golden-tests | Goldens pin text, not appliability | documented in design + release-notes.md | N/A (honesty requirement, not a behavior) | PASS |
| referential-actions (delta) | onDelete/onUpdate reach both renderers | `addForeignKey`/`renderForeignKey` include `ON UPDATE` | `fk-actions-emitted` (both `migrationSql` and `pushSql` asserted) | PASS |
| referential-actions (delta) | Action-only change re-issues FK (DROP+ADD) | `fkDefinition()` compared for matched FKs | `fk-actions-changed` | PASS |
| referential-actions (delta) | Fully unchanged FK → zero DDL | same | `fk-unchanged` | PASS |
| enum-value-mapping (delta) | CREATE TYPE/ADD VALUE/push render from `dbName` | `enumMembers()` in both renderers | `enum-value-mapped` (both renderers asserted) | PASS |
| enum-value-mapping (delta) | Unmapped member unchanged (regression) | `enumMembers()` fallback `dbName === name` | covered implicitly by every fixture with an unmapped enum member (e.g. `enum-add-value`'s `INACTIVE`) | PASS |
| enum-value-mapping (delta, design addendum, NOT in the 6 specs) | Retained member, changed `dbName` → RENAME VALUE | **Not implemented** | **No fixture** | **GAP — WARNING (design-only, not spec-required)** |

## Scope audit

`git diff --stat f6e3faf..ea9bc14` (branch tip) confirms all changed files fall within: `packages/migrator/**`, `packages/generator/{package.json,src/client.ts,test/**}`, `packages/cli/src/migrate-runner.ts`. Zero changes to `crates/`, `packages/core`, `packages/ast`, `packages/client`, `apps/studio`. `cargo test` gate result (unaffected, all green) independently corroborates the crates claim at runtime, not just via diff.

## Release note audit

`release-notes.md` reviewed against the requirement:
- Leads with the "previously-silent changes now produce migrations" warning — confirmed, first section ("Read this before your next `migrate dev`").
- Lists every behavior change a user will notice: `@map` rename → RENAME COLUMN + dependent-object realignment, PK change → DROP+ADD, referential actions/enum `@map` (cross-referenced to the prior PR), plus `migrate dev`'s new refuse-on-diagnostic behavior and the `migrations/` backward-compatibility note.
- Both known limitations present and honestly worded: PK rename assumes `<table>_pkey`, and "goldens pin generated SQL text, not appliability" with the no-PostgreSQL-in-CI caveat and the named integration-testing follow-up.
- **Gap**: does not mention the enum `RENAME VALUE` non-implementation (see gap above) — since that arm isn't implemented, there is nothing to release-note about it *as a feature*, but the resulting silent no-op is exactly the class of behavior this release note otherwise takes care to flag. Minor omission, consistent with the WARNING above.

## Inherited-incompleteness closure (predecessor change)

`onUpdate` and enum `members` — both were exposed on the IR by `fix-compiler-schema-validation` (predecessor) but left unconsumed by the migrator/generator. Confirmed closed by this change:
- `onUpdate`: threaded into `addForeignKey`/`renderForeignKey` (both renderers) and into `fkDefinition()` for change detection — `fk-actions-emitted`/`fk-actions-changed` exercise it in both `migrationSql` and `pushSql`.
- `members`/`dbName`: threaded via `enumMembers()` into `createEnum`/`renderEnum`/ADD VALUE in both renderers, into `renderDefault` (enum-literal defaults), and into the generated client (`client.ts`) — closing a real cross-package hazard identified in design's Open Questions #2 (client sending logical names while migrator creates PG labels from `dbName`).

## Characterization fixtures — turned green vs. stayed unchanged

- Turned GREEN this change (previously wrong/silent): `enum-value-removed`, `map-rename-only`, `map-rename-ambiguous` (new), `pk-change`, `not-null-no-default`, and (Phase 2) `fk-order-declaration`, `enum-add-value` (both corrected from their original characterization of *today's buggy* output).
- Confirmed unchanged (regression-pinned, zero diff across phases per `apply-progress`'s stated `git diff --stat` check, independently re-verified by a fresh `pnpm test` run in this pass): `no-changes`, `not-null-with-default`, `optional-column-added`, `fk-self-reference`, `fk-cycle`, `fk-to-new-table-from-existing`, `category-order-combined`, `enum-value-mapped`, `fk-actions-emitted`, `fk-actions-changed`, `fk-unchanged`.

## Known context (per verification brief — not re-litigated as findings)

- Slice line counts exceeded ceilings; maintainer-accepted, not a finding.
- No PostgreSQL runs anywhere in this suite or CI; goldens pin SQL text only. Documented, accepted, follow-up named. Reported here as context only.

## Issues

### CRITICAL
None.

### WARNING
1. **Enum `RENAME VALUE` design decision not implemented, no fixture, and no release-note honesty caveat.** A retained enum member whose `@map` changes produces zero DDL and zero diagnostic — a silent no-op in the same class this change exists to eliminate. Not a spec violation (design marked it droppable), but `apply-progress`'s "Deviations from design: None" understates the actual state. See gap section above for remedy options.

### SUGGESTION
1. Consider a dedicated fixture for the PK-rename-with-hand-named-constraint edge case (currently undocumented as untested rather than only "assumes default naming") — low priority, already disclosed as a known limitation in the release note.

## Verdict

**PASS WITH WARNINGS.** All 30 tasks genuinely complete, all four gates green (freshly executed, not cache-reused), scope discipline held, release note accurate except for one omission, and the self-reported coverage gap (dependent-object realignment) is genuinely closed. One undisclosed, non-spec-blocking design deviation (enum `RENAME VALUE` arm) found independently by this verify pass — recommend the maintainer either implement it with a fixture or explicitly document it as a known limitation before archive.
