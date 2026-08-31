# Design: Studio Environment Badge

## Technical Approach

One optional string threaded startup → probe → store → badge, mirroring `readOnly` exactly.
`resolveStudioEnvironment(option, env)` joins `resolveStudioReadOnly` / `resolveQueryTimeoutMs` /
`resolveQueryRowCap` in `packages/cli/src/util.ts` as a pure resolver that **throws** (never
`process.exit`); `index.ts`'s `studio` action resolves it after `loadEnv()`, catches, prints and
exits 1 before binding. `studio-server.ts` holds it as a startup constant, adds
`environment: string | null` to the exempt `GET /api/auth/status` payload and a startup log line.
`useAuthStore` mirrors it; a new `EnvironmentBadge` renders it. No enforcement path reads it.

**Written before `sdd-spec`.** The normative choices below (length bound, trim, case-insensitive
recognition, verbatim rendering) must appear in the spec's scenarios. If the spec lands
contradicting any of them, this design is wrong and must be reconciled explicitly — not quietly
diverged from, which is what cost `studio-query-guardrails` a mid-flight correction.

## Architecture Decisions

### Decision: structurally invalid = empty-after-trim, > 32 chars, or any C0/DEL control character

**Choice**: after `String.prototype.trim()`, reject when `length === 0`, when `length > 32`
(UTF-16 code units), or when the value contains any character below U+0020 or the U+007F DEL
character. Because `trim()` already stripped leading and trailing whitespace, that last check
catches *interior* control characters such as a newline or a tab. Anything else is accepted and
returned trimmed. The error names the offending input and its flag or env var, matching
`resolveGuardrailValue`'s message shape.

**Alternatives considered**: no upper bound at all; 16; 64/255; a `/^[a-z0-9._-]+$/` charset
allowlist; code-point counting.

**Rationale**: 32 clears every plausible environment name by a wide margin (`production` 10,
`staging-eu-west-1` 17, `preview-pr-12345` 16) while rejecting the realistic pathological input —
a pasted connection string or a whole `.env` line — at startup rather than shipping it to the
header. 16 would plausibly reject a real name; 64+ stops being a bound the layout can rely on. A
charset allowlist is *semantic* filtering, which decision 3 of the proposal forbids: `qa-café` is
unfamiliar, not malformed. Control characters are the exception because they are structurally
hostile, not unfamiliar — a newline corrupts the startup log line and the operator-facing output.
Code-unit counting keeps the resolver's check identical to the bound the UI measures.

**The bound is belt-and-braces, not a UI guarantee.** The resolver only governs the CLI path; the
badge renders whatever the probe returns, so `EnvironmentBadge` independently applies
`max-w-[16ch] truncate` with the full value in `title`. A pathological value must degrade to an
ellipsis, never wrap the 48px header or push the actions group off-screen.

### Decision: trim, and recognise case-insensitively — deliberately unlike the sibling resolvers

**Choice**: the resolver trims. The UI recognises via `label.trim().toLowerCase()` against
`{development, staging, production}` and renders the operator's value **verbatim** (`Production`
stays `Production`, styled as production).

**Alternatives considered**: exact-match, no trim, no case folding — the `isReadOnlyEnv` /
`parseGuardrailInt` precedent, which this consciously breaks.

**Rationale**: those resolvers parse a *machine value* into a boolean or an integer, where any
leniency creates ambiguity about whether a guardrail is armed. This is an operator-facing *label*,
and the failure mode inverts. Under exact-match, `INDIGODB_ENV=Production` (or a trailing space
from a `.env` line, invisible in an editor) is a **valid, unrecognised** label under decision 3, so
it renders neutral grey — a badge that is present, plausible and silently wrong about the most
dangerous case the feature exists to signal. Rejecting is not better here: it locks out a correct
label over its capitalisation. Rendering verbatim keeps the operator's own text authoritative while
recognition stays forgiving.

### Decision: badge lives in `Header`'s right-hand chip group, not a second banner strip

**Choice**: `<EnvironmentBadge />` is the first item in `Header.tsx`'s right-hand
`flex items-center gap-3` group, styled on the existing "Connection Diagnostics" pill. It reads
`useAuthStore` directly (the `ReadOnlyBanner` precedent — no prop drilling through `HeaderProps`).
`Header` renders only inside `AppShell`, so the badge is never on `LoginScreen` for free.

**Alternatives considered**: a second full-width strip beside `ReadOnlyBanner` in `AppShell`; the
header's left group beside the cluster selector; folding it into `ReadOnlyBanner`.

**Rationale**: an operator on a read-only production instance must see both signals at once. Two
stacked strips compete for the same register and eat vertical space; a strip plus a chip separates
them by kind — the amber strip states a *posture*, the chip states an *identity* — and they occupy
different rows, so neither can hide the other. The left group is unusable: it already holds a mock
"Environment / Cluster" dropdown (`ENVIRONMENTS` from `../constants`), and putting real server
state adjacent to fake UI invites reading them as one control.

### Decision: static tone map in the component; neutral is the `??` fallback

**Choice**: a module-level frozen `RECOGNISED_TONES: Record<string, string>` of complete Tailwind
class strings keyed by lowercase name, plus `NEUTRAL_TONE`; lookup is
`RECOGNISED_TONES[key] ?? NEUTRAL_TONE`. Production is the most prominent (rose, solid), staging
mid (amber, outlined), development lowest (zinc, muted), neutral zinc/dashed.

**Alternatives considered**: interpolating colour names into class strings; a `cva`-style variant
helper; the server sending a `severity`/`tone` field alongside the label.

**Rationale**: Tailwind v4's JIT cannot see interpolated class names, so composed strings silently
render unstyled — and that failure would be a *missing* production warning. `cva` is not a
dependency here. A server-sent tone puts presentation into the API contract and makes the probe
field no longer the operator's verbatim label; the open label set means the client must own the
fallback anyway.

### Decision: no `role="status"` on the badge

**Choice**: `<span data-testid="environment-badge" title={label}>`. No ARIA live region.

**Rationale**: two reasons, both load-bearing. Semantically it is persistent chrome present from
first paint, not an event to announce. Mechanically,
`apps/studio/src/app/__tests__/App.test.tsx` asserts `screen.getByRole('status')` (singular) for
`ReadOnlyBanner`; a second `status` node makes that throw the moment both are active — exactly the
read-only-production combination this change must support.

### Decision: accessible name from real content (`sr-only` prefix + verbatim value), not `aria-label`

**Corrected during apply.** The badge originally shipped as
`<span data-testid="environment-badge" aria-label={t('environment.badge_aria')} title={label}>`
with the environment string as the element's text content. On an element that already has text
content, `aria-label` **overrides** that content when the accessible name is computed — so
assistive tech announced only the static i18n key ("Environment label for this Studio instance")
and never the actual value (`production`, `staging`, `qa`). That is exactly the one piece of
information this badge exists to convey, so the original shape silently failed its own purpose
for screen-reader users.

**Choice**: drop `aria-label` entirely. Give the badge a visually-hidden `sr-only` span carrying
`t('environment.badge_aria')` as a context prefix, followed by the verbatim environment text as a
sibling text node:

```tsx
<span data-testid="environment-badge" title={environment} className={`... ${tone}`}>
  <span className="sr-only">{t('environment.badge_aria')}: </span>
  {environment}
</span>
```

With no `aria-label` present, the accessible name falls back to the element's text content, which
now includes both the prefix and the environment value — so the announced name always contains
the actual label. `sr-only` is Tailwind v4's built-in utility, already used elsewhere in this
codebase (`TableBrowserPage.tsx`'s pagination `<label>`), so nothing new was introduced.

**Alternatives considered**: `aria-describedby` pointing at a hidden node (keeps `aria-label` but
adds a second announced string — more complex than needed since the visible text already carries
the value); dropping the context prefix entirely and relying on the bare visible text (loses the
"this is an environment indicator" framing for AT users that sighted users get for free from
surrounding chrome).

**Rationale**: the accessible name MUST contain the actual environment string. Composing it from
real content rather than `aria-label` is the only shape that satisfies that constraint while
keeping the verbatim, case-preserved rendering (`Production` stays `Production`) untouched.

## Data Flow

    --env <name> / INDIGODB_ENV ──→ index.ts studio action (after loadEnv)
                                  │ resolveStudioEnvironment (util.ts, pure, throws)
                                  │ catch → console.error → exit 1 (before bind)
                                  ▼
                  startStudio({ ..., environment })  ──→ log "Environment: <label> | (unset)"
                                  │
                                  ▼
                  GET /api/auth/status → { ..., environment: string | null }   (auth-exempt)
                                  │
                    api.ts AuthStatus → useAuthStore.environment → EnvironmentBadge
                                                                    │ null → render nothing
                                                                    └ RECOGNISED[lower] ?? NEUTRAL

Nothing downstream of the store reads `environment`. The read-only gate, `/api/rows/*`,
`/api/query` and both query guardrails are untouched paths.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/cli/src/util.ts` | Modify | Exported pure `resolveStudioEnvironment(option, env)`; throws on structurally invalid input |
| `packages/cli/src/index.ts` | Modify | `--env <name>` option; resolved after `loadEnv()` in the action; catch → print → exit 1; threaded into `startStudio` |
| `packages/cli/src/studio-server.ts` | Modify | `environment?: string` on `StudioOptions`; `environment` in the `/api/auth/status` payload; `Environment:` startup log line |
| `packages/cli/test/studio-environment-resolution.mjs` | Create | Unit suite for the resolver |
| `packages/cli/test/studio-environment.mjs` | Create | Integration suite (probe echo, non-enforcement controls) |
| `packages/cli/package.json` | Modify | Append both suites to the `test` chain |
| `apps/studio/src/lib/api.ts` | Modify | `AuthStatus.environment: string \| null` |
| `apps/studio/src/store/useAuthStore.ts` | Modify | `environment: string \| null` (default `null`), adopted in `checkStatus` |
| `apps/studio/src/app/components/EnvironmentBadge.tsx` | Create | The badge; tone map + neutral fallback; always visible (no responsive `hidden`); accessible name from `sr-only` prefix + verbatim value, not `aria-label` (corrected during apply, see Decision above) |
| `apps/studio/src/app/components/__tests__/EnvironmentBadge.test.tsx` | Create | Component suite |
| `apps/studio/src/app/components/Header.tsx` | Modify | Render `<EnvironmentBadge />` first in the right-hand chip group |
| `apps/studio/src/i18n/locales/{en,es}.json` | Modify | `environment.badge_aria` (+ any hint copy), both locales in the same task |
| `apps/studio/src/store/__tests__/useAuthStore.test.ts` | Modify | **Required**: add `environment` to every `fetchAuthStatus` mock literal |
| `apps/studio/src/app/__tests__/App.test.tsx` | Modify | **Required**: same, including the inline `resolveStatus` promise type near line 50 |

The last two rows are not optional cleanup. `AuthStatus` gains a **required** field, so every
existing typed mock literal fails `tsc`. `apps/studio`'s `lint` is now `tsc -b --noEmit` (it
previously typechecked nothing), so these breaks surface in `pnpm lint` as well as `pnpm build`.
`QueryEnginePage.test.tsx` uses `useAuthStore.setState` partials only and needs no change.

## Interfaces / Contracts

```ts
// packages/cli/src/util.ts — pure; throws, never process.exit
export function resolveStudioEnvironment(
  option: string | undefined,
  env: string | undefined,
): string | undefined;   // trimmed label; undefined when both are absent

// packages/cli/src/studio-server.ts
export interface StudioOptions { /* ... */ environment?: string }

// GET /api/auth/status (200) — third additive widening, still auth-exempt
{ authRequired, authenticated, readOnly, queryTimeoutMs, queryRowCap, environment: string | null }

// apps/studio/src/lib/api.ts
export interface AuthStatus { /* ... */ environment: string | null }
```

Precedence: `--env` > `INDIGODB_ENV` > absent. Absent is `undefined` on `StudioOptions` and `null`
on the wire and in the store — never `"development"`.

## Testing Strategy

Every row is a covering runtime test and must produce a RED task. Checked deliberately for the
three shapes that have slipped past this epic before: **symmetric pairs** (rows 1–2, 10, 14–15),
**negative/absence requirements** (rows 3, 15, 17, 19, 21) and **two-option combinations**
(rows 18, 22, 25).

| # | Layer | What to test | Approach |
|---|-------|--------------|----------|
| 1 | Unit | `--env` beats `INDIGODB_ENV` when both are set | `studio-environment-resolution.mjs` |
| 2 | Unit | `INDIGODB_ENV` used when the flag is absent | same |
| 3 | Unit | Both absent → `undefined` (never `"development"`) | same |
| 4 | Unit | `"production"` accepted verbatim | same |
| 5 | Unit | `"staging"` accepted verbatim | same |
| 6 | Unit | `"development"` accepted verbatim | same |
| 7 | Unit | `"qa"` — unrecognised but valid — accepted, not thrown | same (guards against a closed-set regression) |
| 8 | Unit | `""` throws, from the flag path and from the env path, naming the offending source | same |
| 9 | Unit | `"   "` (whitespace-only) throws | same |
| 10 | Unit | 33 chars throws; exactly 32 accepted (boundary pair) | same |
| 11 | Unit | Interior control character (embedded newline, embedded tab) throws | same |
| 12 | Unit | `" staging "` → `"staging"` (trim applied) | same |
| 13 | Unit | `"Production"` accepted and returned as `"Production"` (verbatim, not lowercased) | same |
| 14 | Integration | Probe reports `environment` exactly as `startStudio` received it | `withStudio(..., { environment: "staging" })` |
| 15 | Integration | Probe reports `environment: null` when unset | `withStudio(...)` default |
| 16 | Integration | Probe answers `environment` pre-auth (route stays exempt) | `withStudio(..., { password, environment })`, no cookie |
| 17 | Integration | **Not an enforcement input**: `environment: "production"` alone leaves `/api/rows/*` writes succeeding, `readOnly:false`, and both guardrails at defaults | `withStudio(..., { environment: "production" })`, control assertions |
| 18 | Integration | `{ environment: "production", readOnly: true }` → probe reports both; writes 403 for the read-only reason only | same harness, two options |
| 19 | Component | `environment: null` renders nothing (empty container, no badge testid) | `EnvironmentBadge.test.tsx` |
| 20 | Component | Each recognised label renders its own distinct tone class, production the most prominent | same; assert on class strings — `t()` returns raw keys in this env |
| 21 | Component | `"qa"` renders verbatim with the neutral tone (not a recognised tone, not hidden) | same |
| 22 | Component | `"Production"` renders verbatim **and** picks the production tone (case-insensitive recognition) | same |
| 23 | Component | A 32-char label carries the truncation class and the full `title`; the badge does not use `role="status"` | same |
| 24 | Component | Store default is `null`; `checkStatus` adopts a probe value; a fail-soft (`null`) probe leaves it `null` and does not throw | `useAuthStore.test.ts` |
| 25 | Component | With `readOnly: true` **and** an environment set, `getByRole('status')` still resolves uniquely to the banner and the badge is present too | `App.test.tsx` (the collision regression) |
| 26 | Component | The badge never applies a responsive `hidden` utility class (proxy — jsdom does not evaluate media queries, so this checks the rendered class list rather than actual viewport visibility) | `EnvironmentBadge.test.tsx` (added in corrective batch) |
| 27 | Component | No `aria-label` attribute; the `sr-only` i18n-key prefix is present as real content and the environment value is part of `textContent` (proxy for "the accessible name contains the environment value" — no `aria-label` means the accessible name falls back to text content) | `EnvironmentBadge.test.tsx` (added in corrective batch) |

Component tests assert on i18n **keys**, not copy — `apps/studio`'s test environment has no i18n
instance, so `t()` returns the raw dotted key.

## Threat Matrix

N/A — no routing change (the probe payload widens; no route is added, removed or re-gated), and no
shell, subprocess, VCS/PR automation, executable-file classification, or process integration. The
label never reaches SQL, a file path, or a spawned command; it is serialised into JSON and rendered
as a React text child (auto-escaped), and its only injection-adjacent sink — the startup
`console.log` line — is covered by the control-character rejection in decision 1.

## Migration / Rollout

No migration. Unset is a structural no-op on every path: no badge, `environment: null`, behavior
identical to today. Rollback is revert; short of revert, drop `--env` and unset `INDIGODB_ENV`.

## Open Questions

- [ ] The proposal's Risks table ("Resolver throws with the allowed values named") and Success
      Criterion 3 ("an unrecognised value exits 1") still carry the **superseded closed-set**
      wording from before the label-set amendment. This design implements the amended open set;
      the spec must too. Raised for the orchestrator rather than silently reconciled.
- [ ] `Header.tsx`'s pre-existing mock "Environment / Cluster" dropdown now shares a noun with real
      server state. Out of scope here; worth a follow-up before 1.0.
