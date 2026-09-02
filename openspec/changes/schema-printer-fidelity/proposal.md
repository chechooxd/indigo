# Proposal: Schema printer fidelity

## Intent

`printSchema` (`packages/core/src/print.ts`) opens its own docstring with a promise: it "never
guesses — any IR construct it cannot represent losslessly throws `IndigoPrintError`". **It breaks
that promise four times, silently.** Relations become an inert `// @fk(…)` comment nothing parses
back; `@@allow` vanishes; `@@realtime(columns: […])` collapses to bare `@@realtime` — the strictest
declaration a user can write degrades into the loosest; `TableGroup` blocks disappear.

The reason four data-loss bugs sat green is a single function. `normalizeForRoundTrip`
(`packages/core/test/print.mjs:540-550`) deletes `color, group, allow, realtimeColumns` and zeroes
`foreignKeys`/`relations` **on both sides** before comparing. It compares what survives against what
survives. The suite cannot see the losses by construction, so the printer's guarantee is currently
unfalsifiable.

Success: `printSchema` prints every IR construct `.indigo` can express, and the round-trip suite
compares the **full** IR with a short, individually justified exclusion list — so the next silent
drop fails a test instead of shipping.

## The correction this change is opened on — read first

**This change does not fix a `db pull` bug, and any report claiming otherwise is wrong.**

The change was initiated on the claim that a live shipped `db pull` FK-loss bug is fixed by teaching
the printer to emit `@relation(…)`. It is not.

- `packages/migrator/src/introspect.ts:350` hardcodes `relations: []`, documented at `:302`.
  Introspection is a pure DDL scan with no relation-field concept, so **a `db pull` schema carries
  no relation IR at all** — only `foreignKeys`, physical constraints with no field names.
- Printing `@relation(…)` from `table.relations` is therefore a no-op for `db pull`: there is
  nothing to read.
- Closing that path requires **inventing** a forward field name, a pluralized inverse name, and a
  disambiguation policy for multiple FKs from one table to the same target and for self-relations.
  No pluralize/singularize utility exists anywhere in this repo. It is a naming-policy design
  problem, and doing it inside `printSchema` would violate the module's own "never guess" invariant.
- It is a **documented known limitation, not an oversight**:
  `openspec/changes/archive/2026-08-18-indigo-schema-printer/design.md` named it an explicit
  out-of-scope follow-up when the printer shipped, and `packages/migrator/test/pull-roundtrip.mjs:81-82`
  pins the current behavior as correct:

  ```js
  ok(!text.includes("@relation"), …);
  ok(text.includes("@fk("), …);
  ```

Implied follow-up change: **`db-pull-relation-synthesis`** — a naming policy, a pluralize utility,
disambiguation rules, and a deliberate inversion of those two assertions. Not this change.

## Scope

### In Scope

- Print `@relation(…)` from `table.relations` when populated, both the FK-holding and the inverse
  side, with `onDelete`/`onUpdate` cross-referenced from `table.foreignKeys`.
- Print `@@allow(action, left == right)`, one per `AllowRule`, in IR order.
- Print `@@realtime(columns: […])`, **including the empty-list case**; bare `@@realtime` otherwise.
- Print `TableGroup` blocks from `ResolvedSchema.tableGroups`.
- Rewrite `normalizeForRoundTrip` to compare the full IR, with a short exclusion list where every
  entry carries a written reason.
- Make the residual gap visible in the module docstring rather than silently re-closed.

### Out of Scope / Non-Goals

- **Synthesizing relation field names for introspected (`db pull`) schemas.** See the correction
  above. `printFkComment` **stays** as the honest fallback for a `ForeignKey` with no matching
  relation metadata — it remains exactly what `db pull` needs until the follow-up lands.
- **`packages/migrator/test/pull-roundtrip.mjs` is not touched.** Its assertions still describe
  correct behavior under this scope, and introspected schemas still take the `// @fk(…)` path.
- Re-collapsing `write`/`all` `@@allow` aliases (already expanded 1:4 by resolve; re-collapsing
  risks getting the alias heuristic wrong).
- `UNPRINTABLE_FIXTURES`' exclusion of `05-relations.indigo` — excluded for an unrelated reason
  (duplicate model name + dangling `@relation` field refs make `fieldNameFor` throw). Stays.
- No `fixtures/snapshots/` or `parity.mjs` dependency; **no golden regeneration**.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `schema-printing`: four requirement changes.
  1. **"Raw Foreign Key Output (No Relation Synthesis)" must be narrowed**, not deleted. It
     currently forbids `@relation(…)` output unconditionally. It becomes conditional on the IR:
     relation metadata present → print `@relation(…)`; absent (introspected) → the `// @fk(…)`
     fallback, still documented as intended behavior and still the `db pull` contract.
  2. **"@@realtime Printing"** gains the column-projection form, with the empty list as a distinct
     printed state.
  3. New requirement for `@@allow` printing.
  4. New requirement for `TableGroup` printing.
  5. **"Round-Trip Fidelity for In-Scope IR"** must name its residual exclusions explicitly instead
     of leaving "in-scope subset" undefined.

Untouched at spec level (behavior is read, not changed): `relation-identity`, `relation-validation`,
`model-allow-rules`, `realtime-column-projection`, `db-pull-command`, `schema-introspection`.

## Approach

Read the IR that already exists. Every fact needed is present; nothing is inferred.

`ResolvedRelation` carries `name`, `targetModel`, `list`, `optional`, `fkColumns`, `refColumns`,
`relationName`, `inverse` — enough to print faithfully with zero guessing.

| Construct | Source | Emission |
|---|---|---|
| FK-holding relation | `fkColumns.length > 0` | `${name} ${targetModel}${suffix} @relation(${"relationName", }fields: […], references: […]${onDelete}${onUpdate})` |
| Inverse / unpaired relation | `fkColumns.length === 0` | `${name} ${targetModel}${suffix}`, plus `@relation("${relationName}")` only when `relationName` is present |
| `@@allow` | `table.allow` | `@@allow(${action}, ${left} == ${right})`, operands via a **new** printer: `{kind:"field"}` → `this.${fieldNameFor(...)}`, `{kind:"claim"}` → `auth.${name}` |
| `@@realtime` | `realtimeColumns !== undefined` | `@@realtime(columns: […])` even when empty; else bare `@@realtime` when `table.realtime` |
| `TableGroup` | `schema.tableGroups` | Verbatim top-level blocks after the tables |

Type suffix is `[]` for `list`, `?` for `optional`, empty otherwise.

`@@allow` operand printing is a new function, **not** `printAttributeValue`. That function's
throwing `path`/`comparison` guard (`print.ts:85-93`) exists for the unrelated `datasource.url`
path and stays a genuine dead branch — leave it. The comparison vocabulary is closed to `==`
(`validate.rs:875` rejects anything else), so no `op` field is missing from the IR.

`ResolvedSchema.tableGroups` mirrors declared blocks verbatim rather than deduplicating to final
ownership (`04-tablegroup-edge.indigo`'s "last group wins" case), so it — not the derived
`table.color`/`table.group` — is the correct print source.

## Decisions this proposal settles

| Question | Decision | Why |
|---|---|---|
| `onDelete`/`onUpdate` source | Cross-referenced from `table.foreignKeys` by **exact `columns` array equality**, reusing `schemaActionFromSql` | They are not on `ResolvedRelation`, and there is no IR back-pointer from a `ForeignKey` to its producing relation field |
| Ambiguous cross-reference (two relation fields on one table with identical FK column sets to the same target) | **Throws `IndigoPrintError`. Never silently picks the first match.** | Column-set equality is unambiguous for every existing fixture but is **not IR-guaranteed unique**. Picking the first match is exactly the "best guess" this module forbids |
| FK constraint `name:` | **Unrepresentable — the one legitimate residual exclusion**, and it must be commented as such | `.indigo`'s `@relation` has no `name:` argument (`name:` exists only on `@@index`/`@@unique`), and `resolve.rs:267` hardcodes `name: None` — `ForeignKey.name` is introspection-only, so it only ever reaches the `// @fk(…)` comment path |
| Ordering inside a table block | Relation fields print **after all scalar columns**, in IR order, and this **is asserted** in the text-level tests | Interleaving is not recoverable from the IR, and this matches existing precedent (`@@unique` before `@@index`). It costs no round-trip exclusion: `columns` order is untouched, and relative `relations` order is preserved |
| The docstring's "throws" promise | **Narrowed, honestly, and made true within the narrowing.** The printer throws on unmappable *and ambiguous* IR; the `// @fk(…)` fallback for relation-free FK metadata is stated as deliberate, documented behavior with a named follow-up, not as an exception silently taken | The current docstring is false. Deleting the promise loses the invariant; leaving it loses trust. Narrowing keeps a checkable statement |
| `@@allow` alias handling | Print all 4 expanded entries; do not re-collapse to `write`/`all` | Re-collapsing requires a heuristic that can be wrong; expansion is what the IR states |

## The `normalizeForRoundTrip` rewrite is the heart of this change

Not a chore. It is the mechanism that made four bugs invisible, and every exclusion it keeps is a
place the next bug can hide. The target list is deliberately near-empty:

| Exclusion | Keep? | Reason |
|---|---|---|
| `foreignKeys: []` / `relations: []` on both sides | **Delete** | This is the mask over the primary bug. After this change, relations round-trip through real `@relation(…)` syntax |
| `tableGroups: []`, and `color`/`group` deletion | **Delete** | `TableGroup` blocks are now printed, so both sides must carry them |
| `allow` deletion | **Delete** | `@@allow` is now printed |
| `realtimeColumns` deletion | **Delete** | `@@realtime(columns:)` is now printed |
| Index re-bucketing (all `unique: true` first, then `unique: false`, each in original relative order) | **Keep** | The spec's fixed block-attribute order is the printer's designed emission order, not a loss. Fixture 16 interleaves them. Both sides re-bucketed identically |

Target end state: **exactly one exclusion.** If the design or apply phase finds a further one is
unavoidable, it MUST be justified inline with a code comment naming the IR field and the reason it
is unrepresentable, and it MUST be named in the verify report. An undocumented exclusion is a
regression of this change's whole point.

## Slice boundary — confirmed, two stacked PRs

`auto-chain` / `stacked-to-main`, ~450–670 authored lines total against an 800 budget.

| PR | Contents | Est. |
|---|---|---|
| **1 — the mechanical three** | `@@allow`, `@@realtime(columns:)`, `TableGroup`; the `allow`/`realtimeColumns`/`tableGroups`/`color`/`group` exclusions deleted from `normalizeForRoundTrip`; spec deltas for those three | ~200–300 |
| **2 — relations** | `printRelation`, the FK `onDelete`/`onUpdate` cross-reference with its ambiguity throw, the `foreignKeys`/`relations` exclusions deleted, the narrowed FK spec requirement, docstring | ~250–370 |

- **Independently green**: PR 1 touches no relation code and deletes only the exclusions covering
  what it prints; the round-trip suite passes with `foreignKeys`/`relations` still zeroed. PR 2
  deletes the remaining two exclusions.
- **Independently revertible**: PR 1 reverts to bare `@@realtime` + dropped `@@allow`/`TableGroup`
  with its own exclusions restored; PR 2 reverts to the `// @fk(…)` comment for every FK. Neither
  revert leaves the other half broken, because the two exclusion sets are disjoint.

`Decision needed before apply: No` · `Chained PRs recommended: Yes` · `400-line budget risk: Medium`

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `packages/core/src/print.ts` | Modified | `printRelation`, FK action cross-reference + ambiguity throw, `@@allow` operand printer, `@@realtime(columns:)`, `printTableGroup`, docstring |
| `packages/core/test/print.mjs` | Modified | `normalizeForRoundTrip` rewrite + text-level assertions per construct |
| `openspec/specs/schema-printing/spec.md` | Modified | Delta: narrowed FK requirement, `@@realtime` columns, `@@allow`, `TableGroup`, named residual exclusions |
| `packages/migrator/test/pull-roundtrip.mjs` | **Unchanged** | Confirmed unaffected — introspected schemas still take the `// @fk(…)` fallback |
| `packages/cli/src/util.ts` (`db pull`) | **Unchanged** | Behavior identical under this scope |

## Testing (must actually bite)

Each item states how it fails against the current tree. **The strongest demonstration already
exists and should be used as the change's proof:** deleting any single normalization from today's
`normalizeForRoundTrip` fails the suite immediately — which is precisely the evidence that the
printer is dropping that construct. This change makes those deletions permanent and green.

1. **Round trip with the exclusions removed** across the 17-fixture corpus (`04`, `07`, `08`, `12`,
   `18`, `20` carry the relevant constructs). **Today**: fails the instant any exclusion is deleted.
2. **`@@realtime(columns: [])` empty-list** fixture: printed text contains `@@realtime(columns: [])`,
   and re-resolving yields `realtimeColumns: []`, not `undefined`. **Today**: prints bare
   `@@realtime`; the re-resolved value is `undefined`. Fails. This is the negative control proving
   the strictest declaration is not silently loosened.
3. **`@@allow` operands**: a `this.<field>` operand uses the **schema field name**, not the physical
   `dbName`. Mutation proof: replacing `fieldNameFor(...)` with the raw `dbName` must fail this on a
   fixture with a `@map`ped column.
4. **FK action ambiguity throws**: a hand-built IR with two relation fields sharing an identical FK
   column set to the same target → `IndigoPrintError`. Mutation proof: downgrading the throw to
   "pick the first match" must fail this test.
5. **Relation-free FK metadata still prints `// @fk(…)`**: hand-built IR with `foreignKeys` and
   `relations: []` (the `db pull` shape) → the comment fallback, unchanged. Guards the non-goal.
6. **`TableGroup` "last group wins"** (`04-tablegroup-edge.indigo`): printed blocks re-resolve to
   an identical `tableGroups` array **and** identical derived `color`/`group` on every table.
7. **Purity**: `printSchema` called twice on the same IR is byte-identical (existing requirement,
   now exercised over the new constructs).
8. Root gate: `pnpm clean && pnpm build --force && pnpm lint && pnpm test`. Focused:
   `node packages/core/test/print.mjs`.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **The change is reported as fixing `db pull`'s FK loss** | High | Stated in the Intent, a dedicated correction section, a Non-Goal, a guarding test (#5), and it must be repeated in the archive report |
| FK `onDelete`/`onUpdate` cross-reference by column-set equality has no IR uniqueness guarantee | Med | Throws on ambiguity with a test that bites against "pick the first" |
| A new exclusion is quietly added to `normalizeForRoundTrip` to make a fixture pass | Med | Exclusions require an inline reason comment and must be named in the verify report; the target is exactly one |
| Relation printing changes text for existing `db pull` output | Low | Introspected IR has `relations: []`, so it takes the unchanged fallback path — asserted by `pull-roundtrip.mjs`, untouched |
| `pull-roundtrip.mjs` encodes the OLD behavior as its correctness assertion | Low (this change) | Recorded: when `db-pull-relation-synthesis` lands, those assertions invert and must be rewritten deliberately, not deleted |
| Slice 2 exceeds budget | Low | ~370 worst case against 800; corpus likely needs no new fixtures |

## Rollback Plan

Per slice, and cheap. `print.ts` is a pure, I/O-free function with no persisted state, no wire
format, no generated-client surface, and no migration. Reverting either PR restores the previous
printer plus its corresponding `normalizeForRoundTrip` exclusions; the two exclusion sets are
disjoint, so either revert leaves a green suite. No `fixtures/snapshots/` or WASM artifact is
touched, so no regeneration is needed in either direction.

## Dependencies

None. No new packages. All IR fields consumed already exist and are populated by `resolve.rs`.

## Success Criteria

- [ ] `normalizeForRoundTrip` contains **exactly one** exclusion (index re-bucketing), or every
      additional exclusion carries an inline reason and is named in the verify report.
- [ ] Deleting `foreignKeys: []`/`relations: []`, `tableGroups: []`, `allow`, `realtimeColumns`,
      `color`, and `group` from the normalizer leaves the round-trip suite green across the corpus.
- [ ] A `@@realtime(columns: [])` schema round-trips to `realtimeColumns: []`, never `undefined`.
- [ ] An ambiguous FK cross-reference throws `IndigoPrintError`; no test passes with a
      "first match wins" implementation.
- [ ] Introspected-shape IR (`relations: []` with `foreignKeys`) still prints `// @fk(…)`, and
      `pull-roundtrip.mjs` passes unmodified.
- [ ] The module docstring's failure promise is true as written, and the residual `db pull` gap is
      stated in the docstring with its follow-up change named.
- [ ] The archive report states that this change does **not** fix `db pull`'s FK loss.

## Proposal question round

Execution mode is `auto`, so the following were decided rather than asked. Flag any before design.

1. **Relation fields print after all scalar columns, and that ordering is asserted.** The
   alternative is leaving text order free and asserting only the IR round-trip. Asserting it locks
   in a diff shape for anyone hand-editing a printed schema; leaving it free makes the printer's
   output less predictable. Assumed: assert.
2. **The docstring promise is narrowed rather than made unconditionally true.** Making it literally
   true would require throwing on relation-free FK metadata — which would break `db pull` today.
   Assumed: narrow, and name the follow-up.
3. **`@@allow` is printed expanded (4 entries), never re-collapsed to `write`/`all`.** Round-trip
   safe, but a user who wrote `@@allow(write, …)` and then runs `db pull` gets four lines back.
   Assumed acceptable; a "preserve the authored alias" IR field would be a separate change.
4. **The `db pull` relation-synthesis follow-up is named but not scheduled here.** Confirm that the
   downstream ERD designer (`studio-erd-designer`) is genuinely unblocked by printer fidelity alone
   and does not also need introspected relations.
