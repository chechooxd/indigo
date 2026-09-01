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
