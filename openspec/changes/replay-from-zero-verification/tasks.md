# Tasks: Replay-from-Zero Verification

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~300 (design estimate) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: stacked-to-main
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Comparator + chain fixture + replay suite, wired into `test` | PR 1 | `pnpm --filter @indigodb/migrator test:replay` | `pnpm --filter @indigodb/migrator test:replay` (PGlite, in-process) | Revert `replay.mjs`, `fixtures-chain/`, and the two edits to `pg-harness.mjs`/`lib.mjs`/`package.json`; no production code touched |

## Phase 1: Comparator Self-Tests (RED)

- [x] 1.1 In `packages/migrator/test/pg-harness.mjs`, add a RED self-test block (or a temporary test file) that imports a not-yet-existing `assertSameStructure`/`introspectPublicSchema` and observe the import/usage fail — confirms no premature implementation exists yet.
- [x] 1.2 Write self-test: two hand-built PGlite instances with `"n" text` vs `"n" integer` on table `T`; call `assertSameStructure`; assert it throws with a message containing `T.n`, `text`, `integer`. Confirm it fails RED before the helper exists.
- [x] 1.3 Write self-test: two instances with identical columns but differently-named PK constraint and index; assert `assertSameStructure` does NOT throw. Confirm RED (fails because helper doesn't exist).
- [x] 1.4 Write self-test: instance B lacks a 3-column table present in A; assert exactly one `table "..."` divergence line, not one per column. Confirm RED.

## Phase 2: Comparator Implementation (GREEN)

- [x] 2.1 In `packages/migrator/test/pg-harness.mjs`, add `introspectPublicSchema(db)` running the `information_schema.columns` ⋈ `information_schema.tables` query (`table_schema = 'public'`, `table_type = 'BASE TABLE'`, columns `table_name, column_name, data_type, udt_name, is_nullable, column_default, is_identity, identity_generation`, `ORDER BY table_name, column_name`), returning a `Map` keyed `${table}.${column}` → `{ table, column, type, nullable, default }` per the design's normalization rules (`enum:${udt_name}` for `USER-DEFINED`; `identity:${identity_generation}` when identity else whitespace-collapsed `column_default ?? null`).
- [x] 2.2 Add `assertSameStructure(a, b, { aLabel, bLabel })` to `pg-harness.mjs`: positive-selection comparison over exactly `table, column, type, nullable, default`; collects ALL divergences, emits ONE line per missing table (not per column), sorted, and throws once joining lines with the exact formats from design (`table "X": present in A, absent in B`, `T.c: type mismatch — A=..., B=...`, etc.).
- [x] 2.3 Re-run the three Phase 1 self-tests; confirm all three now pass (GREEN).

## Phase 3: Chain Fixture

- [x] 3.1 Create `packages/migrator/test/fixtures-chain/user-post-status/schema-01.indigo` — `enum Status { ACTIVE INACTIVE }` + `Table User { id Int @id @default(autoincrement()); email String @unique; status Status @default(ACTIVE) }`.
- [x] 3.2 Create `schema-02.indigo` — same as `schema-01` plus `name String?` on `User`.
- [x] 3.3 Create `schema-03.indigo` — same as `schema-02` plus enum member `PENDING` appended to `Status`.
- [x] 3.4 Create `schema-04.indigo` — same as `schema-03` plus `Table Post { id Int @id @default(autoincrement()); authorId Int; author User @relation(fields: [authorId], references: [id]); status Status @default(PENDING) }`.
- [x] 3.5 In `packages/migrator/test/lib.mjs`, add `loadChainFixture(dir)`: reads sorted `schema-NN.indigo` files, parses+resolves each via `parse`/`resolve`, throws on an empty or gapped sequence, returns the ordered array of resolved schemas.

## Phase 4: Chain Replay Suite

- [x] 4.1 Create `packages/migrator/test/replay.mjs` with header comment (mirrors `appliability.mjs` scope-statement style), imports (`loadChainFixture` from `./lib.mjs`; `withDatabase`, `applyPlan`, `introspectPublicSchema`, `assertSameStructure` from `./pg-harness.mjs`; `planMigration`, `renderMigrationSql`, `renderPushSql` from `../dist/index.js`), and a local `check()` runner copied from `appliability.mjs`.
- [x] 4.2 Add integration test "chain replays from empty": one `withDatabase` call; loop hops 1→4 running `planMigration(schema[i-1] ?? null, schema[i])` → `renderMigrationSql` → `applyPlan(db, sql)` with NO reset between hops; assert each hop's `applyPlan` returns ≥1 executed statement and hop 3 (the enum-value hop) returns 2 (pre-transaction + transactional body).
- [x] 4.3 Add integration test "replay ≡ push": build database A per 4.2 inside one `withDatabase`; build database B in a SEPARATE `withDatabase` applying `renderPushSql(schema-04's resolved schema)` once; call `assertSameStructure(introspectPublicSchema(A), introspectPublicSchema(B), { aLabel: "migrate-path", bLabel: "push-path" })`; assert it does not throw.
- [x] 4.4 Add console summary/exit-code handling matching `appliability.mjs`'s pattern (`failures` counter, non-zero `process.exit` on failure).

## Phase 5: Wiring

- [x] 5.1 In `packages/migrator/package.json`, change `"test"` to `"node test/migrator.mjs && node test/appliability.mjs && node test/replay.mjs"` and add `"test:replay": "node test/replay.mjs"`.
- [x] 5.2 Run `pnpm --filter @indigodb/migrator test:replay` and confirm the full suite (self-tests + chain replay) passes.
- [x] 5.3 Run `pnpm --filter @indigodb/migrator test`, `pnpm build`, `pnpm lint`, `pnpm test` (root), and `cd crates && cargo test`; confirm all pass with no unrelated regressions.

## Phase 6: Spec Promotion

- [ ] 6.1 Update `openspec/specs/migration-appliability-tests/spec.md` to fold in the delta requirements from `openspec/changes/replay-from-zero-verification/specs/migration-appliability-tests/spec.md` (chain fixtures, additive-only hops, single-instance no-reset replay, separate push-seeded instance, positive-selection structural comparison, hard-failure on divergence, wiring into the existing test run). **DEFERRED to sdd-archive** — the apply-phase session brief explicitly forbids touching `openspec/specs/` (the promoted store) during apply; promotion happens at archive time.
