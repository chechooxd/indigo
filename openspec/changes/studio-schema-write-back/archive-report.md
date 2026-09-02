# Archive Report: `studio-schema-write-back`

**Change**: `studio-schema-write-back`
**Archived to**: `openspec/changes/archive/2026-09-02-studio-schema-write-back/`
**Status**: Complete, three stacked PRs merged to main, 0 CRITICAL issues remain open

---

## Final State Authority

| PR | Branch | Commits | Scope |
|----|----|----|----|
| #1a | `feat/studio-schema-write-back-1a` | `5cdfa22`, `f807c51` | `splitDatasource` refactor, per-request `GET`, version header, `schemaPath` plumbing, GET-only verb guard pinned |
| #1b | `feat/studio-schema-write-back-1b` | `86334b1`, `71014f0` | `PUT /api/schema/source` — reattachment, staleness, atomic write, validation, diagnostic translation, read-only gate, audit op |
| #2 | `feat/studio-schema-write-back-2` | `7f4aa81`, `9e20388` | Studio Save UI — dirty tracking, markers, diagnostics panel, conflict handling |

**Base**: `main`@`760d30b`
**Implementation tasks**: 80 complete (Phase 1: 12, Phase 2: 37, Phase 3: 27, Phase 4: 4)
**Verification verdict**: PASS WITH WARNINGS — 0 CRITICAL, 1 WARNING (a doc line off by one; fixed before archive), 1 SUGGESTION
**Suites**: `studio-schema-source.mjs` 5/5, `studio-schema-write.mjs` 19/19, `apps/studio` 153/153 across 24 files
**Root gate**: `pnpm clean && pnpm build --force && pnpm lint && pnpm test` → 18/18 Turbo tasks, exit 0

---

## What This Change Did

The Studio's Monaco editor could display the `.indigo` schema but not save it — "a designed schema
cannot leave the browser tab except by copy-paste." This adds `PUT /api/schema/source`, a Save
action, and real compiler diagnostics as editor markers.

### The hazard this change existed to avoid

`GET /api/schema/source` serves the schema with its `datasource { … }` block **stripped** and
replaced by the sentinel line `// datasource redacted by Studio`, because a connection string can
only appear inside that block. The buffer the editor holds is therefore redacted text. A naive
`PUT` of that buffer would have **destroyed the user's connection string in their own source file**.

This was not discovered during implementation. A previous change left a forward-looking warning in
`redactSource`'s own doc comment, naming this exact roadmap item and stating that a save-back
endpoint "MUST NOT round-trip this redacted text back into the real schema file." That comment is
what turned a latent trap into a design input.

### Design decisions worth carrying forward

- **One scanner, not two.** Reattachment needs to know where the block goes, and the obvious
  implementation is a second brace-depth scan mirroring the redaction scan. Two scanners that must
  agree, agree until someone edits one. Instead `splitDatasource(source) → {redacted, block}` is the
  single scanner, `redactSource` is a one-line wrapper over it, and the write path performs a
  **literal exact-match substitution of the sentinel line**. The drift is not prevented by
  discipline; it is made structurally impossible.
- **The startup snapshot was deleted.** `publicSource = redactSource(source)` was computed once at
  process start and served forever, so an external edit was invisible until restart. PR #1a's
  per-request read+redact fixes that bug on its own, and without it the staleness check would have
  been undetectable by construction.
- **Sentinel count must be exactly 1, and that is safe BY CONSTRUCTION.** A `datasource` block is
  not mandatory to the grammar — most fixtures have none, and the validator only rejects more than
  one. But `index.ts:400` calls `resolveConnectionString`, which `process.exit(1)`s without a
  datasource url, immediately before `startStudio` at `:401`. A running Studio always has exactly
  one. This reasoning is written into the spec so a future reader meeting a refusal does not "fix"
  it by loosening the guard.
- **Redaction is now bidirectional.** A buffer arriving with a `datasource` keyword at declaration
  position is refused before the sentinel count runs: a credential must never travel inbound either.
- **Content hash, not mtime**, for staleness — mtime brings clock skew and no-op-touch false trips.
- **Atomic write with the temp file in the SAME directory.** `rename(2)` is atomic only within one
  filesystem, and `os.tmpdir()` routinely crosses devices. There was no atomic-write precedent
  anywhere in this CLI; this change sets it.
- **The audit line records that a schema write happened, not to which file.** A path leaks the home
  directory or a private project name. Specced explicitly so nobody later "improves" it.
- **Read-only's gate was generalized, not duplicated.** Its requirement scoped the gate to the
  `/api/rows/` prefix, so a schema-write route would have silently bypassed it. The gate is now
  defined over an explicit write-route set, and a future write route inherits it by joining the set.

---

## The Roadmap Was Half Wrong, and Saying So Was the Point

The roadmap row claimed this "needs only the Monaco editor and the compiler's existing diagnostics
— both already in the repo."

True for **parse** errors: `IndigoParseError.errors` carries 1-based `line`/`column`/`endLine`/
`endColumn`, and markers are cheap. **False for validation errors**: `ValidationError` carries only
`{message, model?, field?}` with no position data at all. They surface as a labelled panel entry
with **zero** markers, and the spec forbids fabricating a position — no model-name text search, no
line-1 anchor. Adding spans to the Rust validator is a follow-up, not a thing that already existed.

### Decision 7 — the second route to a fabricated position

Validation runs on the **reattached** text, whose line numbers differ from the user's buffer by
`blockLineCount − 1`, because the redactor collapses an N-line block into one sentinel line.
Reporting those numbers untranslated fabricates positions by a second route: coordinates that are
real, but from another coordinate system, which is worse than none because they look right.
`translateLine` handles three cases, and the middle one is the honest one — an error falling
**inside** the reattached block returns **no position**, because that line is not visible to the
user.

Proved by mutation: reducing `translateLine` to `return line;` fails SW-10 with
`expected buffer-relative line 3, got 6`.

---

## Specs Synced to Source of Truth

### NEW Capabilities
- **`studio-schema-write`** — 9 requirements, 18 scenarios: one scanner, `schemaPath` plumbing,
  per-request GET, sentinel-count enforcement, staleness by content hash, atomic write, pre-write
  compile validation, `schemaWritable` refusal, and every write outcome as a distinct observable
  result.
- **`studio-editor-diagnostics`** — 3 requirements, 5 scenarios: positional parse markers,
  validation errors with zero fabricated markers, and a failed parse no longer looking like a
  frozen diagram.

### MODIFIED Capabilities
- **`studio-server-security`** — redaction is now bidirectional and computed per request
  (previously: outbound only, snapshotted at startup).
- **`studio-readonly-mode`** — the single shared write gate is defined over an explicit write-route
  set (previously: scoped to the `/api/rows/` prefix).
- **`studio-audit-log`** — schema-write attempts are audited with no file content and no file path.

---

## Scope Excluded, Deliberately

**"Offer the migration from the UI"** — the third strand of the roadmap row — was split out.
`migrateDev()` returns `void` and is coupled to `console` and `process.exitCode` with no
data-returning seam, and carries a destructive-statement `--force` refusal path with no read-only
or audit coverage. It needs its own destructive-action UX and gating design. It does **not** block
`ERD becomes a designer`, whose stated dependency is persistence, not migration.

---

## Open Follow-Ups

- **Migrate-from-UI**, as above — the remaining third of the roadmap row.
- **Validation errors have no source positions.** Closing this means adding spans to
  `crates/indigo-compiler`'s validator; until then the panel entry is the honest ceiling.
- **Residual TOCTOU**: two writers within milliseconds can both pass the staleness check and the
  second wins. `rename` still guarantees no blended file. Advisory locking has no CLI precedent and
  was accepted as out of scope.
- **`readBody`'s size cap was not audited** — recorded during design as a non-blocking open
  question, deliberately not bolted onto this change.
- **A local `SchemaParseErrorDetail` type** mirrors `ParseErrorDetail` because `@indigodb/core` does
  not re-export it. Verified structurally identical; a future divergence is a real risk worth a
  re-export.
