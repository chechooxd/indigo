# Archive Report: `schema-printer-fidelity`

**Change**: `schema-printer-fidelity`
**Archived to**: `openspec/changes/archive/2026-09-02-schema-printer-fidelity/`
**Status**: Complete, two stacked PRs merged to main, 0 CRITICAL issues remain open

---

## Final State Authority

| PR | Commit | Scope |
|----|----|----|
| #1 | `ab58f75` | `@@allow`, `@@realtime(columns:)`, `TableGroup` printing; five normalizer exclusions deleted |
| #2 | `dbbd7e3` | `@relation(…)` printing, FK claiming, ambiguity/name throws, final normalizer shrink |
| — | `00ddf73` | Orchestrator: pin each unprintable fixture's throw to its documented cause (closes verify's WARNING) |

**Base**: `main`@`968f8de`
**Implementation tasks**: 58 complete (Phase 1: 23, Phase 2: 29, Phase 3: 6)
**Verification verdict**: PASS WITH WARNINGS — 0 CRITICAL, 1 WARNING (closed before archive), 2 SUGGESTION
**Suite**: `packages/core/test/print.mjs` — green, 18/21 fixtures in round-trip scope
**Root gate**: `pnpm clean && pnpm build --force && pnpm lint && pnpm test` → all green

---

## What This Change Did

`printSchema` claimed in its own docstring that it "never guesses — any IR construct it cannot
represent losslessly throws `IndigoPrintError`". It did not. Four constructs were dropped **silently**:

| Construct | Before | After |
|---|---|---|
| relations / foreign keys | inert `// @fk(…)` comment; nothing parses it back | real `@relation(…)` field on the holder, plus the back-relation field |
| `@@allow` | dropped, no error | printed, one line per rule, IR order |
| `@@realtime(columns: […])` | collapsed to bare `@@realtime` | printed, including the empty list |
| `TableGroup` / `color` / `group` | vanished | printed as a top-level block |

Measured before: a two-table schema with one relation went `1 FK` → printed → `0 FK`, and the
`posts Post[]` back-relation field disappeared. `@@realtime(columns: [])` — the strictest possible
declaration — round-tripped to bare `@@realtime`, the loosest. Measured after: `07-referential-actions`
(6 FK), `08-self-relation` (1 FK) and `12-relation-naming` (3 FK) all round-trip **deep-identical**,
and `columns: []` stays `[]`.

### Design decisions worth carrying forward

- **The FK-holder discriminator is `rel.inverse !== true && rel.fkColumns.length > 0`.** Both the
  exploration and the proposal said `fkColumns.length > 0` alone. That is wrong: `pair_relations`
  (`crates/indigo-compiler/src/resolve.rs:592-597`) back-fills the holder's columns **onto the
  paired inverse side**, so `User.authoredPosts` carries `fkColumns: ["authorId"]` for a column that
  lives on `Post`. The wrong test emits `fields: [authorId]` on `User` and makes `fieldNameFor`
  throw. The design caught it by reading the Rust rather than trusting two upstream artifacts.
- **`onDelete`/`onUpdate` are cross-referenced by exact column-array equality, and ambiguity
  throws.** They are not on `ResolvedRelation`, and there is no IR back-pointer from a `ForeignKey`
  to its producing relation field. Column-set equality is unambiguous for every existing fixture but
  is not IR-guaranteed unique, so an ambiguous match raises `IndigoPrintError` rather than picking
  the first candidate.
- **A claimed FK is removed from the comment list**, or the output would carry both a
  `@relation(…)` and a duplicate `// @fk(…)` for one constraint.
- **An orphan FK still prints `// @fk(…)`, and that is now normative rather than legacy.** It is the
  only thing `db pull` can emit, and deleting the fallback would turn an inert comment into nothing
  at all.
- **Fixture exclusions are categorically different from normalizer exclusions.** A fixture exclusion
  means the printer **provably throws** — loud, recorded. A normalizer field exclusion means it
  **silently drops** and the test looks away. Conflating them is what produced this bug class.

---

## The Real Subject: a Test That Verified Nothing

`packages/core/test/print.mjs`'s `normalizeForRoundTrip` deleted `color`, `group`, `allow` and
`realtimeColumns` and zeroed `foreignKeys` and `relations` — **on both sides** — before comparing.
It compared what survived against what survived. That is why four data-loss bugs sat green for
weeks, in the file whose entire purpose is to catch them.

It now carries **exactly one** exclusion — index re-bucketing — with an inline comment naming the
field and the reason. The spec makes that binding: the round-trip MUST compare the full IR, every
exclusion MUST carry an inline justification, and **any exclusion beyond that one MUST be reported
in the change's verify report**. The point is not that nobody would write a bad test on purpose;
it is that a future reader with a failing fixture and an afternoon cannot quietly add a line to the
normalizer to make it green.

### The WARNING, and why it was worth closing before archive

Verify found the `UNPRINTABLE_FIXTURES` confirmation loop asserting only
`throws(fn, IndigoPrintError)` while its own comment claimed each fixture's exact throw was pinned.
**The comment overclaimed — that is the defect.** A class-only assertion passes whenever the printer
throws for any reason, including one that masks a regression in the construct the fixture exists to
exercise. An exclusion is only legitimate while the printer refuses **for the documented cause**.

Now a `Map` from fixture to its required message substring. Proved by mutation: changing the message
from `has no matching field` to `is unsupported` — same class, same site, same underlying condition
— fails all three, and was invisible before.

---

## Specs Synced to Source of Truth

`schema-printing` MODIFIED:
- **Raw Foreign Key Output** — narrowed to be **conditional on relation metadata** rather than
  deleted, so the `db pull` fallback cannot be removed by accident.
- **`@@realtime` Printing** — the empty-list case is a distinct valid state.
- **Round-Trip Fidelity for In-Scope IR** — compares the full IR; exactly one named exclusion;
  every exclusion carries an inline reason; additional exclusions must be reported.

`schema-printing` ADDED: **`@@allow` Printing**, **TableGroup Printing**.

---

## What This Change Does NOT Do

**It does not fix `db pull`'s FK loss**, and the change was opened on the mistaken claim that it
would. `packages/migrator/src/introspect.ts:350` hardcodes `relations: []` (documented at `:302`),
so an introspected schema carries no relation IR — there is nothing to print `@relation(…)` from.
Closing that path requires **inventing** field names: a forward name, a pluralized inverse, and a
disambiguation policy for multiple FKs to one target and for self-relations. No pluralize utility
exists in this repo, and doing it inside `printSchema` would violate its "never guess" contract.

It is also not an oversight: `openspec/changes/archive/2026-08-18-indigo-schema-printer/design.md`
named it an out-of-scope follow-up when the printer shipped, and
`packages/migrator/test/pull-roundtrip.mjs:81-82` pins the current behavior with
`ok(!text.includes("@relation"))` and `ok(text.includes("@fk("))`. That file is byte-unmodified by
this change and still green.

**Deferred follow-up: `db-pull-relation-synthesis`.**

---

## Open Follow-Ups

- **`db-pull-relation-synthesis`** — as above. Note `pull-roundtrip.mjs`'s assertions **invert**
  when it lands; they must be rewritten deliberately, not patched around.
- **`tasks.md` says "17/20 fixtures in scope"** in tasks 1.22 and 2.28; the runtime count is
  **18/21**. Confirmed by verify as a prose typo with no code or assertion dependency.
- **A citation imprecision in `apply-progress.md`** placing `introspect.ts` under
  `packages/cli/src`; it lives in `packages/migrator/src`. The technical claim is correct.
- **The unprintable-fixture corpus went 20 → 18 files.** Positive coverage for both newly printed
  constructs survives via `18-allow-rules` and `20-realtime-columns`, but the three exclusions are
  each a place where a future regression could hide behind a documented throw. They are pinned by
  message now, which is the mitigation.
