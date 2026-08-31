# Design: Studio Read-Only Mode

## Technical Approach

One boolean, `StudioOptions.readOnly`, resolved once at startup exactly like `auth`, enforced by a
single prefix gate in `startStudio`'s request handler, echoed on the existing ungated
`GET /api/auth/status` probe, and surfaced by one non-dismissible banner in the Studio shell.
No new module, no new fetch, no runtime toggle.

## Architecture Decisions

### Decision: One method-agnostic gate on the `/api/rows/` prefix

**Choice**: a single block placed **between** the existing session-auth gate (`studio-server.ts:614-625`)
and the routing `try` (line 627), refusing every request whose path starts with `/api/rows/`,
regardless of method.

```ts
// existing auth gate ends at line 625 — unchanged
if (readOnly && path.startsWith("/api/rows/")) {
  sendJson(res, 403, { error: "Studio is running in read-only mode" });
  return;
}
try { /* existing routes, untouched */ }
```

**Alternatives**: (a) one check inside each of the POST/PATCH/DELETE branches (lines 788-801);
(b) a method allowlist (`req.method !== "GET"`); (c) refusing inside `resolveWriteTarget` or `db.writable`.
**Rationale**: (a) lets a future fourth write verb silently bypass the mode. (b) leaves a hole the day
someone adds `GET /api/rows/`; `/api/rows/` is exclusively the write namespace — reads are served by
`/api/tables/:name` and `/api/query`, so blanket refusal is both correct and the strongest invariant.
(c) opens a pool connection before refusing and lives in the wrong layer (identity validation and the
transaction port). This composes additively with `studio-session-auth`: zero lines of the auth gate change.

### Decision: auth gate strictly before the read-only gate

**Choice**: the 401 gate keeps its current position; the read-only gate goes after it.
**Alternatives**: read-only first (cheaper — no HMAC on a doomed write).
**Rationale**: ordering is load-bearing, not incidental. Read-only-first would make an unauthenticated
write answer 403 while an unauthenticated *read* answers 401, turning the write route into an oracle for
server posture and inverting the layering (authorization decided before authentication). With auth on and
no valid session, every `/api/*` route answers 401 uniformly. The status probe deliberately discloses
`readOnly` publicly (below); the ordering rule is about never letting the *enforcement* path disagree
with the *disclosure* path.

### Decision: `--read-only` resolved after `loadEnv()`, not as a commander module-load default

**Choice**: `.option("--read-only", "…")` with no default; inside the action, after `loadEnv()`:
`const readOnly = options.readOnly === true || isReadOnlyEnv(process.env.INDIGODB_STUDIO_READONLY)`,
where `isReadOnlyEnv(v) => v === "1" || v === "true"` (exact match, no trim, no case folding).
**Alternatives**: mirror `--host` literally — `process.env.INDIGODB_STUDIO_READONLY` as the option
default (`index.ts:297`).
**Rationale**: observably identical flag+env-default semantics, but `--host`'s default is evaluated at
module load, *before* `loadEnv()` runs at `index.ts:301`, so a `.env` value never reaches it. For a bind
address that fails loudly; for a guardrail it fails **open and silently**. Resolving in the action matches
how `password` already reads its env var (line 302) and keeps `.env` working. Note the divergence in a
comment so the `--host` inconsistency stays visible.

### Decision: `readOnly` is an additive field on the existing probe

**Choice**: `sendJson(res, 200, { authRequired, authenticated, readOnly })` at line 632, populated from
the startup constant, wholly independent of `auth`.
**Rationale**: purely additive — existing consumers destructure `authRequired`/`authenticated`; JSON key
order is inconsequential to both `JSON.parse` and the typed `AuthStatus` interface. No collision: the
route currently emits only those two keys. Public disclosure is accepted: read-only is the *absence* of a
capability, and the probe already publishes `authRequired`.

**Naming note**: `StudioOptions.readOnly` (boolean) sits alongside the unrelated `StudioDb.readOnly()`
(transaction helper, `studio-server.ts:90`). Different types, different objects; call it out in the
option's doc comment.

## Data Flow

    --read-only / INDIGODB_STUDIO_READONLY ──→ index.ts action (post loadEnv)
                                                     │ readOnly: boolean
                                                     ▼
                                       startStudio (resolved once at startup)
                                          │                        │
                     ┌────────────────────┘                        └──────────────┐
                     ▼                                                            ▼
       auth gate → readOnly gate → 403 on /api/rows/*            GET /api/auth/status { …, readOnly }
                                                                                   │
                                        api.ts AuthStatus → useAuthStore.readOnly → ReadOnlyBanner

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/cli/src/studio-server.ts` | Modify | `readOnly?: boolean` on `StudioOptions`; `const readOnly = options.readOnly === true` next to `auth` (line 588); prefix gate after line 625; `readOnly` on the status payload (line 632); startup log line after `Auth:` (line 833) |
| `packages/cli/src/index.ts` | Modify | `--read-only` option + env resolution in the action; thread into `startStudio` |
| `apps/studio/src/lib/api.ts` | Modify | `AuthStatus.readOnly: boolean` (line 42) |
| `apps/studio/src/store/useAuthStore.ts` | Modify | `readOnly: boolean` state (default `false`), set from the probe in `checkStatus` |
| `apps/studio/src/app/components/ReadOnlyBanner.tsx` | Create | Non-dismissible banner, `SampleDataBanner` styling |
| `apps/studio/src/app/App.tsx` | Modify | Render `<ReadOnlyBanner />` as the first child of `AppShell`'s content column, above `<Header>` |
| `apps/studio/src/i18n/locales/{en,es}.json` | Modify | Banner copy |
| `packages/cli/test/studio-readonly.mjs` | Create | Integration suite |
| `packages/cli/package.json` | Modify | Append to the `test` chain after `studio-auth.mjs` |

## Interfaces / Contracts

```ts
// studio-server.ts
export interface StudioOptions { /* … */ readOnly?: boolean }

// 403 body — matches every other error on this server
{ error: "Studio is running in read-only mode" }

// GET /api/auth/status (200)
{ authRequired: boolean, authenticated: boolean, readOnly: boolean }
```

**Banner**: lives in `AppShell()`, so it never paints on `LoginScreen` — the shell is the only place
write affordances exist. Permanent for the session, no dismiss control: it reflects live server state,
not a one-time notice. Copy: "Read-only mode — this Studio instance refuses all writes." Styling copies
`SampleDataBanner.tsx` verbatim (`role="status"`, `px-4 py-2 … border-b … text-[11px] … shrink-0`) with
amber swapped for the same amber palette; it is the app's one existing banner precedent. Data source is
`useAuthStore((s) => s.readOnly)` — no second fetch.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Integration | Read-only off (control): POST/PATCH/DELETE succeed, `readOnly:false` on the probe | `withStudio(db, fixture, fn)` with no options |
| Integration | Read-only on, no auth: POST/PATCH/DELETE **and** an unrouted verb (PUT) on `/api/rows/User` → 403 with the exact message; DB row count unchanged | `withStudio(…, { readOnly: true })` |
| Integration | Reads unaffected: `/api/schema`, `/api/tables/User`, `POST /api/query` → 200 | same server |
| Integration | **Precedence**: auth on + read-only on, no cookie → write is **401**, body is `Authentication required`, DB unchanged | `{ password, readOnly: true }` |
| Integration | Same server, valid cookie → write is **403** | login, reuse cookie |
| Integration | Probe reports `readOnly` correctly across the 4 auth×read-only combinations | one compact loop asserting only `{authRequired, readOnly}` |

`withStudio(db, fixture, fn, options)` spreads `options` into `startStudio` (`studio-harness.mjs:89`),
so `{ readOnly: true }` flows through with **zero harness changes**, exactly as `password` did. Structure
follows `studio-auth.mjs`: local `check`/`assert`, `withDatabase` wrapper, failure counter, exit code.
Session mechanics (mint/verify, expiry, logout, rotation) are **not** re-tested — only the status code a
write receives under each posture. No unit or E2E layer: the gate has no isolatable unit, and Studio has
no E2E harness.

## Threat Matrix

Routing changes, but every listed row is version-control/shell-oriented and does not apply.

| Boundary | Applicability |
|---|---|
| Documentation-like paths | N/A — no file classification or execution |
| Git repository selection | N/A — no VCS invocation |
| Commit state | N/A — no VCS invocation |
| Push state | N/A — no VCS invocation |
| PR commands | N/A — no PR automation |

The HTTP-routing adversarial cases (prefix bypass via an unrouted verb, auth/read-only precedence,
direct `curl` bypassing the UI) are enumerated in Testing Strategy and carry into `tasks.md` unchanged.

## Migration / Rollout

No migration. Default off; unset is a structural no-op on every path. Rollback = revert, or drop the flag
and unset the env var.

## Open Questions

- [ ] Confirm during apply that no `GET /api/rows/` route is planned by a sibling change — the gate is
      deliberately method-agnostic and would refuse one.
