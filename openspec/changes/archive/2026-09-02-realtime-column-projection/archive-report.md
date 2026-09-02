# Archive Report: `realtime-column-projection`

**Change**: `realtime-column-projection`
**Archived to**: `openspec/changes/archive/2026-09-02-realtime-column-projection/`
**Status**: Complete, both PRs merged to main, 0 CRITICAL issues remain open

---

## Final State Authority

This archive report describes the state of the change AT CLOSE, after both PRs were merged to main:

| PR | Branch tip | Merge commit | Scope |
|----|----|----|----|
| PR 1 (Phase 1) | `907f3d2` | `907f3d2` (fast-forward) | Compiler half — grammar, validation, IR field |
| PR 2 (Phases 2–6) | `1c03ae0` (+ `bce50d0` merge of main) | `bf9c6c9` | TypeScript half — write-time enforcement in both sources |

**Base**: `main`@`ab5c34f`
**Implementation tasks**: 53 complete (Phase 1: 16, Phase 2: 3, Phase 3: 19, Phase 4: 9, Phase 5: 3, Phase 6: 3)
**Verification verdicts**: PR 1 PASS WITH WARNINGS (0 CRITICAL / 1 WARNING / 1 SUGGESTION), PR 2 PASS WITH WARNINGS (0 CRITICAL / 1 WARNING / 2 SUGGESTION)
**CRITICAL issues at close**: 0

---

## What This Change Did

Added `@@realtime(columns: [...])`, a closed column allowlist for `@@realtime` models, enforced
**once** at write time so a non-allowlisted column can never reach `_indigo_realtime_log`, an SSE
frame, a replay page, or a `subscribe()` callback.

Before this change, declaring a model `@@realtime` streamed **every** column to every authorized
subscriber. `@@allow` scoped *which rows* a subscriber saw; nothing scoped *which fields*. A model
carrying a `passwordHash`, a reset token, or an internal audit column had no way to stream its
status changes without also streaming those. `columns` closes that: a field is excluded unless it
is explicitly listed, so a newly added field stays out by default rather than silently joining the
stream.

### Design decisions worth carrying forward

- **Enforced once, at the write.** Projection happens in `WalSource` immediately before the log
  INSERT, and the same projected object is what gets dispatched. There is deliberately no second
  filtering step at dispatch, replay, or the generated client — the replay page is guaranteed as
  narrow as the live frame because the stored row is already narrow, not because anything narrows
  it again downstream.
- **Identity travels outside the projected view.** `event.pk` is built from `names.primaryKey`,
  independently of `new`/`old`, and is never narrowed. A PK field appears inside `new`/`old` only
  if it was explicitly listed. That is what makes `columns: []` (identity-only notification) a
  coherent shape rather than a broken one.
- **`null` and an empty `Set` are distinct states.** `projectionSet` returns `null` for "no
  allowlist, stream everything" and an empty `Set` for "allowlist with zero entries". Any
  `!allow.size` shortcut would collapse the strictest declaration into the loosest one — the exact
  fail-open the capability exists to prevent. A dedicated test pins the distinction.
- **Buckets are computed on the full row, before projection.** Excluding a field from `columns`
  must not change *who* is authorized to read the row, only *what they see* — so `@@allow` read
  rules still evaluate against the unprojected row.

---

## Specs Synced to Source of Truth

Four delta specs were merged into `openspec/specs/`:

### NEW Capability
- **`realtime-column-projection`**: the grammar, the compile-time diagnostics, the IR field, and
  the single write-time enforcement guarantee. Sibling to `model-allow-rules` — rows and columns
  are orthogonal axes on the same `ResolvedTable`.

### MODIFIED Capabilities
- **`realtime-wal-source`**: two ADDED requirements (narrowing placement relative to `renameKeys`
  and the log INSERT; projection running after bucket computation on the same buffered object) and
  one MODIFIED requirement — "Emitted events are shape-identical to `PgNotifySource`" now
  distinguishes field **set** parity (unaffected) from field **value** content (narrowed).
- **`realtime-live-endpoint`**: two ADDED requirements — `dispatch()`/`handleLogRequest` forward
  stored bodies verbatim and never re-widen; `subscribe()` callbacks receive the projected payload
  as an intentional, accepted shape change.
- **`realtime-shape-log`**: two ADDED requirements — the log stores the projected view, and
  widening the allowlist later does not retroactively recover values for already-logged rows.

---

## The Manual DB Gate (task 5.3) — Why This Change Was Held

Task 5.3 required running the realtime suites against a real Postgres to exercise **RLE-2** (replay
page narrowness) before merging PR 2. That gate turned out to be **unrunnable**: `WalSource.start()`
awaited `subscribe()`, which resolves only when the replication stream *ends*, so every DB-gated
suite blocked forever.

Rather than merge on the automated (non-DB) suites alone, PR 2 was held and the blocking defect was
raised as its own SDD change, `realtime-start-contract` — which then uncovered two further production
defects in the same path, including a Studio live badge that would read `live` over a dead stream.
That defect was only *reachable* once the hang was fixed: the feature had been working only while it
was broken.

After `realtime-start-contract` landed (`04b3f5d`), the gate was run on the merge candidate against
`postgres:17 -c wal_level=logical -c max_replication_slots=8 -c max_wal_senders=8`:
`log.mjs` exit 0 (4/4), `endpoint.mjs` exit 0 (3/3), `buckets.mjs` exit 0 (5/5). PR 2 then merged as
`bf9c6c9`.

**Carry-forward**: `resume.mjs` passes its three assertions and then hangs on a leaked handle — a
defect distinct from the one fixed, and the one thing still preventing a clean full-suite DB-gated
run.

---

## Open Follow-Ups (deliberately out of scope)

- **`print.ts` drops `realtimeColumns`** (PR 1 WARNING, adjudicated): `printSchema` emits bare
  `@@realtime`, so an allowlist — including the strictest `columns: []` — round-trips to the
  loosest form. Not reachable in production today: `printSchema`'s only call site is `db pull`,
  which has no live path. `print.mjs`'s round-trip drop-list was extended to include
  `realtimeColumns`, following the identical precedent already set for `allow`. Must be closed
  before `db pull` ships.
- **The delegate's `partial` refetch re-widens on the v1 `PgNotifySource` path**
  (`realtime-delegate.ts:85-92`). Pinned by test DX-5 as documented current behavior so it cannot
  change silently; explicitly out of scope to close here.
