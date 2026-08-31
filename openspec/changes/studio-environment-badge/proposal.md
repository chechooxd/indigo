# Proposal: Studio Environment Badge

## Context

Change **4 of 5** splitting the roadmap epic "Auth and production guardrails" (Road to 1.0, Phase 5).
Archived: `studio-session-auth`, `studio-readonly-mode`, `studio-query-guardrails`. Still unstarted:
`studio-audit-log`. Exploration (Engram `sdd/explore/auth-production-guardrails`) rated this the
smallest, lowest-risk slice: nearly pure-additive.

## Intent

Studio looks identical whether it is pointed at a scratch local Postgres or at production. Nothing in
`StudioOptions`, `ResolvedSchema`, or `resolveConnectionString` (`packages/cli/src/util.ts`) carries an
environment label, and the datasource string is redacted in the UI by design. An operator with several
tabs open has no persistent, glanceable answer to "which database am I about to edit?".

## Scope

### In Scope
- `StudioOptions.environment?: string`, resolved **once at startup** via a new pure
  `resolveStudioEnvironment(option, env)` in `util.ts`, throwing (never `process.exit`) only on a
  structurally invalid value (empty/whitespace-only, or over a bounded length) — never on an
  unrecognised name.
- CLI `--env <name>` paired with `INDIGODB_ENV`, resolved **after `loadEnv()`** inside the `studio`
  action (the `--read-only` precedent, not the `--host` module-load default).
- **Open label set with recognised names.** `development | staging | production` are the recognised
  labels and each gets its own distinct visual treatment (production the most prominent). Any other
  non-empty label is **accepted** and rendered verbatim with a neutral treatment. Unset means
  **absent** — no label, no badge. A team running `qa`, `preview`, or `uat` must never be unable to
  start Studio because of a label name.
- `environment: string | null` added to the exempt `GET /api/auth/status` probe (third widening).
- Persistent badge in the Studio shell, driven through the existing `useAuthStore` status wiring.

### Out of Scope — deliberate non-goals
- **Any hostname / connection-string heuristic**, even as a soft hint. See Approach.
- **Any enforcement.** The badge gates nothing. Read-only stays governed solely by
  `resolveStudioReadOnly`; `studio-readonly-mode` explicitly forbids environment-driven auto-enable and
  cites this change by name.
- Defaulting to `development` when unset — an unevidenced "you are safe" is the exact failure mode here.
- Per-connection labels, schema-declared environments, or an `@datasource` IR field.
- `studio-audit-log` (sibling), auth, read-only mode, query guardrails, pagination, write guards — all untouched.

## Capabilities

### New Capabilities
- `studio-environment-badge`: explicit flag/env resolution, open label set with three recognised
  names, status-probe field, UI badge.

### Modified Capabilities
- `studio-session-auth`: the exempt `GET /api/auth/status` probe carries `environment`.

## Approach

One optional string threaded startup → probe → store → badge, mirroring `readOnly` exactly.

**Load-bearing position: the heuristic is rejected, not deferred-with-a-hint.** Exploration floated a
hostname hint. A badge whose only job is saying "you are pointed at production" earns nothing from a
guess: a false *local* reading is actively dangerous, and a false *not-local* hint trains operators to
dismiss the badge, destroying the signal the change exists to create. Explicit opt-in only.

**Rejected alternative: a closed label set with a throwing resolver.** Determinism of the badge's
visual treatment is worth keeping, but buying it by refusing to start is the wrong trade: an operator
whose environments are named `qa` or `preview` would be locked out of the feature entirely until
someone edited an enum. Recognised names keep their deterministic treatment; unrecognised ones fall
back to a neutral style. The resolver still throws on a structurally invalid value (empty or
over-long), so bad input is never silently swallowed — only *unfamiliar* input is tolerated.

**Rejected alternative: fully free-form with no recognised names.** That costs the differentiated
treatment which is the entire reason production must leap off the screen.

**Seam note:** no new seam. `resolveStudioEnvironment` joins `resolveStudioReadOnly` /
`resolveQueryTimeoutMs` / `resolveQueryRowCap` as pure, unit-testable resolvers. No `crates/` change, so
no `build:wasm` rerun. No `ResolvedSchema` field — this is process configuration, not schema.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/cli/src/util.ts` | Modified | `resolveStudioEnvironment` (pure, throws) |
| `packages/cli/src/index.ts` | Modified | `--env` option, resolved after `loadEnv()`, threaded into `startStudio` |
| `packages/cli/src/studio-server.ts` | Modified | `environment` option, status field, startup log line |
| `apps/studio/src/lib/api.ts` | Modified | Widen `AuthStatus` with `environment` |
| `apps/studio/src/store/useAuthStore.ts` | Modified | Hold `environment` from the same probe |
| `apps/studio/src/app/components/` | New | Badge component (sibling of `ReadOnlyBanner.tsx`) |
| Write routes, `useSettingsStore.ts` | Untouched | Badge is informational only |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Operators assume the badge protects them | Med | Badge is purely informational; pair with `--read-only` in docs and the startup log |
| Absent label reads as "this is safe" | Med | Absent renders no badge at all, never a "development" claim |
| Custom label (`qa`, `preview`) renders without a distinct treatment | Low | Accepted by design: recognised names keep their treatment, any other valid label renders verbatim with a neutral one. Startup is never blocked by a label name |
| A pathological label breaks the shell layout | Low | Bounded length enforced by the resolver; the badge truncates rather than overflowing (design decides the bound) |
| Third `/api/auth/status` widening deepens the naming smell | Med | Deliberate, additive, non-breaking; already twice-precedented |
| i18n drift (en/es badge strings) | Low | Add both locales in the same task |

## Rollback Plan

Revert the change commits. Short of revert, omitting `--env` and unsetting `INDIGODB_ENV` restores
today's behavior exactly — unset is a structural no-op on every path.

## Dependencies

None. No new packages.

## Success Criteria

- [ ] Default (no flag, no env): Studio behaves exactly as today and renders no badge.
- [ ] `--env production` or `INDIGODB_ENV=production`: `GET /api/auth/status` reports it and the badge shows.
- [ ] `--env` beats `INDIGODB_ENV`.
- [ ] An unrecognised but valid label (e.g. `qa`) starts normally, reaches the probe verbatim, and
      renders with the neutral treatment — it MUST NOT block startup.
- [ ] A structurally invalid value (empty, whitespace-only, over-length) exits non-zero before
      binding, with a message naming `--env` / `INDIGODB_ENV`.
- [ ] The badge changes no request behavior: writes, read-only mode, and query guardrails are unaffected.
- [ ] Standalone `pnpm dev` (no backend, probe fails soft) renders no badge and does not error.

## Proposal question round (execution_mode: auto — assumptions recorded, not asked)

1. **Heuristic**: fully rejected, not shipped as a soft hint. Most consequential call here.
   Confirmed by the user after this proposal was written.
1b. **Label set**: the user chose an OPEN set with three recognised names over the closed,
   throwing set this proposal originally assumed. Scope, Approach, Capabilities, Risks and
   Success Criteria above reflect that decision; it is settled, not an open assumption.
2. **Label set**: assumed closed (`development|staging|production`) with a throwing resolver, not free-form.
3. **Unset**: assumed no badge, not an implied `development`.
4. **Enforcement**: assumed zero — the badge never feeds read-only or any other gate.
5. **Runtime**: assumed startup-only resolution, no route to change the label on a running server.
