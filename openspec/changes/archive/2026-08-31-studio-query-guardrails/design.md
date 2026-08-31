# Design: Studio Query Guardrails

## Technical Approach

Two independent integers — `queryTimeoutMs` and `queryRowCap` — resolved once at startup by pure
helpers in `packages/cli/src/util.ts` (the `resolveStudioReadOnly` precedent), threaded into
`StudioOptions`, and enforced at exactly two points: a `SET LOCAL statement_timeout` added to the
`db.readOnly` transaction preamble in `createPgDb`, and a cursor-based row cap inside the
`/api/query` handler. `StudioDb`'s contract does not widen. Cancellation is not designed here.

Defaults: `queryTimeoutMs = 30000`, `queryRowCap = 1000`. `0` is the disabled sentinel for both —
chosen because Postgres already spells "no statement timeout" as `statement_timeout = 0`.

## Architecture Decisions

### Decision: row cap via `DECLARE` cursor + `FETCH cap+1`, applied only to cursor-eligible statements

**Choice**: inside the already-open read-only transaction, for a statement classified as a
*query*, run `DECLARE _indigo_query_cursor NO SCROLL CURSOR FOR <sql>` then
`FETCH FORWARD <cap+1> FROM _indigo_query_cursor`. If `cap+1` rows come back, respond with the
first `cap` and `truncated: true`; otherwise all rows and `truncated: false`. The cursor is never
closed explicitly — the transaction is already always `ROLLBACK`ed.

Eligibility is a conservative classifier: after stripping leading whitespace, `--`/`/* */`
comments and `(`, the statement must match `/^(select|with|table|values)\b/i`. Everything else
runs uncapped exactly as today (`truncated: false`).

**Alternatives considered**: (a) subquery wrapping —
`SELECT * FROM (<sql>) _capped LIMIT cap+1`; (b) unconditional `DECLARE` with a `SAVEPOINT` and an
uncapped retry on syntax error; (c) slicing rows client-side after a full fetch.

**Rationale**: `isReadOnlyQuery` deliberately dropped its `^(select|with)` prefix test
(`studio-server.ts:203-216`), so `/api/query` today legitimately admits `EXPLAIN SELECT …`,
`SHOW …`, `TABLE t`, `VALUES (1)`. `DECLARE CURSOR FOR` accepts only a *query*, so an
unconditional cursor would turn `EXPLAIN SELECT 1` — currently working — into a syntax error.
The classifier fixes that, and it is a **capability** test, not a safety boundary: a
misclassification degrades to today's uncapped behavior (still bounded by `statement_timeout`),
never to a rejected valid statement. The spec's "pre-filter is advisory only" requirement is
untouched; `SET TRANSACTION READ ONLY` remains the sole enforcement.
(a) rewrites the user's SQL, which the proposal rules out, and additionally breaks statements the
cursor handles fine (a top-level `ORDER BY` is preserved but no longer guaranteed at the outer
level, and duplicate output column names become fragile). (b) costs a round trip, needs savepoint
bookkeeping, and re-executes a statement that may have side effects through a function call.
(c) does not bound memory, which is half the stated risk.

**Verified, not assumed**: a data-modifying CTE (`WITH x AS (DELETE …) SELECT * FROM x`) is *not*
rejected by `isReadOnlyQuery` — it is rejected by Postgres. On the cursor path it is rejected one
step earlier and with a different SQLSTATE: `0A000` ("DECLARE CURSOR must not contain
data-modifying statements in WITH") instead of `25006` (read-only transaction). Still a 400, still
zero mutation, but the message text changes — this is a deliberate, tested delta to
`studio-readonly-queries`' first scenario.

**Empty results**: `FETCH` returns the cursor's row description even for zero rows, so `columns`
is still populated on an empty result set — no regression, and an explicit test.

### Decision: `SET LOCAL statement_timeout`, issued from a shared exported preamble builder

**Choice**: `SET LOCAL statement_timeout = <ms>` immediately after `SET TRANSACTION READ ONLY`
in `createPgDb.readOnly` (`studio-server.ts:132-145`), emitted by an exported pure
`readOnlyPreamble(timeoutMs: number): string[]`, which `packages/cli/test/studio-harness.mjs`'s
PGlite adapter also uses.

**Alternatives considered**: session-level `SET statement_timeout` on connect; a pool-level
`options: '-c statement_timeout=…'` connection parameter.

**Rationale**: `SET LOCAL` dies with the transaction that is already unconditionally rolled back,
so a pooled connection can never hand the setting — or its absence — to the next borrower. Session
level on a `max: 4` pool leaks state across checkouts. The preamble builder exists because the
integration harness injects its own `StudioDb`: without it the production preamble would have zero
runtime coverage, which is precisely how the previous change in this epic failed verify.
`SET LOCAL` with `0` is a no-op equal to today. Blast radius over `/api/tables/:name` is intended.

### Decision: resolvers are pure and throw; the CLI action prints and exits

**Choice**: in `util.ts`, `resolveQueryTimeoutMs(option, env)` / `resolveQueryRowCap(option, env)`,
both built on `parseGuardrailInt(raw)` returning `number | null` for `/^\d+$/` only (exact match,
no trim, no case folding, no `Infinity`/float/negative). Precedence: flag > env > default. A
present-but-malformed flag or env value **throws** an `Error` naming the offending input and its
flag; `index.ts`'s `studio` action catches, prints, and `process.exit(1)`.

**Alternatives considered**: `process.exit` inside the resolver (the `assertStudioAuthForHost`
shape); silently falling back to the default on a bad value.

**Rationale**: exiting inside the resolver makes it untestable — the exact defect the prior change
was corrected for. Silent fallback makes a typo'd `--query-row-cap=1O0` look enforced when it is
not; a guardrail must fail loud. Resolution happens in the action *after* `loadEnv()`, not as a
commander module-load default, so `.env` values are honoured (the `--read-only` precedent; the
`--host` inconsistency stays as-is).

### Decision: `57014` is translated on both read-only routes

**Choice**: in the existing catch of BOTH `/api/query` and `/api/tables/:name`, if
`(error as {code?: string}).code === "57014"` respond `400 { error: "Query exceeded the
${queryTimeoutMs}ms statement timeout. Raise it with --query-timeout or
INDIGODB_STUDIO_QUERY_TIMEOUT_MS." }`. No SQL, no connection details, no stack.

**Rationale**: the timeout is issued in the shared `readOnlyPreamble`, so it bounds both routes;
a route that can time out but reports it as an opaque failure is worse than one that names the
cause. The normative requirement "statement_timeout is enforced on both read-only routes" in
`specs/studio-query-guardrails/spec.md` requires a 4xx naming the timeout on each.

**Corrected during apply**: this decision originally scoped the mapping to `/api/query` only,
reasoning that the console is where an operator can act on the message and that touching the table
browser's error posture would widen the diff against the proposal's "byte-identical" criterion for
that route. That criterion covers SUCCESS results, not a newly reachable timeout failure, so the
narrower scope contradicted the spec it was meant to implement. The spec governs.

### Decision: probe fields are additive; the console discloses both

**Choice**: `GET /api/auth/status` → `{ authRequired, authenticated, readOnly, queryTimeoutMs,
queryRowCap }`, straight from the startup constants, independent of `auth`. `AuthStatus` and
`useAuthStore` widen; `QueryEnginePage` shows a persistent "max N rows / Ns timeout" hint and, when
`truncated`, a banner above `ResultsTable`. Both values are operational limits, not secrets — the
probe already publishes `authRequired` and `readOnly` pre-auth.

## Data Flow

    --query-timeout / --query-row-cap / INDIGODB_STUDIO_QUERY_* ──→ index.ts action (post loadEnv)
                                        │ resolveQueryTimeoutMs / resolveQueryRowCap (util.ts, pure)
                                        ▼
                      startStudio({ queryTimeoutMs, queryRowCap })
                          │                        │                         │
                          ▼                        ▼                         ▼
        createPgDb.readOnly preamble        POST /api/query          GET /api/auth/status
        BEGIN; READ ONLY;                   classify → DECLARE          { …, queryTimeoutMs,
        SET LOCAL statement_timeout          FETCH cap+1 → slice          queryRowCap }
              │ (also /api/tables/:name)     { columns, rows, truncated }        │
              └── 57014 ──→ 400 "exceeded …"                                     ▼
                                                                 api.ts → useAuthStore → console hint

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/cli/src/util.ts` | Modify | Exported `parseGuardrailInt`, `resolveQueryTimeoutMs`, `resolveQueryRowCap` |
| `packages/cli/src/studio-server.ts` | Modify | `queryTimeoutMs`/`queryRowCap` on `StudioOptions`; exported `readOnlyPreamble`; `createPgDb` takes the timeout; `isCursorEligible`; `/api/query` cursor path + `truncated` + `57014` mapping; status payload; startup log |
| `packages/cli/src/index.ts` | Modify | `--query-timeout` / `--query-row-cap` options, resolved after `loadEnv()`, threaded into `startStudio`; catch resolver errors → exit 1 |
| `packages/cli/test/studio-harness.mjs` | Modify | PGlite adapter uses `readOnlyPreamble`; `withStudio` already spreads options |
| `packages/cli/test/studio-query-guardrails.mjs` | Create | Integration suite |
| `packages/cli/test/studio-query-resolution.mjs` | Create | Unit suite for the resolvers, preamble and classifier |
| `packages/cli/package.json` | Modify | Append both suites to the `test` chain |
| `apps/studio/src/lib/api.ts` | Modify | `AuthStatus` gains both fields; `QueryResult` gains `truncated?: boolean` |
| `apps/studio/src/store/useAuthStore.ts` | Modify | Hold `queryTimeoutMs`/`queryRowCap` from the probe |
| `apps/studio/src/features/studio/query/QueryEnginePage.tsx` | Modify | Cap/timeout hint + truncation banner |
| `apps/studio/src/i18n/locales/{en,es}.json` | Modify | Hint, banner and timeout copy |
| `openspec/specs/studio-readonly-queries/spec.md` | Modify (delta) | Preamble gains `SET LOCAL statement_timeout`; CTE scenario's SQLSTATE/message note |

## Interfaces / Contracts

```ts
// studio-server.ts
export interface StudioOptions { /* … */ queryTimeoutMs?: number; queryRowCap?: number }
export function readOnlyPreamble(timeoutMs: number): string[];   // [] entries run in order
export function isCursorEligible(sql: string): boolean;          // capability test, not a guard

// util.ts — throw on a present-but-malformed value; never process.exit
export function parseGuardrailInt(raw: string | undefined): number | null;
export function resolveQueryTimeoutMs(option: string | undefined, env: string | undefined): number;
export function resolveQueryRowCap(option: string | undefined, env: string | undefined): number;

// POST /api/query (200)
{ columns: string[], rows: unknown[], truncated: boolean }
// POST /api/query (400, timeout)
{ error: "Query exceeded the 30000ms statement timeout. Raise it with --query-timeout or INDIGODB_STUDIO_QUERY_TIMEOUT_MS." }
// GET /api/auth/status (200)
{ authRequired: boolean, authenticated: boolean, readOnly: boolean, queryTimeoutMs: number, queryRowCap: number }
```

`cap` is interpolated into `FETCH FORWARD <n>` from a resolver-validated integer that never
originates in a request — client input reaches the SQL text only as the user's own statement,
exactly as today.

## Testing Strategy

Every row below is a covering runtime test; each maps to at least one spec scenario and must
produce a RED task.

| Layer | What to test | Approach |
|-------|--------------|----------|
| Unit | Flag > env > default precedence for both resolvers | `studio-query-resolution.mjs` |
| Unit | Defaults applied when flag and env are both absent (30000 / 1000) | same |
| Unit | `0` accepted as the disabled sentinel for both | same |
| Unit | Malformed values (`"abc"`, `"-1"`, `"1.5"`, `" 100 "`, `""`, `"1e3"`, `"Infinity"`) throw naming the flag | same — exact-match, no coercion, no silent default |
| Unit | `readOnlyPreamble(30000)` → `["SET TRANSACTION READ ONLY", "SET LOCAL statement_timeout = 30000"]`; `readOnlyPreamble(0)` still emits the `0` form | same |
| Unit | `isCursorEligible`: true for `select`/`with`/`table`/`values`, leading comments, leading `(`, mixed case; false for `EXPLAIN`, `SHOW` | same |
| Integration | Cap enforced: a table with `cap+5` rows returns exactly `cap` rows and `truncated: true` | `withStudio(…, { queryRowCap: 5 })` |
| Integration | Under the cap: exact-`cap` and below return every row with `truncated: false` (off-by-one boundary) | same server |
| Integration | Empty result set: `columns` still populated, `rows: []`, `truncated: false` | same |
| Integration | `queryRowCap: 0` disables the cursor path — response is byte-identical to today plus `truncated: false` | `withStudio(…, { queryRowCap: 0 })` |
| Integration | Cursor-ineligible statements still work: `EXPLAIN SELECT 1`, `SHOW server_version`, `TABLE "User"`, `VALUES (1)` → 200 | default options |
| Integration | `WITH x AS (DELETE FROM "User" RETURNING *) SELECT * FROM x` → 400, no row mutated (SQLSTATE may be `0A000` or `25006`; assert refusal + zero mutation, never the exact text) | default options |
| Integration | Multi-statement/empty input still rejected by the pre-filter before any connection | unchanged behavior regression check |
| Integration | `/api/tables/:name` results, `ALLOWED_LIMITS` validation and pagination are unchanged with guardrails on | control assertions |
| Integration | Write routes take no timeout and no cap; `db.writable` preamble unchanged | control assertions |
| Integration | Probe reports both values; values echo what `startStudio` received | `withStudio(…, { queryTimeoutMs: 1234, queryRowCap: 7 })` |
| Integration | `57014` → 400 with the exact guidance message, no SQL echoed | inject a `StudioDb` double whose `readOnly` rejects with `{ code: "57014" }` — deterministic, since PGlite cannot be relied on to interrupt on `statement_timeout` |
| Component | Console shows the cap/timeout hint from the store and a truncation banner only when `truncated` | `apps/studio` vitest, existing `__tests__` pattern |
| Component | `useAuthStore` holds both probe values; standalone (no backend) falls back without throwing | `useAuthStore.test.ts` |

## Threat Matrix

Routing changes; no shell, subprocess, VCS/PR automation, or executable-file classification exists
on this path.

| Boundary | Applicability |
|---|---|
| Documentation-like paths | N/A — no file classification |
| Git repository selection / commit / push / PR commands | N/A — no VCS invocation |
| SQL text interpolation | **Applicable** — `FETCH FORWARD <n>` interpolates a resolver-validated integer only; covered by the resolver unit rows above |
| Prefix/capability bypass | **Applicable** — `isCursorEligible` is fail-open to today's uncapped-but-timeout-bounded behavior and is never a safety boundary; covered by the ineligible-statement and CTE rows |

## Migration / Rollout

No migration. Defaults are on; `--query-timeout 0 --query-row-cap 0` restores today's behavior on
every path exactly. Rollback is revert.

## Open Questions

- [ ] Confirm during apply that PGlite accepts `SET LOCAL statement_timeout` without error even
      though it may not interrupt — if it rejects the statement, the harness needs a `0` timeout
      and the preamble stays covered by its unit test alone.
