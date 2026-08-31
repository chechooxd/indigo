# Tasks: Studio Environment Badge

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~800–900 (additions + deletions), across 2 PRs |
| Review budget (this project) | **800**, not 400 — see `sdd-init/indigo` |
| 800-line budget risk | Medium per PR, both expected well under budget |
| Chained PRs recommended | Yes — 2 PRs |
| Suggested split | **PR1 backend (Phases 1–2)** → **PR2 frontend (Phases 3–5)** |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes (2)
Chain strategy: stacked-to-main

**Orchestrator override, recorded 2026-08-31.** The original forecast proposed four PRs and
reasoned against a 400-line budget. This project's budget is 800 (`sdd-init/indigo`), so the
four-way split was ceremony for the smallest slice of the epic. It also created a real
sequencing hazard the forecast itself flagged: the typed-mock-literal fixups in Phase 3 must
land before Phase 4, or `pnpm lint` and `pnpm build` break app-wide rather than just for this
feature — `apps/studio`'s lint is `tsc -b --noEmit` and a required new `AuthStatus` field
breaks every typed mock. Keeping Phases 3–5 in one PR makes that PR internally consistent at
every commit. Two PRs also mirror the sibling `studio-query-guardrails`, which shipped
backend-then-frontend at ~900 lines without strain.

Work units 1+2 below compose PR1; units 3+4 plus Phase 5 compose PR2. The per-unit rollback
boundaries stay accurate and remain useful as commit boundaries inside each PR.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | `resolveStudioEnvironment` + `--env`/`INDIGODB_ENV` CLI wiring | PR 1 | `node packages/cli/test/studio-environment-resolution.mjs` | N/A — pure function, no server needed | Revert `util.ts` export + `index.ts` option; no downstream depends yet |
| 2 | `/api/auth/status` `environment` field + non-enforcement | PR 2 | `node packages/cli/test/studio-environment.mjs` | `withStudio()` harness (real server, ephemeral port) | Revert `studio-server.ts` hunk; probe reverts to prior shape |
| 3 | Frontend `AuthStatus`/`useAuthStore` contract + mock fixups | PR 3 | `pnpm --filter @indigodb/studio test` | N/A — vitest, no live backend | Revert `api.ts`/`useAuthStore.ts`; mocks stay typed against old shape |
| 4 | `EnvironmentBadge` + `Header` wiring + collision regression | PR 4 | `pnpm --filter @indigodb/studio test` | N/A — vitest render tests | Remove `EnvironmentBadge.tsx` + its one `Header.tsx` line |

## Scenario Coverage Matrix (spec scenario → design test row → task)

Walked both spec files against design's Testing Strategy table row by row. One gap found and
closed below (Gap A); everything else has a covering row.

| Spec scenario | Design row(s) | Task |
|---|---|---|
| Neither set → null | 3, 15 | 1.1, 2.1 |
| `--env` beats `INDIGODB_ENV` | 1 | 1.1 |
| `INDIGODB_ENV` used when flag absent | 2 | 1.1 |
| Each recognised label resolves + reaches probe | 4,5,6,14,20 | 1.1, 2.1, 4.1 |
| Unrecognised valid label (`qa`) accepted | 7,21 | 1.1, 4.1 |
| Case-insensitive recognition, verbatim (`Production`) | 13,22 | 1.1, 4.1 |
| Whitespace trimmed before recognition | 12 | 1.1 |
| Long valid label truncates with hover title | 23 | 4.1 |
| Empty/whitespace-only rejected | 8,9 | 1.1 |
| Over-length rejected; 32 accepted / 33 rejected | 10 | 1.1 |
| Interior control char rejected | 11 | 1.1 |
| Absent → no badge | 19 | 4.1 |
| Standalone dev, probe fails soft → no badge, no throw | 24 | 3.1 |
| Not an enforcement input: writes/readOnly/guardrails unaffected | 17 | 2.2 |
| **Gap A** — `environment` doesn't alter `/api/auth/login`, an authenticated route, or `POST /api/query` responses | *not in design table* | 2.2 (added explicitly) |
| Badge renders recognised label, distinct treatment | 20 | 4.1 |
| Badge renders custom label verbatim, neutral treatment | 21 | 4.1 |
| (delta) probe reports `environment` pre-auth, no session | 16 | 2.1 |
| (delta) `environment: null` when unset, no session | 15 | 2.1 |
| Collision: `readOnly:true` + `environment` set → single `role="status"`, badge also present | 25 | 4.2 |

## Phase 1: Resolver (Foundation) — `packages/cli/src/util.ts`, `packages/cli/src/index.ts`

- [x] 1.1 RED: create `packages/cli/test/studio-environment-resolution.mjs` covering design rows
      1–13: flag > env precedence; env-only fallback; both-absent → `undefined`; `development`/
      `staging`/`production` accepted verbatim; `qa` accepted (not thrown); `""`/`"   "` throw
      naming `--env`/`INDIGODB_ENV`; 33 chars throws, exactly 32 accepted; interior newline/tab
      throws; `" staging "` → `"staging"` (trim); `"Production"` returned unchanged (not lowered).
- [x] 1.2 GREEN: implement `resolveStudioEnvironment(option, env)` in `util.ts` — trim, throw on
      length 0 or >32 code units or any char < U+0020/U+007F, else return trimmed string or
      `undefined`; message shape matches `resolveGuardrailValue`.
- [x] 1.3 GREEN: add `--env <name>` option to `index.ts`'s `studio` command; resolve after
      `loadEnv()` inside the action (the `--read-only` pattern, not a module-load default);
      catch → `console.error` → `process.exit(1)` before binding; thread into `startStudio`.

## Phase 2: Server/API — `packages/cli/src/studio-server.ts`

- [x] 2.1 RED: create `packages/cli/test/studio-environment.mjs` covering design rows 14–16:
      probe echoes the exact `environment` `startStudio` received; probe reports `null` when
      unset; probe answers `environment` pre-auth (no session cookie, route stays exempt).
- [x] 2.2 RED: in the same file, add the non-enforcement suite (own explicit task — this is the
      absence/negative requirement, easiest to drop): row 17 (`environment: "production"` alone
      leaves `/api/rows/*` writes succeeding, `readOnly:false`, both guardrails at default) **and
      Gap A** — `/api/auth/login`, an authenticated `/api/*` route, and `POST /api/query` each
      return identically with and without `--env` set, aside from the probe's `environment`
      field; plus row 18 (`{ environment: "production", readOnly: true }` → probe reports both,
      writes 403 for the read-only reason only).
- [x] 2.3 GREEN: add `environment?: string` to `StudioOptions`; add `environment: string | null`
      to the `/api/auth/status` payload; add an `Environment: <label>` / `(unset)` startup log
      line. Never read `environment` in any auth/read-only/guardrail check (row 17/18 prove it).
- [x] 2.4 Append both new suites to the `test` chain in `packages/cli/package.json`.

## Phase 3: Frontend contracts — `apps/studio/src/lib/api.ts`, `useAuthStore.ts`

- [x] 3.1 RED: extend `apps/studio/src/store/__tests__/useAuthStore.test.ts` for row 24: default
      `environment` is `null`; `checkStatus` adopts a probe value; a fail-soft (`null`) probe
      leaves it `null` and never throws.
- [x] 3.2 GREEN: widen `AuthStatus` in `api.ts` with `environment: string | null`.
- [x] 3.3 GREEN: add `environment: string | null` (default `null`) to `useAuthStore.ts`, adopted
      in `checkStatus`.
- [x] 3.4 REQUIRED fixup: add `environment` to every existing `fetchAuthStatus`/`AuthStatus` mock
      literal in `useAuthStore.test.ts` and `App.test.tsx` (including the inline `resolveStatus`
      promise type near line 50) — `AuthStatus` gained a required field, so `tsc -b --noEmit`
      (both `pnpm lint` and `pnpm build`) fails until every literal is updated. Do this before
      Phase 4 so the build stays green throughout.

## Phase 4: Badge + wiring — `apps/studio/src/app/components/`

- [x] 4.1 RED: create `EnvironmentBadge.test.tsx` covering rows 19–23: `environment: null` →
      nothing rendered (no `environment-badge` testid); each recognised label renders its own
      tone class, production most prominent; `qa` renders verbatim with the neutral tone; case-
      insensitive `"Production"` renders verbatim **and** picks the production tone; a 32-char
      label carries the truncation class + full value in `title`, and asserts no `role="status"`
      on the badge. Assert on i18n keys (`t()` returns raw dotted keys in this test env).
- [x] 4.2 RED: in `App.test.tsx`, add the collision regression named in design — `readOnly: true`
      **and** `environment` set together: `getByRole('status')` still resolves uniquely to
      `ReadOnlyBanner`, and the environment badge (`data-testid`) is present too.
- [x] 4.3 GREEN: create `EnvironmentBadge.tsx` — `<span data-testid="environment-badge"
      aria-label={t('environment.badge_aria')} title={label}>`, no `role="status"`; a frozen
      `RECOGNISED_TONES: Record<string, string>` of **complete static** Tailwind class strings
      (production rose/solid, staging amber/outlined, development zinc/muted) plus `NEUTRAL_TONE`,
      looked up as `RECOGNISED_TONES[label.trim().toLowerCase()] ?? NEUTRAL_TONE` — never
      interpolate a class name, Tailwind v4 JIT cannot see it; `max-w-[16ch] truncate`.
- [x] 4.4 GREEN: render `<EnvironmentBadge />` first in `Header.tsx`'s right-hand chip group,
      reading `useAuthStore` directly (no prop drilling).
- [x] 4.5 Add `environment.badge_aria` (+ any hint copy) to both
      `apps/studio/src/i18n/locales/en.json` and `es.json` in this same task.
- [x] 4.6 CORRECTIVE (post-review, same branch): fix two committed defects in
      `EnvironmentBadge.tsx` found during PR 2 review. (a) Drop `hidden sm:` from the badge's
      className — the badge was invisible below the `sm` breakpoint, contradicting its purpose as
      a persistent, always-visible signal (`ReadOnlyBanner` is never responsively hidden either);
      width stays bounded by the existing `max-w-[16ch] truncate`. (b) Remove `aria-label` (it
      overrides text-content-derived accessible names, so AT users never heard the actual
      environment value) and replace it with an `sr-only` context-prefix span + the verbatim
      label as real content, so the accessible name is composed from real content and always
      contains the environment string. RED: two new tests in `EnvironmentBadge.test.tsx` —
      no `hidden` utility in the rendered class list; no `aria-label` attribute plus the
      environment value present in `textContent`. Both observed failing against the pre-fix
      component before the fix landed. GREEN: both pass after the component fix; full
      `EnvironmentBadge.test.tsx` (9/9), `App.test.tsx` (8/8, collision regression unaffected),
      and the full `apps/studio` suite (20 files / 123 tests) all pass.

## Phase 5: Verification

- [x] 5.1 Run `pnpm --filter @indigodb/cli test`, `pnpm --filter @indigodb/studio test`,
      `pnpm build`, `pnpm lint` locally (CI is disabled) before each PR merges.
