# Proposal: `migrate resolve` (History Recovery Verb)

Change: `migrate-history-resolve` (Road to 1.0, Phase 3, epic "Introspection — `indigodb db pull`", task 7/8). One focused slice, not the epic.

## Context — this NARROWS/SUPERSEDES the roadmap wording

The roadmap named 7/8 "history table/locking/recovery verbs". Exploration (Engram #683, read against `main` @ `4102d90`) confirmed two of those three are already closed:

- **Locking**: closed by epic 4/8 — `migrateDeploy` holds `pg_try_advisory_lock`; `dev`/`status` are untouched *by explicit, tested design* (`migrate-deploy-concurrency/spec.md`; test `migrate-runner.mjs:618`). **No locking work is in this change.**
- **History-table columns**: closed by epic 3/8 — `checksum` + `success` shipped; `success` is deliberately inert because no failed-migration row is ever persisted (verified in code: ROLLBACK / file removal precede any INSERT).

## Intent

Reality and `_indigo_migrations` can diverge (a migration applied or reverted out-of-band, a DBA hand-fixing a half-applied change). Versioned DDL from `migrate.ts` is deliberately *not* idempotent, so `deploy`/`dev` then either replay conflicting DDL or hard-refuse on checksum drift. Today the **only** remedy is raw SQL against the ledger — `migration-history-integrity/spec.md:101` admits this ("re-baselined by editing the recorded history directly"). Only `dev`, `deploy`, `status` exist (`packages/cli/src/index.ts:143-184`); there is no `resolve`, and no test covers recovery.

## Scope

### In Scope
- New verb `indigodb migrate resolve`, with mutually exclusive `--applied <id>` / `--rolled-back <id>` (exactly one id per invocation; Prisma parity).
- `--applied <id>`: INSERT the ledger row (checksum computed from on-disk `migration.sql`, `success = true`) **without executing any of its SQL**.
- `--rolled-back <id>`: DELETE that id's row; idempotent no-op if absent.
- Guard: refuse with a non-zero exit if `migrations/<id>/migration.sql` does not exist on disk (typo protection, matching `checksumPreflight`'s file-reading style).
- Tests in `packages/cli/test/migrate-runner.mjs` on the existing PGlite harness.

### Out of Scope
- Any locking change (closed — see Context). Any change to `success` semantics or enforcement.
- Epic 8/8 (transaction-boundary control) — separate epic, untouched.
- Auto-detection/diffing of divergence to infer which verb to run — Prisma deliberately doesn't; keep this manual and explicit.
- Weakening the checksum-drift refusal itself, or any behavior change to `dev`/`deploy`/`status`.

## Capabilities

### New Capabilities
- `migration-history-resolve`: the `migrate resolve` verb — direction flags, no-SQL-execution contract, unknown-id guard, idempotency, exit codes.

### Modified Capabilities
- `migration-history-integrity`: the "no override" requirement's remedy clause (`spec.md:101`) currently points at raw SQL. Delta must re-point it at `migrate resolve` while keeping the refusal itself absolute and unbypassable.

## Approach

Add `migrateResolve(options)` to `packages/cli/src/migrate-runner.ts` following the existing `migrateDev`/`migrateDeploy`/`migrateStatus` shape: connect → `ensureHistory` → validate id against disk → single INSERT or DELETE → report. No advisory lock (it is deploy-scoped by design), no snapshot write, no schema/column change.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `packages/cli/src/index.ts` | Modified | `migrate resolve` subcommand + flags |
| `packages/cli/src/migrate-runner.ts` | Modified | new `migrateResolve` + `ResolveOptions` |
| `packages/cli/test/migrate-runner.mjs` | Modified | resolve coverage (both directions, guards) |
| `openspec/specs/migration-history-integrity/spec.md` | Modified | remedy clause delta |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `resolve` becomes a drift-refusal bypass by accident | Med | Spec must state resolve rewrites the ledger, never suppresses a check; drift refusal stays absolute |
| Scope creep into an interactive auto-repair tool | Med | Explicitly out of scope; mirror Prisma's restraint |
| `--applied` on a migration the DB does *not* actually reflect leaves a lie in the ledger | Med | Documented as an explicit, human-asserted operator claim; no inference is attempted |
| `.snapshot.json` left inconsistent after a resolve | Med | Open question for design (see below) |

## Rollback Plan

1. Remove the `migrate resolve` subcommand and `migrateResolve`/`ResolveOptions`.
2. Revert the `migration-history-integrity` remedy-clause delta.
3. No schema, column, or on-disk migration-format change; nothing persisted needs undoing.

## Dependencies

- None beyond `main` @ `4102d90` (epics 1/8–6/8 shipped).

## Success Criteria

- [ ] `migrate resolve --applied <id>` records a row with the correct checksum and executes none of that migration's SQL
- [ ] `migrate resolve --rolled-back <id>` removes the row and is a clean no-op when absent
- [ ] An unknown/typo id is refused with a non-zero exit and no ledger write
- [ ] After `--applied`, `migrate status` reports that migration as applied and `deploy` skips it
- [ ] `dev`/`deploy`/`status` behavior is byte-identical to today; drift refusal remains unbypassable
- [ ] `pnpm build`, `lint`, `test` and `cd crates && cargo test` stay green

## Open questions for sdd-design (auto mode: no interactive round held)

1. Should `--applied` also update `.snapshot.json`, or is snapshot reconciliation left to the next `migrate dev`?
2. Should `--applied` on an id that already has a row be an error or an idempotent no-op (symmetry with `--rolled-back`)?
3. Should `resolve` accept `--applied` for a migration whose on-disk content has already drifted, and if so, which checksum does it record — current bytes (re-baseline) or refuse?
