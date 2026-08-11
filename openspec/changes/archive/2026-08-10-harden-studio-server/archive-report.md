# Archive Report: harden-studio-server

**Date Archived**: 2026-08-10  
**Archived by**: sdd-archive executor  
**Project**: indigo  
**Artifact Store Mode**: hybrid (OpenSpec filesystem + Engram)

---

## Executive Summary

The `harden-studio-server` SDD change has been **successfully completed, verified, and archived**. All 18 tasks across two delivery slices (S1: read-only transaction enforcement, S2: bind host + credential redaction + Origin/Host validation) are implemented and tested. Two verification WARNINGs identified at verification time were subsequently closed in commit `31b8f37` via targeted test additions. The change closes the Phase 0 epic "Close the exposed surfaces" by hardening `packages/cli/src/studio-server.ts` against four independent network-exposure vectors.

---

## Final State Authority

This report describes the state of the change **at close per explicit final-state facts from the orchestrator**, ranking above intermediate artifacts per `sdd-archive/SKILL.md` Section "Final-State Authority".

**Intermediate artifacts consulted:**
- `verify-report.md` (verification time, 2026-08-10): recorded 0 CRITICAL, 2 WARNING, 3 SUGGESTION
- Explicit handoff from orchestrator: both WARNINGs resolved in commit `31b8f37`; 3 SUGGESTIONs carry forward as follow-ups

---

## Capabilities Added

### New Capability Specs (all NEW, no pre-existing specs in these domains)

| Spec | Type | Location | Requirements |
|------|------|----------|--------------|
| `studio-server-security` | NEW | `openspec/specs/studio-server-security/spec.md` | Loopback-by-default bind, datasource redaction, Origin/Host validation |
| `studio-readonly-queries` | NEW | `openspec/specs/studio-readonly-queries/spec.md` | Transaction-level read-only enforcement, fast-path pre-filter (advisory), column aliasing preservation |
| `studio-server-tests` | NEW | `openspec/specs/studio-server-tests/spec.md` | Test harness for `packages/cli`, coverage of all four blockers, Turborepo integration |

All three specs copied mechanically from `openspec/changes/harden-studio-server/specs/` to `openspec/specs/` at archive time (diff -r verified identical).

---

## Implementation Summary

### Delivery Model
**Stacked-to-main chain** (nothing pushed, intentional pending user authorization):
- `main` (e69fad8)  
  → `security/studio-server-readonly-enforcement` (383dedb) — Slice S1  
  → `security/studio-server-bind-and-redaction` (10d95fe) — Slice S2  
  → `31b8f37` — remediation commit (Host-header + startup warning test coverage)

### Four Confirmed Blockers (Orchestrator Independently Verified)

1. **Network-wide bind** → Fixed. Default `127.0.0.1`; explicit `--host` opt-in required for anything else, with startup risk warning.
2. **Credential leak** — `datasource.url` sent over `/api/schema` and `/api/schema/source` → Fixed. Redacted from both (JSON key deletion for the former, brace-depth line scanning for the raw `.indigo` text of the latter).
3. **Regex-bypassable read-only guard** → Fixed. `WITH x AS (DELETE FROM "User" RETURNING *) SELECT * FROM x` was previously able to pass the old `isReadOnlyQuery` prefix regex and delete rows. Now enforced at the transaction level (`BEGIN; SET TRANSACTION READ ONLY; ...; COMMIT/ROLLBACK` on a dedicated pool, `max: 4`, separate from the metadata pool). Orchestrator confirmed: HTTP 400 with the Postgres read-only error, rows unchanged.
4. **No Origin/Host validation** → Fixed. Both are now checked; mismatches get 403; requests with no Origin header at all (same-machine tooling) still succeed.

### Task Completion

**18/18 tasks marked complete** and verified against code:
- **S1** (8 tasks): PGlite harness, StudioDb seam, dedicated read-only pool, pre-filter trim, return-type change, full suite green
- **S2** (10 tasks): bind host, `--host` CLI flag, redaction (JSON and source), Origin/Host validation, documentation, full suite green

All tasks are checklist-verified and code-inspected per `verify-report.md` Section "Tasks — 18/18, checked against code".

### Test Coverage

**First test suite in `packages/cli`** (prior: zero tests):
- **Total cases**: 16 (per remediation commit `31b8f37`)
- **Engine**: PGlite (real PostgreSQL 18.3 compiled to WASM)
- **Server**: real `startStudio` HTTP instance, end-to-end
- **All cases**: passing (verified via fresh `pnpm turbo run test --force`)

**Gate Results**:
- `pnpm build --force`: 10/10 successful
- `pnpm lint --force`: 18/18 successful
- `pnpm test --force`: 14/14 successful (including `@indigodb/cli:test` 16 cases)
- `cd crates && cargo test`: 23 passed

---

## Verification Status

**Intermediate verification (2026-08-10)**:  
Recorded 0 CRITICAL, 2 WARNING, 3 SUGGESTION.

**Warnings Resolution (Orchestrator Confirmed)**:

| Warning | Identified | Resolution | Commit |
|---------|-----------|-----------|--------|
| **WARNING-1** — Startup risk-warning message untested | verify-report.md | Added assertion on `stdout` output for non-loopback `--host` startup | `31b8f37` — `test(cli): cover Host-header rejection and the non-loopback startup warning` |
| **WARNING-2** — Mismatched-Host-header rejection no automated coverage | verify-report.md | Added 4 new test cases using raw `node:http.request()` directly (fetch forbids setting caller-supplied `Host` header) | `31b8f37` (same) |

**Closed by commit `31b8f37`**: Adds 4 new test cases to cover both WARNING vectors. **No production code changed**; this is a coverage gap closure, not a defect fix. Both underlying behaviors (403 rejection on Host mismatch, startup warning on non-loopback) were manually verified correct in production by the orchestrator during verification; the gap was in test automation.

---

## Open Suggestions (Carry Forward as Follow-ups)

The three SUGGESTIONs from `verify-report.md` remain open and are appropriate for future work:

1. **Doc drift (SUGGESTION-1)**: `design.md` / `tasks.md` describe the 403 body as `{"error":"Forbidden origin"}`; shipped code returns `{"error":"Host not allowed"}` / `{"error":"Origin not allowed"}`. No functional impact (no spec scenario asserts the exact string). **Recommendation**: one-line fixup to alignment artifacts if they are reused later.

2. **Side-effecting function calls in read-only context (SUGGESTION-2)**: `SET TRANSACTION READ ONLY` does not block side-effecting administrative function calls (e.g., `pg_terminate_backend`, `pg_reload_conf`). This is inherent Postgres semantics and outside this change's stated scope (data-write bypass via CTE-DELETE), but a real residual attack surface on the `/api/query` SQL console. **Recommendation**: tracked as a future hardening item, e.g., an allowlist/denylist of permitted top-level functions.

3. **Test fixture coverage (SUGGESTION-3)**: `/api/schema` redaction tested only with a literal-URL fixture; the spec's "holds identically when using `env()`" sub-clause is exercised for `/api/schema/source` but not for `/api/schema` itself. Low risk because `redactSchema` deletes the whole `datasource` key regardless of contents. **Recommendation**: low priority; defer unless schema-editor write-back is added.

---

## Known Forward Constraint

**Documented in `packages/cli/src/studio-server.ts` (lines 176–180)**, with code comments at the `redactSource` function site:

**Datasource redaction safety depends on absence of a schema-write-back endpoint.** Currently, `/api/schema/source` serves redacted text only. No save-back or editor-write endpoint exists. If a future change adds a Studio schema write-back feature (currently on the roadmap), that endpoint **must not round-trip the redacted text back into the real schema file** — this would silently delete the `datasource` block from persistent storage. This constraint is documented at the source for future maintainers.

---

## Scope Verification

**Implementation stayed within declared scope:**
- Modified: `packages/cli/{package.json, src/index.ts, src/studio-server.ts, test/studio-harness.mjs, test/studio-server.mjs}`, `openspec/changes/harden-studio-server/**`, `pnpm-lock.yaml`
- Untouched: `packages/core`, `packages/client`, `packages/migrator`, `crates/`, `apps/studio`

**Out-of-scope items (separate changes):**
- `apps/studio` frontend UI fake-CRUD simulations (roadmap item "Delete the simulations", separate SDD change)
- Authentication, TLS, multi-user access control (future hardening phases)

---

## Archive Contents

All artifacts copied from `openspec/changes/harden-studio-server/` to `openspec/changes/archive/2026-08-10-harden-studio-server/`:

- ✅ `proposal.md` — Intent, scope, approach, dependencies, success criteria
- ✅ `design.md` — Technical design decisions, constraints, open questions
- ✅ `tasks.md` — 18 implementation tasks (all marked [x]), delivery model, parallelization
- ✅ `verify-report.md` — 0 CRITICAL, 2 WARNING (resolved), 3 SUGGESTION (forward-carry)
- ✅ `specs/studio-server-security/spec.md` — NEW capability: loopback bind, redaction, validation
- ✅ `specs/studio-readonly-queries/spec.md` — NEW capability: transaction enforcement, aliasing
- ✅ `specs/studio-server-tests/spec.md` — NEW capability: harness, coverage, Turborepo integration

**Main specs updated:**
- Created `openspec/specs/studio-server-security/spec.md` (NEW)
- Created `openspec/specs/studio-readonly-queries/spec.md` (NEW)
- Created `openspec/specs/studio-server-tests/spec.md` (NEW)

---

## Cycle Completion

- **Proposal**: ✅ Delivered, refined during execution
- **Specification**: ✅ Three NEW capabilities defined and archived
- **Design**: ✅ Implementation approach with decision rationale and constraints
- **Tasks**: ✅ 18/18 complete, dual-slice delivery model executed
- **Implementation**: ✅ Stacked commits `383dedb` (S1) → `10d95fe` (S2) → `31b8f37` (remediation)
- **Verification**: ✅ All gates green, two intermediate warnings resolved, three forward-carry suggestions
- **Archive**: ✅ SDD cycle closed, specifications merged into main, change folder archived

**This change is ready for user review and authorization to push/merge.**

---

## Key Learnings

1. Test-coverage gaps identified at verification can be rapidly remedied post-apply without reverting; both WARNINGs closed by a single targeted commit `31b8f37`.
2. Postgres-enforced read-only transactions (`SET TRANSACTION READ ONLY`) provide a much stronger safety guarantee than regex pre-filtering; this pattern is worth reusing for other SQL-guarded API endpoints.
3. Brace-depth scanning (not regex) for multi-line block redaction is both safer and more maintainable than line-by-line heuristics; the `redactSource` implementation proved robust in adversarial testing.
4. PGlite WASM engine (combined with real HTTP harness) provides production-realistic testing for CLI packages without requiring external Docker/Postgres, enabling fast feedback loops.
5. Forward-looking constraints (e.g., "redaction is safe only because no write-back exists yet") belong in code comments, not just design artifacts, so future maintainers cannot miss them.
