# Design: Realtime column projection

Verified live against `main` @ `7eb1621`: `rules.rs:58-98` (`ArgShape`, `@@realtime` is
`ArgShape::None` at `:91`), `validate.rs:74-88` (the `@@realtime` PK check to sit beside),
`resolve.rs:436` (`realtime: Some(true)` or absent), `ir.rs:181-204` (`ResolvedTable`, `allow`
declared LAST) with the byte-order tests at `ir.rs:300-336`, `packages/core/src/ir.ts:200-215`,
`wal-source.ts:78-94` (`TableNames` already caches the whole `ResolvedTable`), `:149-166`
(constructor), `:500-516` (`computeBuckets` then `renameKeys`), `:549-588` (`buildLogInsert`,
INSERT at `:584-586`), `source.ts:136-142` (the v1 `translate` twin), `engine.ts:350-359`
(`handleLogRequest` mapping), `:378-393` (`dispatch`), `realtime-delegate.ts:77-109`.

## Technical Approach

Same closed-whitelist extension as `native-type-attributes` / `realtime-rls-allow-rule`: one
`ATTRIBUTE_RULES` row, a bespoke `ArgShape`, hard diagnostics in `validate.rs`, one resolve pass
into the IR, consumers read the IR. Enforcement is a single write-time narrowing in the WAL
decode path, applied to the **raw physical row** after `computeBuckets` and before `renameKeys`.

    @@realtime(columns: [id, email])
      │ rules.rs ArgShape::Realtime → validate.rs::validate_realtime_columns
      ▼
    resolve.rs ─> ResolvedTable.realtimeColumns: ["id","email"]   (physical dbNames)   ← PR 1
      │
      ▼ PR 2
    decodeRow:  computeBuckets(FULL raw row)  →  project(raw, allowSet)  →  renameKeys
                        │                                    │
                        ▼                                    ▼
                  buckets column                    PendingRow.new/.old
                                                     ├─→ buildLogInsert → _indigo_realtime_log
                                                     └─→ flushCommit → onEvent → engine.dispatch

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| 1 | Arg shape | New `ArgShape::Realtime`: zero positionals, optional named `columns` whose value is a reference array. `REALTIME_ARG_KEYS = ["columns"]` beside `INDEX_ARG_KEYS` | reuse `ArgShape::Index` (positional array) | Bare `@@realtime` must keep parsing unchanged; a *named* optional arg is the only shape where adding an argument cannot alter the zero-arg form. A misspelled key (`cols:`) is a hard error, not a silent no-op |
| 2 | IR field | `ResolvedTable.realtimeColumns: Option<Vec<String>>`, `skip_serializing_if = "Option::is_none"`, declared **after `allow`** (new last field). `ir.ts`: `realtimeColumns?: string[]` | nest as `realtime: {columns}`; a parallel `ResolvedColumn.projected` flag | Appending last + omit-when-absent is exactly the rule that kept every fixture snapshot byte-identical for `allow`. `ir.rs:324-336`'s `allow_serializes_after_group_when_present` asserts `allow` is the last key — that **one unit test changes**; no fixture JSON does |
| 3 | Name form | Physical `dbName`, like `ForeignKey.columns` / `ResolvedIndex.columns` / `AllowOperand::Field` | logical field names | Lets projection run on the raw pgoutput tuple, before `renameKeys` — the same keyspace `computeBuckets` already uses, so one row is never keyed two ways mid-function |
| 4 | Enforcement site | `WalSource.decodeRow` (`wal-source.ts:512-515`), between `computeBuckets` (`:510`) and `renameKeys` | read-time narrowing in `dispatch`/`handleLogRequest`/the delegate | One site; the secret never reaches disk. See "Escape enumeration" below |
| 5 | `old` image | Narrowed by the **same** `project()` call as `new`, in the same two adjacent lines. `REPLICA IDENTITY FULL` stays mandatory | narrow the replica identity | `old` is the field that leaks *previous* secret values. Making it a separate code path is how a half-fix happens; the design forbids a second call site. Narrowing replica identity would break `computeBuckets`' UPDATE union (`:509`) and every other `old` consumer |
| 5b | `columns: []` | **Valid, not an error.** An empty allowlist resolves to `realtimeColumns: []` and emits `new`/`old` as **empty objects** — "a row changed, here is no body". Identity still travels in `event.pk` | reject it with "omit the argument to stream all columns" | That message advises the exact opposite of the author's intent: someone who typed `[]` wanted *less* data, and would be pointed at all of it. The shape already exists in this codebase — `dispatch()`'s `@@allow` wake frame (`engine.ts:386-390`) emits identity with all row data stripped — so rejecting `[]` removes a capability with no alternative expression. Mechanically free: `flushCommit:458-459` guards with `if (row.new)` and `{}` is truthy, so `event.new = {}` is emitted; `buildLogInsert:578-579` stores `'{}'::jsonb`, not `NULL` — an empty body is distinguishable from "no image for this op" |
| 6 | PK not implicit | The allowlist is literal: a PK column not listed does **not** appear in `new`/`old` | always union the PK into the projection | `event.pk` is built separately from `names.primaryKey` (`:493-498`) and is never projected; `handleLogRequest` maps the log's own `pk` column (`engine.ts:353`). `RealtimeModelDelegate.onDelete`/`onInsert`/`onUpdate` read `event.pk`, never `new.id` (`realtime-delegate.ts:98-108`), and the `partial` refetch keys on `event.pk` (`:87`). `.live()` reads neither. So identity survives with zero implicit widening — and an implicit union would be a column the schema author never wrote appearing in a payload. **Spec agreed and was corrected to this invariant**: `event.pk` sits outside the projection and is never narrowed; a PK field appears in `new`/`old` only when explicitly listed |
| 7 | v1 source too | `PgNotifySource.translate` (`source.ts:141-142`) applies the same shared `project()` | leave v1 unprojected | **Deviation from the proposal's affected areas, added here.** `PgNotifySource` is exported and pluggable via `RealtimeEngineOptions.source`; an exported source that ignores the allowlist makes the guarantee conditional on a config value. ~4 lines, shared helper |
| 8 | Consumers stay dumb | `engine.dispatch`, `handleLogRequest`, `protocol.ts`, `realtime-delegate.ts` gain **no** filtering logic — only a doc/type comment that bodies are already projected | filter in each consumer | Defense-in-depth here would be four places that can disagree; this repo's rule is "resolve once, consumers read". `protocol.ts` documents the contract; it does not enforce it |

## Escape enumeration — six collapse to one

| # | Exploration site | After write-time projection |
|---|---|---|
| 1 | `wal-source.ts:513-514` | **The** enforcement point |
| 2 | `_indigo_realtime_log` | `buildLogInsert:578-579` serializes `row.new`/`row.old` — the same already-narrowed objects. Structurally unreachable with unprojected data: no other writer exists |
| 3 | `engine.ts:391` `dispatch` | `{...event}` spreads the object `flushCommit:458-459` copied from the same `PendingRow`. Unreachable |
| 4 | `engine.ts:350-359` `handleLogRequest` | Reads (2). Unreachable |
| 5 | `protocol.ts:16-48` | Types only, no data. N/A |
| 6 | `realtime-delegate.ts:77-109` | Forwards `event.new`/`event.old` verbatim from (3)/(4). Unreachable — **with one named exception** |

**The one exception**: `realtime-delegate.ts:85-92` refetches the full row by PK when
`event.partial` is set. `WalSource` never sets `partial` (only `source.ts:140` does, for
oversized NOTIFY payloads), so it is unreachable on the default source. It is not closed here:
the refetch uses the caller's own DB connection, which already has full read access to the
table, so it discloses nothing that process cannot already `findFirst` for itself. Recorded as a
risk, not silently absorbed.

## Interfaces

```rust
// rules.rs
ArgShape::Realtime,                                   // (Model, "realtime", ArgShape::Realtime)
pub const REALTIME_ARG_KEYS: [&str; 1] = ["columns"];

// ir.rs — ResolvedTable gains ONE field, declared LAST (after `allow`), omitted when absent.
#[serde(skip_serializing_if = "Option::is_none", default)]
pub realtime_columns: Option<Vec<String>>,            // physical dbNames, declaration order
```

```ts
// packages/core/src/ir.ts
realtimeColumns?: string[];

// packages/realtime/src/projection.ts (new, ~20 lines) — shared by wal-source.ts + source.ts
export function projectionSet(table: ResolvedTable): Set<string> | null;   // null = all columns
export function project(row: Record<string, unknown>, allow: Set<string> | null): Record<string, unknown>;
```

Three-state on purpose: `null` (attribute absent ⇒ pass the row through untouched, byte-identical
to today), a non-empty `Set` (narrow), and an **empty `Set`** (return `{}` — decision 5b). `null`
and empty-`Set` must never be conflated; a `!allow.size` shortcut that falls back to "all columns"
would turn the identity-only form into a full-row leak, which is exactly the fail-open this
change exists to prevent.

`WalSource`/`PgNotifySource` build the set **once in the constructor**, on the existing
`TableNames` record (`wal-source.ts:78-94`) which already caches the whole `ResolvedTable` — the
allowlist enters exactly where `columns`/`primaryKey` already do, with no new plumbing and no
per-row resolution.

## Diagnostics (`validate.rs::validate_realtime_columns`, `model: Some(..)`, `field: None`)

| Case | Message |
|---|---|
| unknown field | `@@realtime(columns) references unknown or non-scalar field "secret" on model "User".` |
| relation / non-scalar field | same message (one class, like `validate_allow`'s field check) |
| duplicate entry | `Duplicate column "email" in @@realtime(columns) on model "User".` |
| unknown named key / any positional | `Attribute "@@realtime" on model "User" accepts only a "columns:" argument.` |
| `columns:` on any other attribute | existing closed-key machinery: `columns` is absent from `INDEX_ARG_KEYS`/`RELATION_ARG_KEYS`, so `@@index([a], columns: [b])` already errors — no new code, one new test |

**There is deliberately no empty-list diagnostic** (decision 5b): `columns: []` is valid and means
identity-only notification. The existing `@@realtime` + no-`@id` error (`validate.rs:75-80`) is
unchanged and still fires.

## File Changes

| File | PR | Action | Description |
|---|---|---|---|
| `crates/indigo-compiler/src/rules.rs` | 1 | Modify | `ArgShape::Realtime`, rule row at `:91`, `REALTIME_ARG_KEYS` |
| `crates/indigo-compiler/src/validate.rs` | 1 | Modify | `validate_realtime_columns` + call beside `:75` |
| `crates/indigo-compiler/src/resolve.rs` | 1 | Modify | resolve names → `dbName` at `:436` |
| `crates/indigo-compiler/src/ir.rs` | 1 | Modify | `realtime_columns` last; update `allow_serializes_after_group_when_present` |
| `fixtures/20-realtime-columns.indigo`, `21-rejected-realtime-columns.indigo` (+ snapshots) | 1 | Create | accepted forms; one instance per rejection class |
| `packages/compiler/wasm/*`, `wasm-sources.sha256` | 1 | Modify | `build:wasm` output, committed |
| `packages/core/src/ir.ts` | 1 | Modify | `realtimeColumns?: string[]` |
| `packages/realtime/src/projection.ts` | 2 | Create | `projectionSet` / `project` |
| `packages/realtime/src/wal-source.ts` | 2 | Modify | `TableNames.projection`; project at `:513-514` |
| `packages/realtime/src/source.ts` | 2 | Modify | same at `:141-142` (decision 7) |
| `packages/realtime/src/protocol.ts` | 2 | Modify | doc comment: bodies are projected; consumers never re-widen |
| `packages/realtime/test/{wal-source,dispatch}.mjs`, `packages/client/test/realtime-projection.mjs` | 2 | Modify/Create | see Testing Strategy |

## Testing Strategy

**Reconciled against `sdd-spec`'s final scenario set** (`openspec/changes/realtime-column-projection/specs/`).
One row per spec scenario, keyed by spec domain + scenario title, in spec file order. **Every
scenario in all four delta specs has at least one row below — 28 spec rows, plus 5 design-added
rows carrying no spec scenario.** "Default checkout" = runs with `INDIGODB_TEST_DATABASE_URL`
unset. Only `wal-source.mjs`, `dispatch.mjs` and `handle.mjs` run unconditionally in
`packages/realtime/test/`; every new realtime case below lands in the first two.

### Domain `realtime-column-projection` (13/13 covered)

| ID | Spec scenario | Test file + assertion | Default checkout |
|---|---|---|---|
| RCP-1 | Bare `@@realtime` is unaffected | `ir.rs` omit-when-absent unit; **fixtures 01–19 snapshots byte-identical** after `regen-snapshots.mjs` | Yes (cargo + `packages/compiler/test/parity.mjs`) |
| RCP-2 | Listed columns narrow the payload | `resolve.rs` `#[cfg(test)]` + `fixtures/20` snapshot; `wal-source.mjs` `fakeWriter` (`:266`) — `Object.keys(JSON.parse(params[5]))` deep-equals the allowlist | Yes |
| RCP-3 | `columns` on a non-`@@realtime` attribute is rejected | `rules.rs` unit: `columns` is absent from `INDEX_ARG_KEYS`/`RELATION_ARG_KEYS`, so `@@index([a], columns: [b])` errors; fixture 21 carries one instance | Yes |
| RCP-4 | **A newly added field is excluded until opted in** | fixture 20's model declares a field absent from `columns`; `resolve.rs` unit asserts `realtimeColumns` excludes it, **and** `wal-source.mjs` feeds a pgoutput tuple containing that column and asserts it is absent from the INSERT params *and* from the dispatched event. This is the safe-by-default property that motivated allowlist-over-denylist, so it is proven on both sides, not just in the IR | Yes |
| RCP-5 | Unknown column name rejected | `validate.rs` unit + fixture 21 | Yes |
| RCP-6 | Duplicate entry rejected | `validate.rs` unit + fixture 21 | Yes |
| RCP-7 | **Empty list resolves to identity-only notifications** | `resolve.rs`/`ir.rs` units: `realtimeColumns` serializes as `[]` (present-and-empty, never omitted — that distinction *is* the feature); `wal-source.mjs`: INSERT params store `'{}'::jsonb` not `NULL`, `event.new` deep-equals `{}`, and `event.pk` is complete | Yes |
| RCP-8 | `event.pk` complete when the PK column is absent from `columns` | `wal-source.mjs`, dedicated fixture schema | Yes |
| RCP-9 | An explicitly listed PK field appears in `new`/`old` **in addition to** `pk` | `wal-source.mjs` variant of RCP-8 with the PK listed | Yes |
| RCP-10 | Excluded column absent end-to-end | the RCP-2 → RCP-11 → RLE-1 → RLE-4 chain asserted on one shared payload fixture, so a break anywhere in the chain fails | Yes (except the replay leg, RLE-2) |
| RCP-11 | `old` image is projected identically to `new` | `wal-source.mjs`: UPDATE asserts both `params[5]`/`params[6]`; DELETE asserts `params[6]`; both key sets deep-equal the `new` key set | Yes |
| RCP-12 | An `@@allow` read-rule field excluded from `columns` still authorizes correctly | `wal-source.mjs`, extending the existing `:565` "buckets from the RAW row" case with a projected variant — `buckets` byte-identical with and without the projection | Yes |
| RCP-13 | **Projection suite passes in a default checkout** | every new case lives in an unconditional file, and each new/extended suite ends with `strictEqual(ran, <exact count>)` so an omitted or skipped case fails loudly instead of shrinking the run. Tasks add a `rg` guard that the new files contain no `INDIGODB_TEST_DATABASE_URL` reference | Yes — this row *is* the assertion |

### Domain `realtime-wal-source` (7/7 covered)

| ID | Spec scenario | Test file + assertion | Default checkout |
|---|---|---|---|
| RWS-1 | Projected table narrows before the log INSERT | same as RCP-2 (write side) | Yes |
| RWS-2 | Bare `@@realtime` table is not narrowed | existing `wal-source.mjs` `:76`/`:98`/`:124` cases pass **unmodified** — the regression proof is that they are not edited | Yes |
| RWS-3 | Bucket computation precedes and is unaffected by projection | same as RCP-12 | Yes |
| RWS-4 | Log row and dispatched event carry the same narrowed payload | `wal-source.mjs`: one commit, assert the INSERT params key set and the `onEvent` key set are equal — they must be the same object graph, not two independent narrowings | Yes |
| RWS-5 | Insert parity | existing `:76` case unmodified | Yes |
| RWS-6 | **No `partial: true` truncation** | `wal-source.mjs`: across the projected, empty-list and bare cases, assert no emitted event carries `partial`. `WalSource` never sets it; projection must not become a reason to start | Yes |
| RWS-7 | Projected `new` is narrowed, field set unchanged | `project()` filters the row's own entries against the allowlist, so a listed column whose value is `null` stays present as `null` and is never dropped — asserted explicitly, since "narrowed" and "compacted" are different bugs | Yes |

### Domain `realtime-shape-log` (3/3 covered)

| ID | Spec scenario | Test file + assertion | Default checkout |
|---|---|---|---|
| RSL-1 | Log row never carries a projected-out column | same as RCP-2/RCP-11 (INSERT params) | Yes |
| RSL-2 | **Widening the allowlist does not recover prior history** | `wal-source.mjs`, no DB needed: commit through a source built with allowlist A, rebuild the source with a wider allowlist B, commit again, then assert the **first** captured INSERT params are still narrow. Pins the accepted consequence of write-time projection as an executable fact rather than prose | Yes |
| RSL-3 | Non-projected table's log rows are unchanged | same as RWS-2 | Yes |

### Domain `realtime-live-endpoint` (5/5 rows; 4/5 proven in a default checkout)

| ID | Spec scenario | Test file + assertion | Default checkout |
|---|---|---|---|
| RLE-1 | Live SSE frame matches the projected log row | `dispatch.mjs`, fake `ServerResponse` — feed a pre-projected event, assert the frame's `data` key set equals the allowlist and nothing re-widens | Yes |
| RLE-2 | Replay page is exactly as narrow as the live frame | `packages/realtime/test/log.mjs` / `endpoint.mjs` | **NO — DB-gated. See Coverage honesty** |
| RLE-3 | Column projection and `@@allow` row scoping compose | `dispatch.mjs`: a projected model **with** `@@allow` still gets the data-free wake frame (the scoped branch at `engine.ts:386-390` wins, projection changes nothing); a projected model **without** `@@allow` gets a narrowed change frame. Both asserted — this is the cross-product row | Yes |
| RLE-4 | Subscriber receives fewer keys after adopting `columns` | `packages/client/test/realtime-projection.mjs` (new; fake `RealtimeConnectionManager`, `realtime-entry.mjs` pattern) | Yes |
| RLE-5 | **Non-projected model's subscriber is unaffected** | same file — the `subscribe()`-side counterpart to RWS-2: a bare-`@@realtime` event reaches `onInsert`/`onUpdate`/`onDelete` with every key intact | Yes |

### Design-added rows (no spec scenario; extra coverage, not a spec gap)

| ID | What | Test file | Default checkout |
|---|---|---|---|
| DX-1 | non-scalar/relation field listed → error | `validate.rs` unit + fixture 21 | Yes |
| DX-2 | `@map`ped listed field yields its physical name | `resolve.rs` unit + fixture 20 | Yes |
| DX-3 | `@@realtime(columns:…)` without `@id` still errors | `validate.rs` unit | Yes |
| DX-4 | `PgNotifySource.translate` narrows identically (decision 7) | new cases following `source.ts`'s fake-payload shape | Yes |
| DX-5 | the `partial` refetch re-widens on the v1 source | `realtime-projection.mjs` — asserts the **documented current behaviour**, so a future change cannot alter it silently | Yes |

**Coverage honesty.** RLE-2 is the single scenario with no default-checkout proof, and it stays
visibly uncovered rather than reading as green. The guarantee does **not** come from the read
path: `handleLogRequest` (`engine.ts:350-359`) applies no filter and maps `row.new`/`row.old`
straight out of the stored row, so a narrow stored row cannot produce a wide page — the property
follows from write-time projection (RCP-2, RCP-11, RSL-1, all default-checkout) plus the absence
of any second writer to `_indigo_realtime_log`. What the DB-gated test adds is confirmation that
the jsonb round-trip preserves the narrow body, which nothing in a default checkout can observe.
The tasks phase MUST therefore list `INDIGODB_TEST_DATABASE_URL=… pnpm --filter @indigodb/realtime
test` as a **required manual gate before merge**, not optional extra credit. No other row in any
domain depends on a database.

## Threat Matrix

No routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary — those rows are `N/A`. Two rows are applicable:

| Row | Applicable | Safe behavior | RED test |
|---|---|---|---|
| Sensitive-data disclosure | Yes | a non-allowlisted column never enters `_indigo_realtime_log`, an SSE frame, a replay page, or a `subscribe()` callback; a newly added field is excluded until opted in | RCP-2, RCP-4, RCP-10, RCP-11, RLE-1, RLE-4 — all default-checkout |
| Fail-open on the identity-only form | Yes | `projectionSet` is three-state; an empty `Set` returns `{}` and is never conflated with `null` ("all columns") | RCP-7 |
| SQL injection via projected data | Yes | unchanged: `buildLogInsert` binds every value as a parameter (`:572-582`); projection only removes keys from an object already bound as `jsonb` | existing `wal-source.mjs:623` injection case passes unmodified |
| Privilege bypass / authorization | Yes | `computeBuckets` runs on the FULL raw row **before** projection (decision 4 ordering); projecting an `@@allow` field away is legal and does not weaken row auth | RCP-12, RLE-3 |

## Migration / Rollout

Nothing is published; every existing schema uses bare `@@realtime` and is byte-identical
(RCP-1, RWS-2, RSL-3). No DDL, so no migration: `_indigo_realtime_log` columns are generic `jsonb` and
`REPLICA IDENTITY FULL` is untouched. `migrate.ts::remapPhysicalNames` needs **no** entry for
`realtimeColumns` — it produces no DDL, so a `@map` rename cannot desynchronize any emitted
statement.

**Log rows written before an allowlist is added stay wide.** A replay page spanning the change
therefore mixes wide and narrow bodies. Acceptable, and no consumer breaks: `RealtimeEvent.new`
is a `Record<string, unknown>`, `.live()` uses frames as wake triggers only, and Studio's
`useLiveTable` calls `scheduleRefetch()` without reading the body. Operators who need the old
rows gone must delete them — stated plainly because write-time projection **cannot** retroactively
narrow history, and widening an allowlist later cannot recover history never stored. That second
half is not left as prose: **RSL-2 pins it as an executable, default-checkout assertion**, because
it is the consequence a future reader is most likely to be surprised by.

**PR 1 must leave the tree consistent** so PR 2 starts from a good artifact, per `crates/CLAUDE.md`:
`cd crates && cargo test --locked` → `pnpm --filter @indigodb/compiler build:wasm` (commit
`packages/compiler/wasm/` **and** `wasm-sources.sha256`) → `node
packages/compiler/test/regen-snapshots.mjs` (the diff is the review artifact; fixtures 01–19 must
show **zero** diff, only new 20/21 snapshots appear) → `pnpm build && pnpm lint && pnpm test`
(`wasm-freshness.mjs` must pass). Never hand-compare WASM bytes; the guard hashes inputs, not
output. PR 2 adds no `crates/` change, so it re-runs neither.

**Slice plan** (Feature Branch Chain: PR 2 targets PR 1; goldens/WASM excluded from authored
risk): PR 1 ≈ 260 authored lines (compiler + fixtures + `ir.ts`); PR 2 ≈ 380 (projection helper,
two sources, three test suites — the reconciled table adds RCP-4/RCP-7/RSL-2/RWS-6/RLE-5 cases).
`400-line budget risk: Medium` as one PR, `Low` per slice.
`Chained PRs recommended: Yes`. `Decision needed before apply: No` (strategy is `auto-chain`,
`stacked-to-main`).

## Non-goals restated (scope creep is this repo's top review defect)

SSE backpressure (`realtime-sse-backpressure`), `@@allow`/RLS row filtering, any migrator/DDL
change, `.live()` and Studio's `useLiveTable`, connect-time JWT/CORS on the raw engine. Decision 7
(`source.ts`) is the one addition beyond the proposal's affected areas and is argued above.

## Open Questions

- [x] **Resolved with spec**: `event.pk` is never narrowed and a PK field appears in `new`/`old`
      only when explicitly listed (decision 6, RCP-8/RCP-9).
- [x] **Resolved with spec**: `columns: []` is valid and means identity-only notification, not a
      compile error (decision 5b, RCP-7). The rejected diagnostic and its misleading message are
      removed from this design.
- [ ] Non-blocking: DX-5 (`partial` refetch widening on the v1 NOTIFY source) is documented, not
      closed. Closing it would require the generator to emit the allowlist into `ModelMeta` —
      deliberately deferred, no second caller yet.
