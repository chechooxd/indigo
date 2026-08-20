# Verify Report: pglite-adapter-error-parity

**Change**: pglite-adapter-error-parity
**Commit**: c92cc80e19c8e2ed93d28cb84fda1ab16e452d3a (already on main)
**Mode**: Full artifacts (proposal #626, spec #629, design #630, tasks #635, apply-progress #640)
**Verdict**: PASS

## Completeness

All 12 tasks in `openspec/changes/pglite-adapter-error-parity/tasks.md` are checked `[x]`. No unchecked tasks. `git diff c92cc80^..c92cc80 --stat` confirms the committed diff matches the tasks/design file-change table exactly: `pglite.ts` (+7/-4), `test/adapters.mjs` (+55), `test/transactions.mjs` (+9/-4), plus the 4 OpenSpec artifact files.

## Source-level verification (read against real committed bytes)

1. **Both `createPGliteAdapter` exec sites wrapped** — Confirmed via `git show c92cc80 -- packages/client/src/adapters/pglite.ts`. `exec` and the executor passed to `fn` inside `transaction` are both wrapped with `withDatabaseErrors`, matching `pg.ts`'s pattern exactly (import added, both call sites decorated at construction).

2. **Outer `pglite.transaction()` rejection intentionally left unwrapped** — Confirmed. The diff does not touch the outer `pglite.transaction(...)` promise itself, only the inner query executor. This matches design.md's Architecture Decisions table verbatim: "PGlite exposes no statement site for commit; wrapping the outer promise would also re-type user errors thrown from `fn` that happen to carry a string `code`, which pg.ts never does." Documented scope boundary, not an oversight — also stated explicitly in the commit message.

3. **`errors.ts` and `pg.ts` unchanged** — Confirmed: `git diff c92cc80^..c92cc80 -- packages/client/src/errors.ts packages/client/src/adapters/pg.ts` is empty (0 lines).

4. **Two new regression tests in `adapters.mjs`** — Confirmed via `git show`. Both new Phase 4 checks assert `caught instanceof IndigoDatabaseError`, `caught.code === "UNIQUE_VIOLATION"`, `caught.sqlstate === "23505"`, and `caught.cause !== undefined`, for both the direct-exec path and the `adapter.transaction(async (exec) => ...)` callback path — matching spec #629's two new scenarios exactly.

5. **`transactions.mjs` "no-leak-on-mid-callback-throw" fix is real and correct** — Confirmed via `git show`. The old assertion `/null/i.test(caught.message)` is replaced with `caught.cause !== undefined && /null/i.test(caught.cause.message)`, with an inline comment explaining the behavior change (wrapped executor now produces a typed `IndigoDatabaseError` whose top-level `.message` is generic, with the original driver error preserved on `.cause`). This is the correct adaptation to the new wrapped behavior, not a weakened/hollow assertion — it still verifies the not-null violation propagates, just via `.cause`.

## Runtime evidence (fresh, isolated — see Methodology note)

All commands were re-run from a fresh `git worktree add --detach <tmp> c92cc80` (an exact, isolated checkout of the commit under verification), after discovering the shared main working tree had unrelated concurrent WIP activity from another agent session (uncommitted/committed changes to `client.ts`, `transactions.mjs`, `transactions-pg.mjs`, `generator/src/client.ts` unrelated to this change, appearing and changing mid-session). Testing directly against that contaminated tree produced 9 spurious `array-form` failures in `transactions.mjs` — traced and confirmed to belong entirely to a different, uncommitted, in-progress change (`client-transaction-array-form`), not to `pglite-adapter-error-parity`. The isolated worktree eliminates this contamination.

| Command | Exit | Result |
|---|---|---|
| `pnpm --filter @indigodb/client build` | 0 | clean tsc build |
| `node packages/client/test/adapters.mjs` | 0 | 9/9 ok, including both new Phase 4 tests |
| `node packages/client/test/transactions.mjs` | 0 | 6/6 ok, including the fixed `no-leak-on-mid-callback-throw` |
| `pnpm --filter @indigodb/client test` (full suite) | 0 | 19/19 suites ok, no failures |
| `pnpm lint` (repo root) | 0 | 18/18 tasks green |
| `pnpm test` (repo root) | 1 | Only failure: `13-ambiguous-relations.indigo ValidationError[]` ordering mismatch in `@indigodb/compiler`'s regression harness — a pre-existing fixture-13 flake, confirmed unrelated: `git diff c92cc80^..c92cc80 --stat -- crates/ packages/compiler/` is empty. Turbo's default fail-fast cascaded this single failure into `ELIFECYCLE` cancellations for sibling tasks (client, cli, studio, migrator, generator), which is turbo's cancel-on-failure behavior, not independent regressions — the client suite was independently confirmed green above. |

## Spec compliance matrix

| Scenario (spec #629) | Covering test | Result |
|---|---|---|
| Client executes queries through PGlite adapter | `adapters.mjs` Phase 3.1 | PASS |
| No PGlite runtime dependency introduced | (structural — devDependency only, unchanged by this commit) | PASS (unchanged) |
| Typed error thrown on a plain exec | `adapters.mjs` new Phase 4 test 1 | PASS |
| Typed error thrown inside a transaction callback | `adapters.mjs` new Phase 4 test 2 | PASS |
| Non-database error still receives best-effort typing | `database-errors.mjs` (existing, structural `withDatabaseErrors` coverage — no PGlite-specific new test, but the wrap reuses the same decorator/logic) | PASS (via shared implementation coverage) |

## Design coherence

Matches design.md's Architecture Decisions, Data Flow, File Changes, and Interfaces sections exactly — wrap position (innermost, at construction), harness reuse (`withDatabase` from `pglite-harness.mjs`), test placement (`adapters.mjs` Phase 4), and the outer-transaction-stays-unwrapped decision all verified against real committed code above.

## Issues

None. No CRITICAL, WARNING, or SUGGESTION findings.

## Verdict: PASS

Implementation genuinely matches proposal/spec/design/tasks. All runtime evidence is green in isolation. The only non-green root-level command output is the pre-existing, unrelated fixture-13 compiler flake.
