# Verify Report: named-typed-indexes

**Verdict: PASS WITH WARNINGS**

## Mode
Full spec-driven verification (proposal + specs [3 domains] + design + tasks all present; PR A + PR B merged, uncommitted on `feat/phase2-orm-completion`).

## Task Completeness
35/35 checkboxes `[x]` in `openspec/changes/named-typed-indexes/tasks.md`, 0 unchecked. Matches apply-progress record (#605).

## Source-Verified Checks (against design table)

| # | Check | Result |
|---|---|---|
| 1 | `rules.rs`: `ArgShape::Index`, `INDEX_METHODS`, `INDEX_ARG_KEYS`, `MAX_IDENTIFIER_BYTES=63`, `index_method()` | CONFIRMED — all present, `ArgShape::OneReferenceArray` replaced |
| 2 | `validate.rs`: all 9 pinned diagnostics fire with exact text | CONFIRMED — verified byte-for-byte against design's Diagnostics table (unknown type, unknown arg, type-not-identifier, name-not-string, name length/char rule, duplicate name, name-collides-with-derived, unique-rejects-non-btree, unchanged "requires exactly one array argument") |
| 3 | `ir.rs`/`resolve.rs`: `IndexMethod` enum, `ResolvedIndex.index_type` (serde rename "type", declared last, skip_if_none), name/type populated, `type:btree`→`None` | CONFIRMED |
| 4 | `packages/core/src/ir.ts`: mirrored `type?` field | CONFIRMED |
| 5 | `postgres.ts`: `indexName`/`renderIndexDdl` exported; USING placed BEFORE column list, i.e. `... ON "table" USING gin (cols)` | CONFIRMED — placement bug fix is in the code, comment explicitly documents the fix |
| 6 | `migrate.ts`: two-pass diff (`indexKey`/`indexShape`/`indexDefinition`) replaces old `indexSignature`; name-only/method-only changes produce real DDL | CONFIRMED via source read AND golden fixture inspection (`index-name-changed` → `ALTER INDEX RENAME`; `index-method-changed` → `DROP`+`CREATE ... USING hash`, correct placement) |
| 7 | Fixtures 16/17 + snapshots, 6 new migrator golden fixtures | CONFIRMED — all present and consistent with spec/design |
| 8 | Fresh test suites run | See below |
| 9 | Fixture-13 flake — real, pre-existing, unrelated, correctly left reverted | CONFIRMED |
| 10 | Fixtures 01-15 byte-identical except 16 | CONFIRMED (17 also intentionally changed — legitimately exercises new args; 13 flakes on ordering only, same message set) |

## Fresh Test Execution Evidence

| Command | Result |
|---|---|
| `cd crates && cargo test` | PASS — 53 lib unit tests + 36 fixture-corpus tests + 1 parser-panic test, all green |
| `node packages/compiler/test/parity.mjs` | 16/17 fixtures new+correct; 01-12/14-15 byte-identical; fixture 13 FAILS on ordering only (same messages, different order — documented pre-existing flake) |
| `pnpm --filter @indigodb/migrator test` | PASS — migrator.mjs, native-type.mjs, index-ddl.mjs, appliability.mjs (incl. all 6 new index fixtures against real PGlite/Postgres), replay.mjs — all green |
| `pnpm build --force` (root, 0 cached) | PASS — 10/10 tasks |
| `pnpm lint` | PASS — 18/18 tasks (tsc --noEmit) |
| `pnpm test --force` (root, turbo fail-fast) | FAILS at `@indigodb/compiler#test` on fixture 13's flake only, cancelling downstream tasks before they run (not their own failures) — independently confirmed migrator's full suite green via scoped run above |

## Spec Compliance Matrix

| Domain | Requirement | Status |
|---|---|---|
| index-hints | Explicit name honoured / omitted falls back to auto-derivation | PASS — resolve.rs test + fixture 16 |
| index-hints | Explicit method honoured / omitted defaults to btree | PASS |
| index-hints | Push + migration DDL emit name + USING method | PASS — golden fixtures |
| index-hints | Omitting name/type reproduces byte-identical DDL | PASS — fixtures 01-15 unchanged, `index-no-changes-btree-explicit` regression fixture |
| attribute-validation | name/type accepted on @@index/@@unique only, rejected elsewhere | PASS — validate_index_args scoped to index/unique only |
| attribute-validation | Unknown method / duplicate name / malformed name / unique-non-btree diagnostics | PASS — all pinned messages verified |
| migration-diff-completeness | Method-only change diffs, not no-op | PASS — `index-method-changed` golden: DROP+CREATE |
| migration-diff-completeness | Name-only change diffs, not no-op | PASS — `index-name-changed` golden: ALTER RENAME |
| migration-diff-completeness | Unchanged index stays no-op | PASS — `index-no-changes-btree-explicit` golden |

## Design Coherence
All 10 architecture decisions in design.md are reflected in source: ArgShape::Index replaces OneReferenceArray (#1), dual-form type acceptance (#2), closed IndexMethod enum (#3), btree→None canonicalization (#4), field declared last with skip_if_none (#5), table-scoped uniqueness incl. derived single-column @unique names (#6), @@unique restricted to btree (#7), two-pass diff (#8), shared indexName/renderIndexDdl helpers (#9), name literal rules 1-63 bytes/no quotes/no control chars (#10).

## Issues

### CRITICAL
None.

### WARNING
1. Root `pnpm test` (turbo fail-fast) does not itself prove migrator's suite green in a single command — it is cancelled before running. This is a pre-existing turbo/fail-fast interaction, not a defect of this change, but a follow-up (splitting turbo pipeline or `--continue`) would make CI evidence for future compiler-touching changes clearer. Non-blocking here because the scoped `pnpm --filter @indigodb/migrator test` run above independently supplies full green evidence.
2. Fixture 13's HashMap-ordering flake remains open (pre-existing, unrelated to indexes, documented in both PR A and PR B apply-progress). Not fixed by this change and correctly out of scope, but it will keep intermittently failing `pnpm test`/CI for unrelated future changes until addressed.

### SUGGESTION
1. `apps/studio/src/features/docs/lib/ddl-generator.ts` still hardcodes index DDL without name/type awareness (pre-existing bug, explicitly out of scope per proposal) — worth a follow-up ticket so Studio's docs view doesn't silently diverge from the migrator's DDL.
2. `@@unique(type: hash)` rejection (decision #7) is a static, data-independent restriction; if a future PG version supports unique hash indexes this decision may need revisiting — noted as non-blocking in design's Open Questions.

## Final Verdict
**PASS WITH WARNINGS** — all 9 pinned diagnostics, the USING-placement fix, the two-pass diff engine, and full snapshot/golden regression evidence are independently source-verified and test-verified. The only failing check across all suites is the single documented pre-existing fixture-13 ordering flake, unrelated to this change's scope, which does not block PASS. Ready for archive.
