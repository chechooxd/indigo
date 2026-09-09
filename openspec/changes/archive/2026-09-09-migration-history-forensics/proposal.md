# Proposal: Migration History Forensics

## Intent

`_indigo_migrations` cannot answer who applied a migration, how long it took, or that one
failed. `migrateDeploy`'s failure path ROLLBACKs inside the same transaction that would have
INSERTed, so a failed deploy leaves **no row at all** — only a console line.

**Now or never.** Nothing is published (v0.0.1), so the table has no installed base. After the
first `npm publish`, changing it becomes a migration of the migration-history table itself, on
every user's production database.

**The crux.** `appliedMigrations()` (`migrate-runner.ts:174-177`) selects names with **no
`success` filter**, and feeds pending detection (450). Adding a naive failure row would make a
failed migration look applied and be silently skipped forever — worse than recording nothing.
Failure rows are therefore only safe together with a filtered read and a blocking retry rule.

## Scope

### In Scope
- `installed_by` (`current_user`) and `execution_time_ms` columns; failure rows carry both.
- `success = false` written after ROLLBACK via autocommit UPSERT on the same connection
  (`ON CONFLICT (name) DO UPDATE`, keeping `name text NOT NULL UNIQUE`).
- `appliedMigrations()` filtered on `success = true`; `migrateDeploy` **refuses** when a pending
  id carries a failure row, forcing an explicit `migrate resolve`.
- `migrate status` and `migrate resolve --applied/--rolled-back` semantics against failure rows.
- Drop the `ADD COLUMN IF NOT EXISTS` backfill ceremony — one correct `CREATE TABLE IF NOT
  EXISTS`. Deliberate simplification, not an oversight; valid only pre-publish.

### Out of Scope
- **Any env-var override of `installed_by`.** `current_user` is DB-enforced fact; an override is
  self-reported. Not shipping it keeps the honesty story single-valued.
- A separate `_indigo_migration_failures` table (approach 3).
- Retry counts, failure SQLSTATE/error-text capture, Studio surfacing, `db push` history.
- Any upgrade path for existing tables.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `migration-history-integrity`: full column set, no backfill, `success` enforced rather than
  "forward-compatible with no enforcement yet".
- `migration-history-resolve`: how `--applied` / `--rolled-back` treat a `success = false` row.

## Approach

Exploration approach 1. Matches the file's existing refuse-rather-than-guess doctrine
(`checksumPreflight`, destructive-statement refusal, resolve's checksum-mismatch refusal).

**Mid-crash gap — decided, not implied.** If the process dies between the DDL failure and the
failure-row write, no row is recorded and the id reverts to plain pending. The PGlite suite
cannot model process death, so this ships as a **documented best-effort limitation**, named in
the spec and in code comments — not a tested guarantee. This project has a history of
unenforceable guarantees that were never named as such.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/cli/src/migrate-runner.ts` | Modified | Schema, 3 INSERT sites, `appliedMigrations`, deploy/status/resolve |
| `packages/cli/test/migrate-runner.mjs` | Modified | New regression coverage, not edits to existing assertions |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Filtered `appliedMigrations()` changes deploy/status core behaviour | High | New dedicated regression tests; existing suite says "NO enforcement yet" |
| Failure row makes deploy permanently stuck | Med | `migrate resolve` is the documented, tested exit |
| Autocommit UPSERT after ROLLBACK also fails (connection lost) | Med | Accepted best-effort; same documented gap |
| Dropped backfill breaks a pre-publish local table | Low | Drop and recreate; no installed base |

## Rollback Plan

Single-file revert plus test revert. Pre-publish, any developer table is disposable: drop
`_indigo_migrations` and re-run `migrate deploy`.

## Dependencies

None. `current_user` is already trusted in `util.ts:141-162`.

## Success Criteria

- [ ] A failed `migrate deploy` leaves a `success = false` row with `installed_by` and timing.
- [ ] That id is reported pending, and a re-deploy refuses until `migrate resolve`.
- [ ] Retry after resolve UPSERTs the row rather than violating `UNIQUE (name)`.
- [ ] `ensureHistory` contains no `ADD COLUMN` statement.
- [ ] The mid-crash gap is stated in the spec as a limitation.

## Open Questions for Design

1. What should `resolve --applied` do on a `success = false` row — flip to true, or refuse?
   Its "null checksum means never recorded" rule (571-591) no longer covers this case.
2. Should `resolve --rolled-back` DELETE a failure row (current behaviour) or keep it as history?
3. Does `execution_time_ms` measure SQL execution only, or include checksum/preflight work?
4. How does `migrate status` render a failure row — pending, drift-style diagnostic, or new state?
5. Does a failure row block `migrate dev` too, or only `deploy`?
