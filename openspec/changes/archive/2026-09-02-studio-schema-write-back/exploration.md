# Exploration: Studio schema write-back

**Change**: `studio-schema-write-back`
**Phase**: `sdd-explore`
**Engram**: `sdd/studio-schema-write-back/explore` (obs #881)

The roadmap files this as one row with three strands: (a) persist the Monaco editor to the
`.indigo` file, (b) offer the migration from the UI, (c) surface compiler diagnostics as Monaco
markers. This exploration establishes that (b) is materially larger than the other two and should
be a separate change.

---

## (a) Editor buffer and persistence — current state

`apps/studio/src/features/erd/ERDDesignerPage.tsx` holds the buffer in a plain
`useState<string>` (`dslCode`), seeded once from `fetchSchemaSource()` → `GET /api/schema/source`.
There is **no dirty tracking, no localStorage, no `beforeunload` guard**.
`DslEditorToolbar.tsx` has a Copy button and a disabled History button. **No Save action exists.**

## The trap — confirmed, and worse than stated

`packages/cli/src/studio-server.ts`'s `redactSource()` (~`:341`) strips the `datasource { … }`
block with a brace-depth line scan and replaces it with `// datasource redacted by Studio`.

`startStudio()` computes `publicSource = redactSource(source)` **once at process startup**
(`:771`) and serves that same string on every request — the file is never re-read. So the buffer
the user edits is **provably the redacted text**, not merely possibly.

A naive write-back of `dslCode` to the `.indigo` file therefore destroys the real `datasource`
block, including the connection string, in the user's own source file.

Second, structural gap: **`schemaPath` is never threaded into `StudioOptions`/`startStudio`.**
Only the raw `source` string is passed (`packages/cli/src/index.ts:399-414`). Write-back needs new
plumbing, not just a new route.

### Candidate write-back shapes

| # | Shape | Cost / what breaks |
|---|---|---|
| 1 | **Reattach the original datasource block server-side**, using a scan that mirrors `redactSource` | Recommended. The credential never leaves the process. Requires the reattach scan to stay in lockstep with the redaction scan — a drift hazard worth a shared helper and a round-trip test |
| 2 | Refuse to persist any buffer whose datasource region is not exactly the placeholder | Simple and safe, but rejects a legitimate edit that happens to touch adjacent lines; a poor error to explain |
| 3 | Send a structured patch rather than whole-file text | Highest fidelity, largest surface — needs a diff/patch protocol the repo does not have |
| 4 | Stop redacting; gate the route behind session auth | **Rejected.** Auth answers *who*, never *should this credential leave the process at all*. Same category error the column-projection epic just closed on the realtime side |

## (b) Server side — the gates do NOT come for free

- **Session auth** covers any `/api/*` route, so a new route inherits it.
- **Read-only mode is explicitly scoped to `/api/rows/` only**, per
  `openspec/specs/studio-readonly-mode/spec.md`'s "Single shared write gate" requirement. A new
  schema-write route is **not** covered and needs its own explicit check. Assuming otherwise would
  ship a read-only Studio that can still rewrite the schema file.
- **`AuditOp`** (`packages/cli/src/util.ts:383`) is a closed union `"insert" | "update" | "delete"`.
  A schema write has no variant, so without extending it the write leaves **no audit trail** — in a
  Studio whose own shipped spec says every write is audited.

## (c) Diagnostics as Monaco markers — the roadmap's claim is half true

`apps/studio/src/features/erd/hooks/useERDParser.ts` does `console.warn('ERD Parse error', e)` on
any `resolve(parse(dslCode))` throw. That is the confirmed target.

- **Parse errors**: `IndigoParseError.errors: ParseErrorDetail[]` carries 1-based `line`, `column`,
  `endLine`, `endColumn`. Markers are cheap. The roadmap's claim holds here.
- **Validation/resolve errors**: `resolveSchema` throws a bare `Error(string)`, and
  `ValidationError` (`packages/core/src/ir.ts:268-272`, Rust `ir.rs:254-261`) carries only
  `{message, model?, field?}` — **no position data at all**.

So "needs only the compiler's existing diagnostics, already in the repo" is **false for validation
errors**. They can be surfaced as a non-positional message, but not as a located marker, without
first adding spans to the Rust validator.

## (d) Migrate from the UI — much larger than the row implies

`packages/cli/src/migrate-runner.ts`'s `migrateDev(): Promise<void>` is entirely console- and
`process.exitCode`-coupled with no data-returning seam, and includes a destructive-statement
`--force` refusal path with no read-only-mode or audit-log coverage. Exposing it from the UI needs
its own destructive-action UX and gating design.

**Recommendation: exclude from this change.** It mixes an additive, well-understood strand with one
that needs its own design, and conflating them risks the review budget. It does **not** block
`ERD becomes a designer`, whose stated dependency is persistence ("editing a diagram has to persist
somewhere"), not migration.

## (e) Test surface

`packages/cli/test/studio-harness.mjs`'s `withStudio` never uses a real file path — `source` is
always in-memory. A write-back round-trip test needs new `mkdtemp`-based fixture support. The test
that matters must **read the file back off disk** and assert the datasource block survived; a 200
response proves nothing.

## (f) Concurrency and durability — no precedent to reuse

- **No atomic-write (temp + rename) precedent anywhere in the CLI.** Every `writeFileSync` is
  unconditional, including `db pull`'s explicitly documented "overwriting unconditionally, no
  confirmation".
- **No staleness/mtime check precedent.** A browser tab left open for hours is a materially
  different risk profile than a CLI invocation, so the absence of precedent is not evidence the
  risk is absent.

## Recommendation

Two changes.

1. **`studio-schema-write-back`** (this one): editor persistence with safe datasource
   reattachment, plus parse-error Monaco markers. Validation errors degrade to a non-positional
   surface, stated explicitly rather than silently claimed as covered.
2. **Migrate-from-UI**: proposed separately, later.

## Risks Carried Forward

1. Naive write-back destroying the user's `datasource` block — must be proven by a test that reads
   the file back off disk.
2. Read-only mode's gate is `/api/rows/`-scoped and will not auto-cover a schema-write route.
3. `AuditOp` needs extending or the write leaves a silent audit-trail gap.
4. No atomic-write or staleness-check precedent to copy.
5. Validation errors have no position data — Monaco markers for them are not "already in the repo".
6. The reattach scan and the redaction scan can drift apart; they should share one helper.
