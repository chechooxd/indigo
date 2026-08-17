# Verify Report: shadow-replay-diff

**Verdict: PASS**

## Mode
Full artifacts (proposal/spec/design/tasks all present). Strict TDD active — RED/GREEN evidence present in apply-progress and confirmed by re-running suites fresh.

## Task Completeness
Phase A 9/9, Phase B 10/10, Phase C 16/16 = 35/35 checked. Phase D: D.1 unchecked (full monorepo `pnpm test` — surfaces the known pre-existing compiler flake, confirmed below), D.2 checked (cli/package.json unchanged, confirmed), D.3 unchecked (docs deferred, non-blocking). Matches apply-progress narrative exactly — verified by reading openspec/changes/shadow-replay-diff/tasks.md directly, not the summary.

## Spec Domain Compliance (4 domains)

| Domain | Requirements | Status |
|---|---|---|
| schema-introspection | 7 requirements (table/column structure, PK/FK+actions, indexes, enum members, name===dbName fidelity boundary, excluded metadata, round-trip fidelity) | PASS — introspect.ts implements all; round-trip test (32 fixtures) green |
| shadow-database-replay | 5 requirements (fresh instance per build, recorded-order replay, PGlite hard dep, missing-dir diagnostic, order-divergence diagnostic, no real-DB mutation) | PASS — shadow.ts implements all 4 desync rules + fresh-instance-per-call + read-only real DB access (only reads `_indigo_migrations`) |
| migration-diff-completeness (delta) | @map-only rename via schema-sourced prev (unchanged), @map-only rename degrades to drop+add w/ shadow-derived prev (accepted), simultaneous rename+remap refused (schema-sourced) / not-applicable (shadow-derived) | PASS — matchColumns/matchTables/matchEnumMembers physical-identity fallback exactly matches design; degradation cases positively tested in shadow.mjs |
| migration-appliability-tests (delta) | plan-equivalence across corpus w/ @map exclusion, migrate dev works w/o .snapshot.json, .snapshot.json still written, missing/out-of-order migrations diagnostic | PASS — 27-fixture plan-equivalence loop green, saveSnapshot confirmed still called in migrate-runner.ts, 4 desync tests green |

## Source-Level Confirmation (terminal verification, not checkbox trust)

1. **migrate.ts** — `matchTables`/`matchColumns`(pass-2 pairs)/`matchEnumMembers` all present exactly per Design Decision 1 (read full file). Byte-identical golden claim VERIFIED: `git diff --stat HEAD -- packages/migrator/test/fixtures` shows zero changes to any of the 29 pre-existing fixture directories; only 3 new untracked fixtures added (`enum-member-physical-fallback`, `map-column-type-change-not-skipped`, `map-table-steady-state`).
2. **introspect.ts** — `introspectResolvedSchema` present, matches Design Decision 3: type inversion table (text→String etc.), nativeType recovery (VarChar/Uuid/Numeric), unmappable type throws naming `table.column`, NO ACTION ('a') → absent via `FK_ACTION_MAP`, derived-vs-explicit name policy for index/fk names, single-column @unique-vs-@@unique collapsing via derived-name-match heuristic.
3. **shadow.ts** — `buildShadowSchema`/`ShadowReplayError`/`MigrationSource` present. Grepped for `node:fs`/`pg`/`process.cwd()` imports — absent (only imports `@indigodb/core` types, `./plan.js`, `./introspect.js`). PGlite dynamically imported inside `defaultCreateShadow`. All four desync rules implemented: missing-on-disk refuse, pending-unrecorded refuse (points at `migrate deploy`), reorder-same-set warn+replay-in-recorded-order, empty-history→EMPTY_SCHEMA.
4. **migrate-runner.ts** — `migrateDev` connects then `ensureHistory` then `resolvePrevSchema` before `planMigration` (genuine connect-before-plan). `recordedMigrations` (ORDER BY id) exists beside untouched `appliedMigrations`. `INDIGODB_MIGRATE_PREV=snapshot` escape hatch reachable in `resolvePrevSchema`. `saveSnapshot(options.resolved)` confirmed still called after successful apply/commit, before the success log line.
5. **migrator/package.json** — confirmed `@electric-sql/pglite` is under `"dependencies"` (not devDependencies), same `^0.5.4`. cli/package.json confirmed unchanged via git status.
6. **Extra findings beyond design scope** — confirmed real in shadow.mjs source (not just narrative): `enum-value-remapped` test asserts `plan.diagnostics.some(d => d.code === "enum-value-removed")`; `map-rename-with-dependents` test asserts `plan.diagnostics.some(d => d.code === "required-column-without-default" && d.column === "email")`. Both are genuine positive assertions, not narrative-only claims.
7. **plpgsql/PGlite 0.5.4 claim** — confirmed real test in shadow.mjs (`@@realtime chain replay` check) that builds two real migrations (init + add @@realtime), replays them through `buildShadowSchema`, and asserts `table.realtime === true` via `indigo_rt_*` trigger detection post-replay. The catch-and-warn branch exists only for a genuine PGlite failure (never triggered in this run — no fallback warning appeared in fresh test output), so the positive branch is what actually executed and passed.

## Fresh Test Execution Evidence (this session, not reused from apply)

- `pnpm --filter @indigodb/migrator test` → exit 0. All 7 suites green: migrator.mjs (32 fixtures), native-type.mjs, index-ddl.mjs, appliability.mjs, replay.mjs, introspect.mjs (36 checks incl. round-trip over all 32 fixtures), shadow.mjs (38 checks: 27 plan-equivalence + 5 divergence + chain + realtime + 4 desync — full output captured).
- `pnpm --filter @indigodb/cli test` → exit 0, studio-server.mjs green (no migrate-runner test file exists in-repo, confirmed via search).
- `pnpm build` → exit 0, FULL TURBO, 10/10 tasks including studio vite build.
- `pnpm lint` → exit 0, 18/18 tasks (tsc --noEmit across all packages).
- `pnpm test` (monorepo-wide) → exactly ONE failure: `@indigodb/compiler`'s parity.mjs on `13-ambiguous-relations.indigo ValidationError[]` (diagnostic array ORDER mismatch — same set of 3 diagnostics, different order). Confirmed unrelated: `git diff --stat HEAD -- crates packages/compiler` returns empty (zero changes to compiler/crates in this change's diff). This matches the D.1 narrative exactly.

## Findings

No CRITICAL issues. No WARNING issues — every claim in apply-progress was independently verified against real source and fresh test runs, not trusted from the narrative.

SUGGESTION (non-blocking, does not affect verdict):
1. D.3 (README/CHANGELOG note for `INDIGODB_MIGRATE_PREV=snapshot`) remains undone — low-risk doc gap, reasonable to defer or fold into archive.
2. Manual live-Postgres smoke test (`migrate dev` with `.snapshot.json` deleted) was never run in any sandbox (no Postgres available) — automated PGlite-backed shadow.mjs coverage substitutes but is not identical to a real Postgres round-trip. Consider running once before/shortly after archive if a Postgres instance becomes available.

## Final Verdict: PASS

All 35 in-scope tasks complete and verified against real source and fresh test execution. All 4 spec domains covered by passing runtime tests. Design decisions 1-7 all match implementation. Only known deviation from a clean pipeline is the pre-existing, unrelated compiler flake (order of validation diagnostics), confirmed out of scope for this change's diff. Ready for sdd-archive.
