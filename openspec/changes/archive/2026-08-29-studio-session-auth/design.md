# Design: Studio Session Auth

## Technical Approach

A single optional shared password (`INDIGODB_STUDIO_PASSWORD`) is threaded into `startStudio` as `options.password` (injectable, like `options.db`), never read from `process.env` inside the request handler. When it is `undefined`, one `const auth = password ? createStudioAuth(password) : null;` evaluates once at startup and every request path short-circuits on `if (auth)` — no cookie parse, no HMAC, no branch body. Auth itself is a new dependency-free module `packages/cli/src/studio-auth.ts` reusing `handle.ts`'s exact primitive shape (`base64url(payload).base64url(HMAC-SHA256(payloadText, secret))`, length check before `timingSafeEqual`, every failure collapsing to `null`).

## Architecture Decisions

| Decision | Choice | Alternatives rejected | Rationale |
|---|---|---|---|
| Secret derivation | `createHmac("sha256", password).update("indigodb-studio-session-v1").digest("hex")` | scrypt/HKDF; raw password as key | Password rotation must invalidate sessions (resolved), so no salt/stretching value: the secret never leaves the process and is not stored. A fixed context string domain-separates it from any other HMAC use. Matches `handle.ts`'s single primitive; no second scheme. |
| Cookie payload | `{v:1, iat:<unix s>, exp:<unix s>}`, JSON → base64url, signed exactly as `handle.ts` | JWT lib; opaque server-side session id | Stateless (resolved: unlimited concurrent sessions, no registry). No identity claim exists — one shared password. `v` allows future format change. |
| TTL | Fixed **24 h**, no sliding renewal | 7 d (proposal's guess); 1 h | A dev tool's session should not outlive a working day; one login per day is negligible friction, and a leaked cookie expires overnight. Narrower than the proposal's ~7 d, which is a resolved-value pick, not a scope change. |
| `Secure` flag | **Not** forced; `HttpOnly; SameSite=Strict; Path=/` always | Always `Secure`; conditional on `x-forwarded-proto` | Studio is plain HTTP on loopback; `Secure` would make login silently impossible in the default deployment. Tradeoff recorded: over plain-HTTP LAN (`--host`) the cookie is sniffable — the startup warning already owns that class of risk. |
| Static SPA shell | Served **unauthenticated**; every `/api/*` route gated | Gate the shell too | The SPA is one indivisible bundle; gating it makes the login screen unreachable. The shell carries no schema or row data — those all arrive via gated `/api/*`. Deliberate divergence from the proposal's "gates every route incl. SPA shell". |
| Auth-required detection (SPA) | Explicit `GET /api/auth/status` during `useSchemaBootstrap` | 401-triggered redirect only | `api.ts` **fails soft** by design (returns `null`, falls back to mock data), so a 401 would render fake data instead of a login screen. A status probe makes "auth required" a first-class state. 401 handling still exists as a backstop for mid-session expiry. |

## Data Flow

    request ──→ validateHeaders()  ──403──→ done
                     │ ok
                     ▼
            if (auth) requireSession()          ← null when no password: skipped entirely
                     │        │
             cookie ok      no/bad cookie
                     │        └──→ /api/*: 401 {error:"Authentication required"}
                     ▼             other: fall through to static SPA
              existing routing

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/cli/src/studio-auth.ts` | Create | `deriveSessionSecret`, `mintSession`, `verifySession`, `parseCookie`, `createStudioAuth` |
| `packages/cli/src/studio-server.ts` | Modify | `StudioOptions.password`; `auth` const; gate after `validateHeaders`; `/api/auth/{status,login,logout}`; startup line stating auth state |
| `packages/cli/src/util.ts` | Modify | `assertStudioAuthForHost(host, password)` beside `assertRealtimeSecretPresent` |
| `packages/cli/src/index.ts` | Modify | Call the preflight in the `studio` action before `startStudio`; pass `password` |
| `apps/studio/src/features/auth/LoginScreen.tsx` | Create | Password form; posts to `/api/auth/login` |
| `apps/studio/src/store/useAuthStore.ts` | Create | `authRequired`/`authenticated` state |
| `apps/studio/src/app/App.tsx` | Modify | Render `LoginScreen` instead of the shell when `authRequired && !authenticated` |
| `apps/studio/src/lib/api.ts` | Modify | `fetchAuthStatus`, `login`, `logout`; 401 sets `authenticated=false` |
| `packages/cli/test/studio-auth.mjs` | Create | Full suite (below) |

## Interfaces / Contracts

```ts
// studio-auth.ts
export function createStudioAuth(password: string): {
  mint(): string;                                   // cookie value
  verify(cookieHeader: string | undefined): boolean;
  check(password: string): boolean;                 // timingSafeEqual
  cookieHeader(value: string, maxAge: number): string;
};
export const SESSION_TTL_SECONDS = 86400;
export const SESSION_COOKIE = "indigodb_studio_session";
```

Routes (all JSON, `application/json`):

- `GET /api/auth/status` → `200 {authRequired: boolean, authenticated: boolean}` — the only always-ungated API route.
- `POST /api/auth/login` `{password}` → `200 {ok:true}` + `Set-Cookie` | `401 {error:"Invalid password"}`. Comparison is `timingSafeEqual` over `sha256` digests of both strings (equal length, so no throw and no length leak). When no password is configured the route returns the same `401` body, so probing cannot distinguish "unconfigured" from "wrong".
- `POST /api/auth/logout` → `200 {ok:true}` + `Set-Cookie: ...=; Max-Age=0`.

Preflight (`util.ts`, `process.exit(1)` like its siblings):

```
❌ --host <host> binds the Studio beyond loopback, but INDIGODB_STUDIO_PASSWORD is not set.
   That would publish the schema, data browser and SQL console with no authentication.
   Set INDIGODB_STUDIO_PASSWORD and retry, or drop --host to stay on 127.0.0.1.
```

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | Mint/verify round-trip; tampered payload, tampered signature, truncated cookie, wrong `v`, expired `exp`, foreign secret → all reject; secret changes with password | Plain-node asserts in `studio-auth.mjs` against `dist/studio-auth.js` |
| Unit | Preflight: loopback+no password → ok; non-loopback+password → ok; non-loopback+no password → exit 1 | Extend `preflight.mjs`, mirroring `realtime-secret-preflight.mjs`'s `process.exit` stub |
| Integration | Zero-config passthrough: `withStudio` **without** `password` — `/api/schema`, `/api/tables/:t`, `/api/query`, and rows POST/PATCH/DELETE all behave exactly as today; no `Set-Cookie`, `authRequired:false` | `studio-auth.mjs` via `studio-harness.mjs` |
| Integration | Auth-required flow: unauthenticated 401 on every `/api/*` incl. rows writes; wrong password 401; login → cookie → same routes 200; logout → 401 again; hand-minted expired cookie → 401; SPA shell still 200 | Same harness, `password` forwarded through `withStudio`'s `options` |
| Regression | `studio-write.mjs` and `studio-pagination.mjs` pass unchanged (they construct no password) | Existing suites, unmodified |

## Threat Matrix

| Boundary | Applicability | Design response |
|---|---|---|
| Documentation-like paths | N/A — no file classification or execution |  |
| Git repository selection | N/A — no VCS interaction |  |
| Commit state | N/A |  |
| Push state | N/A |  |
| PR commands | N/A |  |

The routing boundary this change *does* touch is HTTP, not shell/process: its adversarial cases (tampered/expired/foreign-secret cookie, direct `curl` to write routes, unauthenticated static fallthrough, non-loopback bind without a password) are enumerated as RED tests in Testing Strategy and must be carried into `tasks.md` unchanged.

## Migration / Rollout

No migration. Unset `INDIGODB_STUDIO_PASSWORD` reproduces today's behavior exactly; the only breaking change is the `--host`-without-password refusal, which is intentional and documented in the error text.

## Open Questions

None.
