# Exploration: Column projection + backpressure (roadmap epic, `realtime · migrator`)

**Engram**: `sdd/realtime-column-projection/explore` (obs #857)

> Persisted here by the orchestrator. The `sdd-explore` agent has no Write/Edit tool by
> definition, so it can only write the Engram half of the hybrid store. Content is the phase
> agent's; only formatting is the orchestrator's.

## Headline

Both defects confirmed live. The two concerns **do not share a technical seam** — recommend
splitting into two independent SDD changes, `realtime-column-projection` and
`realtime-sse-backpressure`.

## 1. Defect re-verification — both CONFIRMED, not stale

### Column projection: fully absent

| Evidence | Finding |
|---|---|
| `crates/indigo-compiler/src/rules.rs:91` | `(AttributeTarget::Model, "realtime", ArgShape::None)` — `@@realtime` takes **zero** arguments. No allowlist/denylist attribute exists in the grammar. |
| `crates/indigo-compiler/src/ir.rs:193` | `pub realtime: Option<bool>` on `ResolvedTable` — boolean only. |
| `packages/core/src/ir.ts:204` | `realtime?: boolean` — same, TS mirror. |
| grep over `packages/realtime/src` | zero hits for a projection concept; the only `columns` is `wal-source.ts`'s physical↔schema name map. |

### Backpressure: fully absent

`packages/realtime/src/engine.ts` — every `res.write()` ignores its boolean return, at `:158`
(heartbeat), `:218` (ready frame), `:388` (wake frame), `:392` (change frame). No `drain`
listener anywhere in the file. `Subscriber` (`engine.ts:96-101`) is `{res, tables, seq}` — there
is no buffer field to hang backpressure state on, so buffering must be **invented, not extended**.

## 2. Column projection — where truth lives, where it must be enforced

**Precedent is `@@allow`**: `rules.rs:74-108` (`ArgShape::Allow`), a generic
`Attribute{namespace,name,args}` in `ast.rs` given shape by `rules.rs`, expanded in `resolve.rs`,
landing at `ir.rs:203` `pub allow: Option<Vec<AllowRule>>`. Note that field is declared **last**
in `ResolvedTable`'s serde output (`ir.rs:324-334`) — order matters to existing golden snapshots.

A column allowlist is genuinely compiler work: a new `ArgShape`, a `validate.rs` field-existence
check, `resolve.rs` resolution, a new `ir.rs` field and its `ir.ts` mirror. **This crosses the
WASM boundary** — `packages/compiler/test/wasm-freshness.mjs` fails until `build:wasm` reruns, and
the 13+ fixtures in `fixtures/snapshots/` need `regen-snapshots.mjs` via the
intentional-contract-change path in `crates/CLAUDE.md`.

`ResolvedSchema` does **not** already carry enough — this is an additive IR change, not a
re-derivation.

### The migrator filing is STALE

`packages/migrator/src/postgres.ts:394-421` (`renderRealtimeLogSql`) emits `_indigo_realtime_log`
with generic `jsonb` `new`/`old` columns — no per-table column enumeration in DDL. And
`REPLICA IDENTITY FULL` (`postgres.ts:358-365`) is what makes Postgres emit the old image at all,
so it **stays mandatory**: projection must happen in application code *after* WAL decode, never by
narrowing replica identity. The roadmap's `· migrator` tag was accurate in the v1 NOTIFY-trigger
era; now that `WalSource` writes the log (`wal-source.ts:585`), **projection needs zero DDL change**.

### Every place a full row body escapes today

Enforcement must cover **all** of these, or it is fake protection:

1. `wal-source.ts:513-514` — `row.new`/`row.old` built by `renameKeys` from the full physical row, then INSERTed verbatim at `:585`. First point row data enters the system.
2. `_indigo_realtime_log` itself — durable, resumable storage of every column ever written.
3. `engine.ts:391-392` (`dispatch()`) — `{...event, seq}` spread to every non-`@@allow` subscriber.
4. `engine.ts:325-359` (`handleLogRequest`) — maps `RealtimeLogRow` → `RealtimeEvent` including `new`/`old`, the resumable replay path.
5. `protocol.ts:16-48` — `RealtimeEvent.new`/`.old` typed as unconstrained `Row`; the wire contract carries no projection concept.
6. **`packages/client/src/realtime-delegate.ts:19-100` — the actual app-facing leak.** `RealtimeModelDelegate.subscribe()` is wired for **any** `@@realtime` model, not gated on `@@allow`, and `dispatch()` (`:77-100`) hands full `event.new`/`event.old` to `onInsert`/`onUpdate`/`onDelete`/`onChange` verbatim. This is where application code receives `passwordHash` today.

Note the asymmetry at (3): `@@allow` models already get a *coarser* fix — `dispatch()`'s wake-frame
branch (`engine.ts:386-390`) strips **all** row data — but that is binary per model and only fires
when `@@allow` is present at all. **A public model with no `@@allow` but one sensitive column has
zero protection today.**

## 3. Backpressure — actual shape

Four `res.write()` sites ignore their return. No per-subscriber queue exists.

**Eviction is cheap here, and that is the load-bearing finding.** `_indigo_realtime_log` is
LSN/id-addressed and resumable (`realtime-live-endpoint`'s `GET ?handle&offset`, `id`-cursor
semantics), so an evicted subscriber loses nothing durable — it reconnects and pages forward from
its last-seen `id`, the same path `.live()`'s `onResync` already exercises. This is architecturally
unlike a stateless-fanout design where eviction means permanent loss.

So the natural design: cap a per-subscriber outbound buffer and, on overflow, `res.end()` the
connection — letting the client's existing reconnect/resume path do the recovery. No new
persistence needed, and no attempt to synchronously slow the writer.

## 4. What must not regress

- `@@allow`/RLS row filtering — an orthogonal axis (which **rows**) from projection (which **columns**); both coexist per model.
- Bucket pre-evaluation (`computeBuckets`, `postgres.ts:669`) — written at INSERT time. Unaffected **unless** projection strips fields the buckets are computed from. Open design-phase check; not settled here.
- Sealed-vs-head cache headers (`engine.ts:361-374`) — `sealed` comes from `events.length === REALTIME_LOG_PAGE_SIZE`, a row **count**, so column projection cannot interact, provided projection runs before that computation.
- Confirmed unaffected: `packages/client/src/live.ts` (`.live()` uses frames as wake triggers only, never reads `pk`/`new`/`old`) and `apps/studio/.../useLiveTable.ts` (same — only calls `scheduleRefetch()`).
- **`RealtimeModelDelegate.subscribe()` WILL change shape** (fewer keys in `Row`) for any model gaining projection. A real, intentional breaking-ish change for that model's subscribers — must be called out in the design doc, not silently absorbed.

## 5. Specs to amend

| Spec | Action |
|---|---|
| `realtime-live-endpoint` | MODIFY — `dispatch()` payload-shape requirements, `handleLogRequest` row mapping |
| `realtime-shape-log` | MODIFY, conditionally — only if the log stores a projected view (see open question (a)) |
| `realtime-wal-source` | MODIFY — `translate`/`renameKeys` if projection happens at ingestion |
| `model-allow-rules` | Do **not** fold into it — recommend a NEW sibling spec; rows and columns are orthogonal axes |
| `client-live-queries`, `studio-live-view` | NOT modified — consumers confirmed payload-agnostic |
| `realtime-replication-ddl`, `row-level-security-ddl` | NOT modified — migrator unaffected |
| backpressure | Needs its own new spec; no existing file covers SSE write backpressure |

## 6. Test harness reality — 9 suites, and 6 of them skip by default

**DB-gated on `INDIGODB_TEST_DATABASE_URL` (print SKIP, exit 0 — silently green, verifying
nothing):** `endpoint.mjs`, `buckets.mjs`, `pg-harness.mjs`, `parity.mjs`, `log.mjs`, `resume.mjs`.

**Unconditional, run in every default checkout:** `wal-source.mjs`, `dispatch.mjs`, `handle.mjs`.

**Correction to CLAUDE.md**, which calls `wal-source.mjs` one of "the Postgres-backed ones": it is
**not** DB-gated. Its header states it drives `WalSource.handleMessage` through injected
`Pgoutput.Message` fakes with no DB, and that its integration coverage lives in
`parity.mjs`/`resume.mjs` instead.

**Consequence for this work:** any new suite for either defect must follow `dispatch.mjs`'s
pattern — fake `ServerResponse`, fake `RealtimeSource`, no DB — or it becomes exactly the
green-signal-that-verifies-nothing failure this repo keeps hitting. A DB-gated-only test for a
secrets leak is worse than no test.

## 7. Split recommendation

Split, on technical-seam evidence rather than roadmap phrasing:

**`realtime-column-projection`** — Rust compiler (`rules.rs`, `validate.rs`, `resolve.rs`,
`ir.rs`), WASM rebuild + 13+ snapshot regen, `ir.ts`, `wal-source.ts`, `engine.ts` (dispatch and
handleLogRequest), `protocol.ts`, `realtime-delegate.ts`, a new spec, and tests across
`dispatch.mjs`/`wal-source.mjs`/`buckets.mjs`/`log.mjs`/`endpoint.mjs`. **500-700 lines** — inside
the 800 budget but tight. Recommend the compiler+WASM+snapshot slice as **its own stacked PR**,
per the `native-type-attributes` precedent: a lexer/IR/WASM change is structurally unrelated review
work from the TS enforcement half.

**`realtime-sse-backpressure`** — `engine.ts` only: a bounded queue on `Subscriber`, `write()`
wrapped with drain handling, a buffer-cap constant, overflow → `res.end()`. One new unit suite,
`dispatch.mjs`-style. **150-250 lines**, single PR.

**Why this is a split and not one change:** both touch `dispatch()`, but projection filters payload
content *before* the `write()` call while backpressure wraps the call *itself*. Sequential,
independently reviewable concerns on the same function — the same "shared file, not shared seam"
that justified splitting `auth-production-guardrails` into five.

**Sequencing:** exploration recommends backpressure first (smaller, no compiler dependency,
de-risks `engine.ts` before the larger change lands on top). No strict ordering requirement exists
either way.

## Open questions for the design phase

- **(a) Write-time vs. read-time projection.** Write-time (log stores already-narrowed rows) is simpler per consumer; read-time (log stores everything, each read path narrows) avoids unrecoverable loss if the allowlist later changes. Genuine tradeoff, unresolved.
- **(b) Attribute grammar.** Model-level `@@realtime(columns: [...])` allowlist vs. a field-level `@sensitive`/`@omit` marker. The allowlist is closed and safe-by-default — a new column needs explicit opt-in. A denylist is more ergonomic on wide models but **fails open** on a forgotten new column.
- **(c) Bucket inputs.** Whether `computeBuckets`' input fields can themselves be projected out in some schemas.
