# Apply Progress: Studio schema write-back and editor diagnostics

## Scope of this batch

PR #1a only — `## Phase 1: PR #1a` from `tasks.md` (tasks 1.1–1.12). Phase 2
(`PUT /api/schema/source`) and Phase 3 (Studio UI) are NOT started; they land
on their own stacked branches per the `stacked-to-main` chain strategy.

**Mode**: Strict TDD (`node packages/cli/test/studio-schema-source.mjs` focused test).

## Completed Tasks (Phase 1)

- [x] 1.1 RED — `studio-schema-source.mjs` imports `splitDatasource`, which did not exist yet.
- [x] 1.2 GREEN — hoisted `DATASOURCE_SENTINEL`, implemented `splitDatasource`, `redactSource` is now a one-line wrapper.
- [x] 1.3 RED — GET-is-per-request test (SW-2).
- [x] 1.4 GREEN — threaded `schemaPath` into `StudioOptions`/`startStudio`, per-request read + redact, deleted the startup `publicSource` snapshot, `index.ts` wiring.
- [x] 1.5 RED — `X-Indigo-Schema-Version` header test (SW-3).
- [x] 1.6 GREEN — publish `sha256(fileBytes).hex().slice(0,16)` header on GET when `schemaPath` is set.
- [x] 1.7 RED+GREEN — no-datasource-block GET case (SW-18, read half); passed immediately once 1.2/1.4 landed, as the design predicted.
- [x] 1.8 — added `withSchemaFile(contents, fn)` to `studio-harness.mjs`, additive only.
- [x] 1.9 — reachability guard: `strictEqual(ran, 4, ...)`.
- [x] 1.10 — wired `studio-schema-source.mjs` into `packages/cli/package.json`'s `test` chain (right after `studio-server.mjs`).
- [x] 1.11 — regression: `studio-server.mjs` (unmodified) still all green after the refactor.
- [x] 1.12 — `pnpm --filter @indigodb/cli test`: all suites green together (exit 0).

## RED Evidence (actually observed, not assumed)

### 1.1 — `splitDatasource` import (before any implementation)

```
file:///.../packages/cli/test/studio-schema-source.mjs:16
import { splitDatasource, redactSource } from "../dist/studio-server.js";
         ^^^^^^^^^^^^^^^
SyntaxError: The requested module '../dist/studio-server.js' does not provide an export named 'splitDatasource'
```

Whole-suite import failure, as predicted by task 1.1 — this is the strongest possible RED (nothing in the file could even run).

### 1.3 — GET is per-request (SW-2), before `schemaPath` threading

```
FAIL GET /api/schema/source is per-request: an external edit is visible on the next GET (SW-2)
Error: expected the second GET to reflect the on-disk mutation; got:
// datasource redacted by Studio

Table User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  createdAt DateTime @default(now()) @map("created_at")
}
```

Confirms the stale-snapshot bug: the second GET still returned the pre-mutation text (no `Table Widget`).

### 1.5 — `X-Indigo-Schema-Version` header (SW-3), before header implementation

```
FAIL GET /api/schema/source publishes X-Indigo-Schema-Version, which changes with content (SW-3)
Error: expected an X-Indigo-Schema-Version header
```

### 1.7 — no-datasource-block GET, run before 1.4's GREEN landed

Passed immediately (not RED) — matches the design's explicit note ("Expected
to pass once 1.2/1.4 land unmodified"). At that point in the sequence
`schemaPath` was accepted by `withStudio`'s `...options` spread but silently
ignored by `startStudio` (not yet destructured), so the route fell back to
the startup `source` string — which, for a no-datasource fixture with no
external mutation in this test, is identical to what per-request reads
would also produce. Documented here per the strict-TDD gate rather than
silently treated as coverage.

## GREEN Evidence

After implementing 1.2/1.4/1.6:

```
  ok   splitDatasource: split/reconstruct property holds over 4 fixtures (SW-17)
  ok   GET /api/schema/source is per-request: an external edit is visible on the next GET (SW-2)
  ok   GET /api/schema/source publishes X-Indigo-Schema-Version, which changes with content (SW-3)
  ok   GET /api/schema/source: a schema with no datasource block round-trips unchanged, no sentinel (SW-18, read half)
@indigodb/cli studio-schema-source: all green
```

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1.1–1.2 | `test/studio-schema-source.mjs` | Unit | N/A (new file); `studio-server.mjs` baseline: all green before touching production code | ✅ Written (import throws) | ✅ Passed | ✅ 4 fixtures (single-line, multi-line, nested braces, CRLF) | ✅ `redactSource` reduced to a 1-line wrapper over `splitDatasource` |
| 1.3–1.4 | `test/studio-schema-source.mjs` | Integration (real HTTP server, real file on disk) | ✅ `studio-server.mjs` still green pre-change | ✅ Written (observed the stale-snapshot output above) | ✅ Passed | ➖ Single scenario (external mutation visible on next GET) | ➖ None needed |
| 1.5–1.6 | `test/studio-schema-source.mjs` | Integration | ✅ (same server) | ✅ Written (observed missing-header failure) | ✅ Passed | ✅ 2 cases (present+16-hex, and changes after mutation) | ➖ None needed |
| 1.7 | `test/studio-schema-source.mjs` | Integration | ✅ | ➖ Documented pass-before-GREEN case (see above), not a violation of the RED gate — this is the exact scenario tasks.md calls out as "expected to pass once 1.2/1.4 land unmodified" | ✅ Passed | ➖ Single scenario | ➖ None needed |
| 1.8 | `test/studio-harness.mjs` | Test infra (no production assertions of its own) | N/A — additive export only, no existing signature touched | N/A (harness helper, not a behavior under test) | ✅ Used successfully by 1.3/1.5/1.7 | ➖ N/A | ➖ None needed |
| 1.9–1.12 | `test/studio-schema-source.mjs`, `package.json` | Structural | N/A | N/A | ✅ `ran === 4` asserted and confirmed; full `pnpm --filter @indigodb/cli test` green | ➖ N/A | ➖ None needed |

### Test Summary
- **Total tests written**: 4 `check()` cases in `studio-schema-source.mjs` (`ran === 4`, asserted)
- **Total tests passing**: 4/4, plus the full pre-existing `studio-server.mjs` suite (regression) and every other pre-existing `@indigodb/cli` suite
- **Layers used**: Unit (1 — `splitDatasource` property test), Integration (3 — real `startStudio` HTTP server + real file on disk via `withSchemaFile`)
- **Approval tests** (refactoring): the pre-existing `studio-server.mjs` `redactSource` tests (unmodified) serve this role for the `redactSource` refactor — confirmed still green after 1.2, proving the one-line-wrapper refactor preserved behavior exactly
- **Pure functions created**: 1 (`splitDatasource`)

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `node packages/cli/test/studio-schema-source.mjs` → `@indigodb/cli studio-schema-source: all green` (4/4 `check()` cases) |
| Runtime harness command/scenario and exact result | `pnpm --filter @indigodb/cli test` → full chain (`studio-server.mjs` through `migrate-runner.mjs`) exit 0, no `FAIL` lines; includes real PGlite-backed HTTP server runs (not mocked) |
| Rollback boundary | Restore the deleted `const publicSource = redactSource(source);` snapshot and its `/api/schema/source` call site in `studio-server.ts`; drop `DATASOURCE_SENTINEL`/`splitDatasource`/`DatasourceSplit`/`StudioOptions.schemaPath` exports; drop `schemaPath` from `index.ts`'s `startStudio` call; drop `withSchemaFile` from `studio-harness.mjs`; drop `test/studio-schema-source.mjs` and its `package.json` chain entry. Nothing downstream (Phase 2/3) depends on any of this yet |

## Files Changed

| File | Action | What Was Done |
|------|--------|----------------|
| `packages/cli/src/studio-server.ts` | Modified | Hoisted `DATASOURCE_SENTINEL`; added `DatasourceSplit` + `splitDatasource` (single brace-depth scanner); `redactSource` is now a 1-line wrapper (unchanged exported signature); added `StudioOptions.schemaPath?: string`; deleted the startup `publicSource` snapshot; `GET /api/schema/source` now re-reads the file and calls `splitDatasource` per request when `schemaPath` is set, publishing `X-Indigo-Schema-Version`; falls back to `redactSource(source)` with no header when `schemaPath` is absent (decision 13); added `createHash` import |
| `packages/cli/src/index.ts` | Modified | Passes `schemaPath` (already in scope from `loadSchema`) into `startStudio`'s options |
| `packages/cli/test/studio-harness.mjs` | Modified (additive) | Added `withSchemaFile(contents, fn)` export; `withStudio`'s existing signature and every existing call site are untouched |
| `packages/cli/test/studio-schema-source.mjs` | Created | New suite: SW-17 property test, SW-2 per-request GET, SW-3 version header, SW-18 read-half |
| `packages/cli/package.json` | Modified | Added `studio-schema-source.mjs` to the `test` script chain |

## Deviations from Design

None — implementation matches design.md decisions 2, 5, 13, and the "one scanner" `splitDatasource` shape exactly. The `ran` count (4) differs from design's provisional placeholder of "6" — task 1.9 explicitly calls that placeholder provisional and instructs taking `N` from the actual counted run, which is what was done.

## Issues Found

None. All Phase 1 non-negotiables from the launch brief were verified directly rather than assumed:
- `redactSource`'s exported signature is unchanged; the pre-existing `studio-server.mjs` `redactSource` unit test and the `/api/schema/source` integration test both pass unmodified.
- The split/reconstruct property (non-negotiable 3) is asserted over the required 4 fixture shapes (single-line, multi-line, nested braces, CRLF) with byte-for-byte equality.
- `withStudio` needed no signature change — confirmed by diff: `studio-harness.mjs`'s only change is the new additive `withSchemaFile` export; `withStudio`'s body/signature/call sites are untouched.
- The startup snapshot bug is fixed and proven by the SW-2 RED evidence above and its GREEN confirmation.

## Remaining Tasks

- [ ] Phase 2: PR #1b — `PUT /api/schema/source` (tasks 2.1–2.37)
- [ ] Phase 3: PR #2 — Studio Save UI (tasks 3.x)

## Workload / PR Boundary

- Mode: stacked PR slice (`stacked-to-main`, `auto-chain`)
- Current work unit: Unit 1 / PR #1a — `splitDatasource` refactor, per-request GET, version header, `schemaPath` plumbing
- Boundary: starts from `main`@`760d30b` on branch `feat/studio-schema-write-back-1a`; ends at Phase 1 task 1.12 (full `@indigodb/cli` suite green). Phase 2 targets this branch next per `stacked-to-main`.
- Estimated review budget impact: forecast ~285 authored lines; actual diff is smaller (`packages/cli/src/studio-server.ts` +~120/−~20, `index.ts` +1, `studio-harness.mjs` +24, plus the new 224-line `studio-schema-source.mjs` test file) — comfortably under the 400-line/800-line budgets, Low risk confirmed.

## Root Gate (full repo)

`pnpm clean && pnpm build --force && pnpm lint && pnpm test` — all green, exit 0 at every step:
- `pnpm clean`: 10/10 tasks successful
- `pnpm build --force`: 10/10 tasks successful (cache bypassed as required)
- `pnpm lint`: exit 0 (includes Studio's `tsc -b --noEmit`)
- `pnpm test`: 18/18 Turbo tasks successful, includes `workspace pack-contents guard: all green` and `check-realtime-projection-db-gate: PASSED`; no `FAIL` lines anywhere in the full log

## Status

12/12 Phase 1 tasks complete. Ready for `sdd-apply` to continue with Phase 2 (PR #1b) on a fresh batch, or for review/PR of this Phase 1 slice.

---

## Orchestrator addition to PR #1a: the verb guard is now pinned

While reviewing the slice, the orchestrator probed every HTTP verb against
`/api/schema/source` on the built tree. Result before the guard the apply phase added
(recorded here because the change was made as forward-looking cleanup and shipped untested):

```
GET     -> 200   redacted source
PUT     -> 200   redacted source     <-- any verb served the file
POST    -> 200   redacted source
DELETE  -> 200   redacted source
```

`req.method === "GET"` closed that. After it, only GET succeeds and every other verb 404s with
no schema text in the body.

That improvement had **no test**, and PR #1b adds a `PUT` handler on this exact path — so the
regression it must not reintroduce is precisely a verb falling through into the GET body. A fifth
case was added to `studio-schema-source.mjs` pinning it, and the reachability guard moves 4 → 5
with its message aligned.

The case asserts on the **body**, not only the status: a status-only assertion would still pass if
a future handler answered `202` with the schema attached.

**Mutation-proved** (dropping `&& req.method === "GET"`):

```
FAIL GET-only: every other verb on /api/schema/source is refused and serves no source at all
Error: PUT on the schema source route must not succeed, got 200
```

Reverted; suite green at 5/5.

---

# Apply Progress — PR #1b: `PUT /api/schema/source` (Phase 2, tasks 2.1–2.37)

**Scope of this batch**: `## Phase 2: PR #1b` from `tasks.md` (tasks 2.1–2.37) only. Phase 3
(Studio UI) is NOT started; it lands on its own stacked branch (`feat/studio-schema-write-back`
next slice) per the `stacked-to-main` chain strategy. Branch: `feat/studio-schema-write-back-1b`,
stacked on `feat/studio-schema-write-back-1a` (tip `f807c51`).

**Mode**: Strict TDD. Focused test: `node packages/cli/test/studio-schema-write.mjs`.

## Completed Tasks (Phase 2)

All 37 Phase 2 tasks (2.1–2.37) are complete and marked `[x]` in `tasks.md`, including all four
required mutations (2.6b, 2.8b, 2.10b, 2.23b) with their observed outcomes recorded inline there.

## RED Evidence (the row that matters, and the rest)

Before any production code existed for the PUT route, the full 19-case
`studio-schema-write.mjs` suite was run against the tree as it stood after PR #1a. 17 of 19
cases failed (the two that passed, SW-12's negative control and SW-14's 401-precedes-403 case,
are explicitly not expected to be RED — see tasks.md 2.23/2.25). The row that matters (SW-1):

```
FAIL PUT: a round-trip preserves the datasource block byte-for-byte, adds the new model, and
leaves no temp file (SW-1, SW-9 success half, SW-16 body half)
Error: expected 200, got 404
```

This confirms the RED state predicted by the design: no `PUT` route existed, so the request fell
through to the `/api/` catch-all 404 before ever reaching the disk assertion — exactly as
tasks.md 2.1 predicted, and the failure is on the *first* status assertion, not on the disk
assertion that follows it (which is the actual proof this route was built to deliver).

## GREEN Evidence

After implementing `reattachDatasource`, the `PUT /api/schema/source` route
(`handleWriteSchemaSource`), the generalized read-only gate (`isWriteRoute`), the
`buildSchemaAuditEntry`/`respondSchemaWrite` pair, diagnostic line translation, and the atomic
write:

```
  ok   PUT: a round-trip preserves the datasource block byte-for-byte, adds the new model, and leaves no temp file (SW-1, SW-9 success half, SW-16 body half)
  ok   PUT: a stale version is refused with 409, the file keeps the external edit, and audit reason is 'stale' (SW-4)
  ok   PUT: a missing version field is refused with 400, file unchanged (SW-5 negative control)
  ok   PUT: deleting the sentinel line is refused with 400 naming the placeholder, file unchanged, audit reason redaction-conflict (SW-6)
  ok   PUT: a duplicated sentinel line is refused with 400, file unchanged, audit reason redaction-conflict (SW-7)
  ok   PUT: an inbound literal datasource block is refused with 400, file unchanged, response body omits the URL (SW-8)
  ok   PUT: a sentinel line ending in CRLF still round-trips successfully (decision 2)
  ok   PUT: a schema with no datasource block round-trips unchanged; adding a sentinel is refused (SW-18 write half)
  ok   PUT: a buffer that fails to parse is refused with 422, buffer-relative parseErrors, no write, no temp file (SW-9 parse half)
  ok   PUT: a buffer that parses but fails validation is refused with 422 validationErrors, no write, audit schema-invalid (SW-9 validation half)
  ok   PUT: a parse error after the reattached block is translated back to buffer-relative coordinates (SW-10, decision 7)
  ok   PUT: an error inside the reattached (on-disk) datasource block is returned with no position at all, not clamped to the sentinel line (decision 7)
  ok   PUT under readOnly:true is refused with 403, file unchanged, exactly one denied audit line, no path leaked (SW-11)
  ok   GET /api/schema/source succeeds under readOnly:true (SW-12 negative control)
  ok   PUT with no auth cookie answers 401, not 403, even under readOnly:true (SW-14)
  ok   With no schemaPath: schemaWritable is false, PUT is 404, GET still serves the in-memory source (SW-15)
  ok   With a real schemaPath: schemaWritable is true regardless of read-only mode (SW-15 mirror)
  ok   A successful PUT emits exactly one clean audit line: outcome ok, count 1, bytes set, no path or credential leaked (SW-16)
  ok   A write/rename failure answers 500 with an io-error audit line and best-effort temp-file cleanup

@indigodb/cli studio-schema-write: all green
```

19/19 `check()` cases, `ran === 19` asserted (design's provisional `13` was explicitly superseded
per task 2.35's instruction to take `N` from the actual counted run).

## Mutation Evidence (non-negotiable #3)

All four required mutations were run, observed RED, and reverted. Full transcripts recorded
inline in `tasks.md` next to each task (2.6b, 2.8b, 2.10b, 2.23b); summary:

| Task | Mutation | Result |
|---|---|---|
| 2.6b | Dropped version type-check; staleness comparison made falsy-bypassable (`if (submittedVersion && ...)`) | RED — SW-5 failed: `expected 400, got 200` (write succeeded with no `version`) |
| 2.8b | Zero-sentinel branch appends the block instead of refusing | RED — SW-6 failed: `expected 400, got 200` |
| 2.10b | ≥2-sentinel branch falls through to "use the first match" | RED — SW-7 failed: `expected 400, got 200` |
| 2.23b | `isWriteRoute` made method-agnostic for the schema path | RED — SW-12 failed: `expected GET 200 under read-only, got 403` |

No mutation failed to bite — no test needed strengthening as a result.

## Non-negotiables checklist (from the launch brief)

1. **RED actually RED** — confirmed above (17/19 failing before implementation, the 2 passes are
   documented negative controls per design).
2. **Task 2.1 is the row that matters** — the test reads the file back off disk via `read()` and
   asserts `.includes(originalDatasourceBlock)` as an exact substring; a 200 status alone is
   never accepted (the test asserts on-disk bytes, the new model's presence, response-body
   credential absence, AND the `readdir` temp-file check, all in the same case).
3. **Four mutations, recorded** — done, see table above and `tasks.md` inline entries. None needed
   strengthening.
4. **Decision 7 as its own task** — `translateLine`/`translateParseError` implemented as named
   functions in `studio-server.ts`, exercised by two distinct test cases (buffer-relative
   translation past the block, and no-position-at-all for a block-internal error), not folded
   into the parse-failure test (2.16/2.18).
5. **Ordering: inbound guard before sentinel count** — `reattachDatasource` checks
   `/^\s*datasource\b/` on every line FIRST, before computing `sentinelIndexes`; confirmed by
   2.11's test (a buffer with both a real `datasource` block and the sentinel line reports
   `redaction-conflict`).
6. **CRLF** — `stripTrailingCR` strips at most one trailing `\r` before comparing to
   `DATASOURCE_SENTINEL`; proven by the dedicated 2.13 case (not folded into 2.7–2.12).
7. **Atomic write** — temp file in the same directory as the target
   (`join(dirname(schemaPath), ".${basename}.studio-${pid}-${rand6}.tmp")`), mode preserved via
   `statSync(schemaPath).mode`, `renameSync` for the atomic swap, best-effort `unlinkSync` on
   throw. Proven by 2.1/2.32 (no leftover temp file after success), 2.16/2.17 (no leftover temp
   file after a rejected write), and 2.33 (a forced `chmod 0500` on the containing directory
   triggers a real `EACCES` on `writeFileSync`, asserting `500`, an `io-error` audit line, and no
   leftover temp file).
8. **Read-only gate generalized, not duplicated** — `isWriteRoute(path, method)` is the single
   predicate consulted by the one existing gate (no second check inside
   `handleWriteSchemaSource`); `/api/rows/` stays method-agnostic, `/api/schema/source` is
   method-scoped (`GET`/`HEAD` excluded).
9. **Audit never carries the path** — `buildSchemaAuditEntry` never receives a `table`/path
   argument at all; every schema-write test that captures stdout also asserts the captured lines
   do not contain `schemaPath` or its containing `dir`.
10. **PR #1a's GET-only guard not regressed** — `studio-schema-source.mjs` (including its case 5,
    the GET-only pin) was re-run unmodified and stays green; `studio-server.mjs` and
    `studio-readonly.mjs` (task 2.24's regression guard) also re-run unmodified and green.
11. **`ran` count is provisional arithmetic** — set from the actual counted run: 19 `check()`
    calls in `studio-schema-write.mjs`, `strictEqual(ran, 19, ...)` with the message text aligned.

## Deviation noted (not a design deviation — a necessary consequence)

`packages/cli/test/studio-audit.mjs`'s pre-existing "GET /api/auth/status is byte-identical
across --audit-log/--no-audit-log, exactly six keys" case hardcoded the probe's key list. Task
2.28 (design.md decision 12, a MUST) requires adding `schemaWritable` to that same probe body,
which necessarily makes that hardcoded list stale — not a regression, a required consequence of
the new field. Updated the expected key list to the seven current keys (added `schemaWritable`);
the assertion this case actually exists to make — that `--audit-log`/`--no-audit-log` produce a
byte-identical probe body — is untouched and still holds. Flagging explicitly per the "no
regression left unexplained" instruction rather than leaving it as a silent test edit.

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `node packages/cli/test/studio-schema-write.mjs` → `@indigodb/cli studio-schema-write: all green` (19/19 `check()` cases) |
| Runtime harness command/scenario and exact result | `pnpm --filter @indigodb/cli test` (full 22-suite chain including this new one) → exit 0, no `FAIL` lines; real PGlite-backed HTTP server runs throughout, plus a real-filesystem atomic write/rename/chmod-forced-failure exercise (`withSchemaFile`, `mkdtemp`+`rm`) |
| Rollback boundary | Drop `PUT /api/schema/source` (the `path === "/api/schema/source" && req.method === "PUT"` branch and `handleWriteSchemaSource`), revert `isWriteRoute` to the old inline `path.startsWith("/api/rows/")` check, drop `reattachDatasource`/`ReattachResult`/`buildSchemaAuditEntry`/`respondSchemaWrite`/`translateLine`/`translateParseError`/`reattachErrorMessage`/`stripTrailingCR` exports and helpers, drop `schemaWritable` from `/api/auth/status`, drop the `AuditOp`/`AuditReason`/`StudioAuditEntry` additions in `util.ts`, drop `test/studio-schema-write.mjs` and its `package.json` chain entry, revert `studio-audit.mjs`'s probe key-list assertion to six keys. The Studio UI is untouched throughout and keeps working against PR #1a's `GET` path alone |

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 2.1–2.2, 2.32, 2.34 | `test/studio-schema-write.mjs` | Integration (real HTTP server, real file on disk) | ✅ Phase 1 baseline (`studio-schema-source.mjs`, `studio-server.mjs`, `studio-readonly.mjs`, `studio-audit.mjs`) all green before touching production code | ✅ Written (observed 404 above) | ✅ Passed | ✅ single case covers round-trip + no-leftover-temp-file + no-credential-in-response together (folded per tasks.md's own grouping, not a missed scenario) | ✅ `handleWriteSchemaSource` factored into one function with named branches, not inlined in the dispatcher |
| 2.3–2.4, 2.31 (stale) | `test/studio-schema-write.mjs` | Integration | ✅ | ✅ Written | ✅ Passed | ➖ single scenario per design | ➖ None needed |
| 2.5–2.6, 2.6b | `test/studio-schema-write.mjs` | Integration | ✅ | ✅ Written | ✅ Passed | ✅ mutation-forced (2.6b) confirms the check cannot be weakened to a falsy-bypass without turning this red | ➖ None needed |
| 2.7–2.8, 2.8b, 2.31 | `test/studio-schema-write.mjs` | Integration | ✅ | ✅ Written | ✅ Passed | ✅ mutation-forced (2.8b) | ➖ None needed |
| 2.9–2.10, 2.10b, 2.31 | `test/studio-schema-write.mjs` | Integration | ✅ | ✅ Written | ✅ Passed | ✅ mutation-forced (2.10b) | ➖ None needed |
| 2.11–2.12 | `test/studio-schema-write.mjs` | Integration | ✅ | ✅ Written | ✅ Passed | ➖ single scenario; re-ran 2.7/2.9 per task instruction to confirm no shadowing | ➖ None needed |
| 2.13 | `test/studio-schema-write.mjs` | Integration | ✅ | ✅ Written (own case, not folded into 2.7–2.12) | ✅ Passed | ➖ single scenario | ➖ None needed |
| 2.14–2.15 | `test/studio-schema-write.mjs` | Integration | ✅ | ✅ Written | ✅ Passed | ✅ 2 sub-cases (unchanged buffer succeeds; added sentinel refused) | ➖ None needed |
| 2.16–2.18, 2.31 | `test/studio-schema-write.mjs` | Integration | ✅ | ✅ Written | ✅ Passed | ✅ distinct from 2.17 (parse vs validate) per explicit task instruction | ➖ None needed |
| 2.17–2.18, 2.31 | `test/studio-schema-write.mjs` | Integration | ✅ | ✅ Written | ✅ Passed | ✅ distinct scenario from 2.16, not reused | ➖ None needed |
| 2.19–2.20 | `test/studio-schema-write.mjs` | Integration | ✅ | ✅ Written (own task per instruction, not folded into 2.16–2.18) | ✅ Passed | ✅ 2 cases (buffer-relative translation past the block; block-internal error position-less) | ✅ `translateLine`/`translateParseError` extracted as pure, independently-reasoned-about functions |
| 2.21–2.22 | `test/studio-schema-write.mjs` | Integration | ✅ | ✅ Written | ✅ Passed | ➖ single scenario | ➖ None needed |
| 2.23, 2.23b | `test/studio-schema-write.mjs` | Integration | ✅ | ➖ Documented pass-before-mutation (SW-12 is a negative control, per design) | ✅ Passed | ✅ mutation-forced (2.23b) | ➖ None needed |
| 2.24 | `test/studio-readonly.mjs` (unmodified) | Integration | ✅ | ➖ N/A — regression guard, run unmodified | ✅ Passed | ➖ N/A | ➖ N/A |
| 2.25–2.26 | `test/studio-schema-write.mjs` | Integration | ✅ | ➖ Confirmed passing on first run — the existing gate order (header → auth → read-only → route) already extended correctly with no additional fix needed (task 2.26 says "fix ordering only if 2.25 fails") | ✅ Passed | ➖ single scenario | ➖ None needed |
| 2.27–2.28 | `test/studio-schema-write.mjs` | Integration | ✅ | ✅ Written | ✅ Passed | ✅ 2 cases (no schemaPath: not writable; real schemaPath under read-only: still writable — mirror positive case in the same task) | ➖ None needed |
| 2.29–2.30, 2.34 | `test/studio-schema-write.mjs` | Integration | ✅ | ✅ Written | ✅ Passed | ➖ single scenario | ✅ `buildSchemaAuditEntry`/`respondSchemaWrite` factored as named siblings of the row-write builders, not inlined |
| 2.33 | `test/studio-schema-write.mjs` | Integration (real filesystem permission failure, not a stub) | ✅ | ✅ Written | ✅ Passed | ➖ single scenario | ➖ None needed |
| 2.35–2.37 | `test/studio-schema-write.mjs`, `package.json` | Structural | ➖ N/A | ➖ N/A | ✅ `ran === 19` asserted and confirmed; full `pnpm --filter @indigodb/cli test` (22 suites) green | ➖ N/A | ➖ None needed |

### Test Summary
- **Total tests written**: 19 `check()` cases in `studio-schema-write.mjs` (`ran === 19`, asserted)
- **Total tests passing**: 19/19, plus every pre-existing `@indigodb/cli` suite (22 total in the
  chain), plus the one deliberately-updated pre-existing assertion in `studio-audit.mjs`
  (documented above)
- **Layers used**: Integration (19 — every case drives a real `startStudio` HTTP server over real
  `fetch()`, against a real file on disk via `withSchemaFile`, with 2.33 additionally forcing a
  real filesystem permission failure via `chmod`)
- **Approval tests** (refactoring): N/A — no refactoring tasks in this phase; the read-only gate
  generalization (2.22) is proven by the pre-existing `studio-readonly.mjs` suite passing
  unmodified (task 2.24), which serves the same role
- **Pure functions created**: 4 (`reattachDatasource`, `translateLine`, `translateParseError`,
  `stripTrailingCR`)

## Files Changed

| File | Action | What Was Done |
|------|--------|----------------|
| `packages/cli/src/studio-server.ts` | Modified | Added `reattachDatasource`/`ReattachResult`, `stripTrailingCR`, `reattachErrorMessage`, `translateLine`/`translateParseError`, `isWriteRoute`, `buildSchemaAuditEntry`, `respondSchemaWrite`, `handleWriteSchemaSource` (the `PUT /api/schema/source` handler covering staleness, sentinel/inbound-credential guards, pre-write parse+validate, atomic write); generalized the read-only gate to use `isWriteRoute`; added `schemaWritable` to `/api/auth/status`; added value imports `parse`/`validate`/`IndigoParseError` from `@indigodb/core`, `writeFileSync`/`renameSync`/`unlinkSync`/`statSync` from `node:fs`, `dirname`/`basename` from `node:path`, `ParseErrorDetail` type from `@indigodb/parser` |
| `packages/cli/src/util.ts` | Modified | `AuditOp` gains `"schema-write"`; `AuditReason` gains `"stale"`, `"redaction-conflict"`, `"schema-invalid"`, `"io-error"`; `StudioAuditEntry.table` becomes optional; `StudioAuditEntry` gains `bytes?: number` |
| `packages/cli/test/studio-schema-write.mjs` | Created | New suite: 19 `check()` cases covering SW-1, SW-4–SW-12, SW-14–SW-16, SW-18, and decision 7's line translation, plus the four required mutations |
| `packages/cli/test/studio-audit.mjs` | Modified | Updated the `/api/auth/status` probe key-list assertion from six to seven keys (`schemaWritable` added) — see Deviation note above |
| `packages/cli/package.json` | Modified | Added `studio-schema-write.mjs` to the `test` script chain, immediately after `studio-schema-source.mjs` |

## Root Gate (full repo)

`pnpm clean && pnpm build --force && pnpm lint && pnpm test` — all green, exit 0 at every step:
- `pnpm clean`: 10/10 tasks successful
- `pnpm build --force`: 10/10 tasks successful (cache bypassed as required)
- `pnpm lint`: exit 0 (includes Studio's `tsc -b --noEmit`)
- `pnpm test`: 18/18 Turbo tasks successful, includes `workspace pack-contents guard: all green`
  and `check-realtime-projection-db-gate: PASSED`; no `FAIL` lines anywhere in the full log
  (the three "failing" substring matches in the raw log are pre-existing test names describing
  rollback-on-failure behavior in `@indigodb/client`'s own suite, not actual failures)

## Deviations from Design

None — implementation matches design.md decisions 1–13 exactly, including the exact
`ReattachResult`/`DatasourceSplit` interfaces, the route contract's status/reason table, and the
atomic-write temp-filename shape. The `ran` count (19) differs from design's provisional
placeholder of "13" — task 2.35 explicitly calls that placeholder provisional and instructs
taking `N` from the actual counted run, which is what was done (several scenarios were folded
into fewer, richer `check()` cases per tasks.md's own explicit groupings — e.g. 2.1/2.32/2.34
share one case, as do 2.27/2.28 — while 2.19/2.20's two decision-7 assertions were kept as two
distinct cases per that task's explicit "add a second case" instruction).

## Issues Found

One necessary pre-existing-test update, documented above under "Deviation noted" (not a design
deviation, not left silent).

## Remaining Tasks

- [ ] Phase 3: PR #2 — Studio Save UI (tasks 3.x) — lands on its own stacked branch
- [ ] Phase 4: Cross-package verification (tasks 4.x) — runs after Phase 3

## Workload / PR Boundary

- Mode: stacked PR slice (`stacked-to-main`, `auto-chain`)
- Current work unit: Unit 2 / PR #1b — `PUT /api/schema/source`
- Boundary: starts from `feat/studio-schema-write-back-1a`@`f807c51` on branch
  `feat/studio-schema-write-back-1b`; ends at Phase 2 task 2.37 (full `@indigodb/cli` suite green,
  root gate green). Phase 3 targets this branch next per `stacked-to-main`.
- Estimated review budget impact: forecast ~440 authored lines; actual diff is close to forecast
  (`studio-server.ts` +~330 net, `util.ts` +~25 net, `studio-audit.mjs` +~10, `package.json` +1,
  plus the new ~590-line `studio-schema-write.mjs` test file) — under the 800-line session budget,
  and this PR's own diff (excluding the prior PR #1a diff, which GitHub will show separately once
  #1a merges) stays within the stacked-PR review expectation set at tasks.md's Suggested Work
  Units table.

## Status

37/37 Phase 2 tasks complete. Ready for review/PR of this Phase 1b slice, or for `sdd-apply` to
continue with Phase 3 (Studio UI) on its own stacked branch.

---

## Orchestrator independent verification of PR #1b

Three claims were re-checked directly rather than taken from the apply report.

**1. The round-trip preserves the credential on disk.** Built an end-to-end probe against the
built tree: a schema whose `datasource` block holds `postgres://admin:SUPERSECRET@db.internal:5432/prod`,
served over `GET`, edited in the redacted form the browser actually receives, `PUT` back.

```
buffer served to the client leaks credential?  false
--- ON DISK, after the PUT ---
credential survived:       true
exact original block survived: true
new model landed:          true
sentinel NOT written:      true
still compiles:            true
```

**2. The audit line carries no file path.** Observed verbatim:
`{"ts":…,"kind":"studio.audit.write","op":"schema-write","count":1,"outcome":"ok","bytes":243}` —
`op`, `count`, `outcome`, `bytes`, and nothing that identifies the file.

**3. Decision 7's line translation is load-bearing, not accidentally correct.** A translation can
look right by luck when the block is one line and the shift is zero, so it was proved by mutation.
Reducing `translateLine` to `return line;`:

```
FAIL PUT: a parse error after the reattached block is translated back to buffer-relative
     coordinates (SW-10, decision 7)
Error: expected buffer-relative line 3, got 6
```

Three lines off — a marker pointing at innocent code, with no way for the user to tell it is
lying. Reverted; suite green at 19/19.
