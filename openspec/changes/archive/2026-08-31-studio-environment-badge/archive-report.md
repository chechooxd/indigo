# Archive Report: Studio Environment Badge

**Change**: `studio-environment-badge`
**Archived to**: `openspec/changes/archive/2026-08-31-studio-environment-badge/`
**Date**: 2026-08-31
**Position**: change **4 of 5** splitting the roadmap epic "Auth and production guardrails"
(Road to 1.0, Phase 5). Archived siblings: `studio-session-auth`, `studio-readonly-mode`,
`studio-query-guardrails`. **Only `studio-audit-log` (5 of 5) remains unstarted** — after it,
the epic closes.

> There is no `roadmap.md` committed in this repository. The epic wording lives only in Engram
> (`sdd/explore/auth-production-guardrails`, obs #799) and in prior proposals.

## Executive Summary

`indigodb studio` looked identical whether pointed at a scratch local Postgres or at production.
This change adds an opt-in, explicitly-declared environment label — resolved once at startup,
echoed on the existing `GET /api/auth/status` probe, and surfaced as a persistent badge in the
Studio header — so an operator with several tabs open has a glanceable answer to "which database
am I about to edit?".

The label is **purely informational**. It gates nothing.

Final verdict: **PASS WITH WARNINGS** — 0 CRITICAL, 0 new WARNING, 3 SUGGESTION.
7 requirements / 22 scenarios: 21 COMPLIANT, 1 PARTIAL (inherited, non-blocking).
`tasks.md`: **18/18 complete**.

## Delivery

Two chained PRs, `stacked-to-main`, both merged:

| PR | Scope | Commits | Merge |
|----|-------|---------|-------|
| 1 | Backend — resolver, CLI wiring, status probe field | `e14acd0`, `9e87e64`, `a0e72e9` | `c7bb472` |
| 2 | Frontend — `AuthStatus` contract, `useAuthStore`, `EnvironmentBadge`, `Header` wiring, i18n | `d9a5241`, `5183e56`, `1c3ae99` | `6767d50` |

Base was `main` @ `370be7d`. Both feature branches deleted.

**PR 1 passed verify on the FIRST pass (PASS, 0 CRITICAL) — the first change in this epic to do
so.** The three prior siblings each failed their first verify on a spec scenario with no covering
runtime test. The difference here was adding the missing scenarios to the spec *before* any code
was written (see Corrections, item 7).

## Decisions

### 1. The hostname / connection-string heuristic was REJECTED outright

Not deferred, not shipped as a soft hint. Exploration had floated classifying the resolved
connection string as a "this looks like it might not be local" signal.

A badge whose only job is saying "you are pointed at production" earns nothing from a guess: a
false *local* reading is actively dangerous, and a false *not-local* hint trains operators to
dismiss the badge, destroying the signal the change exists to create. Explicit opt-in only.

This also honours a constraint inherited from a sibling: the archived `studio-readonly-mode`
proposal lists "any environment heuristic auto-enabling read-only" as out of scope, *citing this
change by name* as the "soft hint, never authoritative" precedent.

### 2. Open label set with three recognised names (user decision — reversed the original proposal)

The proposal originally assumed a **closed** set with a resolver that threw on anything else. The
user reversed it. As shipped:

- `development | staging | production` are **recognised**, each with its own distinct visual
  treatment, production the most prominent.
- **Any other structurally valid label is accepted**, reaches the probe, and renders verbatim with
  a shared neutral treatment.
- `resolveStudioEnvironment` **never throws on an unrecognised name**. A team running `qa`,
  `preview`, or `uat` must never be unable to start Studio because of a label name.
- It throws only on **structurally invalid** input: after `trim()` — empty, longer than 32 UTF-16
  code units (**32 exactly is accepted; the boundary is inclusive**), or containing any character
  below U+0020 or U+007F DEL. Interior control characters are rejected because they corrupt the
  startup log line; an unfamiliar *name* is never a reason to reject.
- Unset ⇒ `environment: null` ⇒ **no badge at all**. Never defaults to `development` — an
  unevidenced "you are safe" is the exact failure mode this change exists to prevent.

### 3. Normalisation deliberately breaks the sibling resolver precedent

`isReadOnlyEnv` and `parseGuardrailInt` are exact-match: no trim, no case folding. This resolver
trims, and the UI recognises case-insensitively (`.trim().toLowerCase()`) while rendering the
label **verbatim** — `Production` stays `Production`, styled as production.

The reason the precedent does not transfer: those resolvers parse a *machine value* into a boolean
or an integer, where leniency creates ambiguity about whether a guardrail is armed. This is an
operator-facing *label*, and the failure mode inverts. Under exact matching,
`INDIGODB_ENV=Production` — or a trailing space from a `.env` line, invisible in an editor — would
be a **valid but unrecognised** label under decision 2, so it would render neutral grey: a badge
that is present, plausible, and silently wrong about the most dangerous case the feature exists to
signal.

### 4. Static tone map, never interpolated class names

Tailwind v4's JIT scanner cannot see composed class names. `RECOGNISED_TONES` is a frozen map of
complete static class strings with a `?? NEUTRAL_TONE` fallback. Building them from parts would
render the badge unstyled — and for `production`, that failure *is* a missing production warning.

Design authorises a narrow, documented exception to the usual "never assert CSS classes in tests"
rule for exactly this reason. Verify confirmed the exception stayed narrow.

### 5. The badge does not use `role="status"`

`App.test.tsx` asserts a **singular** `screen.getByRole('status')` for `ReadOnlyBanner`. A second
status node would break that assertion precisely in the read-only + production combination this
feature exists to support. The badge uses `data-testid` + composed accessible name instead, and a
regression test covers both signals active simultaneously.

### 6. Orchestrator override on delivery shape

The tasks forecast proposed **4 PRs**, reasoning against a 400-line budget. This project's budget
is **800** (`sdd-init/indigo`), so it shipped as **2**. The four-way split was ceremony for the
smallest slice of the epic, and it created a sequencing hazard the forecast itself flagged: the
typed-mock fixups had to land before the UI work, or `pnpm lint` and `pnpm build` break app-wide
rather than just for this feature. The override is recorded inside `tasks.md`.

## Corrections made during the cycle

1. **Proposal amended** after the propose phase, for the user's open-label-set decision. The first
   amendment covered Scope, Approach and Capabilities but left the Risks table and Success Criteria
   describing the rejected closed design; `sdd-spec` caught the contradiction and it was fully
   reconciled.
2. **Spec extended** with scenarios design's Testing Strategy table predated: case-insensitive
   recognition rendered verbatim, whitespace trimming, the inclusive 32-code-unit boundary, and
   interior-control-character rejection.
3. **Spec error-message requirement disambiguated** (`9e87e64`): it said the message "MUST name
   `--env` and `INDIGODB_ENV`", which read ambiguously. The implementation names only whichever
   source actually supplied the bad value — better UX — and the requirement was rewritten to match.
4. **Two defects found by orchestrator review, not by any test** — both had passed the full suite
   green — fixed in `5183e56`:
   - The badge used `hidden sm:inline-flex`, so it **vanished below the `sm` breakpoint**. Wrong
     for a persistent safety signal, and inconsistent with `ReadOnlyBanner`, which never hides.
     Design never asked for it; it was an unreviewed addition during apply.
   - `aria-label` on a span that also carried the label as text content **overrides that content**
     for accessible-name computation, so assistive tech announced a generic string and **never**
     `production` / `staging` / `qa` — the one piece of information the badge exists to convey. The
     pre-existing test asserted the `aria-label` attribute, i.e. it confirmed the defect rather than
     catching it. Fixed by removing `aria-label` and composing the name from real content via an
     `sr-only` prefix.
5. **Evidence strengthened** (`1c3ae99`): the a11y fix was initially proven by a `textContent`
   inclusion proxy. The verify pass found that `@testing-library/jest-dom` v6 — already installed —
   ships `toHaveAccessibleName()`, which runs the real accessible-name computation. The assertion
   was upgraded and proven to catch the original defect: reintroducing `aria-label` fails exactly
   that one test and no other.

## Verification

CI is disabled in this repository (`.github/workflows-disabled/`), so local is the gate.
Independently re-run by the final verify pass:

| Command | Result |
|---------|--------|
| `pnpm build` | 10/10 Turbo tasks, exit 0 |
| `pnpm lint` | 19/19 Turbo tasks, exit 0 |
| `pnpm test` | 18/18 Turbo tasks, exit 0 |
| Studio vitest | 20 files / 123 tests, all pass |

Note: `pnpm lint` became a **real** signal on the frontend partway through this epic. A repo-wide
fix landed just before this change (`02aeb09`, merged in `370be7d`): `apps/studio`'s lint was
`tsc --noEmit` against a `files: []` root tsconfig with project references, so it typechecked
**zero** files. It is now `tsc -b --noEmit`.

## Spec changes merged into the source of truth

| Spec | Type |
|------|------|
| `openspec/specs/studio-environment-badge/spec.md` | **NEW** capability |
| `openspec/specs/studio-session-auth/spec.md` | **MODIFIED** — `GET /api/auth/status` widened a third time (after `readOnly`, then `queryTimeoutMs`/`queryRowCap`) |

## Follow-ups — NOT resolved

1. **SUGGESTION** — whitespace trimming has no dedicated live-server round-trip test; it is
   resolver-proven only (inherited from PR 1).
2. **SUGGESTION** — `Header.tsx` still renders a pre-existing **mock** "Environment / Cluster"
   dropdown that now shares a noun with the real badge. Design flagged it as out of scope and
   deliberately placed the real badge in the right-hand chip group so real server state is not
   adjacent to fake UI. Worth resolving in a future change.
3. The responsive-visibility fix can only be proven at the component layer by a class-list proxy —
   jsdom never evaluates media queries. Genuine proof needs a real-browser E2E tool, which this
   repository does not currently have.
4. The status probe's name now clearly lags what it reports: `GET /api/auth/status` carries
   `readOnly`, `queryTimeoutMs`, `queryRowCap` and `environment`. Renaming it was deliberately not
   folded into this change.

## Artifact note

The Engram copies of this change's proposal (#826), spec (#827) and tasks (#829) are **stale** —
all three files were amended on disk during the cycle. The archived files here are authoritative.
