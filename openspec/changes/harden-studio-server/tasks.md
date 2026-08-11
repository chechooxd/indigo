# Tasks: Harden the Studio server

Chained delivery on `main` (`stacked-to-main`), two PRs: **S1** (seam + harness +
read-only transaction enforcement) then **S2** (bind host + Origin/Host allowlist +
datasource redaction), stacked on S1. Strict TDD throughout — every scenario task
below is RED before its corresponding implementation task, and no implementation
task is "done" until its paired test task is green.

## Slice S1 — StudioDb seam, PGlite test harness, read-only transaction enforcement (~230 lines)

Requirements covered: `studio-readonly-queries` (transaction-level enforcement,
fast-path pre-filter demotion, aliasing preserved), `studio-server-tests` (harness
boots a real server, CTE-DELETE regression coverage, wired into `pnpm test`).

1. [x] **[S1.1] Add `@electric-sql/pglite` as a devDependency of `packages/cli`** and add
   a `test` script (mirrors `packages/migrator`'s pattern) to `packages/cli/package.json`
   so root `pnpm test` picks it up via Turborepo.
   - Spec: `studio-server-tests` / "Wired into pnpm test"
   - Sequential (prerequisite for all S1 test tasks)

2. [x] **[S1.2] Create `packages/cli/test/studio-harness.mjs`**: PGlite lifecycle helper
   (`withDatabase`, mirroring `packages/migrator/test/pg-harness.mjs`), a `StudioDb`
   adapter over PGlite implementing `query`/`readOnly`/`close` (readOnly via
   `db.transaction(tx => tx.query("SET TRANSACTION READ ONLY") ...)`), and
   `withStudio(fixture, fn)` that starts `startStudio` with `port: 0` and the PGlite
   adapter injected as `options.db`, tearing both down after.
   - Spec: `studio-server-tests` / "Harness boots the server and a database for the test run"
   - Depends on: S1.1, S1.4 (needs the `StudioDb`/`db` option to exist on `StudioOptions`)
   - Sequential

3. [x] **[S1.3] RED: write the failing regression test first** in
   `packages/cli/test/studio-server.mjs` — POST `/api/query` with
   `WITH x AS (DELETE FROM "User" RETURNING *) SELECT * FROM x` against a seeded
   `User` table, asserting the request currently succeeds and the row is deleted
   (proves the OLD `isReadOnlyQuery`-only guard is insufficient). Also write the
   `/api/tables/:name` aliasing test as a green regression guard (must pass
   unchanged before and after).
   - Spec: `studio-readonly-queries` / "CTE-wrapped DELETE is rejected by Postgres, not a regex";
     `studio-readonly-queries` / "Column aliasing preserved for table reads"
   - Depends on: S1.2
   - Sequential

4. [x] **[S1.4] Introduce the `StudioDb` port and `createPgDb` production adapter** in
   `studio-server.ts`: define the `StudioDb` interface (`query`, `readOnly<T>`,
   `close`), add `db?: StudioDb` to `StudioOptions`, and implement `createPgDb(connectionString)`
   wrapping `pg.Pool` as the default when `options.db` is absent.
   - Spec: design "inject a `StudioDb` port" decision (supports all `studio-readonly-queries` scenarios)
   - Depends on: S1.3 (RED first)
   - Sequential

5. [x] **[S1.5] Add the dedicated read-only pool and transaction enforcement.**
   `createPgDb`'s `readOnly` implementation checks out a client from a second,
   dedicated `pg.Pool({ max: 4 })` (never the shared/metadata pool), runs
   `BEGIN; SET TRANSACTION READ ONLY; <query>;`, always ends in `ROLLBACK` (never
   `COMMIT`) in a `finally`, then releases. Route both `/api/query` and
   `/api/tables/:name` through `db.readOnly(...)` instead of the shared pool.
   - Spec: `studio-readonly-queries` / "Transaction-level read-only enforcement";
     "/api/tables/:name uses the same enforcement path"; "Plain SELECT succeeds"
   - Depends on: S1.4
   - Sequential
   - **GREEN checkpoint**: S1.3's CTE-DELETE test now fails to delete the row and
     the server responds 4xx; aliasing test still passes unchanged.

6. [x] **[S1.6] Trim `isReadOnlyQuery` to advisory-only.** Remove the
   `^(select|with)` prefix test; keep only "non-empty AND no interior `;`". Add the
   RED test first (multi-statement body should still be rejected pre-connection with
   the existing 400 message), confirm it stays green through the trim.
   - Spec: `studio-readonly-queries` / "Fast-path pre-filter remains advisory only"
   - Depends on: S1.5
   - Sequential (small, but must land after the transaction guard exists so the
     pre-filter is provably not the sole enforcement)

7. [x] **[S1.7] `startStudio` return-type change**: return `{ port, close() }` instead
   of `void`. `port` reflects the actual bound port (needed for `port: 0` ephemeral
   binding in tests); `close()` tears down the HTTP server, both pools (or the
   injected `StudioDb`), and the realtime engine if started.
   - Spec: design Interfaces/Contracts; verified safe by orchestrator preflight
     (sole caller `packages/cli/src/index.ts:207` never uses the return value)
   - Depends on: S1.4
   - Can run in parallel with S1.5/S1.6 (touches a different part of the function)

8. [x] **[S1.8] Full S1 suite green + `pnpm test` wired end-to-end.** Run
   `pnpm test --filter @indigodb/cli` and root `pnpm test`; confirm the new suite
   executes and a failing scenario fails the overall Turborepo run.
   - Spec: `studio-server-tests` / "Root test run includes the new harness"
   - Depends on: S1.1–S1.7
   - Sequential (closes the slice)

## Slice S2 — bind host, Origin/Host allowlist, datasource redaction (~160 lines)

Stacks on S1. Requirements covered: `studio-server-security` (loopback default,
explicit opt-in, datasource redaction for both JSON and source-text endpoints,
Origin/Host validation).

9. **[S2.1] RED: bind-address test.** In `studio-server.mjs`, assert that starting
   the server with no host option binds `server.address().address` to a loopback
   value (`127.0.0.1`), and a separate case asserts the explicit-`host` option is
   honored (`server.address().address` matches the passed value). Do not attempt to
   assert real non-loopback network reachability (not deterministic in CI — this is
   a known/documented limitation, not a gap to silently work around).
   - Spec: `studio-server-security` / "Default startup binds loopback only";
     "Explicit opt-in allows remote bind"
   - Depends on: S1.8
   - Sequential

10. **[S2.2] Add `host` to `StudioOptions` and thread `listen(port, host)`.** Default
    `host` to `127.0.0.1` when not provided. When an explicit non-loopback host is
    passed, print a startup warning naming the risk (per design: relaxed Host
    validation follows in S2.4).
    - Spec: `studio-server-security` / both bind scenarios; design "Host always,
      Origin when present" (bind portion)
    - Depends on: S2.1 (RED first)
    - Sequential

11. **[S2.3] Add `--host <host>` to the `studio` CLI command** in
    `packages/cli/src/index.ts` (default `127.0.0.1`, overridable via
    `INDIGODB_STUDIO_HOST` env var, explicit flag wins), passed through to
    `startStudio`.
    - Spec: `studio-server-security` / "Explicit opt-in allows remote bind"; design
      File Changes row for `index.ts`
    - Depends on: S2.2
    - Can run in parallel with S2.4–S2.6 (different file)

12. **[S2.4] RED: redaction tests.** Assert `/api/schema` JSON has no `datasource`
    key (both literal-URL and `env()`-URL fixtures), and `/api/schema/source` text
    contains neither the raw block nor any connection string, for a fixture whose
    `datasource { ... }` block is multi-line and nested.
    - Spec: `studio-server-security` / "/api/schema omits datasource...";
      "/api/schema/source omits datasource block from raw source"
    - Depends on: S1.8
    - Sequential

13. **[S2.5] Implement `redactSchema` (shallow copy minus `datasource`, computed
    once into `publicSchema`) and `redactSource` (brace-depth line scan — NOT a
    regex — replacing the whole `datasource { ... }` block with
    `// datasource redacted by Studio`, computed once into `publicSource`).** Wire
    both endpoints to serve the redacted values; the raw `resolved`/`source` never
    reach `sendJson`/the response.
    - Spec: `studio-server-security` / both redaction scenarios; design "startup-time
      redaction of two different artifacts" (brace-depth, not regex)
    - Depends on: S2.4 (RED first)
    - Sequential

14. **[S2.6] RED: Origin/Host validation tests.** Assert a request with a mismatched
    `Origin` header gets `403 {"error":"Forbidden origin"}` before any route/body
    logic runs (including static asset paths); assert a matching or absent `Origin`
    passes through; assert `Host` is checked on every request including static
    assets.
    - Spec: `studio-server-security` / "Cross-origin request is rejected";
      `studio-server-tests` / "Cross-origin rejection is asserted"
    - Depends on: S2.2 (needs `host` option to build the allowlist)
    - Sequential

15. **[S2.7] Implement `validateHeaders`.** Allowlist =
    `{localhost, 127.0.0.1, ::1, <configured host>} × server port`. Runs before
    routing for every request. `Host` always checked; `Origin`, when present, must
    parse and match. Under an explicit non-loopback bind, relax `Host` validation to
    port-match only (per design — the browsing address is unknowable), and note this
    relaxation in the CLI's startup risk-warning output added in S2.2.
    - Spec: `studio-server-security` / "Cross-origin request is rejected"; design
      "Host always, Origin when present"
    - Depends on: S2.6 (RED first)
    - Sequential

16. **[S2.8] Documentation note for the non-loopback Host relaxation.** Add a short
    note (README or CLI help text — wherever `--host` is documented) stating that
    under an explicit non-loopback bind, Host validation is intentionally weakened to
    port-match only, so operators understand the tradeoff they're opting into.
    - Spec: derived from design Open Question ("deliberate weakening needing
      confirmation")
    - Depends on: S2.7
    - Can run in parallel with S2.9

17. **[S2.9] Forward-looking constraint note.** Add a code comment near
    `redactSource`/`/api/schema/source` stating that redaction is safe only because
    no save-back/editor-write endpoint exists yet, and that a future write-back
    endpoint (`apps/studio` roadmap item) must not round-trip the redacted text.
    - Spec: derived from design Open Question (forward-looking constraint)
    - Depends on: S2.5
    - Can run in parallel with S2.8

18. **[S2.10] Full S2 suite green, root `pnpm test`, `pnpm build --filter @indigodb/cli`
    and `pnpm lint` clean.** Confirm all four hardening blockers (bind, redaction,
    CTE-DELETE, cross-origin) plus the aliasing regression pass together in one run.
    - Spec: `studio-server-tests` / all four blocker scenarios, combined
    - Depends on: S2.1–S2.9
    - Sequential (closes the slice)

## Parallelization summary

- **S1**: mostly sequential (RED→GREEN chain over one file); S1.7 (return-type
  change) can run in parallel with S1.5/S1.6.
- **S2**: mostly sequential within each of the three sub-features (bind, redaction,
  Origin/Host), but S2.3 (index.ts flag) can run in parallel with the redaction and
  Origin/Host work since it touches a different file; S2.8/S2.9 (documentation notes)
  can run in parallel with each other at the end.
- **Cross-slice**: S2 depends on all of S1 (shares `StudioOptions`, `startStudio`
  return shape, and the harness) — no parallelism across the slice boundary.

## Review Workload Forecast

| Slice | Est. lines | Files touched | Review lens |
|---|---|---|---|
| S1 | ~230 | `studio-server.ts`, `test/studio-harness.mjs`, `test/studio-server.mjs`, `package.json` | Standard risk (1 focus lens): new I/O boundary (dedicated pool + transaction), test-only harness code |
| S2 | ~160 | `studio-server.ts`, `index.ts`, `test/studio-server.mjs` | Standard risk (1 focus lens): auth/allowlist logic (Origin/Host), secret redaction |

Total ~330–420 lines against the 800-line review budget; two PRs stacked
(`S1 → main`, `S2 → S1`), each independently under budget. Neither slice alone
crosses into high-risk (canonical 4R) territory per the design's own sizing note;
confirm at actual diff time since redaction/allowlist logic is exactly the kind of
change that review risk classification may bump up if the diff grows past estimate.
