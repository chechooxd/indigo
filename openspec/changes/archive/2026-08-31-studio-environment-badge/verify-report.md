```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:8986d9f8518170627bb4ba72d6b067754bb21d27024c699b7d5eb62a0ab6be5e
verdict: pass_with_warnings
blockers: 0
critical_findings: 0
requirements: 7/7
scenarios: 22/22
test_command: pnpm test
test_exit_code: 0
test_output_hash: sha256:8986d9f8518170627bb4ba72d6b067754bb21d27024c699b7d5eb62a0ab6be5e
build_command: pnpm build
build_exit_code: 0
build_output_hash: sha256:d58e93ac0729930fefc7661c0cb0c19b0d6512fcdf6d96a26bb044294dce581b
```

## Verification Report

**Change**: `studio-environment-badge`
**Scope**: FULL change — PR 1 (backend, merged to `main` as `c7bb472`) + PR 2 (frontend, branch
`feat/studio-environment-badge-2-frontend`, commits `d9a5241` + `5183e56`).
**Version**: N/A
**Mode**: Full artifacts (proposal + specs + design + tasks + apply-progress); Strict TDD active.

### Completeness

| Metric | Value |
|--------|-------|
| Tasks total | 18 |
| Tasks complete | 18 |
| Tasks incomplete | 0 |

Verified by direct `rg` count against `tasks.md`, not trusted from any self-report:
`- [x]` occurrences = 18, `- [ ]` occurrences = 0.

### PR 1 (backend) Re-Confirmation

`main` HEAD is `c7bb472` ("feat(studio): add environment badge resolver and status probe
field"), directly following `9e87e64`/`e14acd0` — the exact commits PR 1's own verify report
(`openspec/changes/studio-environment-badge/verify-report.md`) already reviewed and passed
(0 CRITICAL, 2 WARNING — both reporting-accuracy items in `apply-progress`, not code defects
— 1 SUGGESTION). `packages/cli/src/{util,index,studio-server}.ts` and both new `.mjs` suites
are intact and unchanged on `main`. PR 1's accepted findings are not re-litigated here.

### Build & Tests Execution (executed directly in this session, full stacked diff)

**Build**: ✅ Passed — `pnpm build --force`, 10/10 tasks successful, exit 0.

**Lint**: ✅ Passed — `pnpm lint --force`, 19/19 tasks successful, exit 0. `apps/studio`'s
lint is `tsc -b --noEmit` — a real typecheck signal, confirmed clean against the widened
`AuthStatus` contract and all fixed-up mock literals.

**Tests**: ✅ Passed — `pnpm test --force`, 18/18 Turbo tasks successful, exit 0
(~8m37s, forced/uncached, full monorepo). No `FAIL`/`not ok` line found anywhere in the
captured output (grepped the complete log; every `fail`/`failure` hit is a descriptive test
name, e.g. "a failing nested child write rolls back the parent").

Relevant sub-results directly confirmed in the log:
- `packages/cli/test/studio-environment-resolution.mjs` — 16/16 `ok` (rows 1–13, with rows
  8/10/11 each triangulated into 2 cases).
- `packages/cli/test/studio-environment.mjs` — probe-echo, null, pre-auth, non-enforcement
  (row 17), read-only+environment combo (row 18), and all 3 Gap A identical-response checks
  (`login`, an authenticated route, `POST /api/query`) — all `ok`.
- `apps/studio` (`vitest run`): **20 files, 123 tests, all passed** — matches
  `apply-progress`'s claimed count exactly, including `EnvironmentBadge.test.tsx` (9/9) and
  `App.test.tsx` (8/8, including the `readOnly:true` + `environment` collision regression).

**Coverage**: Not measured — no coverage tool configured in this project; not treated as a gap
per skill guidance.

### Spec Compliance Matrix

7 requirements / 22 scenarios across `specs/studio-environment-badge/spec.md` (6 req / 17
scenarios) and `specs/studio-session-auth/spec.md` delta (1 req / 5 scenarios).

| # | Requirement | Scenario | Test | Result |
|---|---|---|---|---|
| 1 | Env resolved once at startup | Neither set → resolver `undefined` / probe `null` | `studio-environment-resolution.mjs` row 3; `studio-environment.mjs` "reports environment: null" | ✅ COMPLIANT |
| 2 | Env resolved once at startup | `--env` beats `INDIGODB_ENV` | resolver row 1 | ✅ COMPLIANT |
| 3 | Env resolved once at startup | `INDIGODB_ENV` used when flag absent | resolver row 2 | ✅ COMPLIANT |
| 4 | Open label set | Each recognised label resolves + reaches probe (dev/staging/prod) | resolver rows 4–6; `studio-environment.mjs` echo test; `EnvironmentBadge.test.tsx` tone tests | ✅ COMPLIANT |
| 5 | Open label set | Unrecognised valid label (`qa`) resolves, no error, neutral badge | resolver row 7; `EnvironmentBadge.test.tsx` "qa … neutral tone" | ✅ COMPLIANT |
| 6 | Open label set | Case-insensitive match, verbatim casing (`Production`) | resolver row 13; `EnvironmentBadge.test.tsx` "recognises Production … verbatim … production tone" | ✅ COMPLIANT — styling AND text both proven (see Scrutiny §1) |
| 7 | Open label set | Whitespace trimmed before recognition | resolver row 12 (`" staging " → "staging"`) | ⚠️ PARTIAL — resolver-level only; no live-server round-trip test sends `INDIGODB_ENV=" production "` through the probe. Traceable by code inspection (single untransformed assignment `options.environment ?? null`). Carried forward as a SUGGESTION from PR 1's own report, not a new finding. |
| 8 | Open label set | Long valid label truncates with ellipsis, full value on hover | `EnvironmentBadge.test.tsx` "truncates a maximum-length label…" (32-char, `truncate` class + `title`) | ✅ COMPLIANT |
| 9 | Structurally invalid rejected | Empty/whitespace-only rejected, names actual source | resolver rows 8 (both paths), 9 | ✅ COMPLIANT |
| 10 | Structurally invalid rejected | Over-length rejected; 32 accepted / 33 rejected | resolver row 10 (both directions) | ✅ COMPLIANT |
| 11 | Structurally invalid rejected | Interior control char rejected | resolver row 11 (newline + tab) | ✅ COMPLIANT |
| 12 | Absent label renders no badge | Unset → no badge anywhere | `EnvironmentBadge.test.tsx` "renders nothing when environment is null" (empty container assertion) | ✅ COMPLIANT |
| 13 | Absent label renders no badge | Standalone dev, probe fails soft → no badge, no throw | `useAuthStore.test.ts` "leaves environment null when the probe fails soft… never throws" + null-render composition | ✅ COMPLIANT |
| 14 | Never an enforcement input | `--env production` does not enable read-only | `studio-environment.mjs` row 17 (write succeeds, `readOnly:false`) | ✅ COMPLIANT |
| 15 | Never an enforcement input | `--env production` does not alter auth/query guardrails | `studio-environment.mjs` Gap A ×3 (login, authenticated route, `POST /api/query` — byte-identical JSON body comparison across two independent live servers) | ✅ COMPLIANT — strong proof, not a weaker "still 200" check |
| 16 | Persistent badge in shell | Badge renders recognised label, distinct/most-prominent treatment | `EnvironmentBadge.test.tsx` production/staging/development tone-class assertions | ✅ COMPLIANT |
| 17 | Persistent badge in shell | Badge renders custom label verbatim, neutral treatment | `EnvironmentBadge.test.tsx` "qa" test | ✅ COMPLIANT |
| 18 (delta) | Status probe posture | `readOnly` correct across all 4 auth×readOnly combinations | `studio-readonly.mjs` "…correctly across all 4 combinations" (pre-existing, unaffected by this change, still green) | ✅ COMPLIANT |
| 19 (delta) | Status probe posture | Probe stays unauthenticated (200, not 401) when read-only active | `studio-readonly.mjs` combo test (password+readOnly, 200 body) | ✅ COMPLIANT |
| 20 (delta) | Status probe posture | `queryTimeoutMs`/`queryRowCap` reflect resolved startup values, no session | pre-existing `studio-query-guardrails.mjs`/`studio-query-resolution.mjs`, unaffected, still green | ✅ COMPLIANT |
| 21 (delta) | Status probe posture | `environment` reflects resolved startup value, no session | `studio-environment.mjs` "answers environment pre-auth" (password configured, no cookie, `environment:"production"`) | ✅ COMPLIANT |
| 22 (delta) | Status probe posture | `environment` is `null` when unset | `studio-environment.mjs` "reports environment: null when unset" | ✅ COMPLIANT |

**Compliance summary**: 21/22 fully COMPLIANT, 1 PARTIAL (scenario 7, whitespace trim — resolver-proven, no dedicated live-server round-trip; inherited unchanged from PR 1's own accepted SUGGESTION). No UNTESTED or FAILING scenario found across the full change.

### Correctness (Static Evidence) — PR 2 additions

| Requirement | Status | Notes |
|---|---|---|
| `RECOGNISED_TONES` complete static Tailwind strings, never interpolated | ✅ Implemented | `EnvironmentBadge.tsx:17-23`; lookup is `RECOGNISED_TONES[key] ?? NEUTRAL_TONE`, no string composition anywhere |
| Badge never uses `role="status"` | ✅ Implemented | `<span data-testid="environment-badge" …>` — grepped, no `role` attribute at all |
| `environment` never read in any enforcement path | ✅ Implemented | `rg -n "environment" packages/cli/src` shows only: option destructure, probe payload, startup `console.log` — zero references inside auth/read-only/guardrail logic |
| Mock fixups are additive only | ✅ Implemented | `useAuthStore.test.ts` and `App.test.tsx` diffs (see below) add `environment: <value>` to every existing literal; no removed/weakened assertion found |
| Header wiring — first item, right-hand chip group | ✅ Implemented | `Header.tsx` line 98-99, directly above the "Connection Diagnostics" pill |
| i18n keys added to both locales in the same task | ✅ Implemented | `en.json`/`es.json` both carry `environment.badge_aria` |

### Coherence (Design)

| Decision | Followed? | Notes |
|---|---|---|
| Structurally invalid bound (empty/>32/C0-DEL) | ✅ Yes | matches `util.ts` exactly (confirmed in PR 1 review, unchanged) |
| Trim + case-insensitive recognition, verbatim render | ✅ Yes | `EnvironmentBadge.tsx:58` — `.trim().toLowerCase()` for lookup, `{environment}` verbatim for render |
| Badge lives in Header's chip group, not a second banner | ✅ Yes | confirmed in `Header.tsx` |
| Static tone map, neutral `??` fallback | ✅ Yes | `Object.freeze(RECOGNISED_TONES)`, no interpolation |
| No `role="status"` on the badge | ✅ Yes | confirmed |
| Accessible name from real content, not `aria-label` (corrected during apply) | ✅ Yes | `EnvironmentBadge.tsx:66` — `sr-only` prefix span + verbatim value as sibling text, no `aria-label` attribute present |
| Always visible, no responsive `hidden` (corrected during apply) | ✅ Yes | `inline-flex` unconditional, `hidden` class list absent |

No design deviations found in the verified scope.

### Corrective Batch Verification (commit `5183e56`) — the two defects the orchestrator asked to confirm

1. **Responsive-hiding defect** — confirmed fixed. `EnvironmentBadge.tsx`'s className no longer
   contains `hidden sm:`; it is `inline-flex` unconditionally, width still bounded by
   `max-w-[16ch] truncate`. `EnvironmentBadge.test.tsx` asserts `classes.not.toContain('hidden')`
   and `classes.toContain('inline-flex')`. **Assessment of the proxy**: this is the best
   available proof at the component-test layer — jsdom does not evaluate media queries at all,
   so no unit/component/integration test in this stack can observe real viewport-conditional
   rendering; only a real-browser E2E tool (Playwright/Cypress, neither present in this
   project) could prove the visual claim directly. The class-list assertion is therefore a
   correctly-scoped proxy, not a shortcut that skipped a stronger option that was actually
   available. Noted as a SUGGESTION only in the sense that a future E2E layer would strictly
   improve it — not a gap in the current layer.

2. **`aria-label` overriding accessible name** — confirmed fixed. `aria-label` is fully removed;
   an `sr-only` prefix span (`{t('environment.badge_aria')}: `) precedes the verbatim
   `{environment}` text node, so with no `aria-label` present the accessible name correctly
   falls back to text content. **Verified the `dom-accessibility-api` claim directly**: ran
   `require.resolve('dom-accessibility-api')` from `apps/studio/package.json`'s context — it
   fails (`Cannot find module`), confirming it is genuinely unreachable as a direct import from
   `apps/studio` under pnpm's strict `node_modules` layout, even though two copies
   (`0.5.16`, `0.6.3`) exist in the workspace root's `.pnpm` store as transitive deps of
   `@testing-library/dom`. The `textContent`-inclusion proxy is therefore the strongest test
   achievable without adding a new direct devDependency; adding `dom-accessibility-api` (or
   `@testing-library/jest-dom`'s `toHaveAccessibleName` — already present as a jest-dom matcher
   as of v6, worth checking in a follow-up) would be a strictly stronger, real accessible-name
   computation. This is a genuine, actionable SUGGESTION, not a blocking gap: the current test
   does correctly catch the exact regression that shipped (re-adding `aria-label` would fail
   both the "no aria-label" assertion and, transitively, break the accessible-name contract).

### Additional Scrutiny Items (explicitly requested)

1. **Verbatim rendering + styling for `--env Production`**: proven at both halves.
   `resolveStudioEnvironment` returns `"Production"` unchanged (resolver row 13, backend).
   `EnvironmentBadge.test.tsx`'s "recognises 'Production' case-insensitively" test asserts BOTH
   `toHaveTextContent('Production')` (text half) AND `badge.className.toContain('rose')`
   (styling half — the production tone). Not a text-only check.
2. **Open label set (`qa`) end to end**: resolver never throws (row 7); server integration never
   rejects `qa` at startup (implicit — the resolver is the only gate, and row 7 already proves
   it does not throw); `EnvironmentBadge.test.tsx` renders `qa` verbatim with the neutral tone
   and explicitly asserts it does NOT pick up `rose`/`amber`. No regression from the amended
   open-label decision found anywhere in the stack.
3. **Static tone map**: `RECOGNISED_TONES` is `Object.freeze`d, keyed by lowercase name, values
   are complete literal Tailwind strings (e.g. `'bg-rose-950/60 border border-rose-800 text-rose-300 font-bold'`).
   No template-literal or string-concatenation class construction found anywhere in the file —
   confirmed by direct read, not grep alone.
4. **`role="status"` collision**: `App.test.tsx` line 110/128 use `screen.getByRole('status')`
   (singular, throws on >1 match). The dedicated collision regression (`readOnly:true` AND
   `environment:'production'` together) explicitly asserts `getByRole('status')` still resolves
   to exactly one node AND `getByTestId('environment-badge')` is separately present — this is a
   genuine regression test, not an assumption. The badge component itself carries no `role`
   attribute anywhere.
5. **Unset ⇒ no badge, never a default**: `useAuthStore`'s initial state and `AuthState.environment`
   default is `null` (not `'development'` or any string); `EnvironmentBadge` returns `null` via
   `if (!environment) return null;` — no fallback label path exists in the component.
6. **Non-enforcement**: `rg -n "environment" packages/cli/src` shows exactly 3 hits, none inside
   any auth/read-only/guardrail function — confirmed by direct read of `studio-server.ts`'s
   surrounding code, not just the grep count.
7. **Mock fixups purely mechanical**: read both full diffed files (`useAuthStore.test.ts`,
   `App.test.tsx`). Every pre-existing test body, assertion, and mock value is unchanged; the
   only edits are the added `environment: <value>` (usually `null`, once `'production'` for the
   new collision test) key on each `AuthStatus`-shaped literal, including the inline
   `resolveStatus` promise type. No assertion was loosened, removed, or had its expected value
   changed.
8. **Strict TDD honesty**: see TDD Compliance section below. The two design-mandated Tailwind
   class-fragment assertions (`toContain('rose')`/`'amber'`/`'zinc'`, `toContain('truncate')`,
   `not.toContain('hidden')`) are the documented, narrowly-scoped exception design calls out for
   the Tailwind JIT risk. The exception does not appear to have spread beyond what design
   requires — checked every `className`/`class` assertion in `EnvironmentBadge.test.tsx` and
   found none that assert layout/spacing/typography classes unrelated to tone or truncation.

### TDD Compliance

| Check | Result | Details |
|---|---|---|
| TDD Evidence reported | ✅ | Present in `apply-progress` (#830) for all phases, including the corrective batch's own RED/GREEN table |
| All tasks have tests | ✅ | 18/18 tasks map to a covering test file (backend: 2 `.mjs` suites; frontend: `useAuthStore.test.ts`, `App.test.tsx`, `EnvironmentBadge.test.tsx`) |
| RED confirmed (tests exist) | ✅ | All listed test files exist and were re-executed this session |
| GREEN confirmed (tests pass) | ✅ | Full monorepo `pnpm test` — 18/18 Turbo tasks, exit 0; `apps/studio` vitest 20/20 files, 123/123 tests |
| Triangulation adequate | ✅ | Resolver rows 8/10/11 each triangulated (2 cases); badge tone tests cover 3 recognised + 1 unrecognised + 1 case-insensitive, not a single case standing in for all |
| Safety Net for modified files | ✅ | Corrective batch explicitly records "7/7 pre-existing pass (baseline before edit)" in `apply-progress`'s TDD table for task 4.6; PR 1's own report already flagged the equivalent PR 1 gap as a non-blocking WARNING, not repeated here |

**TDD Compliance**: 6/6 checks passed.

### Assertion Quality Audit

Scanned `EnvironmentBadge.test.tsx`, `App.test.tsx`'s new/modified test, `useAuthStore.test.ts`'s
new/modified tests, and both backend `.mjs` files (already audited in PR 1's own report,
re-confirmed unchanged).

- No tautologies.
- No ghost loops.
- No assertions that skip production code — every test renders the real component or calls the
  real store action/API function.
- No ARIA/class assertions used *alone* without a companion value assertion — every tone-class
  check is paired with a `toHaveTextContent` value check in the same test.
- The two design-sanctioned CSS-class assertions (tone lookup, truncation, no-`hidden`) are the
  documented exception, not undisclosed implementation-detail coupling — see Scrutiny item 8.
- Mock/assertion ratio: `EnvironmentBadge.test.tsx` uses zero `vi.mock()` calls (only
  `useAuthStore.setState`, a real store); `App.test.tsx`/`useAuthStore.test.ts` mock only
  `../../lib/api`'s network boundary, consistent with the pre-existing pattern, not new
  over-mocking.

**Assertion quality**: ✅ All assertions verify real behavior. 0 CRITICAL, 0 WARNING.

### Test Layer Distribution (full change)

| Layer | Tests | Files | Tools |
|---|---|---|---|
| Unit | 16 | 1 (`studio-environment-resolution.mjs`) | plain Node `assert` |
| Integration | 8 | 1 (`studio-environment.mjs`) | real HTTP + PGlite-backed `withStudio` harness |
| Component | 18 | 3 (`EnvironmentBadge.test.tsx` 9, `App.test.tsx` +1 new/8 total, `useAuthStore.test.ts` +2 new/13 total) | Vitest + Testing Library, jsdom |
| E2E | 0 | 0 | Not installed in this project (Playwright/Cypress absent) |
| **Total (this change)** | **~42** | **5** | |

### Quality Metrics

**Linter/Type Checker**: ✅ No errors — `pnpm lint --force`, 19/19 tasks pass, including
`apps/studio`'s real `tsc -b --noEmit` against the widened `AuthStatus` contract.

### Diff Size vs Budget

PR 2 (`apps/studio` only): `git diff --numstat c7bb472..feat/studio-environment-badge-2-frontend -- apps/studio` = **260 additions + 8 deletions = 268 changed lines**, confirmed by direct re-run in this session — matches the orchestrator's stated ~268 and `apply-progress`'s own figure. Comfortably under the 800-line PR budget. Combined with PR 1's 492 lines (per PR 1's own verify report), the full change totals ~760 authored lines across 2 PRs — under budget for each individual PR slice and consistent with the stacked-PR strategy in `tasks.md`.

### Issues

**CRITICAL**: None.

**WARNING**: None new for PR 2. PR 1's own 2 WARNINGs (apply-progress diff-count reporting
accuracy; missing explicit pre-edit safety-net record) are pre-existing, already accepted in
PR 1's own verify report, and not re-raised here.

**SUGGESTION**:
1. Scenario "surrounding whitespace trimmed before recognition" is proven at the resolver layer
   plus a traceable single-assignment code path to the wire, but has no dedicated live-server
   round-trip test sending `INDIGODB_ENV=" production "` through `withStudio` and reading the
   probe. Carried forward unchanged from PR 1's own SUGGESTION; still not a functional gap.
2. The two corrective-batch tests are honestly-disclosed proxies. The `hidden`-class proxy is
   the best available proof at this test layer (jsdom cannot evaluate media queries) and would
   only be strengthened by adding a real-browser E2E tool, which this project does not have. The
   `aria-label`-absence + `textContent`-inclusion proxy is the best available proof without
   adding `dom-accessibility-api` (confirmed genuinely unreachable via direct `require.resolve`
   from `apps/studio` under pnpm's strict layout) as an explicit devDependency; `@testing-library/jest-dom`
   v6's `toHaveAccessibleName()` matcher may already be available as a lower-effort alternative
   and is worth checking in a follow-up, since it would compute the real accessible name rather
   than inferring it from the no-`aria-label` fallback rule.
3. `Header.tsx`'s pre-existing mock "Environment / Cluster" dropdown (`ENVIRONMENTS` from
   `../constants`) now shares a noun with the real server-sourced `EnvironmentBadge`. Flagged in
   design's own Open Questions as out of scope for this change; repeated here only so it is not
   lost before archive.

### Verdict

**PASS WITH WARNINGS** — 0 CRITICAL, 0 new WARNING (2 pre-existing/accepted from PR 1), 3
SUGGESTION.

The full stacked change (PR 1 backend + PR 2 frontend, 18/18 tasks, both corrective-batch
defects genuinely fixed and test-covered) is spec-compliant, design-coherent, and covered by
re-executed, currently-passing runtime tests: `pnpm build` (10/10), `pnpm lint` (19/19,
including `apps/studio`'s real typecheck), and `pnpm test` (18/18 Turbo tasks, 20/20 Studio
test files, 123/123 Studio tests, exit 0) all pass in a forced, uncached run in this session.
21/22 spec scenarios are fully COMPLIANT; the 1 PARTIAL (whitespace-trim end-to-end) is an
inherited, already-accepted SUGGESTION from PR 1, not a new or blocking gap. No CRITICAL issue
exists anywhere in the full change. Ready for `sdd-archive`.
