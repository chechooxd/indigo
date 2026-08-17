# Tasks: Shadow-Replay Diff Source

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1100+ authored (200 + 500 + 400) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR A -> PR B -> PR C |
| Delivery strategy | auto-chain |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Physical-identity fallback matching in migrate.ts | PR A (base: feature/shadow-replay-diff) | `node packages/migrator/test/migrate.mjs` (or `pnpm --filter @indigodb/migrator test`) | N/A — pure function unit tests, no live DB needed | Revert matchTables/matchColumns/enum-fallback changes; goldens stay byte-identical so revert is a clean no-op |
| 2 | introspectResolvedSchema + exports | PR B (base: PR A branch) | `node packages/migrator/test/introspect.mjs` | Real: PGlite-backed round-trip (push -> introspect -> planMigration) over fixture corpus | Remove introspect.ts + index.ts export; PR A unaffected since no caller yet |
| 3 | shadow.ts + migrate-runner restructure + PGlite dep promotion | PR C (base: PR B branch) | `node packages/migrator/test/shadow.mjs` | Real: PGlite shadow replay against fixtures-chain/user-post-status, plus `pnpm --filter @indigodb/cli test` for migrate-runner wiring | Revert migrate-runner.ts to snapshot-only path via INDIGODB_MIGRATE_PREV=snapshot; PGlite dep demotion is a package.json-only revert |

## Phase A: Physical-Identity Fallback Matching (migrate.ts)

- [x] A.1 RED: add fixture/test asserting `@@map` table steady-state produces no spurious drop/create when prev/next only differ by dbName vs missing logical name.
- [x] A.2 RED: add fixture/test asserting `@map` column type-change on a mapped column is NOT skipped (pass-2 must yield a pair, not just consume).
- [x] A.3 RED: add fixture/test asserting a `@map`'d enum member does not trigger `enum-value-removed`.
- [x] A.4 RED: add byte-identical-golden-corpus regression test asserting every existing golden in `fixtures/snapshots/` is unchanged after this PR.
- [x] A.5 GREEN: implement `matchTables` (pass 1 by name, pass 2 by dbName; drop detection via consumed set, not `nextTables.has(name)`) in `packages/migrator/src/migrate.ts`.
- [x] A.6 GREEN: fix `matchColumns` pass 2 to push a pair instead of only consuming, for both name and dbName matching.
- [x] A.7 GREEN: add enum-member physical fallback (pass 1 name, pass 2 dbName) in enum diffing logic.
- [x] A.8 GREEN: update `computeStatements` (table drop detection) to use consumed sets instead of `nextTables.has(name)`.
- [x] A.9 VERIFY: run full regression harness (`node packages/compiler/test/parity.mjs` equivalent for migrator, plus `pnpm --filter @indigodb/migrator test`) confirming zero golden byte diffs.

## Phase B: Schema Introspection (introspect.ts)

- [x] B.1 RED: add `introspect.mjs` unit test for type/nativeType inversion table (text->String, integer->Int, numeric->Decimal, bytea->Bytes, character varying(n)->VarChar, uuid->Uuid, numeric(p,s)->Numeric).
- [x] B.2 RED: add test asserting unmappable pg type THROWS naming `table.column`.
- [x] B.3 RED: add test asserting FK `confdeltype`/`confupdtype` value `'a'` (NO ACTION) normalizes to ABSENT, not a literal action.
- [x] B.4 RED: add test asserting derived-vs-explicit name policy — `index.name`/`fk.name` populated only when it differs from `indexName()`/`fkName()`'s derived formula.
- [x] B.5 RED: add round-trip test — for every fixture in the corpus: `renderPushSql(schema)` -> `introspectResolvedSchema` -> `planMigration(introspected, schema)` yields an empty plan (zero statements, zero diagnostics).
- [x] B.6 GREEN: implement `introspectResolvedSchema(query, {schema?, exclude?})` in `packages/migrator/src/introspect.ts` — 6 catalog queries: tables, columns, PK/FK constraints, indexes+amname, enums, `indigo_rt_*` triggers.
- [x] B.7 GREEN: implement column mapping (name===dbName, type inversion, nullable, isPk, unique, autoincrement via identity detection, default parsing for `now()`/`gen_random_uuid()`/literals/enum-cast literals, nativeType for out-of-inverse-table types).
- [x] B.8 GREEN: implement PK/FK/index/enum derivation with the normalizations from B.3/B.4.
- [x] B.9 GREEN: export `introspectResolvedSchema` and its `IntrospectionQuery` type from `packages/migrator/src/index.ts`.
- [x] B.10 VERIFY: run `node packages/migrator/test/introspect.mjs` and confirm round-trip passes for the full fixture corpus.

## Phase C: Shadow Replay + migrate-runner Restructure

- [x] C.1 RED: add `shadow.mjs` plan-equivalence test over the fixture corpus — `planMigration(introspectedPrev, next)` equals `planMigration(resolvedPrev, next)`, excluding the documented `@map` divergence fixture.
- [x] C.2 RED: add positively-asserted `@map` divergence test: map-rename-only -> DROP+ADD instead of RENAME COLUMN (shadow-derived prev).
- [x] C.3 RED: add positively-asserted `@map` divergence test: map-rename-with-dependents -> DROP+ADD, dependents handled correctly.
- [x] C.4 RED: add positively-asserted `@map` divergence test: map-rename-ambiguous -> no `ambiguous-column-remap` diagnostic fires, DROP+ADD emitted instead.
- [x] C.5 RED: add single-column `@@unique` divergence test — identical-index drop+recreate on first post-adoption migration.
- [x] C.6 RED: add chain-replay-through-shadow test using `fixtures-chain/user-post-status` — real `migrations/<id>` dirs replayed via `buildShadowSchema`, compared against `renderPushSql(final)` via `assertSameStructure`.
- [x] C.7 RED: add `@@realtime` chain replay test proving plpgsql triggers replay under PGlite; if PGlite 0.5.4 lacks base-build plpgsql, assert scoped fallback (skip trigger statements, derive `realtime` from migration text) — flag as open question in test comment.
- [x] C.8 RED: add desync diagnostic test — recorded migration directory missing on disk -> refuses via `ShadowReplayError` naming the missing migration.
- [x] C.9 RED: add desync diagnostic test — pending on-disk directory not in recorded set -> refuses, message points at `migrate deploy`.
- [x] C.10 RED: add desync diagnostic test — reordered same-set (recorded order != lexicographic on-disk order) -> WARNs and replays in recorded order.
- [x] C.11 RED: add desync diagnostic test — empty `_indigo_migrations` history -> yields empty `ResolvedSchema`.
- [x] C.12 GREEN: implement `buildShadowSchema(source: MigrationSource)`, `ShadowReplayError`, and `MigrationSource` type in `packages/migrator/src/shadow.ts`; I/O-injected (recorded ids + onDisk list + read fn), PGlite `await import()`ed, replay uses shipped `splitMigrationSql`.
- [x] C.13 GREEN: implement the four desync rules from C.8-C.11 in `buildShadowSchema`.
- [x] C.14 GREEN: restructure `packages/cli/src/migrate-runner.ts` — connect before planning, add `recordedMigrations(client)` beside untouched `appliedMigrations` Set, swap `prev` source to `buildShadowSchema`, keep `saveSnapshot` writing after every run, gate `loadSnapshot` behind `INDIGODB_MIGRATE_PREV=snapshot`.
- [x] C.15 GREEN: promote `@electric-sql/pglite` from devDependency to dependency (same `^0.5.4`) in `packages/migrator/package.json`; add `introspect.mjs`/`shadow.mjs` to migrator's test script.
- [x] C.16 VERIFY: run `node packages/migrator/test/shadow.mjs`, confirm plan-equivalence, divergence, chain-replay, and all four desync tests pass; manual smoke: `migrate dev` with `migrations/.snapshot.json` deleted from disk.

## Phase D: Cross-cutting Verification

- [ ] D.1 Run full monorepo `pnpm build && pnpm lint && pnpm test` after PR C to confirm no cross-package regressions.
- [x] D.2 Confirm `packages/cli/package.json` dependencies remain unchanged (PGlite arrives transitively via `@indigodb/migrator`).
- [ ] D.3 Update relevant package README/CHANGELOG notes for the `INDIGODB_MIGRATE_PREV=snapshot` escape hatch if user-facing docs exist.
