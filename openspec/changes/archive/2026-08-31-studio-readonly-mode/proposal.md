# Proposal: Studio Read-Only Mode

## Context

Change **2 of 5** splitting the roadmap epic "Auth and production guardrails" (Road to 1.0, Phase 5).
`studio-session-auth` shipped and is archived. Siblings still unstarted: `studio-query-guardrails`,
`studio-environment-badge`, `studio-audit-log`.

## Intent

Studio has no enforced read-only mode. The only write restraint is the client-side "Safe Updates"
toggle, which gates DELETE only, in one browser tab, and is bypassed by any `curl` to
`POST/PATCH/DELETE /api/rows/:table`. An operator pointing Studio at a shared, staging, or production
database has no way to say "inspect, never mutate" — auth answers *who*, not *what they may do*.

## Scope

### In Scope
- `StudioOptions.readOnly?: boolean`, resolved **once at startup** (mirroring `auth`), default off.
- CLI `--read-only` with `INDIGODB_STUDIO_READONLY=1|true` as its commander default, following the
  `--host`/`INDIGODB_STUDIO_HOST` convention (not the password's env-only pattern — this is not a secret).
- **A single gate check on the shared `/api/rows/` prefix**, placed after the auth gate and before
  write-route dispatch; returns `403 {error}` and never reaches `resolveWriteTarget` or `db.writable`.
- `readOnly: boolean` added to the already-shipped `GET /api/auth/status` response.
- Persistent "this instance is read-only" banner in Studio, driven by that same probe through the
  existing `useAuthStore` status wiring.

### Out of Scope
- **Disabling or hiding individual write affordances** (Add Record, Save Changes, Delete) one by one —
  banner plus a clear 403 on attempt, matching `real-row-crud`'s visible-state precedent.
- Any environment heuristic auto-enabling read-only (hostname, `DATABASE_URL` sniffing). Explicit
  operator opt-in only, per `studio-environment-badge`'s "soft hint, never authoritative" precedent.
- The client-side Safe Updates toggle — untouched; complementary, not superseded.
- Per-user/per-table read-only, `/api/query` guardrails, environment badge, audit log.

## Capabilities

### New Capabilities
- `studio-readonly-mode`: opt-in flag/env resolution, single-point 403 write gate, status-probe field,
  UI banner.

### Modified Capabilities
- `studio-session-auth`: the exempt `GET /api/auth/status` probe widens from auth-only to general
  server posture by carrying `readOnly`.

## Approach

One boolean threaded start-to-finish. Read-only and auth are **fully orthogonal** — all four on/off
combinations are valid and need zero interaction logic. Auth (401) runs first so an unauthenticated
caller cannot learn whether read-only is active.

**Load-bearing detail:** the gate is **one** check on the `/api/rows/` prefix, *not* three copies
inside the POST/PATCH/DELETE branches. Duplicating it means a future fourth write route silently
bypasses read-only mode. Gating inside `resolveWriteTarget` or `db.writable` is the wrong layer:
identity validation and the transaction port, respectively, and both open a connection before refusing.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/cli/src/studio-server.ts` | Modified | `readOnly` option, startup resolution, prefix gate, status field, startup log line |
| `packages/cli/src/index.ts` | Modified | `--read-only` option, threaded into `startStudio` |
| `apps/studio/src/lib/api.ts` | Modified | Widen `AuthStatus` with `readOnly` |
| `apps/studio/src/store/useAuthStore.ts` | Modified | Hold `readOnly` from the same probe |
| `apps/studio/src` (app shell) | New | Read-only banner |
| `useSettingsStore.ts`, `QueryGuardsCard.tsx` | Untouched | Safe Updates stays as-is |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Future write route bypasses the gate | Med | Single prefix check + a test asserting all `/api/rows/` methods are refused |
| `/api/auth/status` now reports non-auth posture (naming smell) | Med | Deliberate widening, called out in design; additive JSON, non-breaking |
| Banner-only UI reads as "buttons work, then fail" | Low | Accepted tradeoff; 403 message is explicit and actionable |
| Operators expect read-only to auto-engage in production | Low | Startup line states the mode explicitly; documented as opt-in |

## Rollback Plan

Revert the change commits. Short of revert, unsetting `INDIGODB_STUDIO_READONLY` and dropping
`--read-only` restores today's behavior exactly — unset is a structural no-op on every path.

## Dependencies

None. No new packages; `studio-session-auth` already shipped.

## Success Criteria

- [ ] Default (no flag, no env): every write route behaves exactly as today.
- [ ] `--read-only` or `INDIGODB_STUDIO_READONLY=1`: `POST/PATCH/DELETE /api/rows/:table` all return 403,
      via `curl` as well as the UI.
- [ ] Read paths (`/api/schema`, `/api/tables/:name`, `/api/query`) are unaffected in read-only mode.
- [ ] With auth on and no session, a write returns **401**, not 403 — auth precedence preserved.
- [ ] `GET /api/auth/status` reports `readOnly`; Studio shows the banner whenever it is true.
- [ ] All four auth x read-only combinations start and behave as described.

## Proposal question round (execution_mode: auto — assumptions recorded, not asked)

1. Granularity: assumed **global** read-only, not per-table or per-user. Per-table is a later refinement.
2. Failure UX: assumed banner + 403-on-attempt is sufficient; individually disabling write controls is an
   explicit non-goal for this slice. This is the most reversible-if-wrong decision here.
3. Env var truthiness: assumed only `1` and `true` enable it; any other value is off (no fuzzy parsing).
4. Runtime toggling: assumed startup-only resolution — no route to flip the mode on a running server.
5. Audit: assumed a refused write emits no audit record here; that is `studio-audit-log`'s call.
