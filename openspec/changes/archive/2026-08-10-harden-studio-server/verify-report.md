# Verify Report: harden-studio-server

Date: 2026-08-10
Branch: `security/studio-server-bind-and-redaction` @ `10d95fe` (stacked on `security/studio-server-readonly-enforcement` @ `383dedb`, on `main` @ `e69fad8`). Nothing pushed, no PR — intentional.

## Verdict

CRITICAL: 0 · WARNING: 2 · SUGGESTION: 3

No implementation defects found. Both stacked slices (18/18 tasks) are genuinely
implemented and match the spec. Two real test-coverage gaps found (WARNING) where
the spec/tasks explicitly call for a scenario that has zero automated coverage,
even though the underlying behavior is correct today (verified manually). Three
low-severity SUGGESTIONs (doc drift, an out-of-scope residual risk, one thin test
case).

## Gates — fresh run, this session (not cached)

### `pnpm turbo run build --force`
```
Tasks:    10 successful, 10 total
Cached:    0 cached, 10 total
Time:    16.792s
```
All packages including `@indigodb/cli` and `@indigodb/studio` (vite) built clean.

### `pnpm turbo run lint --force`
```
Tasks:    18 successful, 18 total
Cached:    0 cached, 18 total
Time:    17.282s
```
`@indigodb/cli:lint` (`tsc --noEmit`) clean, no errors.

### `pnpm turbo run test --force`
```
Tasks:    14 successful, 14 total
Cached:    0 cached, 14 total
Time:    1m28.45s
```
`@indigodb/cli:test` (12 cases, PGlite-backed, real HTTP): all `ok`. Ran directly
(`node test/studio-server.mjs`) for full visibility — all 12 named cases green:
CTE-DELETE rejected + no row deleted; `/api/tables/:name` aliasing; plain SELECT
succeeds; multi-statement pre-filter; default loopback bind; explicit-host
threaded through; `/api/schema` omits datasource; `/api/schema/source` omits
datasource + credential; `redactSource` unit test (brace-depth scan, direct
import — confirmed NOT routed through HTTP, see below); mismatched Origin → 403;
no-Origin → 200; matching Origin → 200. `@indigodb/migrator:test` (54 cases) also
green, unaffected by this change.

### `cd crates && cargo test`
```
running 4 tests ... test result: ok. 4 passed
running 19 tests ... test result: ok. 19 passed
Doc-tests: 0 passed
```
Untouched by this change (scope check below) — green as expected.

## Scope discipline

`git diff --stat e69fad8 10d95fe`: only `openspec/changes/harden-studio-server/**`,
`packages/cli/{package.json,src/index.ts,src/studio-server.ts,test/studio-harness.mjs,test/studio-server.mjs}`,
and `pnpm-lock.yaml`. Nothing under `packages/core`, `packages/client`,
`packages/migrator`, `crates/`, `apps/studio`. Clean.

## Requirement traceability

| Spec / Requirement | Implemented | Tested | Status |
|---|---|---|---|
| `studio-server-security` / Loopback bind by default | `isLoopbackHost`, `host` option defaults `127.0.0.1`, threaded into `listen(port, host)` | `default bind ... loopback address`, `explicit host option is threaded through` | PASS — but the scenario's "startup output includes a risk message" clause has **no assertion** on stdout; message is only eyeballed in this report's manual run. WARNING-1. |
| `studio-server-security` / Datasource redaction, `/api/schema` | `redactSchema` (shallow copy minus `datasource` key) | Tested against a **literal**-URL fixture only | PASS functionally (deletion is content-agnostic) but the spec's explicit "AND this holds identically when the schema instead uses `env()`" sub-clause has no dedicated `/api/schema` case (only `/api/schema/source` and the standalone `redactSource` unit test use `env()`). SUGGESTION-3. |
| `studio-server-security` / Datasource redaction, `/api/schema/source` | `redactSource` brace-depth scan | literal-URL fixture + standalone `env()` unit test, both green | PASS |
| `studio-server-security` / Origin/Host validation | `validateHeaders` checks `Host` on every request, `Origin` when present | **Only `Origin` mismatch is tested** (3 cases: mismatched/absent/matching). **Zero automated coverage of a mismatched `Host` header**, despite the spec scenario explicitly listing `Host` alongside `Origin`, and task S2.6 explicitly requiring it ("assert `Host` is checked on every request including static assets"). | WARNING-2 (see manual repro below — behavior is correct, coverage is not). |
| `studio-readonly-queries` / Transaction-level enforcement (`/api/query`) | `db.readOnly` wraps `BEGIN; SET TRANSACTION READ ONLY; ...; ROLLBACK` on a dedicated pool | CTE-DELETE regression test | PASS |
| `studio-readonly-queries` / Transaction-level enforcement (`/api/tables/:name`) | Same `db.readOnly` call, confirmed by direct code read — not a separate/overlooked path | Aliasing test exercises the success path through this route; no write-vector test needed since the route has no user-controlled SQL beyond a table-name lookup against `resolved.tables` | PASS |
| `studio-readonly-queries` / Fast-path pre-filter advisory only | `isReadOnlyQuery` — non-empty, no interior `;` | multi-statement test; manually verified empty string and bare `;` both → 400 | PASS |
| `studio-readonly-queries` / Column aliasing preserved | `SELECT "col" AS "field"` list built from `table.columns` | Aliasing test | PASS |
| `studio-server-tests` / Real server + real Postgres | PGlite in-process engine, real `startStudio`, real `fetch()` | N/A (this is the harness itself) | PASS |
| `studio-server-tests` / Coverage of all 4 blockers | — | Bind, redaction, CTE-DELETE, cross-origin(Origin only) | PASS per this spec's own narrower wording (only mentions `Origin`, not `Host`) — but see WARNING-2 against the sibling `studio-server-security` spec, which does mention `Host`. |
| `studio-server-tests` / Wired into `pnpm test` | `packages/cli/package.json` `test` script | Confirmed via fresh `pnpm turbo run test --force` | PASS |

## Tasks — 18/18, checked against code (not just checkboxes)

All 18 tasks in `tasks.md` are marked `[x]` and each maps to real code:
- S1.1–S1.8 (seam, harness, dedicated read-only pool, pre-filter trim, return-type,
  full-suite green) — all present in `studio-server.ts` / `studio-harness.mjs` /
  `package.json`, confirmed by direct read.
- S2.1–S2.10 (bind, `--host` flag, redaction x2, Origin/Host validation, doc notes,
  full-suite green) — all present, confirmed by direct read of `studio-server.ts`
  lines 216–275 (validateHeaders/isLoopbackHost), 161–214 (redactSchema/redactSource),
  283–427 (startStudio host threading + warning), and `index.ts` lines 197–223
  (`--host` flag + help text documenting the relaxation).
- One documentation-only drift, not a code defect: task S2.6 and `design.md` both
  describe the rejection body as `{"error":"Forbidden origin"}`; the shipped code
  returns `{"error":"Host not allowed"}` / `{"error":"Origin not allowed"}`. No
  spec scenario or test asserts the exact string (only presence/non-emptiness), so
  this doesn't fail anything — SUGGESTION-1.

## Adversarial checks performed beyond the orchestrator's two manual repros

All run against a real `startStudio` HTTP server (PGlite-backed, via the existing
harness) this session, not reused from the apply report.

1. **Mismatched `Host` header (not just `Origin`).** `fetch()` cannot override
   `Host` (forbidden header per the Fetch spec — the browser/undici silently drops
   it), so a `fetch`-based probe gives a false negative. Repeated with raw
   `node:http` `request()`:
   - `Host: evil.example.com:9999` → **403 `{"error":"Host not allowed"}`** — correct.
   - `Host: 127.0.0.1:<actual port>` → 200 — correct.
   Conclusion: the implementation is correct; the gap is purely in automated test
   coverage (WARNING-2 above).
2. **Origin that matches by port-string prefix but not exactly**
   (`http://127.0.0.1:<port+1>` against a server on `<port>`) → 403. `URL().host`
   parsing plus exact `Set` membership (not `startsWith`) means no prefix-collision
   risk. Correct.
3. **Function call with a side effect inside the read-only transaction**:
   `SELECT pg_terminate_backend(pg_backend_pid())` → **200**, executes normally
   (returned `false` under PGlite's own backend semantics). `SET TRANSACTION READ
   ONLY` in Postgres blocks writes to data/catalogs, not arbitrary function calls —
   this is inherent Postgres behavior, not a defect in this change, and no spec
   requirement in this change claims to cover it. Flagged as SUGGESTION-2 (residual
   risk for a future hardening pass, e.g. an allowlist of permitted top-level
   functions), not a defect against `harden-studio-server`'s stated scope.
4. **Empty query string** (`{"sql": ""}`) → 400, rejected by `isReadOnlyQuery`
   before any connection. Correct.
5. **Bare `;`** (`{"sql": ";"}`) → 400 (trims to empty after stripping trailing
   semicolons, then hits the empty-string branch). Correct.
6. **Schema with no `datasource` block at all** → `redactSource` does not crash,
   content passes through unchanged. Correct (no defensive gap).
7. **`generator { ... }` block with a plausible-looking secret field** — confirmed
   it is *not* swept into redaction; only `/^\s*datasource\b/`-prefixed blocks are
   scanned. Correct per spec (redaction is explicitly scoped to `datasource`).
8. **Two `datasource`-like blocks in one source** (not valid `.indigo`, but tested
   defensively) — both credentials redacted, scanner correctly re-arms after the
   first block closes (`inBlock` resets to `false` at `depth <= 0`). No leak.
9. **`redactSource` unit-test authenticity confirmed**: `studio-server.mjs` line 17
   imports `redactSource` directly from `../dist/studio-server.js` and calls it
   with a raw multi-line/nested fixture with no HTTP server involved (case at line
   248, "unit test, brace-depth scan)" in its own name) — the apply report's claim
   holds up.
10. **Dedicated read-only pool is genuinely separate from the main pool**:
    confirmed by direct code read (`studio-server.ts` lines 74–105) — `pool` and
    `readOnlyPool` are two distinct `new pg.Pool(...)` instances (`readOnlyPool`
    capped `max: 4`), and `close()` ends both independently. A shared pool would
    have been one `pg.Pool` reused for both `query` and `readOnly`; that is not
    what's here.
11. **Non-loopback Host-validation relaxation documented at both required sites**:
    the check site itself (`studio-server.ts` lines 222–237, a full doc comment
    above `validateHeaders` explaining the port-only relaxation and why), AND the
    CLI's `--host` help text (`index.ts` lines 202–209, "relaxes Host-header
    validation to a port-only match... Only do this on a trusted network"). Both
    present, matches task S2.8's requirement.

## WARNING detail

**WARNING-1 — startup risk-warning message untested.** `studio-server-security`'s
"Explicit opt-in allows remote bind" scenario requires "startup console output
includes a message naming the risk." The message exists and is correct (`⚠
Binding to 0.0.0.0: ...`, verified in this session's fresh test run output), but
no test captures/asserts stdout for it. A future refactor could silently drop the
warning and nothing in `pnpm test` would catch it.

**WARNING-2 — mismatched-Host-header rejection has no automated test.** Confirmed
correct behavior manually (adversarial check #1), but `studio-server.mjs` only
exercises the `Origin` header (3 cases); there is no case sending a mismatched
`Host` header, despite: (a) the `studio-server-security` spec scenario explicitly
listing `Host` alongside `Origin`; (b) task S2.6 explicitly calling for "assert
`Host` is checked on every request including static assets." A regression in the
`Host` branch of `validateHeaders` would not be caught by `pnpm test` today.

## SUGGESTION detail

**SUGGESTION-1** — `design.md` and `tasks.md` (S2.6) describe the 403 body as
`{"error":"Forbidden origin"}`; shipped code returns `{"error":"Host not
allowed"}` / `{"error":"Origin not allowed"}`. No functional impact (nothing
asserts the exact string), but the artifacts drifted from the implementation —
worth a one-line fixup if these docs are reused later.

**SUGGESTION-2** — `SET TRANSACTION READ ONLY` does not block side-effecting
administrative function calls (e.g. `pg_terminate_backend`, `pg_reload_conf`,
`dblink`, `lo_export`) reachable via `/api/query`. This is inherent Postgres
semantics, out of this change's stated scope (which is specifically the
CTE-DELETE-style data-write bypass), and no spec requirement here claims to
cover it — but it's a real residual attack surface on the SQL console worth a
future dedicated hardening item (e.g. a function-name allowlist/denylist).

**SUGGESTION-3** — `/api/schema`'s redaction is tested only against a
literal-URL fixture; the spec's "holds identically... when the schema instead
uses `env()`" sub-clause is exercised for `/api/schema/source` (and the
standalone `redactSource` unit test) but not for `/api/schema` itself. Low risk
since `redactSchema` deletes the whole `datasource` key regardless of its
contents, so the literal-vs-`env()` distinction is a non-issue for that code
path — but the letter of the spec scenario isn't independently covered there.

## Known accepted limitations (not re-litigated)

- Non-loopback reachability cannot be tested deterministically in CI; only bind
  address is asserted, not real cross-host `fetch()`.
- `apps/studio` frontend simulations are out of scope (future change).
- Datasource redaction is safe only because no schema-write-back endpoint exists
  yet — documented forward constraint in `studio-server.ts` (lines 176–180).

## Recommendation

Not CRITICAL-blocked. Both WARNINGs are test-coverage gaps behind already-correct
behavior (manually verified this session), not functional defects — reasonable to
either (a) archive as-is and file the two WARNINGs as fast-follow test additions,
or (b) send back to `sdd-apply` for two small test cases (mismatched-Host-header
403 test, startup-warning-stdout assertion) before archive, per team preference.
This report doesn't decide that trade-off.
