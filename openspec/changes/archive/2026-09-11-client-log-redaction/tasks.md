# Tasks: Redact bound parameter values from client statement logging

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~120-160 (client.ts: ~20 prod + ~15 doc-comment; extensions.mjs: ~90-110 new test lines across 6 additive cases; spec.md delta already authored, not counted here) |
| 800-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
800-line budget risk: Low

This is a single function body, one call site, one doc comment across three sites, one
spec delta already authored, and additive test cases. Well under the 800-line project
budget (Engram #270) even generously estimated; no split needed.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Redact `wrapLog` params + doc comments + additive tests + spec delta, landed together | PR 1 (only PR) | `node packages/client/test/extensions.mjs` | N/A — hermetic `stubExecutor`, no DB gating required for this change | Single-commit revert of `client.ts:56-57,60-68,248-254`, `extensions.mjs` additions, and the spec delta restores prior behavior and prior canonical text together |

## Phase 1: RED — Failing tests for redaction (write first, confirm red)

- [x] 1.1 In `packages/client/test/extensions.mjs`, append (do not modify `:98-115`) a case for
      **Scenario 1**: non-empty params `["hunter2-SENTINEL"]` × `log: true` × no extensions.
      Capture `console.log` via the existing swap pattern (`:101-109`). Assert the sentinel is
      absent from every stringified captured arg (membership check, not property access), AND
      `args[2] === "$1=<redacted>"`, AND `args[1]` is the SQL. Confirm this fails red against
      today's `console.log("[indigodb]", sql, params)` (it will pass shape but the sentinel
      assertion must be written so a later revert-mutation check in 3.4 fails it correctly —
      run it now only to confirm the file loads and the harness works, not to prove redaction).
- [x] 1.2 Append a case for **Scenario 2**: non-empty params × `log: false` (and a second
      sub-case with `log` omitted entirely). Assert zero captured lines have
      `args[0] === "[indigodb]"`.
- [x] 1.3 Append a case for **Scenario 3**: non-empty sentinel params × an extension that
      rewrites `sql` to `"SELECT 1 -- rewritten"` (params passed through unchanged, non-empty).
      This is additive alongside `:98-115`, not a replacement — `:98-115` stays evidence for the
      SQL-rewrite requirement with its own empty-params fixture. Assert sentinel absent from
      captured stdout AND `args[1] === "SELECT 1 -- rewritten"`.
- [x] 1.4 Append a case for **Scenario 4** (empty params, non-sentinel): `log: true` with
      `params: []`. Assert `args[2] === "(0 params)"` and the captured args array still has
      exactly 3 positions.
- [x] 1.5 Append a case for **Scenario 5**: non-empty sentinel params × `log: true` on the
      `$transaction`/`$withSession` path. Inject `db: { exec, transaction: async (fn) => fn(exec) }`
      so `client.ts:304`'s composition is actually exercised, not assumed. Assert sentinel absent
      from captured stdout and placeholders present in the emitted line.
- [x] 1.6 Append a case for the multi-shape row: params `[new Date(), null, ["a", "b"], Buffer.from("x")]`
      × `log: true`. Assert every rendered position is the literal `<redacted>` with no
      shape-specific formatting (no `[object Object]`, no ISO date string, no array contents).
- [x] 1.7 Append a case asserting the base executor still receives real values: for any one of
      the above scenarios, read the stub's `calls[0].params` (per `stubExecutor`'s existing
      `calls` recording, `extensions.mjs:35`) and assert it holds the **unredacted** sentinel/
      real values — proving redaction is display-only and does not corrupt what reaches the DB.
- [x] 1.8 Run `node packages/client/test/extensions.mjs` and record that 1.1, 1.3, 1.5 fail red
      on the sentinel-membership assertion specifically (not on a `TypeError` and not on 1.2/1.4/
      1.6/1.7, which should already pass unchanged against today's code — 1.2/1.4/1.6/1.7 test
      shape/absence properties current code either already satisfies or is irrelevant to; only
      1.1/1.3/1.5 assert sentinel absence against a leak that exists today). Confirm the failure
      messages name the leaked sentinel value, not a stack trace.

## Phase 2: GREEN — Implement redaction

- [x] 2.1 In `packages/client/src/client.ts`, add module-scope function `redactParams(params: unknown[]): string`
      near `wrapLog` (not exported from `client.ts`, not re-exported from `src/index.ts`):
      returns the constant `"(0 params)"` when `params.length === 0`; otherwise
      `params.map((_, i) => \`$${i + 1}=<redacted>\`).join(", ")`, with the callback discarding
      its first argument so no parameter value is referenced in any branch.
- [x] 2.2 In `wrapLog` (`client.ts:249-254`), change `console.log("[indigodb]", sql, params)` to
      `console.log("[indigodb]", sql, redactParams(params))`. Keep argument position 0
      (`"[indigodb]"`) and position 1 (`sql`) unchanged; only argument 2 changes.
- [x] 2.3 Update the doc comment at `client.ts:56-57` (`log?: boolean`) to state: logs every
      executed statement's SQL for debugging; bound parameter values are never printed, only
      positional placeholders (`$1=<redacted>`) preserving order and arity; output format is a
      debugging aid, not a parsing contract.
- [x] 2.4 Update the `wrapLog` doc comment at `client.ts:248` to say it logs SQL plus redacted
      positional placeholders, never values.
- [x] 2.5 Update the `extensions` doc comment at `client.ts:60-68`: append "with parameter values
      redacted" to the existing "keeps logging the SQL actually sent" phrase; no other wording
      changes in that block.

## Phase 3: Mutation proof (mandatory, two-sided) and verification

- [x] 3.1 Temporarily revert `wrapLog` to `console.log("[indigodb]", sql, params)` (uncommitted
      local edit) and re-run `node packages/client/test/extensions.mjs`.
- [x] 3.2 Confirm rows 1, 3, and 5 (from 1.1, 1.3, 1.5) turn red **on their own sentinel-membership
      assertion**, with a failure message naming the leaked sentinel (e.g. "expected the sentinel
      to be absent from stdout; found it in: ..."). A red produced by a `TypeError` or any crash
      does not satisfy this step — if that happens, rewrite the assertion in the affected task
      (1.1/1.3/1.5) as a membership check over stringified captured args, not a property access
      that breaks on the reverted 3-argument shape, then repeat 3.1-3.2.
- [x] 3.3 Confirm rows 2, 4, 6, 7 (from 1.2, 1.4, 1.6, 1.7) do NOT depend on the redaction branch
      to pass/fail meaningfully — record their status under the revert as expected (2/6/7 may
      still pass or fail depending on shape; only 4 is expected to flip since `(0 params)` no
      longer prints). This distinguishes real mutation coverage from incidental passes.
- [x] 3.4 Revert the temporary mutation, restoring the `redactParams` call from 2.2. Re-run
      `node packages/client/test/extensions.mjs` and confirm all cases (existing `:98-115` plus
      1.1-1.7) pass green.
- [x] 3.5 Run `pnpm build && pnpm lint && pnpm test` from repo root and confirm green, including
      `@indigodb/client`'s full suite and the unrelated existing `:98-115`/`:117-129` cases
      unchanged.

## Phase 4: Spec landing

- [x] 4.1 Confirm `openspec/changes/client-log-redaction/specs/client-query-extensions/spec.md`
      (already authored, 1 MODIFIED requirement, 6 scenarios) reuses the exact title "Extension
      composition order and wrapLog placement" — no edits needed here, this task is a landing
      checkpoint so apply does not ship code without the delta present in the same change.
- [x] 4.2 Do not touch `openspec/specs/client-query-extensions/spec.md` (the canonical merged
      spec) directly — that merge is `sdd-archive`'s job, matching by the requirement title per
      `proposal.md`'s Risks table.
