# Tasks: Schema printer fidelity

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | PR 1 ≈ 265 authored (`printAllowRule`/`printAllowOperand`, `@@realtime(columns:)`, `printTableGroup`, block-order change, `UNPRINTABLE_FIXTURES` +19/+21, `normalizeForRoundTrip` half-rewrite); PR 2 ≈ 305 authored (`claimForeignKeys`, `printRelationField`, ambiguity + FK-`name` throws, `05-relations.indigo` comment update, `normalizeForRoundTrip` final exclusion, docstring) |
| 400-line budget risk | Low per slice; both slices land inside the 800-line review budget with margin |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (mechanical three) → PR 2 (relations, stacked on PR 1) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Low per slice

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | `@@allow` printing, `@@realtime(columns:)`, `TableGroup` printing, block-attribute reorder to `@@map → @@unique → @@index → @@realtime → @@allow → @@note`; `UNPRINTABLE_FIXTURES` gains `19-rejected-allow.indigo` + `21-rejected-realtime-columns.indigo`, each with a written reason and a pinned throw; `normalizeForRoundTrip` deletes the `tableGroups`/`color`/`group`/`allow`/`realtimeColumns` exclusions | PR 1 | `node packages/core/test/print.mjs` | Plain-Node `.mjs`, no DB | Revert `print.ts` to bare `@@realtime`/no `@@allow`/no `TableGroup`; restore the five deleted normalizer exclusions; drop 19/21 from `UNPRINTABLE_FIXTURES` (leave 05). PR 2 has not yet touched relation code, so this revert is clean |
| 2 | `claimForeignKeys` (matching + both ambiguity throws + FK-`name` throw), `printRelationField`, relation rows appended to the field block in `printFieldLines`, orphan-FK comment filtering, `05-relations.indigo`'s `UNPRINTABLE_FIXTURES` comment updated (throw now originates in `printRelationField`, not `printFkComment`), `normalizeForRoundTrip`'s final two exclusions deleted (down to the one permitted index-re-bucketing exclusion), docstring narrowed | PR 2 | `node packages/core/test/print.mjs` | Plain-Node `.mjs`, no DB | Revert relation printing to the `// @fk(…)` comment for every FK; restore the `foreignKeys: []`/`relations: []` exclusions. PR 1's `@@allow`/`@@realtime`/`TableGroup` output is untouched by this revert |

## Scenario Coverage Map (17/17)

Every scenario from `specs/schema-printing/spec.md`'s delta is listed once, with the task(s) that
implement and prove it. `T-n` are the design's Testing Strategy row IDs where one exists.

| Requirement | Scenario | Design row | Task(s) |
|---|---|---|---|
| Raw Foreign Key Output | FK-holding relation field prints `@relation(...)` | T6 | 2.3–2.4, 2.7–2.8 |
| Raw Foreign Key Output | Inverse relation field prints without `fields`/`references` | T6, T11 | 2.3–2.4, 2.9–2.10 |
| Raw Foreign Key Output | Relation-free FK metadata still prints `// @fk(...)` (the `db pull` shape) | T8 | 2.5–2.6 |
| Raw Foreign Key Output | Ambiguous FK-to-relation cross-reference throws | T9 | 2.11–2.14 |
| @@realtime Printing | Realtime model without column allowlist | (regression) | 1.1 |
| @@realtime Printing | Realtime model with a non-empty column allowlist | T4 | 1.5–1.6 |
| @@realtime Printing | Realtime model with an empty column allowlist prints the empty list, not bare `@@realtime` | T4 | 1.5–1.6 |
| Round-Trip Fidelity | Round-trip equality holds over the full IR | T14 | 1.17–1.18, 2.22–2.23 |
| Round-Trip Fidelity | The one permitted exclusion is index re-bucketing, and it is documented | (structural) | 1.19, 2.24 |
| Round-Trip Fidelity | A deleted normalization exclusion fails the suite | T14 (proof already on hand) | 1.20, 2.25 |
| @@allow Printing | Multiple allow rules print as separate lines in IR order | T1 | 1.7–1.8 |
| @@allow Printing | Field operand prints the schema field name, not the mapped column name | T2 | 1.9–1.10 |
| @@allow Printing | Claim operand prints as `auth.<name>` | T1 (extended) | 1.7–1.8 |
| @@allow Printing | `write`/`all` sugar is never re-collapsed | T3 | 1.11–1.12 |
| TableGroup Printing | TableGroup blocks print after model/enum blocks | T5 | 1.13–1.14 |
| TableGroup Printing | "Last group wins" overlap round-trips faithfully | T5 | 1.13–1.14 |
| TableGroup Printing | TableGroup source, not derived fields, drives printing | T5 (extended) | 1.15–1.16 |

Additionally: T8 and T13 are **explicitly not RED** against the current tree (guards, not
coverage; see 2.5–2.6 and 2.20–2.21). T9/T10 are **weak-RED** and require a message-substring
pin plus a mutation proof to count as real coverage (see 2.11–2.18).

## Phase 1: PR 1 — `@@allow`, `@@realtime(columns:)`, `TableGroup`

- [x] 1.1 Regression guard: run `packages/core/test/print.mjs` unmodified before any edit in this
      phase; confirm "`@@realtime` emitted only when resolved with realtime true" still passes.
      This pins the bare-`@@realtime` behavior as a baseline before T4 changes it into a
      conditional form.
- [x] 1.2 RED (spec: `@@realtime(columns:)`, T4 setup — non-empty list): extend
      `packages/core/test/print.mjs` — unit test with `realtimeColumns: ["id", "status"]`; assert
      the output includes `@@realtime(columns: [id, status])` and does **not** include bare
      `@@realtime` on its own line. Fails today: `printTable` only reads `table.realtime` and has
      no `realtimeColumns` branch.
- [x] 1.3 RED (spec: `@@realtime(columns:)`, T4 — the empty-list case, the load-bearing row):
      extend `print.mjs` — unit test with `realtimeColumns: []`; assert the output contains the
      literal text `@@realtime(columns: [])`, **and** `deepStrictEqual` the re-resolved
      `realtimeColumns` against `[]` (not `undefined`), round-tripping through `parse`+`resolve`.
      Fails today: `realtimeColumns` is never read, so nothing is emitted and re-resolving yields
      `undefined`. This is the negative control proving the strictest declaration is not silently
      loosened to bare `@@realtime`.
- [x] 1.4 GREEN: in `printTable` (`packages/core/src/print.ts`), branch on
      `table.realtimeColumns !== undefined` → emit `@@realtime(columns: [${cols.map(c =>
      fieldNameFor(table, c)).join(", ")}])` (mapping physical → field names, including when the
      array is empty); else `table.realtime` → bare `@@realtime`; else nothing. Make 1.1–1.3
      green.
- [x] 1.5 RED (spec: @@allow Printing — "multiple allow rules print as separate lines in IR
      order", T1; plus the claim-operand scenario folded into the same fixture): extend
      `print.mjs` — a table with `allow.read = [rule1, rule2]` (two `AllowRule`s, one with a
      `{kind:"field"}` operand, one with `{kind:"claim", name:"userId"}`), in a specific order;
      assert two `@@allow(read, ...)` lines appear in that order, the field operand emits
      `this.<fieldName>`, and the claim operand emits `auth.userId`. Fails today: nothing prints
      `@@allow` at all.
- [x] 1.6 GREEN: add `printAllowOperand(table, op)` (field → `this.${fieldNameFor(table,
      op.name)}`, claim → `auth.${op.name}`, string/number/boolean → literal rules matching
      `printAttributeValue`) and `printAllowRule(table, action, rule)` → `@@allow(${action},
      ${left} == ${right})`; wire one line per `AllowRule` across `allow.create/read/update/delete`
      in IR order into `printTable`'s block-attribute list. Do **not** extend
      `printAttributeValue` itself — leave its `path`/`comparison` throw guard (`print.ts:85-93`)
      as the dead branch it already is (design D6). Make 1.5 green.
- [x] 1.7 RED (spec: "Field operand prints the schema field name, not the mapped column name",
      T2 — the mutation-proof row, kept as its own task so the proof is legible on its own):
      extend `print.mjs` — a table with a `@map`ped column (`ownerId` field, `owner_id` dbName)
      referenced by an `AllowRule` field operand; assert the output includes `this.ownerId` and
      does **not** include `owner_id` anywhere. Fails today: no output at all.
- [x] 1.8 GREEN: confirm 1.6's `printAllowOperand` routes the field case through `fieldNameFor`
      (not the raw `dbName`). Make 1.7 green. **Mutation proof (required)**: temporarily replace
      `fieldNameFor(table, op.name)` with the raw `op.name` in `printAllowOperand`; run 1.7 and
      record the observed outcome in this file (expected: RED, because the output now contains
      `owner_id`). Revert once recorded.
- [x] 1.9 RED (spec: "`write`/`all` sugar is never re-collapsed", T3 — round trip): extend
      `print.mjs`'s fixture round-trip loop scope to include `18-allow-rules.indigo` (remove it
      from any exclusion if present — it is not currently in `UNPRINTABLE_FIXTURES`, so this task
      is really "confirm the round trip fails once `allow` re-enters the comparison"). Assert the
      printed text contains three separate `@@allow(create, ...)`, `@@allow(update, ...)`,
      `@@allow(delete, ...)` lines for a rule that originated from one authored `@@allow(write,
      ...)`, never one collapsed `@@allow(write, ...)` line. Fails today (after 1.6/1.8 land):
      `allow` is still deleted by `normalizeForRoundTrip` at this point in the sequence, so the
      fixture round trip does not yet exercise the printed text — this task's unit-level assertion
      is what turns genuinely RED before 1.21 deletes the exclusion.
- [x] 1.10 GREEN: confirm 1.6 performs no alias re-collapsing (it doesn't — it iterates the four
      already-expanded `allow.*` buckets independently). Fix only if 1.9 fails.
- [x] 1.11 RED (spec: TableGroup Printing — "TableGroup blocks print after model/enum blocks",
      T5): extend `print.mjs` — a schema with one non-empty `tableGroups` entry; assert the
      printed text contains a `TableGroup "..." { ... }` block, and its start index is after every
      `Table`/`enum` block's end. Fails today: `printSchema` never reads `schema.tableGroups`.
- [x] 1.12 GREEN: add `printTableGroup(group, indent)` → `TableGroup "<name>" {\n${color line if
      group.color !== undefined}\n${one member per group.tables entry, verbatim}\n}`; append one
      block per `schema.tableGroups` entry, in array order, after the table/enum blocks in
      `printSchema`. Make 1.11 green.
- [x] 1.13 RED (spec: "'Last group wins' overlap round-trips faithfully", T5 — round trip on
      `04-tablegroup-edge.indigo`): extend `print.mjs`'s fixture round trip to assert, for this
      fixture specifically, that the re-resolved `tableGroups` array is deep-equal to the
      original, **and** an explicit assertion that `A.group === "NoColor"` and `A.color ===
      undefined` on the re-resolved side (the design's named overlap check — a generic round-trip
      pass alone would not catch a subtly wrong derivation). Fails today: `tableGroups` is zeroed
      by the normalizer at this point in the sequence and `color`/`group` are deleted, so nothing
      is compared yet.
- [x] 1.14 GREEN: confirm 1.12's verbatim, array-order emission reproduces `04-tablegroup-edge`'s
      overlap once re-resolved (per design's walkthrough: printing `tableGroups` in source order
      replays `group_by_table`'s last-wins overwrite on re-resolve). Fix only if 1.13 fails.
- [x] 1.15 RED (spec: "TableGroup source, not derived fields, drives printing"): extend `print.mjs`
      — hand-build a `ResolvedSchema` where `table.color`/`table.group` are set to values
      inconsistent with `tableGroups` (e.g. `table.color = "bogus"` but `tableGroups` says
      something else, or the table isn't listed in any group at all); assert the printed
      `TableGroup` blocks reflect `tableGroups` only — the inconsistent `table.color`/`table.group`
      values never leak into the output.
- [x] 1.16 GREEN: confirm `printTableGroup` reads only `group.color`/`group.tables`, never
      `table.color`/`table.group` (per design D8 — it already does, since 1.12 takes `group` as
      its only argument). Fix only if 1.15 fails.
- [x] 1.17 Unpin the round-trip corpus for the constructs this phase covers: in
      `normalizeForRoundTrip`, delete the `tableGroups: []` reset and the `color, group, allow,
      realtimeColumns` destructure-and-drop. Keep `foreignKeys: []`/`relations: []` (PR 2's job)
      and the index re-bucketing (the one permanent exclusion). Update the function's docstring to
      describe exactly the two remaining categories: FK/relations (still excluded, PR 2) and index
      re-bucketing (permanent).
- [x] 1.18 RED→GREEN together (T14, this phase's slice): run the full fixture round-trip loop.
      Fixtures `04-tablegroup-edge`, `18-allow-rules`, `20-realtime-columns` are the ones newly
      exercised by 1.17's deletions and must now pass with the real printed text, not a normalized
      stand-in. Confirm green with 1.4/1.6/1.12 in place.
- [x] 1.19 Confirm the single documented exclusion is present and worded correctly: the inline
      comment on the index re-bucketing line names the field (`indexes`) and the reason (fixed
      emission-order grouping, not data loss) per spec scenario "The one permitted exclusion is
      index re-bucketing, and it is documented".
- [x] 1.20 MUTATION (required, T14's "deleted exclusion fails the suite" proof — spec scenario "A
      deleted normalization exclusion fails the suite"): temporarily re-add the `allow` deletion to
      `normalizeForRoundTrip` (restore `const { allow, ...rest } = t;` and drop `allow` from the
      returned object) while `printTable` still emits `@@allow`. Run the fixture round trip and
      record the observed outcome in this file (expected: RED — `18-allow-rules.indigo`'s
      round-trip now fails because the printed side has `allow` populated but the normalized
      "expected" side does not). Revert the mutation once recorded.
- [x] 1.21 Two new `UNPRINTABLE_FIXTURES` entries, each with a written per-fixture reason (spec:
      design's correction #2 — these are **fixture** exclusions, the printer provably throws, a
      different category from the **normalizer field** exclusions removed in 1.17):
      - `19-rejected-allow.indigo` — `@@allow(read, auth.userId == this.owner)` resolves to
        `{kind:"field", name:"owner"}` with no column carrying that `dbName`; `fieldNameFor` throws
        inside `printAllowOperand`.
      - `21-rejected-realtime-columns.indigo` — `@@realtime(columns: [id, ghostField])` resolves
        to `realtimeColumns: ["id", "ghostField"]`; `fieldNameFor` throws inside 1.4's
        `@@realtime(columns:)` branch on `ghostField`.
      RED: add both filenames to `UNPRINTABLE_FIXTURES` with an inline comment per entry stating
      which operand/column has no matching `dbName` and which printer function throws. Assert (in
      the existing `UNPRINTABLE_FIXTURES` throw-confirmation loop) each fixture resolves
      successfully but `printSchema` throws `IndigoPrintError`. Fails today (before 1.6/1.4 land):
      neither fixture is in the exclusion set yet, and before this task the printer silently drops
      the unresolvable operand/column rather than throwing.
      GREEN: confirm 1.6/1.4 throw as expected once the fixtures are excluded from the round-trip
      loop and added to the throw-confirmation loop. Corpus goes 20 → 18 round-trippable files;
      positive coverage for `@@allow`/`@@realtime(columns:)` survives via `18-allow-rules.indigo`
      and `20-realtime-columns.indigo`, which stay in scope.
- [x] 1.22 Reachability guard: confirm the fixture round-trip `console.log` line still reports the
      correct in-scope count (`18/20` after 1.21; `05-relations.indigo` remains the pre-existing
      third exclusion pending PR 2).
- [x] 1.23 Run `node packages/core/test/print.mjs` (after `pnpm build --filter=@indigodb/core`) —
      confirm 1.1–1.22 all green together with every pre-existing case in the file. Rollback
      boundary: revert `print.ts` to bare `@@realtime`/no `@@allow`/no `TableGroup`; restore the
      five deleted normalizer exclusions; drop 19/21 from `UNPRINTABLE_FIXTURES` (leave 05 alone —
      it is PR 2's fixture, untouched by this phase).

## Phase 2: PR 2 — Relations (`claimForeignKeys`, `printRelationField`)

- [x] 2.1 Design-correction guard (read before writing any code in this phase, not a test): the FK-
      holder discriminator is `rel.inverse !== true && rel.fkColumns.length > 0`, **not**
      `rel.fkColumns.length > 0`. `pair_relations` (`resolve.rs:592-597`) back-fills the holder's
      `fkColumns`/`refColumns` onto the paired inverse side and sets `inverse: true`, so
      `User.authoredPosts` in `12-relation-naming.indigo` carries `fkColumns: ["authorId"]` — a
      column that lives on `Post`, not `User` — while `inverse: true`. Using the wrong
      discriminator here is not a hypothetical bug; it is the exact error the proposal and
      exploration both made and the design corrected. Task 2.3 below is written specifically to
      catch a regression back to the wrong discriminator.
- [x] 2.2 RED (spec: "Inverse relation field prints without `fields`/`references`", T6/T11 setup
      — self-relation, the simplest holder case): extend `print.mjs` — round trip
      `08-self-relation.indigo`; assert the printed text contains
      `parent   Category? @relation(fields: [parentId], references: [id])` and no `// @fk(…)` line
      for `Category` (its only FK is claimed). Fails today: `relations` is zeroed by the normalizer
      and no `@relation(` text is ever emitted.
- [x] 2.3 RED (spec: "FK-holding relation field prints `@relation(...)`" AND "Inverse relation
      field prints without `fields`/`references`" together — T6, the row that specifically exists
      to catch the wrong discriminator per 2.1): extend `print.mjs` — round trip
      `12-relation-naming.indigo`; assert the printed text contains, verbatim:
      ```
      authoredPosts Post[]   @relation("PostAuthor")
      reviewedPosts Post[]   @relation("PostReviewer")
      profile       Profile?
      ```
      on `User` (no `fields:`/`references:` — these are the back-filled-`fkColumns` inverse sides,
      D1), and:
      ```
      author     User @relation("PostAuthor", fields: [authorId], references: [id])
      reviewer   User @relation("PostReviewer", fields: [reviewerId], references: [id])
      ```
      on `Post` (the true holders). **This specifically fails under the wrong discriminator**
      (`fkColumns.length > 0` alone): `User.authoredPosts` would wrongly qualify as a holder (its
      back-filled `fkColumns` is `["authorId"]`), and `fieldNameFor(User, "authorId")` throws
      because `authorId` is a column on `Post`, not `User`. Confirm during apply that this
      assertion genuinely throws under the wrong discriminator before moving to 2.4 (a manual
      one-line swap-and-revert, recorded in this file).
- [x] 2.4 GREEN: implement `printRelationField(schema, table, rel, fk)` per the design's exact
      algorithm — `holder = rel.inverse !== true && rel.fkColumns.length > 0`; non-holder emits
      the bare type + optional `@relation("name")`; holder emits `@relation(${args})` with
      `relationName` positional first, then `fields:`/`references:` (D9 — only when the
      corresponding array is non-empty), then `onDelete:`/`onUpdate:` when `fk` carries them.
      `targetTable = schema.tables.find(t => t.name === rel.targetModel)`, missing → throw (same
      shape as `printFkComment`'s unknown-refTable throw). Wire relation rows into
      `printFieldLines` so they join the **same** aligned block as scalar columns, appended after
      all scalars, in `table.relations` IR order (design D5). Make 2.2 and 2.3 green.
- [x] 2.5 RED (spec: "Relation-free FK metadata still prints `// @fk(...)` (the `db pull` shape)",
      T8 — **explicitly GREEN-TODAY, not new RED coverage**): extend `print.mjs` — unit test with
      `foreignKeys: [...]` and `relations: []` (the introspection shape); assert the printed
      column is a plain scalar field and the FK still prints as `// @fk(…)`, with no synthesized
      `@relation(...)`. This passes against the current tree (the printer already does this for
      every FK, since it doesn't yet read `relations` at all) — record explicitly that it is a
      guard against a regression PR 2 could introduce, not proof of new behavior.
- [x] 2.6 GREEN: confirm `claimForeignKeys` (built in 2.11) treats an FK as an orphan whenever no
      relation claims it — which is unconditionally true when `table.relations` is empty. Fix only
      if 2.5 fails once 2.11/2.12 land; do not implement ahead of 2.11.
- [x] 2.7 RED (spec: "A claimed FK emits **no** `// @fk(...)`", design T7 — the assertion that a
      constraint is never printed twice): extend `print.mjs` — a table with one holder relation and
      exactly one matching `ForeignKey`; assert the output includes `@relation(` **and** does
      **not** include `// @fk(`. Fails today (pre-`claimForeignKeys`): no `@relation(` is emitted
      at all, so the "no `@fk`" half is vacuously true but the positive half fails.
- [x] 2.8 GREEN: implement the claiming half of `claimForeignKeys(schema, table)` — for each
      holder relation, `matches = table.foreignKeys.filter(fk => arrayEq(fk.columns,
      rel.fkColumns) && fk.refTable === targetTable.dbName)`; `matches.length === 1` → claim it
      (`fk = matches[0]`, removed from the comment list); `matches.length === 0` → `fk = undefined`
      (reachable only for the `references:`-less shape per D9). Wire `printTable` to build the FK
      comment list from `claimForeignKeys(...).orphans` instead of `table.foreignKeys` directly.
      Make 2.7 green.
- [x] 2.9 RED (spec: "Inverse relation field prints without `fields`/`references`" — the plain
      unpaired-inverse case, distinct from 2.3's name-paired case): extend `print.mjs` — a relation
      with `fkColumns: []`, no `relationName` (an implicitly-paired inverse, e.g. `User.profile` in
      `12-relation-naming.indigo`); assert the printed field line is the bare `name type` with no
      `@relation(` clause at all (not even an empty one).
- [x] 2.10 GREEN: confirm 2.4's non-holder branch emits `attrs = []` when `relationName` is
      undefined (not `@relation()`). Fix only if 2.9 fails.
- [x] 2.11 RED (spec: "Ambiguous FK-to-relation cross-reference throws", T9 — **weak-RED,
      message-pinned per design's adversarial reading**): extend `print.mjs` — two holder relations
      on one table with identical `fkColumns` and the same target, matched by two FKs with an
      identical column set; assert `throws(() => printSchema(s), IndigoPrintError)` **and**
      `err.message.includes("matches")` (or the exact substring the implementation uses — pin
      whatever `claimForeignKeys` actually throws, and record it here). A bare
      `throws(fn, IndigoPrintError)` with no message assertion does not count as satisfying this
      task — per the design, it can pass today for the wrong reason (any hand-built relation IR
      currently produces no relation output before 2.4 lands, or an unrelated `fieldNameFor` throw
      could satisfy a message-less assertion).
- [x] 2.12 GREEN: implement the `matches.length > 1` branch of `claimForeignKeys` — throw
      `IndigoPrintError` naming the table and the ambiguous column set (design's exact message
      shape: `Table "X": relation field "y" matches N foreign keys with identical column set […] —
      cannot determine onDelete/onUpdate`). Make 2.11 green.
- [x] 2.13 MUTATION (required, T9's weak-RED closure): temporarily replace 2.12's throw with
      "pick `matches[0]`" (first-match-wins). Run 2.11 and record the observed outcome in this file
      (expected: RED — the test now fails because no throw occurs). Revert once recorded. This is
      the proof that 2.11 is not theatre.
- [x] 2.14 RED (design: the second ambiguity direction — "an FK already claimed by another
      relation" throws, distinct from 2.11's "one relation matches ≥2 FKs"): extend `print.mjs` —
      two holder relations whose `fkColumns` legitimately differ but both happen to match the same
      single FK entry via the matching rule (construct via two relations with equal `fkColumns` +
      target but only one FK present, so both relations' `matches` singleton-resolve to the same
      FK); assert `throws(IndigoPrintError)` with a message pinned to `err.message.includes("claimed
      by both")` (or the exact substring used).
- [x] 2.15 GREEN: track claimed FKs in a `Map<ForeignKey, ResolvedRelation>` (or equivalent) inside
      `claimForeignKeys`; when a singleton match is already claimed by a different relation, throw
      naming both relation field names. Make 2.14 green.
- [x] 2.16 RED (design D4 — "a claimed FK carrying `name` throws"; spec doesn't have a standalone
      scenario for this, but it's load-bearing per the design's non-negotiable #4): extend
      `print.mjs` — a holder relation whose matched FK carries `name: "some_fkey"`; assert
      `throws(IndigoPrintError)` with `err.message` pinned to a substring naming the constraint
      (e.g. `includes("constraint name")` — pin the actual implementation string).
- [x] 2.17 GREEN: in `claimForeignKeys`, once a singleton match is found and not already claimed,
      check `fk.name !== undefined` → throw naming the table, relation field, and `fk.name`. Make
      2.16 green. Confirm this needs **no** `normalizeForRoundTrip` exclusion — 0/21 corpus FKs
      carry a `name` (measured, design correction #3), so this branch is unreached by the fixture
      round trip and reachable only via hand-built unit IR.
- [x] 2.18 MUTATION (required, closing 2.16's weak-RED status the same way as 2.11/2.13): temporarily
      remove the `fk.name !== undefined` check from 2.17's implementation. Run 2.16 and record the
      observed outcome (expected: RED — the relation now prints successfully with the named FK
      silently ignored instead of throwing). Revert once recorded.
- [x] 2.19 RED (spec: "Relation fields print after all scalars", T11 — ordering assertion, distinct
      from 2.2/2.3's content assertions): extend `print.mjs` — a table with ≥1 scalar column and
      ≥1 relation field; assert `out.indexOf(relationLine) > out.indexOf(lastScalarLine)`.
- [x] 2.20 GREEN: confirm 2.4's wiring into `printFieldLines` appends relation rows after all
      scalar rows in the same aligned block (design D5). Fix only if 2.19 fails.
- [x] 2.21 Update the `05-relations.indigo` `UNPRINTABLE_FIXTURES` comment (**not** a new
      exclusion, and **not** re-litigating why it's excluded — design correction #2 is explicit
      that PR 2 must not touch 19/21's PR-1 reasons): its `ghost` relation's `missingLocal` now
      throws inside `printRelationField`'s `fieldNameFor` call (via `claimForeignKeys`'s matching
      path or the field-name lookup inside `printRelationField`), not inside `printFkComment` as
      the current comment states. Update the inline comment and the throw-confirmation loop's
      description to name the new code path; the throw assertion itself (still
      `throws(printSchema, IndigoPrintError)`) needs no behavior change, only the explanatory text.
- [x] 2.22 Delete the two remaining `normalizeForRoundTrip` exclusions: `foreignKeys: []` /
      `relations: []` on both sides. Update the docstring to describe the function's final,
      single-exclusion state (index re-bucketing only) per the spec's "Round-Trip Fidelity"
      requirement.
- [x] 2.23 RED→GREEN together (T14, this phase's slice): run the full fixture round-trip loop.
      Fixtures `07-referential-actions`, `08-self-relation`, `12-relation-naming` are the ones
      newly exercised by 2.22's deletion. Confirm green with 2.4/2.8/2.12/2.15/2.17 in place.
- [x] 2.24 Confirm the final `normalizeForRoundTrip` body matches the spec's target exactly: **one**
      exclusion (the index re-bucketing line with its inline comment naming `indexes` and the
      reason), nothing else. Diff it against the design's quoted target function
      (`design.md` "The `normalizeForRoundTrip` rewrite" section) — any additional line here is a
      regression of this change's whole point and must be reported in the verify report if
      unavoidable.
- [x] 2.25 MUTATION (required, T14's final closure — the strongest available RED lever per the
      design's non-negotiable #9): temporarily delete any single line from the fully-restored
      `normalizeForRoundTrip` (e.g. re-add `relations: []`). Run the fixture round trip and record
      the observed outcome (expected: RED — immediate failure on the fixture(s) exercising that
      construct). Revert once recorded. This is the demonstrated proof that the round-trip suite,
      in its final state, actually falsifies a silent drop.
- [x] 2.26 Narrow the `printSchema` module docstring (proposal decision, spec-adjacent): the
      "never guesses" promise becomes conditional and honest — the printer throws on unmappable
      *and* ambiguous IR; the `// @fk(…)` fallback for relation-free FK metadata is stated as
      deliberate, documented behavior for the `db pull` path, with the `db-pull-relation-synthesis`
      follow-up named. Do not delete the invariant statement; narrow it truthfully.
- [x] 2.27 Cross-package regression guard: run `node packages/migrator/test/pull-roundtrip.mjs`
      unmodified — confirm `ok(!text.includes("@relation"))` / `ok(text.includes("@fk("))` still
      pass. Introspected IR has `relations: []` by construction (`introspect.ts:350`), so it takes
      `claimForeignKeys`'s all-orphan path unchanged. This file must not be edited in this phase.
- [x] 2.28 Reachability guard: confirm the fixture round-trip `console.log` line reports `20/20`
      round-trippable fixtures minus the three permanent exclusions (`05-relations.indigo`,
      `19-rejected-allow.indigo`, `21-rejected-realtime-columns.indigo`) = `17/20` in scope, and
      that `UNPRINTABLE_FIXTURES` has exactly those three entries, each with its own written
      per-fixture reason comment (no shared/generic comment covering more than one fixture).
- [x] 2.29 Run `node packages/core/test/print.mjs` (after `pnpm build --filter=@indigodb/core`) —
      confirm 2.1–2.28 all green together with every pre-existing and PR-1 case in the file.
      Rollback boundary: revert relation printing to the `// @fk(…)` comment for every FK; restore
      the `foreignKeys: []`/`relations: []` normalizer exclusions. PR 1's `@@allow`/
      `@@realtime(columns:)`/`TableGroup` output and normalizer deletions are untouched by this
      revert.

## Phase 3: Cross-package verification

- [x] 3.1 Run `pnpm clean && pnpm build --force && pnpm lint && pnpm test` from the repo root.
      `--force` is mandatory — Turbo restores a cached `dist/` wholesale on a cache hit, and a bare
      `pnpm clean && pnpm build` has previously resurrected dead files from deleted packages in
      this repo (see `crates/CLAUDE.md`/root `CLAUDE.md`).
- [x] 3.2 Confirm no `fixtures/snapshots/` regeneration or `@indigodb/compiler`'s
      `test/parity.mjs` change is needed — verify by running
      `node packages/compiler/test/parity.mjs` unmodified and confirming it stays green (the
      design states this as verified, but this task re-confirms it against the actual final diff
      rather than assuming the design's claim).
- [x] 3.3 Confirm `packages/cli/src/util.ts` (`db pull`'s `printSchema` call site) and
      `packages/migrator/test/pull-roundtrip.mjs` remain byte-unmodified in the final diff (both
      were declared **Unchanged** in the design's File Changes table).
- [x] 3.4 Update `openspec/changes/schema-printer-fidelity/proposal.md` Success Criteria checkboxes
      to checked, referencing this `tasks.md` as evidence.
- [x] 3.5 Record explicitly in the archive report (per the proposal's highest-likelihood risk,
      Risk #1, and Success Criteria's last bullet): **this change does not fix `db pull`'s FK
      loss.** `introspect.ts:350` still hardcodes `relations: []`; `pull-roundtrip.mjs` (task 2.27)
      still pins the `// @fk(…)` fallback as correct for that path. The follow-up is named:
      `db-pull-relation-synthesis`.
- [x] 3.6 Record explicitly-out-of-scope items (not silently dropped), matching the proposal's
      Non-Goals: relation-field-name synthesis for introspected schemas; re-collapsing expanded
      `@@allow` `write`/`all` aliases; any change to `fixtures/snapshots/` or the WASM artifact.
