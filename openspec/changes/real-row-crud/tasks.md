# Tasks: Real row CRUD

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~850-950 total (new pool, resolver, widget registry, store, dialog, 3 routes, 2 test files) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (slice a, ~450 LOC) -> PR 2 (slice b, ~150 LOC) -> PR 3 (slice c, ~250 LOC) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Writable pool + `resolveWriteTarget` + PATCH route + widget registry + generic editor | PR 1 | `node packages/cli/test/studio-write.mjs` | `packages/cli/test/studio-harness.mjs` PGlite | Revert `studio-server.ts`/`api.ts`/editor files; read-only server restored |
| 2 | INSERT route + Add Record wiring | PR 2 | `node packages/cli/test/studio-write.mjs` | Same PGlite harness | Revert POST route + Add Record button; UPDATE-only server remains |
| 3 | DELETE route + Safe Updates dual gate | PR 3 | `node packages/cli/test/studio-write.mjs` | Same PGlite harness + vitest UI suite | Revert DELETE route/dialog/store; UPDATE+INSERT remain, DELETE disabled |

## Phase 1: Slice (a) - Write infra, UPDATE, widgets

- [x] 1.1 RED: extend `studio-harness.mjs` with PGlite `writable` adapter (real committed `db.transaction`).
- [x] 1.2 RED: create `studio-write.mjs` with failing PATCH tests (single PK, composite PK, unknown table 4xx, unknown column 4xx, read-only-pool-unused regression).
- [x] 1.3 GREEN: add `writePool`/`writable<T>(fn)` to `StudioDb` in `studio-server.ts` (literal BEGIN/COMMIT, ROLLBACK on throw); widen `query` to `(sql, params?)`.
- [x] 1.4 GREEN: add `resolveWriteTarget(resolved, table, columns)` -> `WriteTarget`, throwing `WriteTargetError` (400) on unknown table/column, empty PK, generated column in patch.
- [x] 1.5 GREEN: add `PATCH /api/rows/:table` route using `resolveWriteTarget` + `writable`.
- [x] 1.6 Create `widgets/registry.tsx`: `WIDGET_REGISTRY` (String/Int/Float/Boolean/DateTime/Json/Decimal/BigInt) + `resolveWidget` (enum -> registry -> text).
- [x] 1.7 Create `apps/studio/src/lib/rowKey.ts`: `rowKey`/`pkValues` helpers.
- [x] 1.8 Modify `useRecordEditor.ts`: generic `draft`/`nulls`/`baseline` keyed by `selectedRowKey`.
- [x] 1.9 Modify `RecordInspector.tsx`: iterate `activeTable.columns` via `resolveWidget`; read-only generated PK.
- [x] 1.10 Modify `TableBrowserPage.tsx`: switch selection to `selectedRowKey`.
- [x] 1.11 Add `updateRow(table, pk, patch)` to `api.ts`.
- [x] 1.12 Verify: `node packages/cli/test/studio-write.mjs` and existing `studio-server.mjs` regression both green.

## Phase 2: Slice (b) - INSERT

- [ ] 2.1 RED: extend `studio-write.mjs` with failing POST tests (generated PK omitted from body, returns generated key).
- [ ] 2.2 GREEN: add `POST /api/rows/:table` route reusing `resolveWriteTarget`/`writable`.
- [ ] 2.3 Add `createRow(table, values)` to `api.ts`.
- [ ] 2.4 Wire "Add Record" in `TableBrowserPage.tsx`/`RecordInspector.tsx` (enable when backend available).
- [ ] 2.5 Verify: studio-ui-honesty scenarios (Add Record conditional; Discard/Create Table submit unchanged).

## Phase 3: Slice (c) - DELETE + guards

- [ ] 3.1 RED: extend `studio-write.mjs` with failing DELETE tests (composite PK, single-row removal).
- [ ] 3.2 RED: add failing vitest cases for dual-gate (both-required, either-alone-blocks, session-reset-to-off) and disabled-delete state.
- [ ] 3.3 GREEN: add `DELETE /api/rows/:table` route reusing `resolveWriteTarget`/`writable`.
- [ ] 3.4 Create `useSettingsStore.ts` (Zustand, unpersisted, `safeUpdates: boolean = false`).
- [ ] 3.5 Modify `useSettingsForm.ts` to read/write the store.
- [ ] 3.6 Create `DeleteRecordDialog.tsx`: confirm handler re-reads `safeUpdates` at click time.
- [ ] 3.7 Add `deleteRow(table, pk)` to `api.ts`.
- [ ] 3.8 Wire delete control in `TableBrowserPage.tsx`: disabled+titled when `safeUpdates` true, else opens dialog.
- [ ] 3.9 Verify: `node packages/cli/test/studio-write.mjs` + vitest suite green; `pnpm build|lint|test` green.

## Phase 4: Cleanup

- [ ] 4.1 Confirm no stray hardcoded `email`/`role`/`metadata` references remain in editor path.
- [ ] 4.2 Update proposal Success Criteria checkboxes once all slices land.
