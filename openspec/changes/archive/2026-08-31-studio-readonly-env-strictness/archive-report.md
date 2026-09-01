# Archive Report: Read-Only Env Var Strictness

**Change**: `studio-readonly-env-strictness`
**Archived to**: `openspec/changes/archive/2026-08-31-studio-readonly-env-strictness/`
**Date**: 2026-08-31

Not part of the "Auth and production guardrails" epic — a **defect fix found while closing it**,
in the first change that epic shipped.

## Executive Summary

`INDIGODB_STUDIO_READONLY=yes` silently left read-only mode **off**. No warning, no non-zero exit.
An operator who set it believing they had protected a production database had no protection and was
never told.

Worse, this was **normative**: `openspec/specs/studio-readonly-mode/spec.md` stated the lenient rule
as a requirement and carried a scenario, "Malformed env values do not enable read-only mode", that
explicitly blessed `"yes"`, `"1.0"` and the empty string resolving to `false`. The defect was
written into the contract, which is why this needed its own change rather than a quiet code edit
folded into a sibling.

Final verdict: **PASS WITH WARNINGS** — 0 CRITICAL, 1 WARNING (since addressed, see below).
7/7 spec scenarios COMPLIANT. `tasks.md`: **22/22 complete**. Single PR, 215/63 lines.

## Delivery

Single PR — no chaining. Branch `fix/studio-readonly-env-strictness`, commits `c75c7e2`
(implementation) and `48f2338` (assertion tightening), merged as `b28ce64`. Branch deleted.

## The fix

`resolveStudioReadOnly` now mirrors `resolveStudioAuditLog`'s accepted set:

| Value | Before | After |
|-------|--------|-------|
| `"1"`, `"true"` | read-only on | unchanged |
| `"0"`, `"false"` | off (via the catch-all) | off — **explicitly accepted** |
| anything else | off, **silently** | exit 1 before binding, naming the variable and the accepted values |

`isReadOnlyEnv` is deleted, absorbed into the single throwing resolver — a `boolean` return type
cannot express rejection, so it could not survive in any useful form. Design verified exactly two
importers before removing it.

### Why `"0"` and `"false"` had to stay accepted

The obvious fix — reject anything that isn't `"1"`/`"true"` — would have been a regression, not a
fix. Those two values resolve to off today via the catch-all, and that is precisely what an
operator who wrote them intended. Turning a correct, working configuration into a startup failure
is not hardening. Only genuinely ambiguous input rejects.

### Why the flag does not suppress env validation

`--read-only` is **enable-only**: it can add read-only mode but never turn it off, so it expresses
no intent to override the environment. A malformed `INDIGODB_STUDIO_READONLY` therefore exits
non-zero **even when `--read-only` is passed**.

This deliberately diverges from `resolveStudioAuditLog`, whose early-return on an explicit flag
exists because that flag *is* authoritative in both directions. Copying that shape here by inertia
would have swallowed a typo the operator never asked to suppress — and their next launch without
the flag would come up writable, with no warning. The same failure this change closes, merely
deferred.

The spec originally encoded the short-circuit; design argued against it and won, and the spec was
amended (`f118011`) before implementation.

## Findings worth keeping

**The throw was inert.** The resolver call sat **outside** `index.ts`'s `try/catch`, so making the
resolver throw would have produced an uncaught crash rather than a clean exit — or nothing useful
at all. Fixing the resolver alone would have shipped a change that looked complete and was not.
The wiring test's RED proved it directly: it failed with `❌ Schema file not found` instead of the
validation message, because the uncaught throw crashed the process before schema loading. A RED
that fails for the *revealing* reason is worth more than one that merely fails.

**A test that could not tell success from failure.** Verify raised a WARNING: the new `spawnSync`
wiring check asserted only `status === 1` plus a stderr regex — but Node also exits 1 on an
uncaught throw, and its stack trace contains the variable name the regex matched. Someone moving
the resolver call back outside the `try/catch` would have left the test **green**. The test could
not distinguish the two states it existed to distinguish.

Tightened in `48f2338`: it now requires the handled-error prefix and the *absence* of stack frames.
Proven by simulating that exact regression — moving the call back outside, rebuilding, observing
the failure, then restoring `index.ts` byte-identically and observing green again.

**The proposal was wrong and design caught it.** The proposal said every malformed-value check in
the existing test file should flip from "→ false" to "→ throws". But `"0"` and `"false"` were in
those lists and are *accepted* under the new contract. A blanket flip would have broken the
compatibility guarantee the change was built around — and the test file would have stayed green
while doing it. Design's Test Migration Plan is the authoritative source; verify independently
recounted and confirmed zero near-miss values were lost (9 distinct malformed values before, all 9
accounted for after: 2 became accepted-disable, 7 became rejections).

## Verification

CI is disabled in this repository, so local is the gate:

| Command | Result |
|---------|--------|
| `pnpm build` | 10/10 Turbo tasks, exit 0 |
| `pnpm lint` | 19/19 Turbo tasks, exit 0 |
| `pnpm test` | 18/18 Turbo tasks, exit 0 |

End-to-end against the built CLI in an empty temp cwd:

| Invocation | Result |
|------------|--------|
| `INDIGODB_STUDIO_READONLY=yes indigodb studio` | exit 1, `❌ INDIGODB_STUDIO_READONLY must be "1", "0", "true", or "false", got: "yes"` |
| same, plus `--read-only` | exit 1, same message — the flag does not suppress it |
| `=false` / `=1` | pass validation, proceed to schema loading |

## Spec change merged into the source of truth

`openspec/specs/studio-readonly-mode/spec.md` — **MODIFIED**. The "Read-only flag resolved once at
startup" requirement now states the accepted set and the fail-loud rule, and the scenario that
blessed the defect is gone, replaced by scenarios covering both halves of every accepted/rejected
pair plus the flag-with-malformed-env case. The denial-logging sentence that `studio-audit-log`
added to the write-gate requirement survived the merge intact.

## Notes

- The `--read-only` flag surface was deliberately not redesigned: no `--no-read-only`, no
  harmonising of other resolvers, no renames beyond the deletion. `openspec/config.yaml` names
  silent scope creep between adjacent Studio epics as this repository's most common review defect,
  and "while we're in `util.ts`" is exactly how it starts.
- Nothing here is published yet, so a behavior change that fails loudly is acceptable. Reasonable
  existing configurations (`1`, `true`, `0`, `false`, unset) are unaffected; only genuinely
  ambiguous values now fail, which is the entire point.
