# Tasks: Studio schema write-back and editor diagnostics

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | PR #1a ≈ 285 authored (`splitDatasource` refactor, per-request GET, version header, `schemaPath` plumbing, `withSchemaFile`, `studio-schema-source.mjs`); PR #1b ≈ 440 authored (`PUT` route, gate generalization, audit types, atomic write, validation, diagnostic translation, `studio-schema-write.mjs`); PR #2 ≈ 350 authored (Studio Save UI, dirty tracking, markers, diagnostics panel, vitest) |
| 400-line budget risk | Low per slice; High if any slice were landed unsplit (the proposal's original PR #1 estimate landed at ~700–730 authored lines against this repo's real suite density, with no margin under the 800 budget) |
| Chained PRs recommended | Yes |
| Suggested split | PR #1a → PR #1b (targets #1a) → PR #2 (targets #1b) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Low per slice

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | `splitDatasource` refactor; `GET /api/schema/source` re-reads + re-redacts per request with a `version` header; `schemaPath` threaded into `StudioOptions` | PR #1a | `node packages/cli/test/studio-schema-source.mjs` | Plain-Node `.mjs`, no DB | Restore `publicSource` snapshot at the old call site, drop `splitDatasource`/`schemaPath` exports; nothing downstream depends on them yet — independently green, independently valuable (fixes the stale-snapshot bug alone) |
| 2 | `PUT /api/schema/source` — reattachment, staleness, atomic write, pre-write validation, diagnostic translation, read-only gate generalization, schema-write audit op | PR #1b | `node packages/cli/test/studio-schema-write.mjs` | Plain-Node `.mjs`, no DB | Drop the route, revert `isWriteRoute` to the `/api/rows/` prefix test; the Studio UI is untouched and keeps working against the PR #1a `GET` path |
| 3 | Studio Save UI: dirty tracking, markers, diagnostics panel, 409/reload/undo, disabled-with-reason | PR #2 | `pnpm --filter @indigodb/studio test` | Vitest | Reverts to today's read-only editor with no server-side change |

## Scenario Coverage Map (37/37)

Every scenario from all five capability spec files is listed once, with the task(s) that
implement and prove it. `SW-n`/`SD-n` are the design's Testing Strategy row IDs where one
exists; rows the design table does not itemize are marked `(new)`.

| Capability | Scenario | Design row | Task(s) |
|---|---|---|---|
| studio-schema-write | redactSource and the write path share one scanner | SW-17 | 1.1–1.2 |
| studio-schema-write | CLI invocation supplies schemaPath | — (structural) | 1.4 |
| studio-schema-write | An external edit is visible on the next GET | SW-2 | 1.3–1.4 |
| studio-schema-write | A round-trip preserves the datasource block byte-for-byte | SW-1 | 2.1–2.2, 2.32 |
| studio-schema-write | Deleting the sentinel line refuses the write | SW-6 | 2.7–2.8, 2.8b |
| studio-schema-write | A duplicated sentinel line refuses the write | SW-7 | 2.9–2.10, 2.10b |
| studio-schema-write | An inbound literal datasource block is refused, never persisted | SW-8 | 2.11–2.12 |
| studio-schema-write | A schema with no datasource block round-trips without a sentinel | SW-18 | 1.7, 2.14–2.15 |
| studio-schema-write | A concurrent external edit is caught before overwrite | SW-4 | 2.3–2.4 |
| studio-schema-write | No temp file is left behind after a successful write | SW-9 (success half, new) | 2.32 |
| studio-schema-write | No temp file is left behind after a rejected write | SW-9 | 2.16, 2.18 |
| studio-schema-write | A schema that fails to parse is never written | SW-9 | 2.16, 2.18, 2.19–2.20 |
| studio-schema-write | A schema that fails validation is never written | SW-9 (validation variant, new) | 2.17–2.18 |
| studio-schema-write | Embedder/test harness without a real file reports not writable | SW-15 | 2.27–2.28 |
| studio-schema-write | A real file path reports writable, subject to other gates | SW-15 (mirror, new) | 2.28 |
| studio-schema-write | A successful save shows a toast and clears the dirty flag | (new) | 3.21–3.22 |
| studio-schema-write | No success toast is ever shown for a non-2xx response | SD-7 | 3.19–3.20 |
| studio-schema-write | Save renders disabled with a reason when not writable | SD-4 | 3.11–3.12 |
| studio-editor-diagnostics | A syntax error produces a marker at the exact reported position | SD-1 | 3.1–3.2 |
| studio-editor-diagnostics | Fixing the error clears its marker | (new) | 3.3–3.4 |
| studio-editor-diagnostics | A validation error produces a panel entry, not a marker | SD-2 | 3.5–3.6 |
| studio-editor-diagnostics | No marker is fabricated at line 1 or via name search | SD-2 (strengthened, new) | 3.7–3.8 |
| studio-editor-diagnostics | A parse failure is visible on screen, not only in the console | (new) | 3.24 |
| studio-server-security | /api/schema omits datasource regardless of literal/env() URL | — (regression) | 1.11 |
| studio-server-security | /api/schema/source omits datasource, computed fresh each time | SW-2/SW-3 | 1.3–1.6 |
| studio-server-security | A literal datasource block in a write buffer never reaches disk/response | SW-8 | 2.11–2.12, 2.34 |
| studio-server-security | The real datasource block never appears in a response during reattachment | SW-1/SW-16 | 2.1, 2.29, 2.34 |
| studio-readonly-mode | All three row-write verbs are rejected identically from one gate | SW-13 (regression) | 2.24 |
| studio-readonly-mode | A schema write is refused by the same gate | SW-11 | 2.21–2.22 |
| studio-readonly-mode | A denied write emits an audit line marked as denied | SW-11 | 2.21–2.22, 2.31 |
| studio-readonly-mode | The 403 response body is unaffected by audit logging | — (regression) | 2.37 |
| studio-audit-log | A successful schema write is audited without content or path | SW-16 | 2.29–2.30 |
| studio-audit-log | A stale write is audited with reason "stale" | SW-4 (extended) | 2.31 |
| studio-audit-log | A sentinel/redaction conflict is audited with reason "redaction-conflict" | SW-6/7/8 (extended) | 2.31 |
| studio-audit-log | An invalid schema is audited with reason "schema-invalid" | SW-9 (extended) | 2.31 |
| studio-audit-log | The audit line never carries the schema file path | SW-16/SW-11 | 2.29, 2.21, 2.31 |
| studio-audit-log | Row-write audit entries are unaffected by the widened union | — (regression) | 2.37 |

Additionally: SW-12 and SW-13 are explicitly **not RED** (negative controls / regression
guards; see 2.23–2.24), and SD-3 is explicitly **not RED** (typecheck-only guard; see 3.9–3.10).
None of the three count toward either suite's `ran` total.

## Phase 1: PR #1a — `splitDatasource` refactor, per-request GET, version header

- [x] 1.1 RED: `packages/cli/test/studio-schema-source.mjs` — import `splitDatasource` (does not
      exist yet, suite import throws); assert the split/reconstruct property over ≥4 fixtures
      (single-line block, multi-line, nested braces, CRLF): `split(s).redacted === redactSource(s)`
      **and** `redacted` with its single sentinel line replaced by `block` equals `s` byte-for-byte
      (SW-17).
- [x] 1.2 GREEN: in `packages/cli/src/studio-server.ts`, hoist
      `export const DATASOURCE_SENTINEL = "// datasource redacted by Studio"` (the existing literal
      at `:356`); implement `splitDatasource(source) -> { redacted, block }` as the single
      brace-depth scanner; make `redactSource(s) = splitDatasource(s).redacted` a one-line wrapper
      with its exported signature unchanged. Make 1.1 green. Covers "redactSource and the write
      path share one scanner" and "CLI invocation supplies schemaPath" (structurally — the plumbing
      itself lands in 1.4).
- [x] 1.3 RED: `studio-schema-source.mjs` — GET is per-request: `GET /api/schema/source`, mutate
      the file on disk, `GET` again; assert the second body reflects the mutation (SW-2). Fails
      today: `:771` snapshots at startup, `:944` serves it — the second GET returns pre-mutation
      text.
- [x] 1.4 GREEN: thread `schemaPath` into `StudioOptions`/`startStudio`; wire
      `packages/cli/src/index.ts` (`schemaPath` already in scope at `:399`, one line) to pass it;
      make `GET /api/schema/source` read the file and call `splitDatasource` on every request when
      `schemaPath` is set; delete the startup `publicSource` snapshot at `:771`; fall back to
      `redactSource(options.source)` with no version header when `schemaPath` is absent (decision
      13). Make 1.3 green.
- [x] 1.5 RED: `studio-schema-source.mjs` — assert response header `X-Indigo-Schema-Version` is
      present and a 16-hex string; mutate the file; assert a different value on the next GET (SW-3).
      Fails today: no header is set.
- [x] 1.6 GREEN: publish `X-Indigo-Schema-Version = sha256(fileBytes).hex().slice(0, 16)` on GET
      when `schemaPath` is present (decision 5). Make 1.5 green.
- [x] 1.7 RED+GREEN: `studio-schema-source.mjs` — a fixture with no `datasource` block: `GET`
      returns it unchanged with no sentinel line (GET half of SW-18). Expected to pass once 1.2/1.4
      land unmodified — this is the read-side half of the "no datasource block" round-trip; the
      write-side half is 2.14–2.15.
- [x] 1.8 Add `withSchemaFile(contents, fn)` to `packages/cli/test/studio-harness.mjs` —
      `mkdtemp(join(tmpdir(), "indigo-studio-"))`, write `schema.indigo`, always `rm -rf` in
      `finally`; returns `{ dir, schemaPath, read: () => readFile(schemaPath, "utf-8") }`. This is
      **additive only** — `withStudio`'s existing signature and every existing call site are
      unmodified; `...options` at `studio-harness.mjs:103` already carries `{ schemaPath }` through.
      Confirm by diffing this commit against `studio-harness.mjs`: no existing exported function
      signature changes.
- [x] 1.9 Reachability guard: end `studio-schema-source.mjs` with a `ran`-counting `check()`
      variant (increment on entry, not on `failures`); run the suite and set
      `strictEqual(ran, N, "expected exactly N check() cases in studio-schema-source.mjs")` with `N`
      taken from the actual counted run — the design's `6` is provisional; do not hardcode it.
- [x] 1.10 Wire `studio-schema-source.mjs` into `packages/cli/package.json`'s `test` chain.
- [x] 1.11 Regression check (studio-server-security: "/api/schema omits datasource regardless of
      literal or env() URL"): run the existing `studio-server.mjs` suite unmodified; confirm the
      pre-existing `/api/schema` and `/api/schema/source` redaction cases still pass after the
      refactor — no edits to that file in this phase.
- [x] 1.12 Run `pnpm --filter @indigodb/cli test` — confirm 1.1–1.11 all green together with every
      pre-existing CLI suite. Rollback boundary: restore `publicSource` at the old call site and
      drop the new exports; nothing downstream depends on them at this point.

## Phase 2: PR #1b — `PUT /api/schema/source`

- [x] 2.1 RED (**the row that matters** — SW-1): `packages/cli/test/studio-schema-write.mjs` —
      `withSchemaFile` with a literal `postgres://user:pass@host/db` datasource; `GET` (assert the
      body has no credential and exactly one sentinel line); `PUT` that body plus a new
      `model Widget` with the fetched `version`; assert `200`; then `read()` the file back off disk
      and assert the on-disk text `.includes(originalDatasourceBlock)` as an **exact substring**
      and `.includes("model Widget")`. A `200` status alone is never accepted as proof. Fails
      today: no `PUT` route → falls through to the `/api/` catch-all → `404`, before ever reaching
      the disk assertion.
- [x] 2.2 GREEN: implement `reattachDatasource(buffer, block)` (decision 3 — exact-one-sentinel
      splice; deferred branches wired in 2.8/2.10/2.15) and a minimal `PUT /api/schema/source`
      route: inherited auth → parse JSON body → re-read the on-disk file → `splitDatasource(file)`
      → `reattachDatasource` → `parse`+`resolve` the reattached text → atomic write (temp file in
      the same directory, mode preserved, `rename`) → `200 {ok:true, version}`. Scope this task to
      only what 2.1 needs; staleness, the read-only gate, and audit logging are added by their own
      RED/GREEN pairs below, not assumed here.
- [x] 2.3 RED (SW-4): `studio-schema-write.mjs` — `GET` version, mutate the file externally, `PUT`
      the stale version; assert `409` **and** `read()` equals the externally-mutated text (not the
      submitted buffer).
- [x] 2.4 GREEN: re-read the file, recompute its content hash, compare against the submitted
      `version` before any write; mismatch → `409 {error}`, nothing written. Make 2.3 green.
- [x] 2.5 RED (SW-5, negative control): `studio-schema-write.mjs` — `PUT {source}` with no
      `version` field; assert `400` and `read()` unchanged.
- [x] 2.6 GREEN: require `source` and `version` to both be present strings; missing/non-string
      `version` → `400 invalid-request`, checked before the staleness comparison. Make 2.5 green.
- [x] 2.6b MUTATION (required, SW-5): temporarily change the check to
      `if (body.version && hash !== body.version)`. Run 2.5 and **record the observed outcome in
      this file** (expected: 2.5 turns red because a falsy/absent `version` now bypasses the
      comparison). If it does **not** turn red, that is a finding about the test, not a pass —
      strengthen 2.5 (e.g. also assert the written bytes differ from the submitted buffer) before
      moving on. Revert the mutation once recorded.
      — Observed outcome: **RED, as expected.** Combined mutation applied — dropped the
      version-type check entirely AND made the staleness comparison falsy-bypassable
      (`if (submittedVersion && currentVersion !== submittedVersion)`). Re-ran
      `node test/studio-schema-write.mjs`: `FAIL PUT: a missing version field is refused with 400,
      file unchanged (SW-5 negative control) — Error: expected 400, got 200`. The write succeeded
      silently with no `version` supplied. Mutation reverted; suite back to 19/19 green.
- [x] 2.7 RED (SW-6): `studio-schema-write.mjs` — submit a buffer with the sentinel line removed;
      assert `400`, error text contains the sentinel verbatim, `read()` unchanged.
- [x] 2.8 GREEN: implement the zero-sentinel branch of `reattachDatasource` — `400`, message quotes
      `DATASOURCE_SENTINEL` verbatim. Make 2.7 green.
- [x] 2.8b MUTATION (required, SW-6): temporarily change the zero-sentinel branch to append the
      block at the end of the buffer and write it instead of refusing. Run 2.7 and **record the
      observed outcome** (expected: red, because the appended text no longer matches the prior
      on-disk bytes / duplicates structure). Revert once recorded.
      — Observed outcome: **RED, as expected.** Re-ran `node test/studio-schema-write.mjs`:
      `FAIL PUT: deleting the sentinel line is refused with 400 naming the placeholder, file
      unchanged, audit reason redaction-conflict (SW-6) — Error: expected 400, got 200`. The write
      succeeded and appended the block instead of refusing. Mutation reverted; suite back to
      19/19 green.
- [x] 2.9 RED (SW-7): `studio-schema-write.mjs` — duplicate the sentinel line; assert `400` and
      `read()` unchanged.
- [x] 2.10 GREEN: implement the ≥2-sentinel branch — `400`, nothing written. Make 2.9 green.
- [x] 2.10b MUTATION (required, SW-7): temporarily change the ≥2-sentinel branch to "use the first
      match" (splice only the first occurrence, ignore the rest, and write). Run 2.9 and **record
      the observed outcome** (expected: red, because the written file no longer matches the
      unchanged-file assertion). Revert once recorded.
      — Observed outcome: **RED, as expected.** Re-ran `node test/studio-schema-write.mjs`:
      `FAIL PUT: a duplicated sentinel line is refused with 400, file unchanged, audit reason
      redaction-conflict (SW-7) — Error: expected 400, got 200`. The write succeeded using only the
      first sentinel match. Mutation reverted; suite back to 19/19 green.
- [x] 2.11 RED (SW-8): `studio-schema-write.mjs` — a buffer containing a real
      `datasource db { url = "postgres://…" }` block **and** the sentinel; assert `400`, `read()`
      unchanged, and the response body does not contain the submitted URL.
- [x] 2.12 GREEN: implement the inbound-credential guard (decision 4) — reject any buffer line
      matching `/^\s*datasource\b/` with `400 redaction-conflict`. **Ordering is load-bearing**:
      this guard MUST run **before** the sentinel count, so a buffer carrying both a real
      `datasource` block and the sentinel is always reported as `redaction-conflict`, never allowed
      to pass the count check and proceed. Make 2.11 green; confirm by re-running 2.9/2.7 to ensure
      the guard doesn't shadow their branches for buffers with no inbound `datasource` line.
- [x] 2.13 CRLF (required, decision 2): RED — `studio-schema-write.mjs` — a buffer whose sentinel
      line ends `\r\n` (CRLF-normalizing editor) must still round-trip successfully, not be treated
      as zero-sentinel. GREEN — sentinel matching strips **at most one** trailing `\r` before exact
      equality; anything looser (`trim()`/`includes()`) is explicitly rejected per decision 2. Add
      as its own case, not folded into 2.7–2.12.
- [x] 2.14 RED (SW-18, write half): `studio-schema-write.mjs` — a file with no datasource block:
      `PUT` of the buffer unchanged succeeds; `PUT` of a buffer that *adds* a sentinel line → `400`.
- [x] 2.15 GREEN: implement the `block === null` branch of `reattachDatasource` — sentinel present
      with `block === null` → `400`; sentinel absent → write the buffer verbatim. Make 2.14 green
      (combines with 1.7 for full SW-18 coverage).
- [x] 2.16 RED (SW-9, parse half): `studio-schema-write.mjs` — a buffer containing
      `model Broken { id Int @id` (unclosed); assert `422`, `parseErrors[0].line` is
      buffer-relative, `read()` unchanged, and `readdir(dir)` is exactly `["schema.indigo"]` (no
      temp file left, including for the rejected-write scenario).
- [x] 2.17 RED (validation half, distinct scenario from 2.16 — "a schema that fails validation is
      never written"): `studio-schema-write.mjs` — a buffer that parses but fails `resolve` (e.g.
      two models with the same name); assert `422` with `validationErrors`, `read()` unchanged,
      `readdir(dir)` unchanged. Do not let 2.16's parse-error case stand in for this: parse and
      resolve are different failure stages with a shared response shape.
- [x] 2.18 GREEN: wire `parse(reattached)` then `resolve(...)` before any temp-file write; a
      failure at either stage → `422` with that stage's diagnostics, and no temp file is ever
      created (validate strictly before `writeFileSync`, not after). Make 2.16 and 2.17 green.
- [x] 2.19 RED (**decision 7 — line-number translation, its own task, not folded into
      2.16–2.18**; SW-10): `studio-schema-write.mjs` — a 4-line datasource block on disk; break
      line 3 of the **buffer** (post-sentinel); assert `parseErrors[0].line === 3`, not
      `3 + blockLineCount − 1`. This is the row that would otherwise ship green with markers on the
      wrong lines if the translation is skipped.
- [x] 2.20 GREEN: implement diagnostic translation on every terminal error returned from 2.18 — for
      a 1-based reattached-relative line `L`: `L > sentinelIdx + blockLineCount` ⇒ report
      `L − (blockLineCount − 1)`; `L` inside the reattached block ⇒ return the error with **no
      position at all** (a validation-class entry, since that line is not visible in the user's
      buffer). Make 2.19 green. Add a second case in the same task asserting a block-internal error
      (break the *on-disk* datasource block externally) is returned position-less, not clamped to
      the sentinel line.
- [x] 2.21 RED (SW-11): `studio-schema-write.mjs` — `{ readOnly: true }`, capture stdout, `PUT` a
      valid buffer; assert `403`, `read()` unchanged, exactly **one** audit line
      `{op:"schema-write", outcome:"denied", reason:"read-only"}` with no `table` key, and the line
      contains neither the schema path nor `dir`.
- [x] 2.22 GREEN: generalize the read-only gate (decision 9) —
      `readOnly && isWriteRoute(path, method)` where
      `isWriteRoute = path.startsWith("/api/rows/") || (path === "/api/schema/source" && method !== "GET" && method !== "HEAD")`;
      place it after the auth gate and before route dispatch (not duplicated in the handler); denied
      audit op for the schema branch is `"schema-write"`. Make 2.21 green. This is the row that
      proves the gate generalization is necessary — a naive `PUT` route added without decision 9
      would answer `200` and write the file, since `:875`'s gate today is `/api/rows/`-prefixed.
- [x] 2.23 RED (SW-12, negative control — **explicitly not RED against the untouched tree**):
      `studio-schema-write.mjs` — `{ readOnly: true }`, `GET /api/schema/source`; assert `200`.
      This passes today (the route is not under `/api/rows/`); it is written as the harness for the
      mutation below, not as new coverage.
- [x] 2.23b MUTATION (required, SW-12): temporarily make `isWriteRoute` method-agnostic for the
      schema path (drop the `method !== "GET"` clause). Run 2.23 and **record the observed
      outcome** (expected: red — GET is now wrongly blocked). Revert once recorded. Document in
      this file that SW-12 passes against the untouched tree and is **not counted** toward
      `studio-schema-write.mjs`'s `ran` total as new coverage — its entire value is the mutation
      proof.
      — Observed outcome: **RED, as expected.** Re-ran `node test/studio-schema-write.mjs`:
      `FAIL GET /api/schema/source succeeds under readOnly:true (SW-12 negative control) — Error:
      expected GET 200 under read-only, got 403`. GET was wrongly blocked once `isWriteRoute`
      became method-agnostic for the schema path. Mutation reverted; suite back to 19/19 green.
      Confirmed: SW-12 passes against the untouched tree (see 2.23) and contributes zero new
      coverage on its own — its only value is this mutation proof, and it is not counted toward
      `studio-schema-write.mjs`'s 19-case `ran` total as new coverage (the 19 total does include
      the 2.23 `check()` call itself, since `ran` counts every executed case regardless of whether
      it was RED against the untouched tree; the negative-control framing here is about "new
      coverage" claims, not about the reachability guard's arithmetic).
- [x] 2.24 Regression guard (SW-13 — **not new coverage**): run the existing `studio-readonly.mjs`
      unrouted-verb case unmodified; confirm it still passes after the decision-9 gate refactor.
      Named as the regression guard for the generalization, not counted toward the write suite's
      `ran` total. Do not edit this file in this phase.
- [x] 2.25 RED (SW-14): `studio-schema-write.mjs` — `{ password, readOnly: true }`, `PUT` with no
      auth cookie; assert `401`, not `403`.
- [x] 2.26 GREEN: confirm/enforce the existing gate order (header check → session auth → read-only
      gate → route, `:845-895`) extends to the new route; fix ordering only if 2.25 fails, since the
      structural ordering already exists for `/api/rows/`.
- [x] 2.27 RED (SW-15): `studio-schema-write.mjs` — `withStudio` with no `schemaPath`; assert
      `schemaWritable: false` on `/api/auth/status`, `PUT` → `404`, `GET` → `200` from the
      in-memory `source`.
- [x] 2.28 GREEN: add `schemaWritable: schemaPath !== undefined` (decision 12 — **not**
      `&& !readOnly`) to the `/api/auth/status` body; `PUT` route responds `404` whenever
      `schemaPath` is absent, regardless of buffer content. Make 2.27 green. In the same task, add
      the mirror positive-case assertion (studio-schema-write's "a real file path reports writable,
      subject to other gates"): a read-only Studio with a real `schemaPath` still reports
      `schemaWritable: true` — writability and the read-only refusal are reported through separate
      fields.
- [x] 2.29 RED (SW-16): `studio-schema-write.mjs` — capture stdout across a successful `PUT`;
      assert exactly one line, `outcome:"ok"`, `count:1`, `bytes` equals the written byte length,
      and the line contains neither the schema path nor the connection string.
- [x] 2.30 GREEN: implement `buildSchemaAuditEntry(session, rest)` (decision 10) as a **separate**
      builder from `buildAuditEntry` — hardcodes `op:"schema-write"`, takes no `table`; wire
      `respondSchemaWrite(res, status, body, audit, entry)` so every terminal branch (200, 400,
      403, 404, 409, 422, 500) pairs its response with exactly one audit call, per the Route
      Contract table's reason column. Make 2.29 green, and retrofit 2.4/2.8/2.10/2.12/2.18/2.22's
      terminal branches to route through `respondSchemaWrite` so each already carries its correct
      audit reason (`stale`, `redaction-conflict` ×3, `schema-invalid`, `read-only`).
- [x] 2.31 Explicit audit-reason assertions (studio-audit-log scenarios 2–4 — do not let 2.3–2.18's
      status/bytes assertions stand in for these without an explicit audit-line check): extend
      2.3 (SW-4/stale), 2.7/2.9/2.11 (SW-6/7/8/redaction-conflict), and 2.16/2.17
      (SW-9/schema-invalid) to each additionally capture stdout and assert exactly one line with
      the matching `reason` and no `table` key.
- [x] 2.32 Atomic write (required, decision 8): RED — extend 2.1 (SW-1) with
      `readdir(dir)` asserting exactly `["schema.indigo"]` after the **successful** write too (2.16
      already covers the rejected-write case; the successful-write case is a separate spec
      scenario). GREEN — confirm `writeFileSync(tmp, text, { mode: statSync(schemaPath).mode })`
      then `renameSync(tmp, schemaPath)`, where
      `tmp = join(dirname(schemaPath), \`.${basename(schemaPath)}.studio-${pid}-${rand6}.tmp\`)` —
      **same directory as the target**, not `os.tmpdir()`. State why in a code comment:
      `rename(2)` is atomic only within one filesystem, and `os.tmpdir()` routinely crosses devices
      (`EXDEV`) on exactly the machines this was meant to protect. On any throw: best-effort
      `unlinkSync(tmp)`, then `500 io-error`. This is the first atomic write in this CLI — no
      precedent exists; it is deliberately not applied retroactively to `db pull` (out of scope).
- [x] 2.33 RED+GREEN: `studio-schema-write.mjs` — simulate a write/rename failure (e.g. stub
      `renameSync` to throw, or point at a non-writable directory) → assert `500 {error}`, audit
      line `reason:"io-error"`, and that a best-effort cleanup of the temp file was attempted.
      `"io-error"` is an `AuditReason` addition beyond the proposal's original list, required by
      decision 8's 500 branch.
- [x] 2.34 studio-server-security regression: extend 2.1 (SW-1) and 2.29 (SW-16) to explicitly grep
      the `PUT` response body for the literal connection string and assert its absence, beyond the
      existing `read()`-based on-disk assertions — covers "the real datasource block never appears
      in a response during reattachment".
- [x] 2.35 Reachability guard: end `studio-schema-write.mjs` with a `ran`-counting `check()`
      variant; run the suite and set `strictEqual(ran, N, "expected exactly N check() cases in
      studio-schema-write.mjs")` with `N` from the actual counted run — the design's `13` is
      provisional; do not hardcode it, and align the assertion's message text to the number set.
- [x] 2.36 Wire `studio-schema-write.mjs` into `packages/cli/package.json`'s `test` chain.
- [x] 2.37 Run `pnpm --filter @indigodb/cli test` — confirm 2.1–2.36 all green together with every
      pre-existing CLI suite unmodified (studio-server.mjs, studio-readonly.mjs, the existing audit
      suite) — satisfies studio-readonly-mode's "403 body unaffected by audit logging" and
      studio-audit-log's "row-write audit entries unaffected by the widened union" as regression
      guards, not new coverage. Rollback boundary: drop the route and revert `isWriteRoute` to the
      `/api/rows/` prefix test; the Studio UI still works against PR #1a's `GET` path alone.

## Phase 3: PR #2 — Studio Save UI

- [x] 3.1 RED (SD-1): `apps/studio/src/features/erd/__tests__/useERDParser.test.tsx` — render the
      hook with a known-bad source; assert one diagnostic with `source:'parse'` and the exact
      1-based `line`/`column`/`endLine`/`endColumn` from `ParseErrorDetail`. Fails today:
      `useERDParser.ts:63` is `console.warn`, the hook returns no diagnostics field.
- [x] 3.2 GREEN: replace the `console.warn` fallback with diagnostics state shared by the editor
      and the ERD canvas; map every `IndigoParseError.errors` entry to a `PositionalDiagnostic`.
      Markers must be cleared and replaced (not accumulated) on each re-parse. Make 3.1 green.
- [x] 3.3 RED (studio-editor-diagnostics: "fixing the error clears its marker" — distinct scenario
      from 3.1, not folded into it): extend `useERDParser.test.tsx` — after a marker is showing,
      edit the buffer to fix that error and re-parse successfully; assert the previously shown
      marker is removed, not merely superseded.
- [x] 3.4 GREEN: rebuild markers from scratch each parse under owner `"indigo"` (decision 17);
      `setModelMarkers(model, "indigo", [])` is the clear path when diagnostics are empty. Make 3.3
      green.
- [x] 3.5 RED (SD-2): `useERDParser.test.tsx` — a source that parses but fails `resolve`; assert
      `diagnostics.length === 1`, `source:'validate'`, `line === undefined`, and
      `toMarkers(diagnostics)` returns `[]`.
- [x] 3.6 GREEN: classify `ValidationError`-shaped failures (`{message, model?, field?}`, no
      position) as position-less diagnostics entries; no text-search inference, no line-1 fallback.
      Make 3.5 green.
- [x] 3.7 RED (strengthened SD-2, distinct assertion — "no marker fabricated via name search"):
      extend the 3.5 test with a validation error naming a `model` value that also happens to
      appear at a specific line in the buffer text; assert no marker appears at that line, and none
      at line 1 either. This proves absence of a name-search fallback specifically — `toMarkers ===
      []` alone does not.
- [x] 3.8 GREEN: confirm 3.6's classification performs no buffer text search for `model`/`field`
      names and no line-1 anchoring; fix only if 3.7 fails.
- [x] 3.9 RED — **explicitly not RED against the untouched tree** (SD-3):
      `apps/studio/src/features/erd/__tests__/markers.test.ts` — a `// @ts-expect-error` on
      `toMarkers([validationDiagnostic])`. Neither `toMarkers` nor `PositionalDiagnostic` exists
      yet, so the file simply fails to compile — there is no failing-test moment to observe, only a
      compile failure. Record this explicitly rather than treating it as a RED case; it becomes a
      real typecheck guard only after 3.10 lands.
- [x] 3.10 GREEN: implement `toMarkers(diagnostics: PositionalDiagnostic[])` with non-optional
      `line`/`column`/`endLine`/`endColumn`, and an `isPositional` filter narrowing `Diagnostic` to
      `PositionalDiagnostic`. Verified by `pnpm --filter @indigodb/studio lint` (`tsc -b --noEmit`
      — see 3.26), not by a runtime assertion.
- [x] 3.11 RED (SD-4): `apps/studio/src/features/erd/__tests__/DslEditorToolbar.test.tsx` — render
      with `schemaWritable:false`; assert the Save button is `disabled` and its `title` names the
      reason; then `dirty:false, schemaWritable:true` → still disabled; `dirty:true` → enabled.
      Fails today: the component takes only `{dslCode}` (`:16`) and renders no Save button.
- [x] 3.12 GREEN: add a Save button to `DslEditorToolbar` with disabled-with-reason logic and a
      saving state; `dirty` is passed in as a comparison result (decision 16), never recomputed
      locally. Make 3.11 green.
- [x] 3.13 RED: a unit test for `apps/studio/src/lib/api.ts`'s new shapes — `fetchSchemaSource`
      returns `Promise<{source, version} | null>` (BREAKING: was `Promise<string | null>`);
      `saveSchemaSource(source, version)` returns the discriminated union
      `{ok:true,version} | {ok:false,status,error,parseErrors?,validationErrors?}` and **never
      throws**. Place alongside the toolbar/page suites, or confirm during apply whether an
      existing `api.ts` test file already exists before creating a new one.
- [x] 3.14 GREEN: implement `fetchSchemaSource`, `saveSchemaSource`, `AuthStatus.schemaWritable`.
      Make 3.13 green; grep every existing call site of `fetchSchemaSource` and update it for the
      breaking return-shape change (`login()` at `api.ts:231` already establishes the
      non-throwing-with-discriminated-result style — follow it, don't invent a new one).
- [x] 3.15 RED (SD-5): `apps/studio/src/features/erd/__tests__/ERDDesignerPage.test.tsx` — mocked
      `saveSchemaSource` → `{ok:false,status:409}`; assert the conflict banner renders and the
      editor's `value` prop is byte-identical to the pre-save buffer. Fails today: no save path
      exists.
- [x] 3.16 GREEN: wire `ERDDesignerPage`'s `savedSource`/`version`/`dirty` state
      (`dirty = dslCode !== savedSource`, a comparison, not a flag — decision 16, so an undo back to
      the saved text correctly re-disables Save), the save handler, and the 409 banner. Make 3.15
      green.
- [x] 3.17 RED (SD-6): extend `ERDDesignerPage.test.tsx` — click Reload (mocked `GET` returns
      different text); assert the editor value is the disk text and the version updated; click
      Undo reload; assert the original buffer is restored.
- [x] 3.18 GREEN: implement Reload (replaces buffer + version token, stashes the pre-reload buffer
      in component state) and Undo reload (decision 14). Confirm **no** save-anyway/force-overwrite
      control is rendered anywhere in the 409 banner — this resolves proposal question 2 as no
      escape hatch. Make 3.17 green.
- [x] 3.19 RED (SD-7): extend `ERDDesignerPage.test.tsx` — mocked `saveSchemaSource` →
      `{ok:false,status:422}`; assert zero success toasts, the diagnostics panel has one entry, and
      `dirty` is still `true`. Guards this repo's recurring "silent no-op that looks green" failure
      mode.
- [x] 3.20 GREEN: wire the `422` path through the same diagnostics state as 3.2/3.6; no toast is
      shown on any non-2xx branch. Make 3.19 green.
- [x] 3.21 RED (studio-schema-write: "a successful save shows a toast and clears the dirty flag" —
      not itemized as its own row in the design's Testing Strategy table; do not let SD-5/6/7's
      negative-path coverage imply this positive path is tested): extend `ERDDesignerPage.test.tsx`
      — mocked `saveSchemaSource` → `{ok:true, version:"v2"}`; assert a success toast, `dirty`
      clears, and the new `version` is adopted for the next save cycle.
- [x] 3.22 GREEN: wire the `200` branch of the save handler — toast, `savedSource := dslCode`,
      `version := response.version`. Make 3.21 green.
- [x] 3.23 Create `apps/studio/src/features/erd/components/DiagnosticsPanel.tsx` — labelled
      entries; explicit "no source location" wording for validation-class diagnostics. Confirm
      3.6/3.20's panel-entry assertions render through this component rather than asserting on raw
      diagnostics state alone.
- [x] 3.24 studio-editor-diagnostics: "a parse failure is visible on screen, not only in the
      console" (integration check, not itemized separately in the design table): extend
      `ERDDesignerPage.test.tsx` (or `useERDParser.test.tsx` if it renders through the panel) to
      assert the diagnostics panel and/or markers are visible for a parse failure, checked without
      inspecting console output — ties 3.2's hook-level diagnostics to the rendered panel from
      3.23.
- [x] 3.25 Run `pnpm --filter @indigodb/studio test` (vitest) — confirm 3.1–3.24 all green.
      `markers.test.ts` (3.9/3.10) is a compile-time guard only, verified by 3.26, not counted in
      this run's pass count.
- [x] 3.26 Run `pnpm --filter @indigodb/studio lint` — **`tsc -b --noEmit`, not plain
      `tsc --noEmit`**, which typechecks zero files in this package. This is what actually gates
      SD-3.
- [x] 3.27 Run `pnpm --filter @indigodb/studio build` — confirm the app still builds with the
      breaking `fetchSchemaSource` shape change fully threaded through every call site. Rollback
      boundary: reverts to today's read-only editor with no server-side change.

## Phase 4: Cross-package verification

- [x] 4.1 Run `pnpm clean && pnpm build --force && pnpm lint && pnpm test` from the repo root.
      `--force` is mandatory: Turbo restores a cached `dist/` wholesale on a cache hit, and a bare
      `pnpm clean && pnpm build` has previously resurrected dead files from deleted packages in
      this repo.
- [x] 4.2 Confirm every regression guard named above stayed untouched and green on the final tree:
      1.11 (`studio-server.mjs`), 2.24 (`studio-readonly.mjs`), 2.37 (existing audit suite), and
      3.14's call-site updates are the only edits to pre-existing `fetchSchemaSource` consumers.
- [x] 4.3 Update `openspec/changes/studio-schema-write-back/proposal.md` Success Criteria
      checkboxes to checked, referencing this `tasks.md` as evidence.
- [x] 4.4 Record explicitly-out-of-scope items (not silently dropped):
      - Residual TOCTOU between the staleness re-read and the `rename`: two writers within
        milliseconds can both pass the staleness check; `rename` still guarantees the file is never
        a blend of the two. A real fix needs advisory locking, which has no precedent in this CLI;
        accepted for a single-operator dev tool.
      - `readBody`'s size cap is inherited unaudited from the existing route infrastructure, not
        newly introduced or newly bounded by this change. A cap, if needed, belongs in a separate
        change covering every route.
      - Migrate-from-UI is excluded per the proposal's scope note (b): `migrateDev()` has no
        data-returning seam and a destructive `--force` path with no read-only/audit coverage of
        its own; it needs its own design and does not block persistence, which is this change's
        actual dependency for `ERD becomes a designer`.
