# Design: Studio schema write-back and editor diagnostics

Verified live against `main` @ `7eb1621`: `studio-server.ts:39-106` (`StudioOptions`), `:326-373`
(`redactSource`, sentinel literal at `:356`), `:682-722` (`AuditContext`, `respondWrite`,
`buildAuditEntry`), `:845-895` (header check → auth gate → read-only gate), `:899-902`
(`/api/auth/status` body), `:937-946` (`/api/schema`, `/api/schema/source` serving the startup
snapshot), `:771` (`const publicSource = redactSource(source)`), `util.ts:383-419` (`AuditOp`,
`AuditReason`, `StudioAuditEntry`), `index.ts:399-414` (`loadSchema` → `resolveConnectionString`
→ `startStudio`, `schemaPath` in scope and dropped), `test/studio-harness.mjs:95-114`
(`withStudio` spreads `options` into `startStudio`), `test/studio-server.mjs:40-55` (`check`
counts `failures`, not `ran`), `apps/studio/src/lib/api.ts:103-112` (`fetchSchemaSource` checks
`text/plain`), `:44-54` (`AuthStatus`), `features/erd/ERDDesignerPage.tsx:21-28,110,119`,
`components/DslEditorToolbar.tsx:16` (props are `{dslCode}` only),
`hooks/useERDParser.ts:62-64` (`console.warn`).

## Three input corrections, verified before designing

1. **`withStudio` needs no modification.** `studio-harness.mjs:103` already does `...options`
   into `startStudio`, so `{ schemaPath }` flows through untouched. The prerequisite is a new
   **additive** export (`withSchemaFile`), not a change to the existing signature or to any
   existing call site. Stated because the launch brief assumed a modification.
2. **The "exactly one datasource block" invariant holds by construction for a running Studio.**
   A `datasource` block is not mandatory to the compiler, but `index.ts:400` calls
   `resolveConnectionString(resolved)` — which `process.exit(1)`s when there is no datasource url
   — one line before `startStudio` at `:401`. So the `block === null` branch is unreachable via
   the CLI and reachable only for embedders and tests. **Do not loosen the ≥2 / 0-sentinel
   refusals on the grounds that "a schema might not have a datasource"**: that observation is
   about a different code path than the one that can reach this route.
3. **Validation-error line numbers need translation.** Validation runs on the *reattached* text
   (decision 6), whose line numbering differs from the buffer's by `blockLineCount − 1` for every
   line after the sentinel. Reporting reattached-relative positions to Monaco would place markers
   on the wrong lines — a fabricated position by a second route. Decision 7 handles it.

## Technical Approach

One scanner, one sentinel, one gate. `redactSource` is refactored into `splitDatasource`, which
returns both halves of the same single brace-depth pass; `redactSource` becomes a one-line
wrapper. `GET /api/schema/source` re-reads and re-splits per request and publishes a content-hash
`version` header. `PUT /api/schema/source` splices the on-disk block back over a **literal
sentinel line** in the submitted buffer — no second scan exists to drift — then compiles the
result, then writes it via temp-file + `rename` in the same directory.

    GET  ─ read file ─▶ splitDatasource ─▶ .redacted            ─▶ 200 text/plain
                    └─▶ sha256(bytes)  ─▶ X-Indigo-Schema-Version

    PUT  ─ auth gate ─▶ write gate (readOnly) ─▶ schemaPath? ─404
           ─▶ body {source, version}                        ─400 invalid-request
           ─▶ re-read file ─▶ sha256 ≠ version               ─409 stale
           ─▶ splitDatasource(file) ─▶ {redacted, block}
           ─▶ reattach(source, block)                        ─400 redaction-conflict
           ─▶ resolve(parse(reattached))                     ─422 schema-invalid
           ─▶ writeFileSync(tmp, mode) ─▶ renameSync          ─500 io-error
           ─▶ 200 {ok:true, version: sha256(written)}
           every terminal branch ─▶ respondSchemaWrite ─▶ exactly one audit line

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| 1 | Split shape | `splitDatasource(source) → { redacted, block }`; `block: string \| null` is the original block text **including** the `datasource` header line and closing brace, `"\n"`-joined; `redacted` is today's output byte-for-byte. `redactSource(s) = splitDatasource(s).redacted` | two brace-depth scans (one redacting, one reattaching) kept in lockstep by discipline | The exploration's named drift hazard. Two scans that must agree is a review-time invariant; one scan producing both halves is a compile-time one. The reconstruction property `redacted.replace(sentinelLine, block) === source` is exactly true because `split("\n")`/`join("\n")` is lossless, and it is directly assertable (test SW-17) |
| 2 | Sentinel constant | `export const DATASOURCE_SENTINEL = "// datasource redacted by Studio"`, the existing literal at `:356`, hoisted. Inbound match is exact equality **after stripping at most one trailing `\r`** | `trim()`/`trimEnd()`/`includes()` matching | An editor or OS that normalizes to CRLF would otherwise turn every save into a 400 that the user cannot diagnose. Anything looser (`trim()`) would accept `  // datasource redacted by Studio  ` and silently move the block's indentation, or let a `includes()` match fire inside an unrelated comment |
| 3 | Reattachment algorithm | Scan the buffer for lines matching the sentinel. **0 → 400**, **≥2 → 400**, exactly 1 → `lines.splice(idx, 1, ...block.split("\n"))`. If `block === null`, any sentinel present → 400; otherwise the buffer is written verbatim | best-effort: append the block at 0, use the first match at ≥2 | At 0 the server does not know *where* the block belongs; appending reorders the user's file and dropping it deletes their connection string — both are silent data loss in the file this change exists to protect. At ≥2 the position is ambiguous **and** the write would produce two `datasource` blocks, i.e. a schema that does not compile and a credential duplicated into a file the user did not expect it in. "Use the first" silently discards whatever the user meant by the second. A refusal with the placeholder line quoted verbatim is recoverable in one edit; a wrong write is not recoverable at all |
| 4 | Inbound credential guard | Before the sentinel count, reject any buffer line matching `/^\s*datasource\b/` with 400 `redaction-conflict` | rely on the sentinel count alone | Ordering matters: a buffer carrying both a real `datasource` block **and** the sentinel would otherwise pass the count check and write a credential the client supplied. Checking first means an inbound credential is always the reported reason. This is the inbound half of the `studio-server-security` redaction requirement |
| 5 | Staleness token | `sha256` of the **full on-disk bytes**, hex, first 16 chars. `GET` publishes it as the response header `X-Indigo-Schema-Version`; `PUT` echoes it as the JSON body field `version`. A missing or non-string `version` is **400, never a bypass** | hash of the redacted text; `mtime`; ETag/`If-Match` semantics | Hashing the *redacted* text is invariant under an external edit that touches only the datasource block — precisely the case the startup snapshot was hiding — so the check would pass and then splice a block the user never saw. Full bytes catch every disk change. `mtime` has 1s granularity on some filesystems, is clock- and checkout-sensitive, trips on a no-op `touch`, and misses a same-second edit. Header on GET because the GET body must stay byte-exact `text/plain` — `api.ts:107` checks that content-type, and wrapping the source in JSON is a shipped-contract break for zero gain. Body field on PUT because that body is already JSON. Full `ETag`/`If-Match` semantics were rejected as more contract than this needs (no caching, no `W/`, no `*`) |
| 6 | What gets validated | The **reattached** text — the exact bytes about to hit disk — via `resolve(parse(text))` from `@indigodb/core` | the submitted buffer | The buffer's datasource block is a comment; validating it validates a text that is never written, and would fail or pass for reasons unrelated to the real file. The reattached text is the only input for which a green result means "the file on disk will compile" |
| 7 | Diagnostic coordinates | Parse errors are translated back to **buffer** coordinates before responding: for a 1-based line `L`, `L > sentinelIdx + blockLineCount` ⇒ `L − (blockLineCount − 1)`; `L` inside the reattached block ⇒ the error is returned **with no position at all**, as a validation-class entry | return reattached-relative positions; clamp block-internal errors to the sentinel line | An untranslated position is a fabricated position, the same defect this change refuses for validation errors. A block-internal error comes from the user's own on-disk datasource block (externally broken), which is *not visible in their buffer* — anchoring a marker at the sentinel would point at a line that is not the error. No position is the honest answer |
| 8 | Atomic write | `writeFileSync(tmp, text, { mode })` then `renameSync(tmp, schemaPath)`, where `tmp = join(dirname(schemaPath), \`.${basename(schemaPath)}.studio-${pid}-${rand6}.tmp\`)` and `mode` is copied from `statSync(schemaPath).mode`. On any throw: best-effort `unlinkSync(tmp)`, then 500 `io-error`. No `fsync` | `os.tmpdir()` + rename; plain `writeFileSync`; `fsync` before rename | Same-directory is load-bearing: `rename(2)` is atomic only within a filesystem, and `os.tmpdir()` is routinely a different device — the cross-device form fails with `EXDEV` on exactly the machines it was supposed to protect. Copying `mode` keeps a `0600` schema from being widened to the umask default. The leading `.` plus `.tmp` suffix keeps the temp file out of `*.indigo` globs and editor watchers. On a crash between write and rename the real file is **untouched** and a stray dot-file remains — the correct failure. `fsync` buys durability against power loss, which is not the threat; atomicity against a killed process is, and `rename` alone gives that. This is the first atomic write in the CLI; it is deliberately not applied retroactively to `db pull` (out of scope) |
| 9 | Read-only gate | Generalize `:875` to `readOnly && isWriteRoute(path, req.method)` where `isWriteRoute` is `path.startsWith("/api/rows/") \|\| (path === "/api/schema/source" && method !== "GET" && method !== "HEAD")`. Denied audit op for the schema branch is `"schema-write"` | add a second gate check next to the route; let the route inherit nothing and check itself | The shipped `studio-readonly-mode` requirement mandates **one** gate placed after auth and before dispatch, not duplicated in handlers. Generalizing the predicate honours that; a second check violates it. `/api/rows/` stays **method-agnostic** exactly as today (narrowing it would regress a shipped scenario); the schema route is method-scoped because `GET` on that same path must remain readable in read-only mode |
| 10 | Audit surface | `AuditOp` gains `"schema-write"`; `AuditReason` gains `"stale"`, `"redaction-conflict"`, `"schema-invalid"`, `"io-error"`; `StudioAuditEntry` gains `bytes?: number` and `table` becomes optional. A **separate** `buildSchemaAuditEntry(session, rest)` hardcodes `op` and takes no `table`; row writes keep `buildAuditEntry(op, table, …)` with `table: string` required. One `respondSchemaWrite(res, status, body, audit, entry)` couples response and log, mirroring `respondWrite` (`:703`) | make `table` optional on the shared builder | `table?: string` on the shared builder would let a row write forget its table and still typecheck. Two builders keep the optionality reachable only from the path that legitimately has no table. `"io-error"` is an addition beyond the proposal's list, required by decision 8's 500 branch |
| 11 | Audit content | Never the file path, never the file content, never the connection string. `{op:"schema-write", count: 0\|1, outcome, reason?, bytes?, session?}` | include `path` for operator traceability | A path carries a home directory and a private project name. In a single-schema Studio the path adds nothing an operator does not already know from the process they started. `count` mirrors the row-write meaning: files written, `1` on success, `0` on every refusal |
| 12 | `schemaWritable` probe | `/api/auth/status` gains `schemaWritable: boolean` = `schemaPath !== undefined`. **Not** `&& !readOnly` | fold read-only into the flag | Two orthogonal reasons need two distinct user-visible messages. Collapsing them makes a read-only Studio claim there is no schema file, which is false and unactionable |
| 13 | GET fallback with no `schemaPath` | Serve `redactSource(options.source)` (the startup string) with **no** version header; `PUT` → 404 | drop the `source` option | Embedders and every existing test construct `startStudio` without a path. Preserving that path keeps `withStudio`'s existing call sites green and makes the 404 a deliberate, probe-advertised state rather than a crash |
| 14 | `409` recovery UX | Buffer is never touched by a failed save. The banner offers **Reload from disk**, which replaces the buffer *and* the version token while stashing the pre-reload buffer in component state behind an **Undo reload** action for the session. **No save-anyway / force-overwrite affordance** | a "Keep my version" button that adopts the new token so the next Save overwrites | "Keep my version" is a force-overwrite with a friendly label: it discards another writer's committed work with no diff shown. Reload-plus-undo satisfies "the buffer is never discarded" — the user can always get their text back and copy it out with the existing Copy button — without adding an overwrite path. This resolves proposal question 2 as **no escape hatch** |
| 15 | Client save API | `saveSchemaSource(source, version)` returns a discriminated union `{ok:true, version} \| {ok:false, status, error, parseErrors?, validationErrors?}` and **never throws** | throw like `updateRow`/`createRow` | Every refusal has a distinct UI (decision table below). `throw new Error(body.error)` flattens five outcomes into one string and forces the caller to re-derive the status it just lost. `login()` (`api.ts:231`) already establishes the non-throwing style for exactly this reason |
| 16 | Dirty tracking | `dirty = dslCode !== savedSource` (a comparison, not a flag) | a boolean set by `onChange` | A flag stays `true` after the user undoes back to the saved text, so Save stays enabled and a no-op write hits disk and burns a version token. The comparison is correct by construction |
| 17 | Marker mapping | `toMarkers(diagnostics.filter(isPositional))` where the mapping function's parameter type is `PositionalDiagnostic` (line/column non-optional). Markers are rebuilt from scratch each parse under owner `"indigo"`; `setModelMarkers(model, "indigo", [])` is the clear path | one `Diagnostic` type with optional positions passed straight to the mapper | "Validation errors produce zero markers" becomes a `tsc` guarantee rather than a filter someone can delete. The owner string scopes the clear so nothing else's markers are wiped. Rebuild-from-scratch means a fixed error clears without a separate code path that could be forgotten |

## Interfaces

```ts
// packages/cli/src/studio-server.ts
export const DATASOURCE_SENTINEL = "// datasource redacted by Studio";

export interface DatasourceSplit {
  /** Byte-identical to today's `redactSource` output. */
  redacted: string;
  /** Original block text, header line through closing brace, "\n"-joined. `null` when absent. */
  block: string | null;
}
export function splitDatasource(source: string): DatasourceSplit;
export function redactSource(source: string): string;   // signature UNCHANGED — hard constraint

export type ReattachResult =
  | { ok: true; text: string }
  | { ok: false; reason: "inbound-datasource" | "no-sentinel" | "multiple-sentinels" };
export function reattachDatasource(buffer: string, block: string | null): ReattachResult;

export interface StudioOptions { /* …existing… */ schemaPath?: string; }
```

```ts
// packages/cli/src/util.ts
export type AuditOp = "insert" | "update" | "delete" | "schema-write";
export type AuditReason =
  | "read-only" | "invalid-request" | "not-found" | "db-error"
  | "stale" | "redaction-conflict" | "schema-invalid" | "io-error";
export interface StudioAuditEntry { /* … */ table?: string; bytes?: number; }
```

```ts
// apps/studio/src/lib/api.ts
export interface SchemaSource { source: string; version: string | null; }
export function fetchSchemaSource(): Promise<SchemaSource | null>;   // BREAKING: was Promise<string|null>
export type SaveSchemaResult =
  | { ok: true; version: string }
  | { ok: false; status: number; error: string;
      parseErrors?: ParseErrorDetail[]; validationErrors?: { message: string }[] };
export function saveSchemaSource(source: string, version: string): Promise<SaveSchemaResult>;
export interface AuthStatus { /* … */ schemaWritable: boolean; }
```

`redactSource`'s exported signature is unchanged, which is what makes PR #1a a pure refactor from
the `studio-server-security` spec's point of view and keeps `test/studio-server.mjs:18`'s import
working untouched.

### Route contract — `PUT /api/schema/source`

Request `{"source": string, "version": string}`. Gate order: header check → session auth
(inherited, `/api/*`) → read-only write gate → route.

| Status | Body | Reason | Audit `reason` |
|---|---|---|---|
| 200 | `{ok:true, version}` | written; `version` is the hash of the bytes just written | — (`outcome:"ok"`, `count:1`, `bytes`) |
| 400 | `{error}` | body not JSON, or `source`/`version` missing or not a string | `invalid-request` |
| 400 | `{error}` naming the placeholder line verbatim | inbound `datasource` declaration, or sentinel count ≠ 1 | `redaction-conflict` |
| 401 | `{error:"Authentication required"}` | auth gate, **before** the read-only gate | none (gate is upstream of the route) |
| 403 | `{error:"Studio is running in read-only mode"}` | read-only | `read-only` |
| 404 | `{error}` | no `schemaPath`, or the file no longer exists on `GET` | `not-found` |
| 409 | `{error}` | on-disk hash ≠ submitted `version`; also the ENOENT-at-PUT case | `stale` |
| 422 | `{error, parseErrors?, validationErrors?}` | reattached text does not compile | `schema-invalid` |
| 500 | `{error}` | write/rename failure | `io-error` |

Nothing is written on any non-200. `parseErrors` carry buffer-relative 1-based coordinates
(decision 7); `validationErrors` carry `{message}` only, forever, until the Rust validator gains
spans (recorded follow-up, out of scope).

## File Changes

| File | Action | Description | Authored lines | Slice |
|---|---|---|---|---|
| `packages/cli/src/studio-server.ts` | Modify | `DATASOURCE_SENTINEL`, `splitDatasource` + wrapper, delete `publicSource` (`:771`), per-request GET + version header, `schemaPath` option | ~+110 / −20 | 1a |
| `packages/cli/src/index.ts` | Modify | pass `schemaPath` (already in scope at `:399`) | ~+1 | 1a |
| `packages/cli/test/studio-harness.mjs` | Modify | additive `withSchemaFile` export (`mkdtemp`/`rm`); no existing signature changes | ~+22 | 1a |
| `packages/cli/test/studio-schema-source.mjs` | Create | split/reconstruction unit + per-request GET + version header suite | ~150 | 1a |
| `packages/cli/src/studio-server.ts` | Modify | `reattachDatasource`, PUT route, gate generalization, `respondSchemaWrite`, atomic write, pre-write compile, diagnostic translation, `schemaWritable` on the probe | ~+150 | 1b |
| `packages/cli/src/util.ts` | Modify | `AuditOp`, `AuditReason`, `table?`, `bytes?`, doc | ~+20 / −4 | 1b |
| `packages/cli/test/studio-schema-write.mjs` | Create | round-trip, refusals, gates, audit suite | ~270 | 1b |
| `packages/cli/package.json` | Modify | two suites into the `test` chain | ~+2 | 1a/1b |
| `apps/studio/src/lib/api.ts` | Modify | `fetchSchemaSource` return shape, `saveSchemaSource`, `AuthStatus.schemaWritable` | ~+60 / −8 | 2 |
| `apps/studio/src/features/erd/hooks/useERDParser.ts` | Modify | diagnostics state replacing `console.warn`; parse/validate classification | ~+45 / −3 | 2 |
| `apps/studio/src/features/erd/ERDDesignerPage.tsx` | Modify | `savedSource`/`version`/dirty, save handler, markers, 409 banner + reload/undo, diagnostics panel wiring | ~+120 | 2 |
| `apps/studio/src/features/erd/components/DslEditorToolbar.tsx` | Modify | Save button, disabled-with-reason, saving state | ~+45 | 2 |
| `apps/studio/src/features/erd/components/DiagnosticsPanel.tsx` | Create | labelled entries; "no source location" for validation-class | ~55 | 2 |
| `apps/studio/src/features/erd/__tests__/*.test.tsx` | Create/Modify | 7 vitest cases | ~180 | 2 |
| `openspec/changes/.../specs/**` | (exists) | authored by `sdd-spec` | ~180 | 1a/1b |

### Slice boundary — revised from the proposal's two PRs to three

The proposal forecast PR #1 at ~630. Counted against this repo's actual suite density (18 CLI
cases at this file's verbosity is ~420 test lines, not 260), PR #1 lands at ~700–730 — under 800
but with no margin, and a single revert of it would take the GET correctness fix down with the
route. Revised:

- **PR #1a (~285)** — `splitDatasource` refactor, per-request GET, version header, `schemaPath`
  plumbing, `withSchemaFile`, `studio-schema-source.mjs`, GET-side spec deltas.
  *Independently green*: no new route, `redactSource`'s signature and output are unchanged, all
  existing suites pass untouched. *Independently valuable*: it alone fixes the stale-snapshot bug.
  *Revertible*: restore `publicSource` at `:771`; nothing depends on the new exports yet.
- **PR #1b (~440)** — PUT route, gate generalization, audit types, atomic write, validation,
  `schemaWritable`, `studio-schema-write.mjs`, write-side spec deltas.
  *Independently green*: ships behind `schemaWritable`; the Studio is untouched and still works.
  *Revertible*: drop the route and revert `isWriteRoute` to the prefix test.
- **PR #2 (~350)** — Studio UI, markers, diagnostics panel, vitest.
  *Revertible*: reverts to today's read-only editor with no server change.

`Decision needed before apply: No` (strategy is cached `auto-chain` / `stacked-to-main`).
`Chained PRs recommended: Yes`. `400-line budget risk: High` for a single PR; each of the three
slices is under the 800-line session budget, and 1a is under 400.

## Testing Strategy

**Where.** `packages/cli/test/studio-schema-source.mjs` and `studio-schema-write.mjs` are plain
Node `.mjs` (`node test/<file>.mjs`), appended to `packages/cli/package.json`'s `test` chain.
Studio rows are `vitest` under `apps/studio/src/features/erd/__tests__/`, run by
`pnpm --filter @indigodb/studio test`. No row needs a real Postgres: `withDatabase` is PGlite and
no scenario here touches SQL.

**The fixture.** `withSchemaFile(contents, fn)` does `mkdtemp(join(tmpdir(), "indigo-studio-"))`,
writes `schema.indigo`, and always `rm -rf`s in `finally`. It hands back
`{ dir, schemaPath, read: () => readFile(schemaPath, "utf-8") }`. Tests then call the **existing**
`withStudio(db, {resolved, source}, fn, { schemaPath })` — `...options` at `studio-harness.mjs:103`
carries it through with no harness signature change. `read()` is the assertion surface that makes
"read the file back off disk" possible at all; a 200 response is never accepted as proof.

**Reachability guard.** `check()` in this repo (`studio-server.mjs:42`) counts `failures`, not
`ran` — a skipped or accidentally-deleted case is invisible. Both new suites use a `ran`-counting
variant (increment on entry) and end with `strictEqual(ran, N, "expected exactly N check() cases
in <file>")`. **The counts below are provisional**: per this repo's history of count drift, apply
MUST set `N` from an actual counted run rather than from this table. Provisional:
`studio-schema-source.mjs` → 6, `studio-schema-write.mjs` → 13.

| ID | Behavior | Test (file + case) | How it FAILS against the untouched tree |
|---|---|---|---|
| SW-1 | **The row that matters** — datasource survives byte-for-byte | `studio-schema-write.mjs` — `withSchemaFile` with a literal `postgres://user:pass@host/db`; GET (assert the body has no credential and exactly one sentinel line); PUT the body plus a new `model Widget`; then `read()` and assert the on-disk text `.includes(originalDatasourceBlock)` **as an exact substring** and `.includes("model Widget")` | No PUT route → the request falls through to `:1115`'s `/api/` catch-all → 404. Fails on status before it can even reach the disk assertion |
| SW-2 | GET is per-request | `studio-schema-source.mjs` — GET, mutate the file on disk, GET again; assert the second body reflects the mutation | `:771` snapshots at startup and `:944` serves it; the second GET returns the pre-mutation text. Fails |
| SW-3 | Version header published and changes with content | `studio-schema-source.mjs` — assert `X-Indigo-Schema-Version` present and a 16-hex string; mutate the file; assert a different value | No header is set today. Fails on the first assertion |
| SW-4 | Stale version → 409, file unchanged | `studio-schema-write.mjs` — GET version, mutate the file externally, PUT the old version; assert 409 **and** `read()` equals the externally-mutated text (not the submitted buffer) | 404, no route. Fails |
| SW-5 | **Missing `version` is not a bypass** (negative control) | `studio-schema-write.mjs` — PUT `{source}` with no `version`; assert 400 and `read()` unchanged | 404 today. Its real bite is mutational: making the check `if (body.version && hash !== body.version)` must turn this red. Tasks MUST run that mutation |
| SW-6 | Sentinel deleted → 400, file unchanged | `studio-schema-write.mjs` — submit a buffer with the sentinel line removed; assert 400, error text contains the sentinel verbatim, `read()` unchanged | 404 today. Mutation proof required: downgrading the refusal to "append the block" must make the `read()` assertion fail |
| SW-7 | Two sentinels → 400, file unchanged | `studio-schema-write.mjs` — duplicate the sentinel line; assert 400 and `read()` unchanged | 404 today. Mutation proof: "use the first match" must make this fail |
| SW-8 | Inbound `datasource` → 400 | `studio-schema-write.mjs` — buffer with a real `datasource db { url = "postgres://…" }` **and** the sentinel; assert 400, `read()` unchanged, and the response body does not contain the submitted URL | 404 today. Ordering-sensitive: with the guard placed after the sentinel count, the sentinel is present and the write would proceed — so this row also bites a plausible wrong implementation |
| SW-9 | Invalid schema → 422, no temp file left | `studio-schema-write.mjs` — buffer with `model Broken { id Int @id` (unclosed); assert 422, `parseErrors[0].line` is buffer-relative, `read()` unchanged, and `readdir(dir)` is exactly `["schema.indigo"]` | 404 today. The `readdir` half additionally bites an implementation that writes the temp file before validating |
| SW-10 | Diagnostic line translation | `studio-schema-write.mjs` — a 4-line datasource block on disk; break line 3 of the **buffer**; assert `parseErrors[0].line === 3`, not `3 + blockLen − 1` | 404 today. This is the row that catches decision 7 being skipped, which would otherwise ship green with markers on wrong lines |
| SW-11 | Read-only → 403 + one audit line, file unchanged | `studio-schema-write.mjs` — `{ readOnly: true }`, capture stdout; assert 403, `read()` unchanged, exactly **one** audit line with `op:"schema-write"`, `outcome:"denied"`, `reason:"read-only"`, no `table` key, and the line contains neither the schema path nor `dir` | **Bites a wrong implementation, not just an empty tree**: the gate at `:875` is `/api/rows/`-prefixed, so a naive PUT route added without decision 9 answers 200 and writes the file. This row is the reason the gate generalization cannot be assumed |
| SW-12 | Read-only does **not** block GET (negative control) | `studio-schema-write.mjs` — `{ readOnly: true }`, GET `/api/schema/source`; assert 200 | **Passes today** (the route is not under `/api/rows/`). Its bite is mutational: making `isWriteRoute` method-agnostic for the schema path must turn it red |
| SW-13 | `/api/rows/` gate stays method-agnostic | covered by the existing `studio-readonly.mjs` unrouted-verb case, **left untouched** | **Passes today and after.** Named as the regression guard for decision 9's refactor, not counted as new coverage |
| SW-14 | 401 precedes 403 | `studio-schema-write.mjs` — `{ password, readOnly: true }`, PUT with no cookie; assert 401, not 403 | 404 today. Guards the write route from becoming an oracle for server posture, matching the shipped read-only requirement |
| SW-15 | No `schemaPath` → probe false, PUT 404, GET still 200 | `studio-schema-write.mjs` — `withStudio` with no `schemaPath`; assert `schemaWritable:false` on `/api/auth/status`, PUT → 404, GET → 200 from the in-memory source | `schemaWritable` is absent from the probe body (`:902`) → `undefined !== false`. Fails on the first assertion |
| SW-16 | Success audit line is clean | `studio-schema-write.mjs` — capture stdout across a successful PUT; assert exactly one line, `outcome:"ok"`, `count:1`, `bytes` equals the written byte length, and the line contains neither the schema path nor the connection string | 404 today. The "no connection string" half is the inbound-redaction assertion at the log boundary |
| SW-17 | Split/reconstruct property | `studio-schema-source.mjs` — over ≥4 fixtures (single-line block, multi-line, nested braces, CRLF): assert `split(s).redacted === redactSource(s)` **and** `redacted` with its single sentinel line replaced by `block` equals `s` byte-for-byte | `splitDatasource` does not exist → import throws, suite exits non-zero. The parity half is trivially true once the wrapper exists; the **reconstruction** half is the load-bearing one and cannot even be expressed today because `block` has no representation |
| SW-18 | File with no datasource block | `studio-schema-source.mjs` + `studio-schema-write.mjs` — a schema with no `datasource`: GET returns it unchanged with no sentinel; PUT of that buffer succeeds; PUT of a buffer that *adds* a sentinel → 400 | 404 today. Note per correction 2 this state is unreachable through `indigodb studio` itself; it is the embedder/test path and is tested because the route cannot tell the difference |
| SD-1 | Parse error → exact-position diagnostic | `__tests__/useERDParser.test.tsx` — render the hook with a known-bad source; assert one diagnostic with `source:'parse'` and the exact 1-based `line`/`column`/`endLine`/`endColumn` from `ParseErrorDetail` | `useERDParser.ts:63` is `console.warn` and the hook returns no diagnostics field → the assertion reads `undefined`. Fails |
| SD-2 | Validation error → **zero** markers, one panel entry | `__tests__/useERDParser.test.tsx` — a source that parses but fails resolution; assert `diagnostics.length === 1`, `source:'validate'`, `line === undefined`, and `toMarkers(diagnostics)` returns `[]` | Same `console.warn`. Fails. This is the negative control proving no position is fabricated |
| SD-3 | Position-less diagnostic is unrepresentable as a marker | `__tests__/markers.test.ts` — a `// @ts-expect-error` on `toMarkers([validationDiagnostic])` | Verified by `pnpm --filter @indigodb/studio lint` (`tsc -b --noEmit`), not at runtime. **Not RED against the tree** — neither function exists, so the file simply does not compile; it becomes a real guard only after PR #2 lands. Stated as such |
| SD-4 | Save disabled with a reason | `__tests__/DslEditorToolbar.test.tsx` — render with `schemaWritable:false`; assert the button is `disabled` and its `title` names the reason; then `dirty:false, schemaWritable:true` → still disabled; `dirty:true` → enabled | `DslEditorToolbar` takes only `{dslCode}` (`:16`) and renders no Save button → query returns null. Fails |
| SD-5 | 409 preserves the buffer | `__tests__/ERDDesignerPage.test.tsx` — mocked `saveSchemaSource` → `{ok:false,status:409}`; assert the conflict banner renders and the editor `value` prop is byte-identical to the pre-save buffer | No save path exists. Fails |
| SD-6 | Reload replaces buffer, Undo restores it | same file — click Reload (mocked GET returns different text); assert the editor value is the disk text and the version updated; click Undo reload; assert the original buffer is back | No such UI. Fails |
| SD-7 | No success toast on non-2xx (negative control) | same file — mocked `{ok:false,status:422}`; assert zero success toasts, the diagnostics panel has one entry, and `dirty` is still true | No save path. Fails. Guards this repo's recurring "silent no-op that looks green" failure mode |

**Adversarial pass — what does not bite.** Three rows are honest about not being RED: **SW-12**
and **SW-13** pass against the untouched tree (mutation-proved and regression-guard respectively),
and **SD-3** is a typecheck guard that only exists after its own slice lands. **SW-5**, **SW-6**,
**SW-7** and **SW-12** each additionally require a named mutation to be run and recorded in the
tasks phase; without those mutations they prove only that the route exists. Every other row fails
on at least two independent assertions (status *and* on-disk bytes), so a partial implementation
cannot turn one green by accident — in particular, **no refusal row is satisfied by the status
code alone**; each also asserts `read()`.

## Threat Matrix

The design changes routing (a new mutating HTTP route). No shell, subprocess, VCS/PR automation,
or process-integration boundary is introduced, so every row of `references/threat-matrix.md` is
`N/A`: **Documentation-like paths** — N/A, no file-type classification or execution decision is
made; the single target path comes from `loadSchema`, never from a request. **Git repository
selection / Commit state / Push state / PR commands** — N/A, no VCS interaction of any kind.

Four rows are applicable to this change's own boundary:

| Row | Applicable | Safe behavior | RED test |
|---|---|---|---|
| Credential disclosure (outbound) | Yes | `GET` never emits the datasource block; the reattached block is spliced only into bytes destined for disk and never into any response body or log line | SW-1, SW-16 |
| Credential injection (inbound) | Yes | a buffer carrying a `datasource` declaration is refused before any write; the check runs *before* the sentinel count so it is always the reported reason | SW-8 |
| Path traversal / arbitrary file write | **No** | The write target is `options.schemaPath` alone, fixed at startup from `loadSchema`. **No component of the path is ever derived from a request** — there is no path parameter, no body field naming a file, and no `join` with request text | Structural; asserted by review and by the absence of any path input in the route contract above |
| Gate bypass (read-only) | Yes | one gate, generalized predicate, placed after auth and before dispatch; `GET` on the same path remains readable | SW-11 (403 + unchanged bytes), SW-12 (GET still 200), SW-14 (401 precedence) |
| TOCTOU between check and write | Yes | the staleness hash is recomputed from a re-read immediately before validation and write. A writer racing inside that window still cannot corrupt the file: `rename` is atomic, so the loser's full text either lands or does not — never a partial blend | SW-4; the residual same-millisecond race is accepted and recorded in Open Questions |
| Resource exhaustion (unbounded body) | Partly | inherited from the existing `readBody`, unchanged by this design | Open Question 1 |

## Migration / Rollout

No migration, no DDL, no wire-format break, no generated-client change, no new dependency
(`node:crypto`, `node:fs`, `node:path` are already in use). `GET /api/schema/source`'s body
contract is unchanged (`text/plain`, redacted); it gains a response header, which no existing
client reads. The old startup snapshot is deleted, so the only observable server behavior change
in PR #1a is that the endpoint now reflects the file — a correctness fix.

**A saved file does not update the running server's `resolved`.** `/api/schema`, `/api/tables/:name`
and the realtime engine keep serving the schema resolved at startup until Studio restarts. This is
deliberate: hot-swapping `resolved` would silently change the meaning of an open data browser and
a live SSE subscription mid-session. The ERD already re-renders from the client-side buffer, so the
user sees their change where they made it. Stated in the spec, not left implicit.

## Open Questions

- [ ] Non-blocking: `readBody`'s size cap (if any) was not audited; an unbounded schema PUT is
      bounded by the same policy as the existing `/api/query` body. If it is uncapped, a cap
      belongs in a separate change covering every route, not bolted onto this one.
- [ ] Non-blocking: the hash re-read and the `rename` are not a single atomic operation, so two
      writers within the same few milliseconds can both pass the staleness check and the second
      wins. `rename` guarantees the file is never a blend of the two. A real fix needs advisory
      locking, which the CLI has no precedent for; accepted for a single-operator dev tool.
- [ ] Non-blocking, carried from the proposal: validation errors stay position-less until the Rust
      validator gains spans (`crates/indigo-compiler`). Recorded, not closed here.
- [x] Resolved: `withStudio` needs no signature change — `...options` already carries `schemaPath`.
- [x] Resolved: proposal question 2 — **no** save-anyway/force-overwrite affordance; Reload with
      Undo (decision 14) preserves the buffer without an overwrite path.
- [x] Resolved: proposal question 3 — the audit line omits the path; `bytes` plus `outcome` is
      what an operator of a single-schema Studio needs.
