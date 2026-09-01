# Proposal: Realtime column projection

## Intent

Any `@@realtime` model streams **every** column to **every** subscriber today. `RealtimeModelDelegate.subscribe()` (`packages/client/src/realtime-delegate.ts:77-100`) hands `passwordHash` to application code, and `_indigo_realtime_log` stores it durably. `@@allow` only filters *rows*; a public model with one sensitive column has zero protection. Columns are the missing axis.

## Scope

### In Scope
- Grammar: `@@realtime(columns: [a, b])` — a **closed allowlist** (`rules.rs`, `validate.rs` field-existence check, `resolve.rs`, `ir.rs`, `ir.ts` mirror).
- Bare `@@realtime` keeps meaning **all columns** — no silent behavior change to existing schemas. Once `columns` is declared, a newly added field is excluded until opted in.
- Primary-key values (`event.pk`) are always emitted; identity drives resume/ordering.
- **Write-time** enforcement in `wal-source.ts`: narrow `row.new`/`row.old` after `renameKeys`, before the `_indigo_realtime_log` INSERT (`:585`).
- Non-DB-gated tests following `dispatch.mjs`'s fake-transport pattern.

### Out of Scope (explicit — adjacent siblings)
- **SSE backpressure** → separate change `realtime-sse-backpressure`. Shares `dispatch()`, not a seam.
- `@@allow`/RLS row filtering — orthogonal axis, unchanged.
- Migrator/DDL: none. `REPLICA IDENTITY FULL` stays mandatory; log columns are generic `jsonb`.
- `.live()`, Studio `useLiveTable`, connect-time JWT/CORS — confirmed unaffected.

## Capabilities

### New Capabilities
- `realtime-column-projection`: allowlist grammar, IR contract, write-time enforcement, payload guarantees. Sibling to `model-allow-rules`, not folded into it.

### Modified Capabilities
- `realtime-wal-source`: `translate`/log-write narrows to the allowlist.
- `realtime-shape-log`: log stores the projected view only.
- `realtime-live-endpoint`: `dispatch()` and `handleLogRequest` emit stored bodies verbatim and never re-widen.

## Approach

Three decisions, with rationale:

**Allowlist over `@sensitive` denylist.** A denylist fails open on a forgotten new column. This repo's recurring defect class is things that silently do nothing; a leak-by-default mechanism is that defect in the security layer. Cost: verbosity on wide models — accepted.

**Write-time over read-time.** The secret never reaches disk, and the six enumerated escape points collapse to one. Accepted risk, stated plainly: **widening an allowlist later cannot recover history never stored** — pre-widening replay pages stay narrow. Read-time would spread enforcement across six sites, and partial projection reads as protection while not being it.

**Bucket inputs (`computeBuckets`, `postgres.ts:669`).** Ordering is load-bearing: compute buckets on the **full** decoded row, then project, then INSERT. Projecting away an `@@allow` read-rule field is therefore legal and does not break authorization. Consequence recorded: that field's value persists in the `buckets` column for server-side authorization only, never in a payload.

**Delivery**: two stacked PRs, per the `native-type-attributes` precedent. PR-1 = crates + `build:wasm` + 13+ golden regen (`fixtures/snapshots/`, intentional-contract-change path in `crates/CLAUDE.md`) + `ir.ts`. PR-2 = TS enforcement + tests. The WASM/snapshot diff is structurally unrelated review work.

**Breaking change, intentional**: `subscribe()`'s `onInsert`/`onUpdate`/`onDelete`/`onChange` receive fewer keys for any model that adopts `columns`. Nothing is published to npm; cheap now, expensive later.

**Test reachability is a requirement, not a footnote**: 6 of 9 `packages/realtime/test/` suites SKIP without `INDIGODB_TEST_DATABASE_URL`. A DB-gated-only test for a secrets leak is worse than no test. New coverage MUST run in a default checkout.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `crates/indigo-compiler/src/{rules,validate,resolve,ir}.rs` | Modified | New `ArgShape`, field-existence validation, IR field appended last |
| `packages/compiler/wasm/`, `fixtures/snapshots/` | Modified | `build:wasm` + snapshot regen required before commit |
| `packages/core/src/ir.ts` | Modified | TS mirror of the new IR field |
| `packages/realtime/src/wal-source.ts` | Modified | Single enforcement point, post-bucket |
| `packages/realtime/src/protocol.ts` | Modified | Wire contract documents projected bodies |
| `packages/realtime/test/`, `packages/client/test/` | New | Non-DB-gated suites |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Bucket field projected away breaks row auth | Med | Compute buckets before projection; spec scenario asserts it |
| Stale WASM artifact | Med | `wasm-freshness.mjs` fails loudly; PR-1 commits the rebuild |
| Enforcement lands in some paths only | Low | Write-time gives exactly one enforcement site |
| New tests are DB-gated and silently green | Med | Fake-transport pattern mandated in spec + tasks |
| Scope creep into backpressure | Med | Named non-goal; separate change |

## Rollback Plan

Revert the two PR commit ranges (PR-2 then PR-1) and re-run `pnpm clean && pnpm build --force`. `columns` becomes an unknown attribute argument again, so any schema using it must drop the argument — bare `@@realtime` is unchanged and needs no edit. No DDL ran, so no migration to undo; log rows written while projection was active stay narrow and remain readable.

## Dependencies

- Rust toolchain + `build:wasm` for PR-1 (TypeScript-only contributors cannot land it).

## Success Criteria

- [ ] `@@realtime(columns: [...])` parses, validates unknown fields as errors, and reaches `ResolvedTable` in both Rust and TS IR.
- [ ] A projected column never appears in `_indigo_realtime_log`, an SSE frame, a replay page, or a `subscribe()` callback.
- [ ] Bare `@@realtime` behavior is byte-identical to today.
- [ ] `computeBuckets` output is unchanged when a bucket field is projected away.
- [ ] New coverage passes with `INDIGODB_TEST_DATABASE_URL` unset.
- [ ] `pnpm build && pnpm lint && pnpm test` and `cd crates && cargo test --locked` green.
