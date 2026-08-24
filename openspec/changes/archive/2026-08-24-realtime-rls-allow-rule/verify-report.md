# Verify Report: realtime-rls-allow-rule

**Change**: realtime-rls-allow-rule (Phase 4, slice 1 — `@@allow` → Postgres RLS)
**Verdicts**: PR A (grammar + validation) PASS | PR B (resolve + IR) PASS | PR C (DDL + client + generator) PASS
**Counts**: CRITICAL 0 · WARNING 0 · SUGGESTION 1 (non-blocking, tracked follow-up)

## Verification Summary

Three chained PRs (Feature Branch Chain) all merged locally on `main` (not pushed). All three independently verified to PASS against their respective spec requirements, design decisions, and task checklists. Complete verification reports preserved in Engram as observations #701 (PR A), #703 (PR B), #705 (PR C).

### PR A: Grammar + Validation (commit 2c0150e, verified 2026-08-20)
- **Scope**: Lexer EqEq token, parser dotted-path + comparison, ast.rs Path/Comparison variants, rules.rs ArgShape::Allow, validate.rs 9 diagnostics
- **Tasks**: 6 checkboxes, all `[x]`
- **Key verification**: Whitelist updated with `@@allow`; arity, unknown claim, constant predicate, and policy-name checks all working; WASM rebuilt and committed
- **Test results**: pnpm build/lint/test all green; `parity.mjs` baseline unchanged
- **Verdict**: PASS

### PR B: Resolve + IR (commit 7274da9, verified 2026-08-21)
- **Scope**: resolve.rs alias expansion (write/all), dbName operand tracking, ResolvedTable.allow IR field, TypeScript mirror
- **Tasks**: 8 checkboxes, all `[x]`
- **Key verification**: IR correctly mirrors Rust-resolved rules; aliases expand correctly; fixture snapshots 01–17 byte-identical
- **Test results**: pnpm build/lint/test all green; no change to existing fixtures
- **Verdict**: PASS

### PR C: DDL + Diff + Client (commit 15402f3, verified 2026-08-24)
- **Scope**: C0 spike (PGlite RLS enforcement under SET ROLE), postgres.ts policy rendering, migrate.ts diff, client.ts $auth, generator $auth override, PGlite enforcement suite
- **Tasks**: 16 checkboxes (C0.1–C6.3), all `[x]`
- **Key verifications**:
  - C0.1 spike independently reproduced: PGlite superuser bypasses FORCE RLS; non-superuser role correctly filtered by policy
  - C1 DDL: correct USING/WITH CHECK clauses per action; cast derivation from field type; idempotent DROP/CREATE pattern; SQL injection prevention (quoteIdent/escapeLiteral)
  - C2 diff: two-sided diff on prev/next; altered rules drop-then-create; policy pruning loop covers rule count shrink
  - C3 $auth: uses `SELECT set_config()` bound param, never `SET LOCAL` with params; pooled-connection non-leak verified at unit and integration levels
  - C4 generator: emits typed $auth override; contravariance fix ($authSession base) verified under strict TS
  - C5 enforcement: 7/7 real-PGlite cases pass under SET ROLE to non-superuser role
- **Test results**: pnpm build --force, lint --force, test --force all green; cargo test sanity green; full suite ~6m39s
- **Verdict**: PASS

## Spec Requirement Coverage (Per PR)

### PR A (Grammar + Validation)
- ✓ Attribute whitelist updated: `@@allow` recognized
- ✓ Arity checked: `@@allow()` rejected
- ✓ Argument type checked: non-equality condition rejected
- ✓ Named args rejected on `@@allow`
- ✓ Unknown claim rejected: only `auth.userId` accepted
- ✓ Constant predicate rejected
- ✓ Policy name length ≤63 bytes validated

### PR B (Resolve + IR)
- ✓ Action vocabulary: `create|read|update|delete` canonical
- ✓ Alias expansion: `write` → create/update/delete; `all` → all four
- ✓ Multi-rule per action: stably-ordered IR entries
- ✓ `@@realtime` conflict rejection
- ✓ IR shape: ResolvedTable.allow exposed, omitted when absent
- ✓ dbName operand for physical column mapping

### PR C (DDL + Client)
- ✓ RLS enabled + forced for models with `@@allow`
- ✓ One idempotent CREATE POLICY per rule with stable naming
- ✓ Cast derived from field scalar type (not hardcoded)
- ✓ Versioned migrations diff policies completely (CREATE/DROP/alter)
- ✓ Deny-by-default via native Postgres semantics
- ✓ `$auth({ userId })` via `SET LOCAL` transaction scope
- ✓ No protected rows without `$auth` (deny-by-default)
- ✓ Pooled connection non-leak (SET LOCAL dies at COMMIT)
- ✓ `$auth` additive, no breaking changes to existing call sites

## Artifacts Reviewed

- **Engram**: Proposal #696, Spec #697, Design #698, Tasks #699, PR A verify #701, PR B verify #703, PR C verify #705
- **OpenSpec**: All delta specs committed to change folder; specs now merged into `openspec/specs/{domain}/`
- **Code**: 3 chained PR branches merged locally; all 37 modified files (1569 insertions, 20 deletions) in `main`

## Design Deviation (Non-breaking)

PR C implemented `$authSession` protected method base + new `$auth` public override (vs. the design's `$auth` override of `$withSession`) due to TypeScript contravariance on method parameters. Reason verified as genuine TS constraint, not workaround. Public `$auth` API signature and `SET LOCAL` scoping guarantees unchanged; no spec contract breach.

## Known Follow-ups (Not Blocking Archive)

**SUGGESTION** (non-blocking, already tracked): `introspectResolvedSchema` does not read `@@allow`/RLS policies back from `pg_policies`, so `db pull` cannot recover allow rules. This was never a PR C goal and is honestly tracked in tasks.md, shadow.mjs, and introspect.mjs comments. Scope remains deferred to a future backlog item beyond this change's own follow-up note.

## Task Completion

All implementation tasks across PR A/B/C are marked `[x]` and match the code state exactly. Post-slice cleanup (verify proposal Success Criteria, merge delta specs, log follow-up) completed. Change ready for archive.

## Verdict

**PASS** — 0 CRITICAL, 0 WARNING, 1 SUGGESTION (non-blocking follow-up). All three PRs independently verified. Spec, design, and code align. Ready for archive and merge into main spec store.
