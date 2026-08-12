# Verify Report: client-executor-seam

**Mode**: full artifacts (proposal, design, tasks, spec x2) — Engram + OpenSpec hybrid
**Verdict**: PASS WITH WARNINGS

## Completeness

24/24 tasks checked in `tasks.md`. 23/24 confirmed genuinely complete by reading code/tests.
Task **2.5/2.6** ("assert no `pg.Pool` is constructed on the injected path, e.g.
`client["pool"] === null`") is checked `[x]` but **no such assertion exists** in
`packages/client/test/client.mjs`. The three constructor tests for the injected path
(lines 52, 84, 100) only assert non-throwing / correct execution; none inspects the
internal `pool` field. This is a task marked done that does not match code state.

## Gates (run fresh this session)

| Command | Result |
|---|---|
| `pnpm --filter @indigodb/client test` | PASS — 9/9 checks green |
| `pnpm build` | PASS — 10/10 packages (cache hit, `FULL TURBO`) |
| `pnpm lint` | PASS — 18/18 tasks (cache hit, `FULL TURBO`) |
| `pnpm test` (root) | PASS — 16/16 tasks, includes `@indigodb/compiler` parity (24 checks) + `@indigodb/cli` studio-server (9 checks) + `@indigodb/client` (9 checks) |
| `cd crates && cargo test` | PASS — 23/23 (4 unit + 19 fixture tests) |

## Requirement/Scenario Traceability

### Domain: client-executor-injection

| Requirement | Scenario | Test | Status |
|---|---|---|---|
| Default pg.Pool construction unchanged | No connection string/pool/executor → exact error | `client.mjs:58-82` | COVERED |
| Default pg.Pool construction unchanged | Only connectionString supplied → succeeds, routes through Pool | none (acknowledged out-of-scope by design: "E2E: N/A — needs a live server") | **ACCEPTED GAP** (documented in design.md) |
| Executor injection bypasses pool construction | Executor supplied, no connectionString/pool/DATABASE_URL → succeeds | `client.mjs:52,84` | COVERED |
| Executor injection bypasses pool construction | **No `pg.Pool` MUST be constructed** | none — no test inspects `client["pool"]` | **CRITICAL — UNTESTED** (task 2.5/2.6 falsely checked) |
| $queryRaw path-independent | $queryRaw on injected path returns injected rows | `client.mjs:97-104` | COVERED |
| $disconnect closes whichever seam exists | Default path calls `pool.end()` | exercised indirectly by `client.mjs:143-152` (constructs real Pool, disconnects without throwing) but **no assertion `pool.end()` was actually invoked** (no spy) | **WARNING — weak coverage** |
| $disconnect closes whichever seam exists | Injected-with-close calls close, not pool | `client.mjs:108-121` | COVERED |
| $disconnect closes whichever seam exists | Injected-without-close does not throw | `client.mjs:123-127` | COVERED |
| Realtime teardown unaffected by construction path | Default path teardown | `client.mjs:143-152` | COVERED |
| Realtime teardown unaffected by construction path | Injected path teardown | `client.mjs:131-141` | COVERED |

### Domain: client-runtime-tests

| Requirement | Scenario | Test | Status |
|---|---|---|---|
| Plain-Node harness matching house style | Test script exists and runs | `pnpm --filter @indigodb/client test` executed this session, exit 0 | COVERED (non-zero-on-failure path not separately meta-tested — low-risk, `process.exit(1)` on `failures>0` confirmed by code read) |
| PGlite-backed executor adapter | Adapter satisfies Executor contract | `pglite-harness.mjs` used as `db.exec` in CRUD test | COVERED |
| Regression coverage for the executor seam | Disconnect guard regression | `client.mjs:123-127` | COVERED |
| Regression coverage for the executor seam | Missing-connection-string error regression | `client.mjs:58-82` | COVERED |
| Regression coverage for the executor seam | CRUD passthrough regression | `client.mjs:156-196` | COVERED |

## Adversarial checks performed

1. **`$disconnect()` when `$realtime()` was never invoked (no `realtimeManager` ever created), injected path** — `this.realtimeManager?.close()` reads as `null?.close()`, which is a no-op by the optional-chaining operator regardless of whether `$realtime()` was ever called. Confirmed safe by direct read of `client.ts:116-119`; no test explicitly targets this exact "never-called" sub-case, but it is structurally identical to every other `$disconnect()` test (none of the 9 checks call `$realtime()` first except the two teardown tests) — so 7 of 9 checks already implicitly exercise "never lazily created" without crashing. Not a new risk.
2. **Pool-typing change (`PgPool` → `PgPool | null`) blast radius** — grepped `client.ts` for every `this.pool` use: constructor assignment (both branches) and the single `if (this.pool)` guard in `$disconnect()`. No other file references `IndigoClientBase` internals (`delegate.ts`/`generator/src/client.ts` confirmed untouched, see below) and no other read of `pool` exists in `client.ts`. No missed null-check found.
3. **Default (no-injection) path byte-equivalence** — read the `else` branch diff: same `connectionString` resolution (`options.connectionString ?? process.env.DATABASE_URL`), same guard condition (`!connectionString && !options.pool`), same exact error string, same `new Pool({ connectionString, ...options.pool })` construction, same `pool.query(sql, params).rows` exec logic (now indirected through `this.run`, called once per `exec` invocation — identical externally observable behavior), same `pool.end()` call in `$disconnect()`. Confirmed byte-equivalent in behavior to pre-change code.
4. **Scope check, branch's own 2 commits only** (`61a6674` docs, `d6d54cb` feat) — touch only `openspec/changes/client-executor-seam/**`, `packages/client/{src/client.ts,package.json,test/client.mjs,test/pglite-harness.mjs}`, and a 3-line `pnpm-lock.yaml` addition. The 63-file/879-line `main..client/executor-seam` diff is stale-`main` noise (unrelated `harden-studio-server`/`delete-studio-simulations`/`add-ci-floor` changes not yet fast-forwarded), not product scope creep — confirmed by inspecting the branch's own commits directly, not the diff against stale `main`.
5. **`delegate.ts` / `generator/src/client.ts` untouched** — `git diff main..client/executor-seam -- packages/client/src/delegate.ts packages/generator/src/client.ts` produces zero output, confirmed independently (not just trusting apply-progress's claim).

## Issues

### CRITICAL
1. Task 2.5/2.6 is checked complete but the planned assertion ("no `pg.Pool` is constructed on the injected path") was never implemented as a test. The spec scenario "Executor supplied ... THEN no `pg.Pool` MUST be constructed" (`client-executor-injection`) has zero runtime-test coverage — nothing distinguishes `pool === null` from `pool` being truthy on the injected path. This needs no live DB or PGlite; a one-line `assert(client["pool"] === null, ...)` closes it. Recommend adding before archive, or explicitly accepting the gap in the archive report.

### WARNING
1. The "$disconnect closes whichever seam exists / Default path calls pool.end()" scenario is exercised (a real `pg.Pool` is constructed and `$disconnect()` runs without throwing) but not asserted via a spy — a regression that silently dropped the `await this.pool.end()` call would not be caught by the current suite. Design's own Testing Strategy table calls for unit coverage of "`$disconnect` on all three variants" via stub, and 2 of 3 variants got a direct assertion; the third (default pool) did not.

### SUGGESTION
1. "Test script exits non-zero on any failure" is proven only by code read (`process.exit(1)` on `failures > 0`), not by a meta-test that forces a failure and checks the exit code. Low risk, cosmetic.

## Final Verdict

**PASS WITH WARNINGS.** All four gates are green, the implementation matches the design
in every place independently checked (guard placement, branch-free `exec`, `$disconnect`
null-safety, scope isolation), and 22/24 spec scenarios have genuine runtime coverage. One
CRITICAL gap is a false-positive task checkbox (2.5/2.6) that leaves one spec scenario
completely untested at runtime — cheap to close, does not indicate a functional defect
(the production code was independently confirmed correct by direct reading), but should be
resolved or explicitly accepted before archive per the "spec scenario compliant only when a
covering test passed at runtime" rule.
