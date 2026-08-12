# Proposal: Harden the Studio server

## Intent

`indigodb studio` is a local developer tool that today behaves like an unauthenticated public service. Four defects in `packages/cli/src/studio-server.ts` (219 lines, zero tests) were confirmed against current HEAD:

1. `server.listen(port, resolve)` passes no host, so Node binds `0.0.0.0` — the API is reachable from the whole network segment.
2. `/api/schema` returns the full `ResolvedSchema` including `datasource.url`; `/api/schema/source` returns raw `.indigo` text. A literal connection string is published verbatim.
3. `isReadOnlyQuery` is a prefix regex. `WITH x AS (DELETE FROM "User" RETURNING *) SELECT * FROM x` passes it and deletes every row (reproduced empirically).
4. No Origin/Host validation, so any page a developer visits while Studio runs can drive the API.

Closes the roadmap Phase 0 epic "Close the exposed surfaces".

## Scope

### In Scope
- Bind `127.0.0.1` by default; remote binding only via explicit opt-in flag/env.
- Redact `datasource` credentials from `/api/schema` and `/api/schema/source`.
- Replace the regex guard with Postgres-enforced read-only transactions (`BEGIN; SET TRANSACTION READ ONLY;` on a dedicated client).
- Origin/Host allowlist check on API routes.
- Minimal test harness for `packages/cli` (first tests in the package) covering all four behaviours.

### Out of Scope
- `apps/studio` frontend fake-CRUD simulations — separate change `delete-studio-simulations`.
- Authentication, TLS, multi-user access control.
- Other CLI commands (`db push`, `migrate`, `generate`).

## Capabilities

### New Capabilities
- `studio-server-security`: loopback-by-default binding, credential redaction, Origin/Host validation.
- `studio-readonly-queries`: transaction-level read-only enforcement for `/api/query`.
- `studio-server-tests`: test harness and coverage requirements for `packages/cli`.

### Modified Capabilities
- None.

## Approach

Change `startStudio` only. Add a `host` option defaulting to `127.0.0.1`. Add a redaction step over the `ResolvedSchema` and source text before they leave the process. Route `/api/query` (and ideally `/api/tables/:name`) through a pooled client wrapped in a read-only transaction, letting Postgres reject writes instead of a string heuristic. Reject requests whose `Origin`/`Host` is not the bound local origin. Establish the test harness first (TDD, `tdd: true`).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/cli/src/studio-server.ts` | Modified | All four fixes |
| `packages/cli/src/index.ts` | Modified | `--host` / opt-in flag wiring |
| `packages/cli/test/` | New | First tests in the package |
| `packages/cli/package.json` | Modified | Test script + dev deps |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Loopback bind breaks container/remote users | Med | Explicit opt-in flag + clear startup message |
| PGlite may not serve real TCP or `pg.Pool` semantics | Med | Design phase verifies; fall back to ephemeral real Postgres or a stub pool |
| Read-only transaction breaks legitimate `SET`/temp-table queries | Low | Scope to the console; document the constraint |
| Redaction hides schema data the Studio UI needs | Low | Redact `datasource` only, verify UI still renders |

## Rollback Plan

Single-package change with no data migration and no `crates/` impact. Revert the commit(s); `pnpm build --filter @indigodb/cli` restores prior behaviour. If only the bind change is problematic, the opt-in host flag reverts it without touching the security fixes.

## Dependencies

- Test runner choice for `packages/cli` (none installed today) — resolved at design time.

## Success Criteria

- [ ] Default startup binds `127.0.0.1`; remote bind requires explicit opt-in.
- [ ] `/api/schema` and `/api/schema/source` contain no datasource URL.
- [ ] The CTE-delete payload is rejected by Postgres and no rows change.
- [ ] Cross-origin API requests are rejected.
- [ ] `pnpm test` runs `packages/cli` tests covering all four; green.

## Proposal question round

Execution mode is `auto`, so no interactive round was run. Assumptions needing user review:

1. Remote binding stays supported as an explicit opt-in (not removed outright).
2. Redaction removes the whole `datasource` block, not just `url`.
3. `/api/tables/:name` reads also move to the read-only transaction path.
4. No authentication token is introduced in this slice.
