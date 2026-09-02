# Verify Report: realtime-column-projection — PR 1 (compiler half)

**Scope**: Phase 1 only (16 tasks, all claimed `[x]`), branch
`feat/realtime-column-projection-1-compiler`, 4 commits off `main`@`ab5c34f`.
PR 2 (Phases 2-6, realtime runtime enforcement) is out of scope by design and
is not reported as a gap. Confirmed: no file under `packages/realtime/src`
is touched by this branch (`git diff --stat main...HEAD | rg realtime/src`
→ no matches).

**Verdict: PASS WITH WARNINGS**
**CRITICAL: 0 · WARNING: 1 · SUGGESTION: 1**

---

## Priority Finding — Adjudicated

**Claim**: `print.ts:229` emits bare `@@realtime` unconditionally, silently
discarding `realtimeColumns`; extending the `print.mjs` round-trip
drop-list to include `realtimeColumns` (same as `allow`) hides this behind
a test that no longer looks — a silent security widening.

**1. Is the round-trip loss real?** — **Yes, confirmed by direct
construction.** Built `packages/core/test/probe-tmp.mjs`, resolved
`fixtures/20-realtime-columns.indigo`, printed it, and re-resolved the
output:

| Table | Original `realtimeColumns` | After print → re-resolve |
|---|---|---|
| `BareRealtime` | `undefined` | `undefined` (correct, unaffected) |
| `ProjectedUser` | `["id","email_address"]` | `undefined` (allowlist lost) |
| `IdentityOnly` | `[]` (identity-only, strictest) | `undefined` (unrestricted, loosest) |

The printed output for all three tables is bare `@@realtime` — confirmed
by inspecting the printed source directly. The `IdentityOnly` case is the
worst instance: the single most restrictive form (`columns: []`) round-trips
to the least restrictive form (bare, all columns).

**2. Does it matter in practice? — No live `db pull` path exists today.**
Traced `printSchema`'s only production call site: `packages/cli/src/util.ts`
`writePulledSchema`, called exclusively from `db pull`
(`packages/cli/src/index.ts:148-152`). `writePulledSchema`'s only producer
of the `ResolvedTable`s it prints is `introspectResolvedSchema`
(`packages/migrator/src/introspect.ts`). That function's only realtime logic
is at `:464-468`: it sets `table.realtime = true` from WAL publication
membership — there is no code path anywhere in `introspect.ts` that ever
sets `realtimeColumns`, and there structurally cannot be one: a column-level
allowlist has no Postgres catalog representation (it is enforced entirely
in the application-layer write path this PR does not touch). `grep`-confirmed
zero references to `realtimeColumns`/`realtime_columns` in
`packages/migrator/src/introspect.ts`. `printSchema` also has no other
production caller (`rg -n "printSchema"` outside `test/` and `print.ts`
itself returns exactly the one `util.ts` hit). **Conclusion: the exposure is
confined to the printer's own incomplete contract, exercised only by the
round-trip test itself — there is no live `db pull` data-loss path, because
`ResolvedTable.realtimeColumns` can never be non-`undefined` on that path
today.**

**3. Was the `allow` precedent correctly applied?** — **Yes, correctly
applied — the finding's contrast is inaccurate.** Read `print.ts`'s
`printTable`/`blockLines` construction (`:221-230`): there is no reference
to `table.allow` anywhere in it. `@@allow` is not printed at all — it is
**silently dropped**, exactly the same treatment now given to
`realtimeColumns`. The `throw` at `print.ts:85-91` lives inside
`printAttributeValue`, reached only for `datasource.url` and the
function/array argument recursion — a defensive guard for a code path
`@@allow` values never travel through today, not an active behavior for
`@@allow` on tables. So the finding's framing ("fail-loud is the
established pattern in this very file, contrasted with a lossy `@@realtime`
path") does not hold: the file's actual, exercised behavior for
out-of-printer-scope block attributes is silent omission, and
`realtimeColumns` was given identical treatment to its one existing
precedent, not a different, laxer one.

**4. Severity: WARNING, not CRITICAL.** No user-reachable path silently
widens a live security boundary — `db pull` cannot produce a
`ResolvedTable` carrying `realtimeColumns` today, so no real schema
introspected from a live database can round-trip through the printer and
lose its allowlist. This is WARNING-level because (a) the printer's
`@@realtime(columns:...)` support gap is real and will bite the moment any
future caller resolves a hand-authored/parsed schema and reprints it (e.g.
a future `format`/`fmt` command, or a future `db pull` capability that
infers column-level triggers from `_indigo_realtime_log` shape), and (b) the
asymmetry between the two out-of-scope attributes is worth closing:
`@@allow` values that hit `printAttributeValue`'s `path`/`comparison` kinds
DO throw, so `@@allow` gets some fail-loud protection in the one shape that
matters, while `realtimeColumns` gets none at all — a future printer caller
has no way to detect the loss. Recommend (non-blocking for this PR, in
scope for the design-owned print.ts follow-up): when `print.ts` is
eventually extended to cover `@@realtime`/`@@allow` (design explicitly
defers this), throw `IndigoPrintError` for any table carrying
`realtimeColumns !== undefined` rather than silently dropping it, matching
the file's own stated contract ("Cannot print a construct losslessly" ⇒
throw, don't guess).

---

## Snapshot Contract

Ran `node packages/compiler/test/regen-snapshots.mjs` directly (fresh WASM
rebuild not required — verified via `wasm-freshness.mjs`, see below).
`git status --porcelain fixtures/snapshots` after regen: **empty** — zero
diff. All of 01–19 regenerated byte-identical to the committed snapshots;
20/21 (new) match the already-committed golden output. RCP-1 holds.

## WASM Freshness

`packages/compiler/wasm-sources.sha256` is committed alongside
`packages/compiler/wasm/`. `node packages/compiler/test/wasm-freshness.mjs`
→ `ok wasm freshness: artifact matches 15 Rust sources`, exit 0.

## Field-Order Test (`ir.rs`)

Task 1.6 asked to *extend* `allow_serializes_after_group_when_present` to
assert the new order. The commit (`48e64e4`) instead **left that test's
assertion unchanged** (it still correctly asserts `allow` is the last
*present* key, valid because its fixture never sets `realtime_columns`) and
added a **new dedicated test**,
`realtime_columns_serializes_last_after_allow_when_present`, which asserts
the new invariant directly (`json.ends_with(r#""realtimeColumns":["id","email"]}"#)`).
A third test, `realtime_columns_is_omitted_not_null_when_absent`, and a
fourth, `realtime_columns_serializes_as_present_and_empty_when_empty`,
round out the coverage. **This is not a deleted or weakened guarantee** —
the original invariant remains correctly asserted and the new invariant is
proven by an additional, more precise test. Minor deviation from the task's
literal wording ("extend X") vs. its actual intent ("prove the ordering
invariant holds"); intent is fully satisfied.

## `columns: []` vs Absent

Confirmed via `resolve.rs`/`ir.rs` unit tests
(`empty_realtime_columns_list_resolves_to_present_and_empty`,
`realtime_columns_serializes_as_present_and_empty_when_empty`) and by
direct construction in the probe script above (`IdentityOnly` resolved to
`realtimeColumns: []`, distinct from `BareRealtime`'s `undefined`). The IR
genuinely distinguishes `None` (bare `@@realtime`, omitted key) from
`Some(vec![])` (`columns: []`, present-and-empty key) — no fail-open
collapse.

## Mutation Test (Prove the Negative Tests Bite)

Target: `validate.rs`'s "unknown or non-scalar field" check (line ~671,
guarding `is_scalar_field`).

1. Neutralized: `sd -s 'if !is_scalar_field {' 'if false {' crates/indigo-compiler/src/validate.rs`
2. `cargo test -p indigo-compiler realtime` → **2 tests FAILED**:
   `realtime_columns_unknown_field_is_rejected`,
   `realtime_columns_relation_field_is_rejected` (panicked on empty
   `errors` vec — confirms the check is load-bearing for both diagnostic
   sub-cases).
3. Restored: `git checkout -- crates/indigo-compiler/src/validate.rs`;
   `git diff --stat` shows zero changes to `validate.rs` (only unrelated
   `.atl/` registry noise from the session, pre-existing).
4. Re-ran: `cargo test -p indigo-compiler realtime` → all green again
   (16 unit + 5 fixture tests).

## Full Gate

| Command | Result |
|---|---|
| `cd crates && cargo test --locked` | exit 0 — 104 unit + 45 fixture + 1 parser_panic tests, all green |
| `pnpm clean && pnpm build --force` | exit 0 — 10/10 tasks successful (Turbo, force-executed, no stale cache) |
| `pnpm lint` | exit 0 — 19/19 tasks successful (incl. `apps/studio`'s `tsc -b --noEmit`) |
| `pnpm test` | exit 0 — 18/18 packages green, incl. `wasm-freshness.mjs`, `parity.mjs`, workspace pack-contents guard |

## Diagnostics vs design.md

| Case | design.md message | Code (validate.rs) | Test |
|---|---|---|---|
| unknown field | `@@realtime(columns) references unknown or non-scalar field "secret" on model "User".` | exact match, `:671` | `realtime_columns_unknown_field_is_rejected` |
| relation/non-scalar field | same message class | exact match (same code path) | `realtime_columns_relation_field_is_rejected` |
| duplicate entry | `Duplicate column "email" in @@realtime(columns) on model "User".` | exact match, `:656` | `realtime_columns_duplicate_entry_is_rejected` |
| unknown named key / positional | `Attribute "@@realtime" on model "User" accepts only a "columns:" argument.` | exact match, `:640` | `realtime_unknown_named_key_is_rejected`, `realtime_positional_argument_is_rejected` |
| pre-existing `@@realtime` + no-`@id` | `Model "X" is @@realtime but has no @id primary key.` | unchanged at `:78` | pre-existing test suite, still green |
| `columns:` on non-`@@realtime` attr | rejected via existing closed-key machinery | `columns` absent from `INDEX_ARG_KEYS` | `realtime_columns_on_index_is_rejected_as_unknown_argument`, fixture 21 |

All four new diagnostics fire with the exact specified message text; the
pre-existing no-`@id` error is untouched and still fires.

## `@map` Physical Names

`resolve.rs::resolve_realtime_columns` (`:385`) resolves listed field names
to physical `dbName`s via `field_to_db`, in declaration order. Confirmed by
`realtime_columns_use_mapped_physical_names` and
`realtime_columns_resolve_to_physical_names_in_declaration_order`, and by
direct probe: fixture 20's `ProjectedUser.email @map("email_address")`
listed in `columns: [id, email]` resolved to
`realtimeColumns: ["id","email_address"]`.

## Compliance Matrix — Design's PR 1-Owned Scenario Rows

| Row | Scenario | Covering test | Status |
|---|---|---|---|
| RCP-1 | Bare `@@realtime` unaffected | `ir.rs` omit-when-absent unit + fixtures 01–19 byte-identical after regen | PASS |
| RCP-3 | `columns` on non-`@@realtime` attr rejected | `rules.rs`/`validate.rs` unit, fixture 21 | PASS |
| RCP-4 (IR half) | Newly added field excluded until opted in | `resolve.rs` unit, fixture 20 | PASS (runtime half is PR 2, correctly out of scope) |
| RCP-5 | Unknown column name rejected | `validate.rs` unit, fixture 21 | PASS |
| RCP-6 | Duplicate entry rejected | `validate.rs` unit, fixture 21 | PASS |
| RCP-7 (IR half) | Empty list → present-and-empty, not omitted | `resolve.rs`/`ir.rs` units | PASS (runtime `'{}'::jsonb` half is PR 2) |
| RCP-9 (IR half) | Explicitly listed PK appears in `new`/`old` | resolve produces `realtimeColumns` including PK when listed; runtime half is PR 2 | PASS (IR-only) |
| DX-1 | non-scalar/relation field listed → error | `validate.rs` unit + fixture 21 | PASS |
| DX-2 | `@map`ped listed field yields physical name | `resolve.rs` unit + fixture 20 | PASS |
| DX-3 | unknown named key/positional rejected | `validate.rs` unit, exact message match | PASS |
| non-`@id` case (design-only, no RCP tag) | pre-existing `@@realtime` + no-`@id` error unchanged | `validate.rs:78`, pre-existing suite green | PASS |
| `columns: []` distinction (design-only) | `None` vs `Some(vec![])` at IR level | `ir.rs`/`resolve.rs` units + probe | PASS |

## Task Completion

All 16 Phase 1 tasks (`1.1`–`1.16`) marked `[x]` in
`openspec/changes/realtime-column-projection/tasks.md`, verified against
actual code state task-by-task (grammar, validation, resolve, IR field,
fixtures, `ir.ts` mirror, cargo test, WASM rebuild, snapshot regen, full
gate) — all match.

## Commit Hygiene

4 commits (`48e64e4`, `aea7f6b`, `e291e00`, `e7b71c7`), all conventional
(`feat(compiler):`, `chore(compiler):`, `feat(core):`, `chore(sdd):`).
`git show -s --format='%B'` on each, grepped for
`co-authored|claude|anthropic|generated by|🤖` — clean on all four.

## Issues

**WARNING** (1): `print.ts` silently drops `realtimeColumns` when printing
a table (identical treatment to `@@allow`, correctly following the
established precedent) — confined to the printer's own incomplete, design-
deferred scope; no live `db pull` path can trigger it today since
introspection never sets `realtimeColumns`. Recommend closing the asymmetry
with `@@allow`'s throw-on-unsupported-value behavior when `print.ts` is
eventually extended to cover either attribute (tracked as design-deferred,
not a PR 1 defect).

**SUGGESTION** (1): Task 1.6's literal wording ("extend
`allow_serializes_after_group_when_present`") was not followed exactly —
the implementation left that test as-is and added a new dedicated test for
the new invariant instead. Functionally equivalent or better coverage;
flagging only so future task wording review knows this is how it was
satisfied.

## Test/Build Evidence Hashes

- `cargo test --locked`: exit 0
- `pnpm clean && pnpm build --force`: exit 0
- `pnpm lint`: exit 0
- `pnpm test`: exit 0
- `regen-snapshots.mjs`: `git status --porcelain fixtures/snapshots` empty (zero diff)
- `wasm-freshness.mjs`: exit 0

---

# Verify Report: realtime-column-projection — PR 2 (TypeScript enforcement half)

**Scope**: Phases 2-6 (37 tasks; 35 `[x]`, 5.3 deliberately `[ ]`), branch
`feat/realtime-column-projection-2-enforcement`, commit `1c03ae0`, off
`main`@`907f3d2` (PR 1, merged, verified above — out of scope here). Diff vs
`main`: 784 insertions / 51 deletions across 13 files.

**Verdict: PASS WITH WARNINGS**
**CRITICAL: 0 · WARNING: 1 · SUGGESTION: 2**

---

## Highest-value check — the empty-`Set` fail-open mutation (item 1)

Applied the exact mutation apply-progress claimed was caught: `project()`
line 53 changed from `if (allow === null) return row;` to
`if (allow === null || !allow.size) return row;`, then `pnpm --filter
@indigodb/realtime build && node packages/realtime/test/wal-source.mjs`.

- Baseline (unmutated): **40/40 passed**.
- Mutated: **37 passed**, 3 named failures — `FAIL - project(): null allow
  returns the row unchanged; empty Set returns {} — never conflated`,
  `FAIL - RCP-7 mechanics: columns:[] stores '{}'::jsonb (not NULL) and
  dispatches new:{} with pk intact`, `FAIL - DX-4: PgNotifySource.translate
  narrows new/old identically for narrow, empty, and bare columns`.
- This is **exactly 3 of 40**, matching apply-progress's claim precisely
  (name-for-name, count-for-count).
- Restored `projection.ts` from a pre-mutation copy; `diff` against the
  restored file showed **zero bytes of difference**. Rebuilt, confirmed
  40/40 green again.

**Verdict: claim confirmed, not merely trusted.** The narrow margin (3/40)
is real — general narrowing coverage genuinely would not have caught this
specific fail-open on its own; only the three dedicated tests do. If any of
those three were ever deleted, this exact regression would silently pass.

## Single projection call site (item 2)

`rg -n "project\(" packages/realtime/src` → exactly two call *sites*
(`wal-source.ts:530-531`, `source.ts:153-154`), both importing from the one
`projection.ts` module — no third, independent narrowing implementation
anywhere. Within each site, `new`/`old` are narrowed via the literal same
`project()` function call, on adjacent lines:

```
wal-source.ts:530  if (fresh) row.new = renameKeys(project(fresh, names.projection), names.columns);
wal-source.ts:531  if (old)   row.old = renameKeys(project(old, names.projection), names.columns);
source.ts:153       if (raw.new) event.new = renameKeys(project(raw.new, names.projection), names.columns);
source.ts:154       if (raw.old) event.old = renameKeys(project(raw.old, names.projection), names.columns);
```

A half-fix narrowing only `new` is structurally impossible without touching
both adjacent lines. Confirmed.

## `event.pk` never projected (item 3)

Read `wal-source.ts:502-508`: `pk` is built from `pkSource` (`fresh ?? old`)
and `names.primaryKey` *before* `computeBuckets`/`project()` run, and is
never passed as an argument to `project()` anywhere in the file. RCP-8
(`event.pk` complete when PK excluded from `columns`) and RCP-9 (PK listed
→ appears in both `pk` and `new`/`old`) both pass in the baseline 40/40 run.
Confirmed structurally and by test.

## `project()` filters, does not compact (item 4)

`projection.ts:49-59` — `for (const key of Object.keys(row)) if (allow.has(key)) out[key] = row[key];`.
A listed key present with value `null` in `row` is copied through unchanged
(`row[key]` is `null`, which is still assigned). RWS-7's dedicated test
(`3.7`/`3.8`) passes in the baseline run. Confirmed.

## Bucket ordering (item 5)

`wal-source.ts:516-519`: `computeBuckets(names.table, primary, secondary)`
runs on `primary`/`secondary` derived from the raw `fresh`/`old` objects,
*before* the `project()` calls at lines 530-531. RCP-12/RWS-3's test
(`buckets computed from the FULL raw row are unaffected by a projected-away
@@allow field`) passes in the baseline run. Confirmed.

## Executable test reachability — RCP-13 (item 6)

- `strictEqual(ran, 40)` in `wal-source.mjs:1022`, `strictEqual(ran, 6)` in
  `dispatch.mjs:283`, `strictEqual(ran, 4)` in
  `realtime-projection.mjs:196` — all three confirmed present and matching
  apply-progress's claimed exact counts.
- `scripts/check-realtime-projection-db-gate.mjs` exists, asserts none of
  the three guarded files reference `INDIGODB_TEST_DATABASE_URL`, and is
  wired into root `package.json`'s `test` script
  (`turbo test && node scripts/check-pack-contents.mjs && node
  scripts/check-realtime-projection-db-gate.mjs`).
- **Guard-trips test**: appended `// INDIGODB_TEST_DATABASE_URL` to
  `wal-source.mjs`, ran the guard script directly → **FAILED** with the
  expected message (`FAIL: packages/realtime/test/wal-source.mjs
  references INDIGODB_TEST_DATABASE_URL...`, exit 1). Reverted; `diff`
  against a pre-edit copy showed zero bytes of difference. Re-ran the
  guard → **PASSED**, exit 0. The guard genuinely fires.

## PgNotifySource narrows identically (`source.ts`)

`source.ts:149-154`, same `project()`/`projectionSet` import, same call
shape as `WalSource`, gated on `names.projection` built the same way in its
own `TableNames` construction. DX-4's test (`wal-source.mjs:940-...`)
exercises `PgNotifySource` directly across narrow/empty/bare `columns` —
part of the 40/40 baseline pass. This closes the "guarantee conditional on
which source is configured" risk the review criteria named — confirmed,
not merely asserted in a doc comment.

## `columns: []` mechanics

- `flushCommit`: `if (row.new) event.new = row.new;` — `row.new` after
  projection to an empty `Set` is `{}`, which is truthy in JS, so the guard
  passes and `event.new = {}` is dispatched (not omitted).
- `buildLogInsert`: `row.new ? JSON.stringify(row.new) : null` — same
  truthiness; `JSON.stringify({})` = `"{}"`, stored as `'{}'::jsonb`, never
  `NULL`. Both mechanics read directly from source, matching apply-progress's
  claim exactly; RCP-7 mechanics test also confirmed via the mutation run.

## RLE-2 — UNPROVEN (per orchestrator's established finding, not re-litigated)

Real-Postgres exercise of the replay-page leg could not be completed in
this session (pre-existing `log.mjs` hang under `wal_level=logical`,
confirmed independent of PR 2 by reproducing on `main`). Per the
established finding, this scenario is recorded as **UNPROVEN**, not
covered and not waived.

Assessed the structural argument that is offered in place of the DB-gated
proof. Read `handleLogRequest` (`engine.ts:285-374`): the query selects
`pk, "new", "old"` directly from `_indigo_realtime_log` with no filtering
predicate on column content, and the mapping at `:349-358` is a straight
field copy — `new: row.new ?? undefined, old: row.old ?? undefined` — no
transformation, no re-widening, no code path that could reintroduce a
projected-out column. Combined with the independently-confirmed facts that
(a) `buildLogInsert` stores the already-`project()`-narrowed object (item
"columns: []" above and RCP-2/RCP-11's passing tests), and (b) there is
exactly one write site to `_indigo_realtime_log` (`flushCommit`, the only
caller of `buildLogInsert` in the codebase), the structural chain holds:
narrow row written → straight read → straight map → response. **The
design's structural argument for RLE-2 is confirmed true by code
inspection**, not merely asserted. This downgrades RLE-2 from
"CRITICAL: untested with no fallback" to "UNPROVEN by direct test, but
structurally guaranteed and independently confirmed" — still flagged
below, not silently accepted as PASS.

## design.md documentation off-by-one (per orchestrator's flagged item)

`design.md:141` (RCP-2 row) cites `params[4]` for the INSERT `new` value.
The actual `buildLogInsert` param layout, confirmed against the SQL:
`[lsn, txid, table, op, pk, new, old, ts, buckets]` — 0-indexed JS array,
so `new` is `params[5]`, `old` is `params[6]`, `pk` is `params[4]`. All of
the actual test code (`wal-source.mjs:646,726,749,781,849,877`) uses
`params[5]` for `new`, matching the real layout, and design's own RCP-11
row (line 150) *correctly* says `params[5]`/`params[6]` — the RCP-2 row
alone has the stale index. **Apply is correct; `design.md`'s RCP-2 row
needs a one-character fix (`4` → `5`).** No test or production code is
affected — this is a documentation-only defect.

## No scope creep

`git diff 907f3d2 HEAD --stat` (13 files, 784/-51) touches only:
`packages/realtime/src/{projection,wal-source,source,protocol,index}.ts`,
`packages/realtime/test/{wal-source,dispatch}.mjs`,
`packages/client/test/realtime-projection.mjs`,
`packages/client/package.json`, `scripts/check-realtime-projection-db-gate.mjs`,
root `package.json`, `openspec/changes/.../{tasks,proposal}.md`. Nothing
under `crates/`; no migrator/DDL file touched; no backpressure-related
change; `packages/client/src/live.ts`, `realtime.ts`,
`studio/browser/hooks/useLiveTable.ts` all untouched (confirmed via the
same `--stat`, none listed). Confirmed clean.

## Review workload guard — 784 lines vs the 400-line default budget

Diff is 784 insertions/51 deletions — above the 400-line single-PR
guideline, under the session's stated 800-line budget. `+322` of the
delta is `packages/realtime/test/wal-source.mjs` (23 new cases); actual
production code stayed small (`projection.ts` 59 lines new;
`wal-source.ts`/`source.ts`/`protocol.ts` deltas 21/18/10 lines). Judgment:
**the split (PR 1 compiler / PR 2 enforcement) was correct** — the two
halves have genuinely independent rollback boundaries (Rust+WASM vs.
TypeScript runtime) and PR 2's overage is concentrated in test volume
proving a security-relevant guarantee (three-state fail-open, single
call-site, PK independence, bucket ordering) rather than production
surface area. A further split of PR 2 itself (e.g. `wal-source.ts` alone
vs. `source.ts`+client tests) was considered against the task list's own
Suggested Work Units table, which defines PR 2 as one atomic deliverable
("Write-time projection enforced in `WalSource` + `PgNotifySource`,
non-DB-gated coverage") — splitting further would have separated
`PgNotifySource`'s narrowing from `WalSource`'s in a way that breaks the
"guarantee not conditional on source" argument reviewers need to see
together. Not a blocking finding; recorded as SUGGESTION only.

## Commit hygiene

`1c03ae0`, author `chechooxd <sergiogalaz60@gmail.com>`, conventional
(`feat(realtime): enforce @@realtime(columns:) write-time column
projection`). `git show -s --format='%B'` grepped for
`co-authored|claude|anthropic|generated with|🤖` → clean.

## Verification Gate

| Command | Result |
|---|---|
| `pnpm clean` | exit 0 |
| `pnpm build --force` | exit 0 — 10/10 tasks, force-executed |
| `pnpm lint` | exit 0 — 19/19 tasks (cache hit, valid — no source changed since last build) |
| `pnpm test` | exit 0 — all packages green, `check-realtime-projection-db-gate.mjs` passed, no `INDIGODB_TEST_DATABASE_URL` set |
| `cd crates && cargo test --locked` | exit 0 — 45 unit + 1 parser_panic + doc-tests, unaffected (no `crates/` changes in PR 2) |

`INDIGODB_TEST_DATABASE_URL` confirmed unset throughout — DB-gated suites
skipped as intended, per this session's instruction not to set it.

## Spec Compliance Matrix (28 spec scenarios across 4 domains + 5 design-added rows)

### `realtime-column-projection` (13/13)

| ID | Scenario | Status |
|---|---|---|
| RCP-1 | Bare `@@realtime` unaffected | PASS (PR 1) |
| RCP-2 | Listed columns narrow the payload | PASS — `wal-source.mjs` `params[5]` assertion |
| RCP-3 | `columns` on non-`@@realtime` rejected | PASS (PR 1) |
| RCP-4 | Newly added field excluded until opted in | PASS — IR (PR 1) + runtime (`wal-source.mjs`) |
| RCP-5 | Unknown column name rejected | PASS (PR 1) |
| RCP-6 | Duplicate entry rejected | PASS (PR 1) |
| RCP-7 | Empty list → identity-only, `{}` not `NULL`/omitted | PASS — mutation-tested |
| RCP-8 | `event.pk` complete when PK absent from `columns` | PASS |
| RCP-9 | Listed PK appears in `new`/`old` in addition to `pk` | PASS |
| RCP-10 | Excluded column absent end-to-end | PASS except the replay leg — see RLE-2 |
| RCP-11 | `old` projected identically to `new` | PASS |
| RCP-12 | `@@allow` field excluded from `columns` still authorizes | PASS |
| RCP-13 | Suite passes in a default checkout | PASS — reachability + guard-trip both confirmed |

### `realtime-wal-source` (7/7)

| ID | Scenario | Status |
|---|---|---|
| RWS-1 | Projected table narrows before log INSERT | PASS |
| RWS-2 | Bare `@@realtime` table not narrowed | PASS — confirmed unmodified via diff (no removed `await check` lines near existing cases) |
| RWS-3 | Bucket computation precedes projection | PASS |
| RWS-4 | Log row and dispatched event share the narrowed payload | PASS |
| RWS-5 | Insert parity | PASS — unmodified |
| RWS-6 | No `partial: true` truncation | PASS |
| RWS-7 | Projected `new` narrowed, field set unchanged (nulls preserved) | PASS |

### `realtime-shape-log` (3/3)

| ID | Scenario | Status |
|---|---|---|
| RSL-1 | Log row never carries projected-out column | PASS |
| RSL-2 | Widening allowlist does not recover prior history | PASS |
| RSL-3 | Non-projected table's log rows unchanged | PASS — unmodified |

### `realtime-live-endpoint` (4/5 proven, 1 UNPROVEN)

| ID | Scenario | Status |
|---|---|---|
| RLE-1 | Live SSE frame matches projected log row | PASS |
| RLE-2 | Replay page as narrow as live frame | **UNPROVEN** — DB-gated test could not run (pre-existing environment hang, confirmed independent of PR 2); structural guarantee confirmed true by direct code inspection of `handleLogRequest` |
| RLE-3 | Column projection composes with `@@allow` row scoping | PASS |
| RLE-4 | Subscriber receives fewer keys after adopting `columns` | PASS |
| RLE-5 | Non-projected model's subscriber unaffected | PASS |

### Design-added rows (5/5)

| ID | What | Status |
|---|---|---|
| DX-1 | Non-scalar/relation field → error | PASS (PR 1) |
| DX-2 | `@map`ped listed field → physical name | PASS (PR 1) |
| DX-3 | `@@realtime(columns:...)` without `@id` still errors | PASS (PR 1) |
| DX-4 | `PgNotifySource.translate` narrows identically | PASS — confirmed, closes the "conditional on source" risk |
| DX-5 | `partial` refetch re-widens on v1 source (documented, not closed) | PASS — pinned as accepted-risk executable assertion |

## Task Completion

35/37 Phase 2-6 tasks `[x]`, verified against actual code state per task.
Task 5.3 (manual DB-gated merge gate) correctly remains `[ ]` — not
automatable in this environment, honestly reported rather than silently
skipped or falsely checked. This is the correct state, not a gap: the
task's own text calls it a "required manual merge gate (not automated, not
counted as coverage)".

## Issues

**WARNING** (1): `design.md:141` (RCP-2 row) cites `params[4]` for the
`new` value in `buildLogInsert`'s param array; actual layout (confirmed
against SQL and all test assertions) places `new` at `params[5]`. Design's
own RCP-11 row already uses the correct index. One-line documentation fix,
no code or test impact.

**SUGGESTION** (2):
1. The 784-line diff exceeds the 400-line single-PR guideline (under the
   800-line session budget). Judged the PR 1/PR 2 split as correct given
   independent rollback boundaries and test-dominated overage; recorded for
   visibility, not blocking.
2. `print.ts` still silently drops `realtimeColumns` (inherited from PR 1,
   already flagged there as WARNING, not re-raised as a new PR 2 defect —
   PR 2 does not touch `print.ts`).

## RLE-2 — Explicit Merge Gate (carried forward, not closed by this verify)

RLE-2 remains the one scenario without direct DB-gated proof in this
environment. The structural guarantee is now independently confirmed true
by source inspection (not just design's prose), which materially reduces
risk, but does **not** substitute for running
`INDIGODB_TEST_DATABASE_URL=… pnpm --filter @indigodb/realtime test`
against a real Postgres before merging PR 2, exactly as tasks.md 5.3 and
proposal.md's "Outstanding before merge" note require. This verify does
not waive that gate.

## Test/Build Evidence

- `pnpm clean && pnpm build --force`: exit 0
- `pnpm lint`: exit 0
- `pnpm test`: exit 0 (`INDIGODB_TEST_DATABASE_URL` unset)
- `cd crates && cargo test --locked`: exit 0
- Fail-open mutation: 40/40 → 37/40 (3 named failures, exact match to
  apply-progress's claim) → restored byte-identical → 40/40
- DB-gate guard trip: PASSED → FAILED (expected message) → reverted
  byte-identical → PASSED
