# Proposal: Studio schema write-back and editor diagnostics

## Intent

The Studio's Monaco editor is a dead end. `ERDDesignerPage.tsx` holds the buffer in a plain
`useState`, `DslEditorToolbar.tsx` has Copy and a disabled History button, and **no Save action
exists** — every edit is lost on reload. Separately, `useERDParser.ts` swallows every compiler
failure into `console.warn('ERD Parse error', e)`, so a typo makes the diagram silently stop
updating with no on-screen explanation.

Success: a user edits `.indigo` in Studio, presses Save, and the file on disk is updated — with
their `datasource` block and connection string intact — or is told precisely why it was not.

**The trap is proven, not suspected.** `startStudio` computes `publicSource = redactSource(source)`
**once at startup** (`studio-server.ts:771`) and serves that string on every request; the file is
never re-read. The editor buffer *is* the redacted text. A naive write-back destroys the user's
real `datasource` block. `redactSource`'s own doc comment (`:336-339`) names this exact change as
the hazard it is warning about.

## Scope

### In Scope

- `schemaPath` threaded into `StudioOptions`/`startStudio` (today only the `source` string is
  passed — `index.ts:399-414`).
- `GET /api/schema/source` re-reads and re-redacts **per request**, returning an opaque content
  `version` token. The startup `publicSource` snapshot is deleted.
- `PUT /api/schema/source` — validated, gated, atomic write-back with server-side datasource
  reattachment.
- Explicit read-only gate, session auth (inherited), and a new audit-log op for schema writes.
- Save UI: dirty tracking, disabled-with-reason when the server reports the schema is not writable,
  and distinct user-visible outcomes for every failure mode.
- Parse errors surfaced as located Monaco markers; validation errors surfaced non-positionally.

### Out of Scope / Non-Goals

- **(b) "Offer the migration from the UI." Excluded deliberately.** `migrateDev()` returns
  `Promise<void>`, is coupled to `console` and `process.exitCode` with no data-returning seam, and
  carries a destructive-statement `--force` refusal path with no read-only or audit coverage. It
  needs its own destructive-action UX and gating design. It does **not** block `ERD becomes a
  designer`, whose stated dependency is persistence, not migration. Proposed separately, later.
- Adding source spans to the Rust validator (`crates/indigo-compiler`). Recorded as the follow-up
  that would upgrade validation errors from panel entries to located markers.
- `beforeunload`/localStorage draft recovery, edit history, and ERD-to-source generation.
- A diff/patch wire protocol (shape 3 below).

## Capabilities

### New Capabilities

- `studio-schema-write`: the write-back route — reattachment, staleness rejection, pre-write
  compile validation, atomic write, gating, audit, and the `schemaWritable` probe field.
- `studio-editor-diagnostics`: Monaco markers for positional parse errors, and the explicit,
  non-fabricating degradation for position-less validation errors.

### Modified Capabilities

- `studio-server-security`: "Datasource redaction in API responses" gains the inbound direction —
  a saved buffer MUST NOT introduce a `datasource` block, and the reattached block MUST NOT leave
  the process — plus per-request redaction replacing the startup snapshot.
- `studio-readonly-mode`: its "Single shared write gate on the `/api/rows/` prefix" requirement is
  **route-prefix-scoped and will not cover the new route for free**. It must be restated as a gate
  over an explicit write-route set covering both `/api/rows/` and `/api/schema/source`.
- `studio-audit-log`: `AuditOp` is the closed union `"insert" | "update" | "delete"`
  (`util.ts:383`); it gains `"schema-write"`. `StudioAuditEntry.table` becomes optional, and
  `AuditReason` gains `"stale"`, `"redaction-conflict"`, and `"schema-invalid"`.

## Approach

**Chosen: shape 1 — reattach the datasource block server-side — with the drift hazard removed
structurally rather than by discipline.**

Shape 4 (drop redaction, rely on session auth) is rejected on principle: auth answers *who*, never
*should this credential leave the process at all*. That is the same category error the
`realtime-column-projection` epic just closed. Shape 3 (structured patch) needs a diff protocol the
repo does not have. Shape 2 (refuse on region mismatch) is folded in below as the narrow fallback,
not the primary path.

### The drift hazard, closed structurally

The exploration's stated risk is that a reattach scan and the redaction scan disagree. **The design
must have exactly one brace-depth scan.** `redactSource` is refactored into
`splitDatasource(source) → { redacted, block, placeholderLine }`, and `redactSource` becomes a thin
wrapper over `.redacted`. The write path never scans the incoming buffer for a `datasource` block:
it performs a **literal exact-match substitution of the sentinel line**
`// datasource redacted by Studio`, replacing it with the `block` returned by the *same* split
function applied to the current on-disk file. One scanner, one sentinel constant. There is no
second scan that could drift.

The sentinel then supplies the shape-2 safety net cheaply — the count of sentinel lines in the
incoming buffer must be exactly what the split produced:

| Incoming buffer | Response |
|---|---|
| Exactly one sentinel line (and the file had a datasource block) | Splice the real block back, continue |
| Zero sentinel lines (user deleted the placeholder comment) | `400`, nothing written, message naming the placeholder line verbatim |
| Two or more sentinel lines | `400`, nothing written |
| Contains a literal `datasource` keyword at declaration position | `400` — a credential must never travel inbound either |
| File has no datasource block at all | No sentinel expected; buffer written as-is |

### Policy decisions this proposal settles (design to specify normatively)

| Question | Decision | Justification |
|---|---|---|
| Staleness check | **Yes — content hash, not mtime.** `GET` returns an opaque `version` (hash of the on-disk bytes at read time); `PUT` echoes it; the server re-reads, recomputes, and returns `409` on mismatch | A browser tab open for hours is a materially different risk profile than a CLI invocation, so "no precedent in the CLI" is not evidence of absent risk. Content-hash avoids mtime's clock skew and false trips from a no-op `touch`. It also correctly catches the case the startup snapshot hides: the user edited the datasource block externally while Studio was open |
| Atomic write | **Yes — temp file in the same directory + `rename`** | `db pull` overwrites a file the user can regenerate; this overwrites a file the user hand-authored, and it is the single source of truth for their entire database. A crash or full disk mid-`writeFileSync` leaves it truncated and uncompilable. ~10 lines |
| Validate before writing | **Yes — the reattached full text must `parse` + `resolve` cleanly server-side, or `422` with diagnostics and no write** | Studio must never be the thing that leaves a project with a schema that does not compile. The client-side check is advisory; the server's is the gate |
| Read-only mode | **`403`, from an explicit gate.** Cannot be inherited | Read-only's promise is "inspect, never mutate", and the schema file is the most consequential mutable artifact in the project. Its current gate is `/api/rows/`-scoped — assuming coverage would ship a read-only Studio that can still rewrite the schema file |
| Session auth | **Inherited unchanged** — the route is under `/api/*` | No new work; state it so it is not silently assumed |
| Audit | **One line per attempt**, `op: "schema-write"`, with outcome/reason and byte count. **Never the file content and never the file path** | A path can carry a home directory or a private project name. The Studio's shipped spec says every write is audited; without extending `AuditOp` this write is invisible |
| No `schemaPath` (embedders, tests) | Status probe reports `schemaWritable: false`; route returns `404`; Save renders **disabled with a reason** | A Save that silently does nothing is precisely this repo's recurring failure mode |

### Diagnostics — the roadmap's claim is half false, and the proposal says so

`IndigoParseError.errors: ParseErrorDetail[]` carries 1-based `line`/`column`/`endLine`/`endColumn`.
Markers are cheap and exact. But `ValidationError` (`packages/core/src/ir.ts:268-272`, Rust
`ir.rs:254-261`) carries only `{message, model?, field?}` — **no position data at all**.

**Decision: validation errors get a diagnostics panel entry, never a marker.** No position is
inferred by text-searching for the model name, and no marker is anchored at line 1. A marker at a
guessed location is a fabricated fact, and the panel entry is labelled "no source location" so the
absence is visible rather than papered over. `useERDParser`'s `console.warn` is replaced by
diagnostics state shared by the editor and the ERD, so a failed parse no longer looks like a frozen
diagram.

### What the user sees

| Outcome | UI |
|---|---|
| `200` | Toast, dirty flag cleared, new `version` adopted |
| `409` stale | Buffer **kept, never discarded**; banner: the file changed on disk, with an explicit Reload action the user chooses |
| `400` redaction conflict | Message naming the placeholder comment line; buffer kept |
| `422` invalid schema | Markers + panel; buffer kept; nothing written |
| `403` read-only | Read-only message, consistent with the existing banner |
| `schemaWritable: false` | Save disabled with a tooltip explaining why |

A success toast is never shown for a non-2xx response, and Save is never a silent no-op.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `packages/cli/src/studio-server.ts` | Modified | `splitDatasource`, per-request source read, `PUT` route, read-only gate, atomic write |
| `packages/cli/src/util.ts` | Modified | `AuditOp` + `AuditReason` + optional `table` |
| `packages/cli/src/index.ts` | Modified | Thread `schemaPath` into `StudioOptions` |
| `packages/cli/test/studio-harness.mjs` | Modified | `mkdtemp` real-file fixture support |
| `packages/cli/test/studio-schema-write.mjs` | New | Round-trip and refusal suite |
| `apps/studio/src/features/erd/*`, `src/lib/api.ts`, `src/store/useStudioStore.ts` | Modified | Save, dirty tracking, markers, diagnostics panel |
| `openspec/specs/studio-schema-write/`, `studio-editor-diagnostics/` | New | New capability specs |

## Testing (must actually bite)

Each item states how it fails against the current tree.

1. **The test that matters**: `mkdtemp` fixture with a real `.indigo` holding a literal connection
   string. `GET` (assert redacted), `PUT` a buffer with an added model, then **read the file back
   off disk** and assert the `datasource` block survived **byte-for-byte** and the new model is
   present. A `200` proves nothing. **Today**: no route → `404`. Fails.
2. **Negative control — sentinel deleted** → `400`, and the on-disk bytes are unchanged. Mutation
   proof required: downgrading the refusal to a warning must make this fail.
3. **Staleness**: mutate the file on disk between `GET` and `PUT` → `409`, file unchanged.
   **Today**: `/api/schema/source` serves a startup snapshot, so the drift is undetectable. Fails.
4. **Read-only**: `--read-only` → `403` + one `denied`/`read-only` audit line, file unchanged.
   **Today**: the gate is `/api/rows/`-scoped, so a plausible naive implementation returns `200` —
   this one bites against a wrong implementation, not merely against an empty tree.
5. **Invalid schema** → `422`, file unchanged, no temp file left behind.
6. **No `schemaPath`** → probe reports `schemaWritable: false`, route `404`.
7. **Studio (`vitest`)**: a `ParseErrorDetail` produces a marker at the exact 1-based position; a
   validation error produces **zero markers** and one panel entry — the negative control proving no
   position is fabricated. **Today**: both are `console.warn`. Fails.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Write-back destroys the user's `datasource` block | High if naive | Single-scanner split + sentinel substitution + a test that reads the file off disk |
| Read-only mode assumed to cover the new route | High | Explicit gate + spec delta + a dedicated `403` test |
| Per-request file read regresses `/api/schema/source` latency | Low | A `.indigo` file is small; the read replaces an in-memory snapshot that was already a correctness bug |
| `409` becomes noisy and users learn to force-overwrite | Med | Content-hash (not mtime) means only real content changes trip it; the buffer is never discarded, so recovery is cheap |
| Validation-error panel reads as second-class next to markers | Med | Labelled explicitly; the Rust-span follow-up is recorded, not implied |
| Chained slices leave PR #1 shipping a route with no UI | Low | PR #1 is independently testable and behind `schemaWritable`; the Studio simply keeps its current read-only editor |

## Rollback Plan

Per slice. PR #2 (Studio) reverts to the current read-only editor with no server change. PR #1
reverts `startStudio` to the startup `publicSource` snapshot and drops the route; `splitDatasource`
is a pure refactor of `redactSource` whose wrapper preserves the existing signature, so the
security spec's redaction guarantee holds identically before and after. No schema, migration, wire
format, or generated-client change.

## Dependencies

None new. No new packages. Monaco marker APIs are already available through the existing editor
integration.

## Delivery Forecast

Honest estimate, authored additions + deletions:

| Slice | Estimate |
|---|---|
| Server: split refactor, per-request read, route, gates, audit types, `schemaPath` plumbing, specs | ~370 |
| Server tests + harness `mkdtemp` support | ~260 |
| Studio: Save, dirty tracking, markers, diagnostics panel, api/store | ~220 |
| Studio `vitest` | ~120 |

**Total ≈ 950–1000 lines — over the 800-line budget.** Cached strategy is `auto-chain` /
`stacked-to-main`, and the exploration already supplies a clean slice boundary.

- **PR #1 (~630)**: server write path, gates, audit, CLI tests, specs. Ships behind
  `schemaWritable`; the Studio is untouched and still works.
- **PR #2 (~340)**: Studio Save UI, markers, diagnostics panel, `vitest`.

`400-line budget risk: High` for a single PR; the chain brings each slice under 800.

## Success Criteria

- [x] A round-trip test reads the `.indigo` file back off disk and proves the `datasource` block is
      byte-identical after a save. Evidence: `tasks.md` 2.1/2.32 (SW-1), verified independently by
      the orchestrator's addendum after PR #1b.
- [x] Exactly one brace-depth datasource scanner exists in `studio-server.ts`; the write path uses
      literal sentinel substitution and never rescans. Evidence: `tasks.md` 1.1–1.2 (`splitDatasource`,
      SW-17).
- [x] `--read-only` refuses a schema write with `403` and one audit line, with the file unchanged.
      Evidence: `tasks.md` 2.21–2.22 (SW-11).
- [x] A schema that does not compile is never written to disk. Evidence: `tasks.md` 2.16–2.18 (SW-9).
- [x] Every failure mode has a distinct, user-visible message; Save is never a silent no-op and
      never reports success on a non-2xx. Evidence: `tasks.md` 3.15–3.22 (SD-5/6/7, the 409 banner
      with Reload/Undo, the 422 diagnostics panel, and the 200-only toast).
- [x] Parse errors produce exact-position markers; validation errors produce zero markers and a
      labelled panel entry. Evidence: `tasks.md` 3.1–3.10 (SD-1/2/3, `toMarkers`/`isPositional`).

## Proposal question round

Execution mode is `auto`, so the following were decided rather than asked. Flag any before design:

1. **Read-only mode blocks schema writes (`403`).** Alternative reading: read-only is about the
   *database*, and the schema file is a source file the operator owns. This proposal treats
   "inspect, never mutate" as covering both. Correct if wrong — it changes a spec delta.
2. **The `409` conflict has no merge, force, or overwrite affordance** — only Reload, with the
   buffer preserved so the user can copy their work out. Is a "save anyway" escape hatch wanted?
3. **The audit line omits the schema file path entirely** (path can leak a home directory or a
   private project name), so the log records that a schema write happened, not to which file. In a
   single-schema Studio this loses nothing; confirm that holds.
4. **Migration-from-UI is deferred to its own change.** Confirm `ERD becomes a designer` is
   genuinely unblocked by persistence alone.
