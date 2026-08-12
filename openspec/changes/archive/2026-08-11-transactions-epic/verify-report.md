# Verify Report: transactions-epic (RE-VERIFICATION)

**Date**: 2026-08-11
**Mode**: hybrid (OpenSpec files + Engram)
**Supersedes**: prior verify-report (2 CRITICAL findings, both remediated in this pass)

## Completeness

| Item | Status |
|---|---|
| Tasks | 37/37 checked (Phase 1: 2, Phase 2: 8, Phase 3: 7, Phase 4: 2, Phase 5: 5, Phase 6: 6, Phase 7: 3, Phase 8: 4) |
| Specs | `client-transactions` (9 requirements / 11 scenarios), `client-executor-injection` (1 requirement / 3 scenarios) — 10 requirements / 14 scenarios total |
| Design | present, Open Questions section resolved and marked `[x]` |
| Apply progress | present, Phase 8 remediation batch documented |

No unchecked tasks. Full verification performed.

## Build / Test / Lint Evidence (executed live, this pass)

| Command | Exit code | Result |
|---|---|---|
| `pnpm --filter @indigodb/client test` | 0 | 21/21 (10 client.mjs + 6 transactions.mjs + 5 transactions-pg.mjs) |
| `pnpm build --force` | 0 | 10/10 packages |
| `pnpm lint --force` | 0 | 18/18 tasks |
| `pnpm test --force` (root) | 0 | 16/16 tasks, incl. generator `transaction-emission.mjs` (5/5) and client's full transaction suites |

All commands run directly in this session against the current working tree (nothing committed/pushed yet, matching prior status).

## Spec Compliance Matrix

### `client-transactions`

| Requirement | Scenario | Covering test | Result |
|---|---|---|---|
| Exclusive session per transaction | pg.Pool path checks out a dedicated connection | `transactions-pg.mjs` — pool:max:1 mutual-exclusion proof | PASS |
| Commit on success | Callback resolves successfully | `transactions.mjs` (injected/PGlite) + `transactions-pg.mjs` (pg.Pool) | PASS |
| Rollback on failure | Callback throws synchronously | `transactions.mjs` + `transactions-pg.mjs` | PASS |
| Rollback on failure | Callback's promise rejects | `transactions.mjs` | PASS |
| Rollback on failure | A tx operation throws before fn settles | `transactions.mjs` (no-leak-on-mid-callback-throw) | PASS |
| Session always released | Release happens on every outcome | `transactions.mjs` (no-leak) + `transactions-pg.mjs` (N sequential txns on max:1, rollback-then-reuse) | PASS |
| Nested transactions are prevented | tx has no $transaction member | Structural: `client.ts`'s `$transaction(fn: (exec: Executor) => ...)` and generated `TransactionClient` never declare a `$transaction` field (source-inspected); generator test `transaction-emission.mjs` asserts `TransactionClient never exposes $transaction` | PASS (compile-time property + generator assertion, correctly not runtime-tested per amended spec) |
| Nested transactions are prevented | Reentrant call on the same client | `transactions.mjs` (nesting-rejected) | PASS |
| Unsupported executors fail explicitly | Injected executor without a transaction hook | `transactions.mjs` (unsupported-executor-error) | PASS |
| Typed tx delegates scoped to the session | tx delegate writes participate in the transaction | `transactions.mjs` (all commit/rollback scenarios use `ModelDelegate` bound to `tx`) | PASS |
| No isolation/timeout/read-only options accepted | Options argument is not part of the surface | Structural: `$transaction<T>(fn)` single-argument signature in `client.ts` and generated client (source-inspected, no dedicated negative test — narrow API-surface assertion, low risk) | PASS (structural) |

### `client-executor-injection`

| Requirement | Scenario | Covering test | Result |
|---|---|---|---|
| Optional transaction hook on injected executors | Hook present is used by $transaction | `transactions.mjs` (all PGlite-injected scenarios use `createPgliteDb`'s `transaction` hook) | PASS |
| Optional transaction hook on injected executors | Hook absent leaves non-transaction behavior unchanged | `client.mjs` (existing injected-executor suite, unaffected by the new field) | PASS |
| Optional transaction hook on injected executors | Hook absence only surfaces when $transaction is called | `transactions.mjs` (unsupported-executor-error) | PASS |

## Re-verification of the two prior CRITICAL findings

**CRITICAL #1 (pg.Pool path untested) — CLOSED, genuinely.**
`packages/client/test/pglite-socket-harness.mjs` fronts PGlite with a real `net.Server` speaking the actual Postgres wire protocol (`@electric-sql/pglite-socket@^0.2.7`, pinned to the exact `@electric-sql/pglite@0.5.4` peer already used elsewhere in the repo). `transactions-pg.mjs` constructs `IndigoClientBase` with only `connectionString`/`pool` (no injected `db`), i.e. the genuine default `pg.Pool` code path, and exercises: dedicated-connection checkout, commit, rollback, N=5 sequential transactions on a `max:1` pool (no leak/exhaustion), and release-after-rollback reuse. Ran the full suite live in this session: 5/5 pass, 21/21 for the package as a whole, 0 exit code.

The mutual-exclusion/dedicated-connection proof was inspected line-by-line and is sound: it uses a `pool: { max: 1 }` client, holds the transaction open via a manually-gated promise, records ordering in an `events` array, asserts the concurrent outside `$queryRaw` has NOT resolved while the gate is held (with a real 50ms wait to let `pool.connect()`+`BEGIN` actually happen), then releases the gate and asserts the outside call resolves only after, with explicit event-ordering assertion (`tx:about-to-return` before `outside:resolved`). This is a real proof of `pool.connect()` holding a dedicated connection for the whole callback's duration — not a stub or a claim. Each `check()` is wrapped in a 15s timeout, so a leaked connection fails fast rather than hanging CI. The harness's documented single-writer limitation (PGlite/`pglite-socket`'s queue only services the in-transaction connection while any session has an open transaction — confirmed empirically per apply-progress, not theoretical) is accurately described and the harness correctly avoids the one scenario it cannot support (two literally-overlapping open transactions), substituting the pool-accounting proof instead, which is an equally valid demonstration of the actual spec wording ("a single connection MUST be checked out... for the duration of fn").

**CRITICAL #2 (unreachable tx.$transaction runtime error) — CLOSED, via spec amendment.**
The current `client-transactions/spec.md` (re-read fresh this pass, not from memory of the prior report) now correctly splits "Nested transactions are prevented" into two independently-testable mechanisms:
1. Reentrant `client.$transaction()` on the same client while one is in flight → runtime `AsyncLocalStorage` guard, rejects with an explicit "cannot be nested" error. Tested by `transactions.mjs`'s `nesting-rejected` scenario — confirmed passing.
2. `tx.$transaction(...)` → prevented at TypeScript compile time because `tx`'s type (the raw `Executor` on `IndigoClientBase`, or the generated `TransactionClient` interface) never declares a `$transaction` member. Source-inspected in both `packages/client/src/client.ts` (`$transaction<T>(fn: (exec: Executor) => Promise<T>)` — the callback parameter type is `Executor`, which has no `$transaction`) and `packages/generator/src/client.ts` (the emitted `TransactionClient` interface has no `$transaction` field; the generator test `transaction-emission.mjs` has an explicit assertion `TransactionClient never exposes $transaction`, confirmed passing this run).

The spec's own "tx has no $transaction member" scenario is now internally consistent with what's implemented: it explicitly documents that a JS caller bypassing types would get a generic "not a function" error rather than the old, previously-unreachable explicit message — and no test claims to exercise a runtime rejection that cannot occur. This is a correct spec correction, not a test gap: TypeScript's own compiler is the enforcement mechanism, and the generator's string-assertion test is the appropriate proxy for "the emitted type never has this member." No test asserts an unreachable runtime branch. The amendment note at the top of the spec file accurately documents the reasoning and correctly states the sibling reentrant-call scenario is unaffected.

## New Scope Drift Check (remediation-introduced)

- `packages/client/package.json`: `@electric-sql/pglite-socket@^0.2.7` added to `devDependencies` (verified — not `dependencies`; correct, it's test-only tooling, never shipped to consumers).
- `git status` shows only expected files changed/added: `client.ts`, `types.ts`, `pglite-harness.mjs` (modified), `pglite-socket-harness.mjs` + `transactions-pg.mjs` + `transactions.mjs` (new client test files), `packages/generator/{package.json,src/client.ts}` + `test/transaction-emission.mjs` + `test/fixtures/transaction-emission.indigo` (Slice 2), `pnpm-lock.yaml`. No unrelated file touched.
- `openspec/changes/transactions-epic/` — only this change's own artifacts.
- No new runtime dependency, no change to `dependencies` (only `devDependencies`), no CI workflow change needed (both `ts` and `rust` CI jobs already run `pnpm test`/`pnpm build`, which transitively cover the new suite).

## Design Coherence

Design's `$withSession` pseudocode, `TransactionClient`/`__delegates` generator contract, and harness hook shape were checked directly against `client.ts`, `packages/generator/src/client.ts`, and `pglite-harness.mjs`/`pglite-socket-harness.mjs` — all match. Both design Open Questions are resolved and marked `[x]`, matching the shipped code (`tx.$queryRaw` is emitted; AsyncLocalStorage Node-only constraint confirmed harmless since Studio never imports `@indigodb/client`).

## Issues

**CRITICAL**: none.

**WARNING**: none.

**SUGGESTION**:
1. The "No isolation/timeout/read-only options accepted" scenario has only structural (source-read) coverage, no dedicated negative runtime test (e.g. asserting a second argument is silently ignored or a TS type error). Low risk — the API surface is a single-parameter function signature, easy to verify by inspection, and adding a test would mostly duplicate the type system's own guarantee. Not blocking.

## Verdict

**PASS**

Both prior CRITICAL findings are genuinely closed with live-executed evidence in this session (not trusted claims): `pnpm --filter @indigodb/client test` (21/21, exit 0), `pnpm build --force` (10/10, exit 0), `pnpm lint --force` (18/18, exit 0), `pnpm test --force` (16/16, exit 0). Tasks are 37/37 complete. Every spec scenario across both delta specs has either a passing covering test or a sound structural/compile-time justification consistent with the amended spec wording. No new scope drift was introduced by the remediation. Ready for archive.
