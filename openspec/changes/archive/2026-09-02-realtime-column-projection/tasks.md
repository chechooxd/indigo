# Tasks: Realtime column projection

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | PR 1 ≈ 260 authored (compiler + fixtures + `ir.ts`, goldens excluded); PR 2 ≈ 380 authored (projection helper, two sources, three test suites) |
| 400-line budget risk | Low per slice (Medium if landed as one PR) |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (compiler) → PR 2 (TS enforcement), PR 2 targets PR 1 |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | `@@realtime(columns:…)` parses, validates, resolves into IR (both Rust + TS) | PR 1 | `cd crates && cargo test --locked` | N/A — compiler-only, no runtime process | Revert `crates/`, `packages/compiler/wasm/`, `wasm-sources.sha256`, `packages/core/src/ir.ts`, fixtures 20/21 |
| 2 | Write-time projection enforced in `WalSource` + `PgNotifySource`, non-DB-gated coverage | PR 2 | `node packages/realtime/test/wal-source.mjs && node packages/realtime/test/dispatch.mjs` | `INDIGODB_TEST_DATABASE_URL=… pnpm --filter @indigodb/realtime test` (manual merge gate, RLE-2 only) | Revert `packages/realtime/src/{projection,wal-source,source,protocol}.ts` + new/modified test files; PR 1 stands alone |

## Phase 1: Compiler grammar + IR (PR 1)

- [x] 1.1 `crates/indigo-compiler/src/rules.rs`: add `ArgShape::Realtime`, `REALTIME_ARG_KEYS = ["columns"]`, wire `@@realtime` rule row to the new shape.
- [x] 1.2 RED: `crates/indigo-compiler/src/validate.rs` unit — unknown field in `@@realtime(columns:…)` on a fixture model fails before the fix (covers RCP-5, DX-1 relation/non-scalar case).
- [x] 1.3 GREEN: implement `validate_realtime_columns` in `validate.rs` (unknown/non-scalar field, duplicate entry, unknown named key/positional arg — messages per design's Diagnostics table), called beside the existing `@@realtime` + no-`@id` check at `:75-80`. Covers RCP-3, RCP-5, RCP-6, DX-1, DX-3.
- [x] 1.4 RED: `resolve.rs` `#[cfg(test)]` — resolving `columns:[id,email]` must produce physical `dbName`s in declaration order, excluding an unlisted field (RCP-4), before implementation.
- [x] 1.5 GREEN: `crates/indigo-compiler/src/resolve.rs` — resolve `columns` into `ResolvedTable.realtimeColumns: Option<Vec<String>>`, using `@map`ped physical names (DX-2).
- [x] 1.6 RED: `crates/indigo-compiler/src/ir.rs` — extend `allow_serializes_after_group_when_present` (`:324-336`) to assert `realtime_columns` serializes last, after `allow`; the existing assertion must fail against the pre-change struct.
- [x] 1.7 GREEN: `ir.rs` — add `realtime_columns: Option<Vec<String>>` as the new last field of `ResolvedTable`, `#[serde(skip_serializing_if = "Option::is_none", default)]`; make 1.6 pass.
- [x] 1.8 RED: `resolve.rs`/`ir.rs` unit — `columns: []` must serialize as present-and-empty `[]`, never omitted (RCP-7), written before confirming current behavior.
- [x] 1.9 GREEN: confirm the empty-list path from 1.5/1.7 satisfies 1.8; no special-case rejection exists anywhere in the pipeline (decision 5b — no empty-list diagnostic).
- [x] 1.10 Create `fixtures/20-realtime-columns.indigo` — bare `@@realtime`, `@@realtime(columns:[...])` with a `@map`ped field, and a field intentionally excluded from `columns` (RCP-2, RCP-4, RCP-8, RCP-9, DX-2).
- [x] 1.11 Create `fixtures/21-rejected-realtime-columns.indigo` — one instance per rejection class: unknown field, duplicate entry, `columns:` on `@@index` (RCP-3, RCP-5, RCP-6, DX-1, DX-3).
- [x] 1.12 `packages/core/src/ir.ts`: add `realtimeColumns?: string[]` mirroring `ir.rs` field order/optionality.
- [x] 1.13 Run `cd crates && cargo test --locked` — all Rust unit tests green, including 1.2–1.9.
- [x] 1.14 Run `pnpm --filter @indigodb/compiler build:wasm`; commit both `packages/compiler/wasm/` and `wasm-sources.sha256`.
- [x] 1.15 Run `node packages/compiler/test/regen-snapshots.mjs`; verify fixtures 01–19 are byte-identical (RCP-1) and only new snapshots for 20/21 appear.
- [x] 1.16 Run `pnpm build && pnpm lint && pnpm test` at repo root — confirms `wasm-freshness.mjs` passes and `packages/compiler/test/parity.mjs` is green.

### Notes (PR 1 closeout)

- **Deviation from design's File Changes table (necessary, in-scope fix)**: `packages/core/test/print.mjs`'s pure fixture round-trip test iterates every `.indigo` fixture automatically, so adding fixtures 20/21 broke it — the printer (`print.ts`) doesn't know about `realtimeColumns` and design's File Changes table intentionally left `print.ts` untouched for PR 1. Fixed by extending `normalizeForRoundTrip`'s existing drop-list (which already dropped `allow` for the identical reason — `@@allow` is likewise out of the printer's scope) to also drop `realtimeColumns`, mirroring the established precedent instead of adding new printer scope. `print.ts` itself is unmodified.
- Fixture 20/21 also got dedicated `crates/indigo-compiler/tests/fixtures.rs` integration tests (`fixture_20_*`, `fixture_21_*`, `corpus_fixtures_01_through_19_are_unaffected_by_realtime_columns`) beyond the task list's minimum, following the existing convention set by fixtures 18/19.

## Phase 2: Shared projection helper (PR 2)

- [x] 2.1 RED: `packages/realtime/test/wal-source.mjs` — new case asserting `project(row, new Set())` returns `{}` while `project(row, null)` returns the row unchanged; must fail before `projection.ts` exists (RCP-7, the null-vs-empty-Set fail-open guard).
- [x] 2.2 GREEN: create `packages/realtime/src/projection.ts` (~20 lines) exporting `projectionSet(table): Set<string> | null` and `project(row, allow): Record<string, unknown>`. `project` MUST filter entries only — never compact `null` values (RWS-7) — and MUST treat `null` (all columns) and an empty `Set` (return `{}`) as distinct states; forbid any `!allow.size` shortcut that would fall back to "all columns" (make 2.1 pass).
- [x] 2.3 `packages/realtime/src/wal-source.ts`: cache `projectionSet(table)` once per table in the `TableNames` record built in the constructor (`:78-94`/`:149-166`), alongside existing `columns`/`primaryKey`.

## Phase 3: Write-time enforcement (PR 2)

- [x] 3.1 RED: `packages/realtime/test/wal-source.mjs` — projected-table case asserting a non-allowlisted column is absent from the INSERT params (`Object.keys(JSON.parse(params[4]))`) and from the dispatched event; must fail against current `decodeRow` (RCP-2, RWS-1).
- [x] 3.2 GREEN: `packages/realtime/src/wal-source.ts` `decodeRow` (`:512-515`) — call `project(rawRow, table.projection)` after `computeBuckets` and before `renameKeys`; make 3.1 pass.
- [x] 3.3 RED: `wal-source.mjs` — assert `old` image is projected via the **same** `project()` call as `new` (adjacent lines), for both UPDATE (`params[5]`/`params[6]`) and DELETE (`params[6]`); key sets deep-equal the `new` key set (RCP-11, RWS-4). Must fail if only `new` is narrowed.
- [x] 3.4 GREEN: apply `project()` identically to `row.old` in the same two adjacent lines as `row.new`; no second call site (decision 5, prohibits half-fixing `new` alone).
- [x] 3.5 RED: `wal-source.mjs` — feed a fixture whose PK column is absent from `columns`; assert `event.pk` is still complete (built from `names.primaryKey`, never from the projected `new`/`old`) (RCP-8). Then a variant where the PK IS listed in `columns`, asserting it additionally appears in `new`/`old` (RCP-9).
- [x] 3.6 GREEN: confirm `event.pk` construction (`:493-498`) reads `names.primaryKey` unconditionally and is never passed through `project()`; fix only if 3.5 fails (decision 6 — PK not implicit).
- [x] 3.7 RED: `wal-source.mjs` — a listed column with a `null` value must remain present as `{col: null}` after projection, not be dropped (RWS-7 — "narrowed" vs "compacted").
- [x] 3.8 GREEN: verify `project()`'s `Object.keys(row).filter(...)` implementation preserves `null` entries; adjust only if 3.7 fails.
- [x] 3.9 RED: `wal-source.mjs` — empty-`columns` case: INSERT params store `'{}'::jsonb` (not `NULL`) via `buildLogInsert:578-579`, and dispatched `event.new` deep-equals `{}` via the `flushCommit:458-459` `if (row.new)` guard (RCP-7 mechanics).
- [x] 3.10 GREEN: confirm `buildLogInsert`/`flushCommit` require no change — `{}` is truthy and already serializes to `'{}'::jsonb`; fix only if 3.9 fails.
- [x] 3.11 RED: `wal-source.mjs` — extend the existing `:565` "buckets from the RAW row" case with a projected variant: `computeBuckets` output (the `buckets` column) is byte-identical whether or not an `@@allow` field is excluded from `columns` (RCP-12, bucket-before-projection ordering).
- [x] 3.12 GREEN: confirm `decodeRow` calls `computeBuckets` on the full raw row before `project()` runs; fix ordering only if 3.11 fails.
- [x] 3.13 RED: `wal-source.mjs` — across projected, empty-list, and bare-`@@realtime` cases, assert no emitted event carries `partial: true` (RWS-6).
- [x] 3.14 GREEN: confirm `WalSource` never sets `partial` in any code path touched by projection; fix only if 3.13 fails.
- [x] 3.15 Verify (no new test): existing `wal-source.mjs` `:76`/`:98`/`:124` bare-`@@realtime` cases and the `:623` SQL-injection case pass **unmodified** (RWS-2, RWS-5, RSL-3, injection row of the threat matrix) — do not edit them; a diff here is a regression.
- [x] 3.16 RED: `wal-source.mjs` — RSL-2: commit through a source built with allowlist A, rebuild the source with wider allowlist B, commit again; assert the **first** captured INSERT params stay narrow (widening does not recover prior history).
- [x] 3.17 GREEN: confirm 3.16 passes with no production change (write-time projection is inherently one-way); if it fails, the bug is a cached/shared projection Set being mutated instead of rebuilt per source instance.
- [x] 3.18 RED + GREEN: `packages/realtime/src/source.ts` (`PgNotifySource.translate`, `:136-142`) — add the same `project()` call (~4 lines), gated on `table.projection`; add DX-4 cases in `wal-source.mjs` or a `source.mjs`-style fake-payload test following existing shape, covering narrow/empty/bare forms.
- [x] 3.19 `packages/realtime/src/protocol.ts`: add a doc comment stating bodies are already projected write-time and consumers (`engine.ts`, `handleLogRequest`, `realtime-delegate.ts`) MUST NOT re-filter — no functional change (decision 8).

## Phase 4: Live endpoint + client coverage (PR 2)

- [x] 4.1 RED: `packages/realtime/test/dispatch.mjs` — feed a pre-projected event through a fake `ServerResponse`; assert the SSE frame's `data` key set equals the allowlist (RLE-1).
- [x] 4.2 GREEN: confirm `dispatch()`/`handleLogRequest` forward the stored/dispatched object verbatim (no widening); fix only if 4.1 fails.
- [x] 4.3 RED: `dispatch.mjs` — cross-product case: a projected model **with** `@@allow` still gets the data-free wake frame (`engine.ts:386-390` branch wins); a projected model **without** `@@allow` gets the narrowed change frame (RLE-3).
- [x] 4.4 GREEN: fix only if 4.3 exposes an interaction bug; expected to pass unmodified per decision 8.
- [x] 4.5 RED: create `packages/client/test/realtime-projection.mjs` (fake `RealtimeConnectionManager`, following the `realtime-entry.mjs` pattern) — subscriber receives fewer keys after adopting `columns` (RLE-4).
- [x] 4.6 GREEN: confirm no client-side change is needed (bodies already narrow on the wire); fix only if 4.5 fails.
- [x] 4.7 RED: `realtime-projection.mjs` — a bare-`@@realtime` event reaches `onInsert`/`onUpdate`/`onDelete` with every key intact (RLE-5).
- [x] 4.8 GREEN: fix only if 4.7 fails; expected pass-through.
- [x] 4.9 `realtime-projection.mjs`: add DX-5 — assert the **documented current behaviour** that the `partial` refetch (`realtime-delegate.ts:85-92`) re-widens on the v1 source (pins it so a future change cannot alter it silently; explicitly out of scope to close).

## Phase 5: Reachability guard + manual DB gate

- [x] 5.1 In every new/extended suite (`wal-source.mjs`, `dispatch.mjs`, `realtime-projection.mjs`), end with `strictEqual(ran, <exact count>)` so an omitted or skipped case fails loudly (RCP-13).
- [x] 5.2 Add an `rg` guard (script or CI step) asserting the new/modified realtime test files contain **no** `INDIGODB_TEST_DATABASE_URL` reference (RCP-13).
- [x] 5.3 Required manual merge gate (not automated, not counted as coverage): run `INDIGODB_TEST_DATABASE_URL=… pnpm --filter @indigodb/realtime test` against a real Postgres to exercise RLE-2 (replay page narrowness) before merging PR 2.
  - Run 2026-09-02 against `postgres:17 -c wal_level=logical -c max_replication_slots=8 -c max_wal_senders=8` on port 55432, on the merge candidate: `log.mjs` exit 0 (4/4), `endpoint.mjs` exit 0 (3/3), `buckets.mjs` exit 0 (5/5). RLE-2 exercised by `log.mjs`.
  - This gate was unrunnable until `realtime-start-contract` fixed `WalSource.start()` (it awaited `subscribe()`, which resolves only at stream end). That is why PR 2 was held rather than merged on the automated suites alone; it merged as `bf9c6c9` after this run.

## Phase 6: Cross-package verification

- [x] 6.1 Run `pnpm clean && pnpm build --force && pnpm lint && pnpm test` from repo root (never plain `clean && build` — Turbo restores a cached `dist/` wholesale for this cross-package change).
- [x] 6.2 Confirm `pnpm --filter @indigodb/compiler test` (`parity.mjs`) and `cd crates && cargo test --locked` both green on the final tree.
- [x] 6.3 Update `openspec/changes/realtime-column-projection/proposal.md` Success Criteria checkboxes to checked, referencing this tasks.md as evidence.
