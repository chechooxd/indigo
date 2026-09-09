# Exploration: migration-history-forensics

Persisted by the orchestrator: the `sdd-explore` agent ships without a `Write` tool
(upstream `Gentleman-Programming/gentle-ai#2269`, open), so only the Engram half of the
hybrid store completed on its own. Content is the agent's, unedited in substance.

## Why now

Last open item on the roadmap's now-or-never list. Nothing is published (v0.0.1), so the
history table has no installed base. The day after the first `npm publish`, changing it
becomes a migration of the migration-history table itself, on every user's production
database.

## Current State — all four prior claims confirmed with evidence

`packages/cli/src/migrate-runner.ts`:

- `ensureHistory` (144-172) creates `_indigo_migrations` as `id serial PK, name text NOT NULL
  UNIQUE, applied_at timestamptz NOT NULL DEFAULT now(), checksum text, success boolean NOT
  NULL DEFAULT true` (146-152), followed by `ADD COLUMN IF NOT EXISTS` backfills (154-171).
- `installed_by` and `execution_time` are absent from the schema and from the whole file.
- `success` is a hard-coded `true` literal at all three INSERT sites — `migrateDev` 406,
  `migrateDeploy` 481, `migrateResolve --applied` 581. No write path ever passes `false`.
- `migrateDeploy`'s failure path (487-490) `ROLLBACK`s inside the same `try` that would
  INSERT-then-COMMIT per migration (475-485), so a failed deploy leaves **no row at all** —
  only a console line. No code path escapes this.
- `migrate resolve --rolled-back` DELETEs the row (592-603) rather than marking it.

## The crux

`appliedMigrations()` (174-177) runs `SELECT name FROM "_indigo_migrations"` with **no
`success` filter**, and feeds `migrateDeploy`'s pending detection (450). A naive
`success = false` row would therefore make a failed migration look applied and be silently
skipped forever — the exact opposite of forensic value, and the same silent-no-op class this
project keeps finding in itself.

## Identity: what `installed_by` may honestly claim

`packages/cli/src/util.ts:141-162` (`assertLogicalReplication`) already trusts
`SELECT current_user` (153) as a database-enforced identity. The archived `studio-audit-log`
change deliberately refused to claim identity, but for a different reason: its session auth is
a shared password, so any "who" would have been a guess dressed as a record. `current_user` is
a Postgres-authenticated role, not a secret-derived value — categorically different, and the
precedent argues *for* using it. Any environment override is a self-reported claim and must
stay visibly distinguishable from the DB-enforced value, never merged into one field with
equal apparent authority.

## Test coverage

`packages/cli/test/migrate-runner.mjs` + `migrate-harness.mjs` run the real runner against
`@electric-sql/pglite` (in-process real Postgres) and are **not** gated on
`INDIGODB_TEST_DATABASE_URL`; only `pg-timeout-harness.mjs` / `studio-query-timeout-pg.mjs`
are. This matters: PGlite cannot model genuine process death, so "the process dies between
the DDL failure and the failure-row write" either needs the real Docker Postgres or must be
scoped as a documented limitation rather than a tested guarantee.

## Approaches

1. **Full column set + blocking failure semantics — recommended.** `installed_by` from
   `current_user`, `execution_time_ms`, `success` actually written `false` via a
   post-`ROLLBACK` autocommit UPSERT on the same connection (rollback ends the transaction,
   not the connection), `appliedMigrations()` filtered on `success = true`, and
   `migrateDeploy` refusing when a pending id already carries a failure row — forcing an
   explicit `migrate resolve` decision. Matches this file's existing refuse-rather-than-guess
   doctrine (`checksumPreflight`, destructive-statement refusal, resolve's checksum-mismatch
   refusal). `name text NOT NULL UNIQUE` then needs `ON CONFLICT (name) DO UPDATE` on retry,
   not a constraint change — cheaper, and consistent with every `WHERE name = $1` /
   `ORDER BY id` assumption already in the file. Medium effort, widest touch.
2. **Columns only, failure row informational.** Smallest diff, but reproduces today's bug in
   spirit: a recorded failure stays invisible to the one query that decides what is pending.
3. **Separate `_indigo_migration_failures` table.** Avoids the UNIQUE(name) retry collision,
   but leaves two tables to keep conceptually in sync and diverges from the Flyway-parity goal.

## Additional recommendation

Drop the `ADD COLUMN IF NOT EXISTS` backfill ceremony. There is no installed base to protect,
so the table definition should simply be correct in one `CREATE TABLE IF NOT EXISTS`. Record
this as a deliberate simplification rather than an oversight.

## Risks

- The mid-crash gap needs real Postgres, not PGlite. Decide up front whether it is tested or
  documented as a limitation — do not leave it implied.
- Changing `appliedMigrations()`'s filter changes `migrateDeploy` and `migrateStatus` core
  behaviour. The existing suite's own header says "NO enforcement yet", so this needs new
  regression coverage, not additions to existing assertions.
- `migrateResolve --applied` (571-591) treats a null checksum as "never recorded". A
  `success = false` row changes what "recorded" means there too, and needs its own explicit
  design rather than an implied fix.

## Ready for proposal

Yes.
