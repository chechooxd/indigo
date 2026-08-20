# Verify Report: migrate-history-resolve

**Branch**: `feature/migrate-history-resolve`, commit `abc6477` (single commit, not pushed, main untouched)
**Verdict**: PASS
**Counts**: CRITICAL 0 · WARNING 0 · SUGGESTION 0

## Artifacts reviewed
- Proposal (Engram #684), Design (Engram #686), Spec delta (Engram #685), Tasks (Engram #687), apply-progress (Engram #688)
- `packages/cli/src/migrate-runner.ts` (`ResolveOptions` 275-282, `migrateResolve` 542-607)
- `packages/cli/src/index.ts` (`migrate resolve` subcommand, 185-199)
- `packages/cli/test/migrate-runner.mjs` (12 new cases, lines 1281-1730)
- `openspec/specs/migration-history-integrity/spec.md` (MODIFIED requirement merged correctly)
- `openspec/changes/migrate-history-resolve/tasks.md` (all 22 checkboxes `[x]`)

## Spec requirement verification (code-level, not narrative)

1. **Applied insert on unrecorded id** — `stored == null` branch INSERTs `(id, migrationChecksum(readFileSync(file,"utf-8")), true)`. Confirmed by test "records the row without executing migration SQL" (asserts table `foo` does NOT exist).
2. **Applied idempotent no-op on match** — `stored === computed` logs "Already recorded", no write. Test confirms row count stays 1, exitCode not gated.
3. **Applied refuses on drift, no re-baseline** — `stored !== computed` branch ONLY logs error + `exitCode = 1`; no UPDATE statement exists anywhere in the function. Test overwrites the file after recording and asserts the stored checksum is unchanged (the ORIGINAL value).
4. **Rolled-back deletes row** — `DELETE ... RETURNING name`, `rows.length > 0` branch. Test confirms row removed, no exec of migration SQL (`tableExists` check).
5. **Rolled-back on unrecorded id** — `rows.length === 0` branch, clean no-op, no error. Test confirms.
6. **Unknown id refused pre-DB-connection** — guard at lines 559-565 runs before `createClient` is invoked at all. Test uses `spyMigrationClient` and asserts `queries.length === 0`.
7. **Path traversal refused via exact membership** — `listMigrationDirs(cwd).includes(id)` is an exact-match check (not fuzzy/prefix), combined with `existsSync`. Dedicated test with `../../etc/passwd`-shaped and `../outside`-shaped ids for both `--applied`/`--rolled-back`, asserting zero queries.
8. **SQL injection — id always parameterized** — grepped every `_indigo_migrations` query in `migrateResolve`: SELECT (572-575), INSERT (579-582), DELETE (593-596) all bind `id` as `$1`/array param, never interpolated into the SQL string. Dedicated test asserts `sql` never contains the id and `params` always does, plus a metacharacter-shaped id (`...DROP TABLE...`) refused pre-query as unknown.
9. **Both/neither flags refused before createClient** — validation at 543-554, before `cwd`/`createClient` are even referenced. Test asserts `createClientCalls === 0` for both cases.
10. **`.snapshot.json` never touched** — grepped `migrateResolve` body: zero references to `SNAPSHOT_FILE`/`loadSnapshot`/`saveSnapshot`. Test writes a snapshot file, runs both applied and rolled-back resolves, asserts byte-identical content after.
11. **No transaction, no advisory lock** — grepped file: `BEGIN`/`COMMIT`/`MIGRATION_LOCK_KEY` occur only inside `migrateDev` (line 310) and `migrateDeploy` (lines 408, 430, 483, 493); zero occurrences inside `migrateResolve` (542-607). Test asserts zero `BEGIN`/`COMMIT`/`pg_try_advisory_lock`/`pg_advisory_unlock` queries recorded.

## Spec merge verification (task 2.2, already committed in abc6477)
`openspec/specs/migration-history-integrity/spec.md` — the MODIFIED "Checksum drift is a hard refusal with no override" requirement now correctly names `migrate resolve` as the sanctioned remedy path (both in the requirement body and in the new "cannot be used to silently re-baseline" scenario). Text matches delta spec #685 verbatim. Not flagged as a process deviation per session instruction — the early merge is expected and confirmed correct.

## Test/build results (run fresh)
- `pnpm --filter @indigodb/cli build` — green
- `pnpm --filter @indigodb/cli lint` — green (`tsc --noEmit`)
- `pnpm --filter @indigodb/cli test` — all green, including all 12 new `migrate resolve` cases and all pre-existing `dev`/`deploy`/`status` cases unchanged
- `pnpm build` (root) — 18/18 tasks, FULL TURBO, green
- `pnpm lint` (root) — 18/18 tasks, FULL TURBO, green
- `cd crates && cargo test --locked` — all passed (36 + 1 + doc-tests)
- `node packages/compiler/test/parity.mjs` (standalone) — shows exactly the one pre-existing unrelated flake (error-ordering nondeterminism in ambiguous-relation validation messages, fixture `18-ambiguous-relations`-class); no CLI/migrate-runner files touched by this change, confirmed unrelated per prior-epic precedent
- `packages/cli/test/studio-server.mjs`, `packages/cli/test/pull.mjs` (standalone) — both green

## Tasks vs code state
All 22 checkboxes (1.1-1.20 slice + 2.1-2.2 post-slice) in `openspec/changes/migrate-history-resolve/tasks.md` are `[x]` and match the actual implemented/tested code exactly — no drift between task claims and code.

## Verdict
**PASS** — 0 CRITICAL, 0 WARNING, 0 SUGGESTION. Implementation matches spec and design exactly, including the critical drift-refusal guarantee verified at the code level (no UPDATE path exists for the drifted-checksum branch). Ready for archive.
