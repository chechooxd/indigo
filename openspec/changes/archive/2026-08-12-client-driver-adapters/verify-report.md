# Verify Report: client-driver-adapters

**Date**: 2026-08-12
**Verdict**: FAIL (1 CRITICAL, 0 WARNING, 1 SUGGESTION)

## Task Completeness (21/21 checked, live-grepped)

All 21 checkboxes in `tasks.md` are `[x]`. Re-verified against real code state rather than
trusting the marks, per the rocky-apply-history directive:

- Phase 1 (types/scaffold): `DriverAdapter` interface in `types.ts`, barrel present — confirmed.
- Phase 2 (pg RED/GREEN): `createPgAdapter` implemented in `packages/client/src/adapters/pg.ts`
  — confirmed against design.md Decisions 1-4.
- Phase 3 (PGlite): `createPGliteAdapter` in `packages/client/src/adapters/pglite.ts`, barrel
  populated — confirmed against Decisions 6-8.
- Phase 4 (client.ts refactor + parity test): constructor delegates to `createPgAdapter`,
  `$withSession`/`$disconnect` route off `adapter.txHook`/`adapter.close` — confirmed.
- Phase 5 (exports/harness/package.json): `index.ts` re-exports adapters, `pglite-harness.mjs`
  delegates to `createPGliteAdapter`, `package.json` test script includes both new suites —
  confirmed.
- Phase 6 (docs/build/lint/test/regression proof): README.md Neon recipe present, fresh
  `pnpm build`/`lint`/`test --force` all green — confirmed. Regression-proof claim (4.5, 6.4)
  does NOT hold as literally stated — see CRITICAL below.

## Code Correctness

- `createPgAdapter` (`packages/client/src/adapters/pg.ts`): accepts `PoolConfig | { pool }`,
  discriminated via `"pool" in config` (not `instanceof`); `ownsPool` inference gates
  `close()`'s `pool.end()` call; `transaction` issues `BEGIN`→fn→`COMMIT`/`ROLLBACK` with
  poison-aware `client.release()`; `exec` and the in-transaction executor are both wrapped
  with `withDatabaseErrors`. Matches design.md Decisions 1-5 exactly.
- `createPGliteAdapter` (`packages/client/src/adapters/pglite.ts`): structural `PGliteLike`,
  no `@electric-sql/pglite` runtime import; wraps `pglite.transaction(tx => …)`, inner
  closure touches only `tx`; `close` omitted by default, opt-in via `{ close: true }`. Matches
  Decisions 6-7.
- `IndigoClientBase` constructor (`packages/client/src/client.ts`): `connectionString`/`pool`
  branch now calls `createPgAdapter({ connectionString, ...options.pool })` and assigns
  `pool`/`run`/`closeInjected`/`txHook` from the adapter; `options.db` branch unchanged
  (`this.pool = null`). `$disconnect` routes through `closeInjected` only — the old
  `pool.end()` branch is gone. Matches design.md Decision 5 and File Changes table.
- Public exports (`packages/client/src/index.ts`): `export * from "./adapters/index.js"`.
  Barrel (`adapters/index.ts`) re-exports `createPgAdapter`/`createPGliteAdapter` plus their
  types. No `createNeonAdapter` export anywhere in `src/`.
- `package.json`: `dependencies` unchanged (`pg`, `@indigodb/realtime` only); PGlite stays in
  `devDependencies`. No new runtime dependency introduced.

## Build / Lint / Test (fresh, `--force`)

- `pnpm build --force`: 10/10 tasks succeeded.
- `pnpm lint --force`: 18/18 tasks succeeded.
- `pnpm test --force`: 16/16 tasks succeeded, 0 failures, including:
  - `@indigodb/compiler` regression harness (14 fixtures + 3 error fixtures, all green — zero
    WASM/snapshot drift as required by proposal Success Criteria).
  - `@indigodb/client` full suite (19 `.mjs` files), including the two new suites:
    - `test/adapters.mjs`: 7/7 checks pass (ownership inference, transaction commit/rollback/
      poison-release, typed-error exec, PGlite end-to-end).
    - `test/adapters-pg.mjs`: 5/5 checks pass (real Postgres over `pglite-socket-harness.mjs`:
      commit, rollback, sequential-release under pool max:1, caller-owned pool not ended,
      typed unique-violation).
  - `transactions.mjs`, `transactions-pg.mjs`, `database-errors.mjs`, `extensions.mjs`,
    `client.mjs` all report "all checks passed" — no regression in observed behavior.

## Spec Compliance Matrix

| Requirement | Scenario | Covering test | Status |
|---|---|---|---|
| PoolConfig or existing Pool | Constructed from PoolConfig | `adapters.mjs` close()/end() (PoolConfig) + `adapters-pg.mjs` commit test | PASS |
| | Constructed from an existing Pool | `adapters.mjs` close()/end() ({pool}) | PASS |
| | Caller-owned pool not closed | `adapters.mjs` + `adapters-pg.mjs` "$disconnect() does not end caller-supplied pool" | PASS |
| | Adapter-owned pool closed on disconnect | `adapters.mjs` "close() calls pool.end()" | PASS |
| Transaction-hook parity | Commits on success | `adapters.mjs` + `adapters-pg.mjs` "commit persists" | PASS |
| | Rolls back on failure | `adapters.mjs` + `adapters-pg.mjs` "fn throws synchronously — rolled back" | PASS |
| | Identical to connectionString-path | `adapters-pg.mjs` mirrors `transactions-pg.mjs` assertions; `extensions.mjs` "wraps default pg.Pool executor" / "wraps injected PGlite executor identically" | PASS |
| Typed database errors | Typed error via adapter path | `adapters.mjs` exec-rejection test + `adapters-pg.mjs` real unique-violation test | PASS |
| Constructor delegation | connectionString path behavior-preserving | `transactions.mjs`/`transactions-pg.mjs`/`database-errors.mjs`/`extensions.mjs`/`client.mjs` (regression) | PASS (functionally); regression-proof mechanism itself is CRITICAL — see below |
| PGlite adapter | Client built through PGlite adapter executes queries | `adapters.mjs` PGlite integration test | PASS |
| | No PGlite runtime dependency | `package.json` inspection (static, per design's own testing strategy — no test required) | PASS |
| Neon docs | Documentation exists without a code adapter | `README.md` + `grep` for `createNeonAdapter` (absent) | PASS |
| | Documented recipe discloses transaction-hook limitation | `README.md` §Neon | PASS |

All 13 spec scenarios have covering evidence (test or, where the spec itself only requires a
static/doc fact, direct inspection matching design's own Testing Strategy table).

## Issues

### CRITICAL

1. **Regression-proof (tasks 4.1, 4.5, 6.4) is not verifiable as literally stated.**
   `git diff --stat` is NOT empty for `packages/client/test/transactions-pg.mjs` (65 lines
   added, uncommitted) versus the last commit, contradicting tasks.md's claim of
   "byte-unmodified" / "SHA-256 hashes unchanged". `packages/client/test/database-errors.mjs`
   and `packages/client/test/extensions.mjs` are **untracked** — they have no commit in git
   history at all (`git log --all` returns nothing for either path), so "byte-unmodified
   versus their state before this change started" cannot be mechanically proven for them by
   any git-based method; only `client.mjs` is both tracked and diff-clean.
   Content inspection of the `transactions-pg.mjs` diff shows it adds two new
   `IndigoDatabaseError`-over-real-Postgres scenarios unrelated to adapter mechanics (no
   `createPgAdapter`/`createPGliteAdapter` reference), and neither `database-errors.mjs` nor
   `extensions.mjs` reference adapters either — consistent with apply-progress's claim that
   these changes pre-date this session and belong to a separate, still-uncommitted body of
   work sitting in the same working tree. That claim is plausible but not independently
   provable by tooling, since no clean baseline commit exists to diff against. All four
   suites *do* pass at runtime (see Test Evidence), so there is no observed functional
   regression — but the specific mechanical proof the design and tasks committed to
   ("git diff --stat empty" / SHA-256 comparison) fails for 1 of 4 files and is structurally
   unconfirmable for 2 more. Recommend: commit a clean baseline before/at the start of the
   next SDD change so this proof is mechanically checkable, or explicitly re-scope the
   regression-proof requirement to content-based review when a git baseline is unavailable.

### WARNING

None.

### SUGGESTION

1. `proposal.md`'s "Success Criteria" checklist items remain unchecked (`- [ ]`) even though
   all five are now factually satisfied (adapters exported, parity tests pass, PGlite suite
   runs through the exported adapter, no new dependency, build/lint/test all green with zero
   WASM/snapshot diff). Cosmetic only — does not affect the verdict — but worth ticking before
   archive for an accurate historical record.

## Final Verdict: FAIL

Rationale: implementation is functionally correct and fully matches proposal/spec/design —
build, lint, and all 16 test tasks (including the new adapter suites) are green, and every
spec scenario has a passing covering test. The single CRITICAL blocks a clean PASS because
the explicitly required regression-proof mechanism (git-diff-based "byte-unmodified"
confirmation for the 4 named pre-existing suites) cannot be honestly certified as passing:
it is objectively non-empty for one file and structurally unverifiable for two others given
the current uncommitted, multi-change working tree. This is a process/repo-hygiene gap, not
an adapter-code defect — recommend resolving the git baseline ambiguity (commit or isolate
unrelated in-flight work) before archiving, then re-running this specific check.
