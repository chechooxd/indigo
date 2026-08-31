# Proposal: Studio Query Guardrails

## Context

Change **3 of 5** splitting the roadmap epic "Auth and production guardrails" (Road to 1.0, Phase 5).
`studio-session-auth` and `studio-readonly-mode` shipped and are archived. Siblings still unstarted:
`studio-environment-badge`, `studio-audit-log`. This change is independent of all four.

## Intent

`/api/query` is safe (single read-only SELECT/WITH, `isReadOnlyQuery` prefilter plus a real
`SET TRANSACTION READ ONLY` inside `db.readOnly`) but **unbounded**: no `SET statement_timeout`
exists anywhere in `studio-server.ts`, and the ad-hoc SELECT has no row cap. Studio is a single
`node:http` process with a `max: 4` read-only pool, so one unqualified join is an availability
incident — four of them wedge the console — and one `SELECT * FROM` a large table buffers every
row into the process before serializing. Safety today means "cannot mutate", not "cannot hurt".

## Scope

### In Scope
- `StudioOptions.queryTimeoutMs` and `queryRowCap`, resolved **once at startup** via pure helpers in
  `packages/cli/src/util.ts` (unit-testable, per the last change's lesson), with sane defaults on.
- CLI `--query-timeout` / `--query-row-cap` with `INDIGODB_STUDIO_QUERY_TIMEOUT_MS` /
  `INDIGODB_STUDIO_QUERY_ROW_CAP` as commander defaults, following the `--read-only` convention.
- `SET LOCAL statement_timeout` issued inside `db.readOnly`, alongside the existing
  `SET TRANSACTION READ ONLY` — one point, covering **both** read routes.
- A row cap on `/api/query` only, with an explicit `truncated: true` in the response.
- Both values echoed on `GET /api/auth/status`; timeout/cap surfaced in the SQL console UI.

### Out of Scope
- **Query cancellation** — deferred to its own change (see Approach). Explicitly not built here.
- `/api/tables/:name` row limits — already capped by `ALLOWED_LIMITS` + keyset pagination; untouched.
- The write routes and `db.writable` — no timeout, no cap, no change.
- Auth, read-only mode, environment badge, audit log: untouched, including their status-probe fields.
- Per-user or per-query overrides; a runtime route to change either value.

## Capabilities

### New Capabilities
- `studio-query-guardrails`: startup resolution of timeout/cap, `statement_timeout` enforcement, the
  `/api/query` row cap and truncation signal, status-probe fields, console UI disclosure.

### Modified Capabilities
- `studio-readonly-queries`: the `db.readOnly` transaction seam gains `SET LOCAL statement_timeout`;
  `/api/query`'s response shape gains `truncated`.
- `studio-session-auth`: the exempt status probe widens again to carry the two guardrail values.

## Approach

Two independent numbers threaded start-to-finish, mirroring `readOnly`.

**Seam note:** this extends `db.readOnly` (the `StudioDb` port), and does so **without widening its
contract** — the timeout is issued by `createPgDb` inside the transaction preamble, so no route,
no test double, and no caller signature changes. `SET LOCAL` scopes it to the transaction that is
already rolled back.

**Row cap:** rewriting user SQL to append `LIMIT` is unsafe. Preferred: `DECLARE` a cursor for the
submitted statement and `FETCH cap+1` inside the transaction already open — no SQL rewriting, and
the extra row is what proves truncation. Subquery-wrapping is the rejected alternative; design
picks finally.

**Cancellation is deliberately deferred.** `statement_timeout` and the row cap close the entire
availability and memory risk; cancellation adds only latency-to-recovery for an operator who
already knows the query is doomed. It is also the one genuinely unsettled piece — it needs backend
PID capture, a request-identity lifetime, a second connection issuing `pg_cancel_backend`, and a
new authenticated route — which is a design spike, not a task. Folding a spike into a settled slice
is exactly the scope creep this repo's config flags as its most common review defect. It should be
proposed as `studio-query-cancellation` once these bounds exist.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/cli/src/util.ts` | New | Pure `resolveQueryTimeoutMs` / `resolveQueryRowCap` resolvers |
| `packages/cli/src/studio-server.ts` | Modified | Options, `SET LOCAL statement_timeout` in `createPgDb`, `/api/query` cap, status fields, startup log |
| `packages/cli/src/index.ts` | Modified | Two CLI options threaded into `startStudio` |
| `apps/studio/src/lib/api.ts`, `useAuthStore.ts` | Modified | Widen `AuthStatus`, hold both values |
| `apps/studio` SQL console | Modified | Show the cap, mark truncated results, explain a timeout error |
| `/api/tables/:name`, write routes | Untouched | Already capped / out of scope |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Timeout on `db.readOnly` also bounds the table browser | High (intended) | Deliberate; default generous enough that normal pagination never trips it, and called out in design |
| Truncated result read as a complete one | Med | Explicit `truncated` flag plus a visible console banner, not a silent short list |
| Cursor `DECLARE` rejects some valid SELECT/WITH input | Med | Design spike on the two options; fall back to subquery-wrapping if a real case fails |
| Defaults too aggressive for a legitimate slow analytical query | Med | Both are operator-overridable; a timeout error names the flag to raise |
| Operators read "guardrails" as including cancellation | Low | Non-goal stated here, in the startup log's absence, and in the follow-up change name |

## Rollback Plan

Revert the change commits. Short of revert, setting both values to their "disabled" sentinel
restores today's behavior exactly on every path.

## Dependencies

None. No new packages; both prior siblings already shipped and are not touched.

## Success Criteria

- [ ] Defaults on: a normal SELECT and normal table-browser pagination behave exactly as today.
- [ ] A query exceeding the timeout returns a 4xx naming the timeout; the server stays responsive
      and the read-only pool is not left holding a connection.
- [ ] A SELECT returning more rows than the cap responds `truncated: true` with exactly `cap` rows.
- [ ] `/api/tables/:name` results and its `ALLOWED_LIMITS` behavior are byte-identical to today.
- [ ] Write routes are unaffected: no `statement_timeout`, no cap, unchanged responses.
- [ ] `GET /api/auth/status` reports both values; the console reflects them without a reload.
- [ ] No cancellation route, cancel button, or `pg_cancel_backend` call exists in the diff.

## Proposal question round (execution_mode: auto — assumptions recorded, not asked)

1. **Cancellation**: assumed OUT of scope, deferred to `studio-query-cancellation`. The single most
   consequential decision here and the easiest to reverse by re-proposing.
2. **Timeout blast radius**: assumed the timeout lives on the shared `db.readOnly` seam and therefore
   also bounds `/api/tables/:name`. The alternative — `/api/query` only — leaves a slow `count(*)`
   on a huge table able to wedge the process, which is the same defect.
3. **Row cap scope**: assumed `/api/query` only; the table browser's existing cap is authoritative
   and untouched.
4. **Defaults**: assumed both guardrails default ON with generous values, not off — a guardrail
   nobody enables is not a guardrail. Exact numbers are a design decision.
5. **Truncation semantics**: assumed truncation is a successful 200 with a flag, not an error.
