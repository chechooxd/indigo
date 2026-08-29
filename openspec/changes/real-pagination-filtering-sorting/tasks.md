# Tasks: Real pagination for the Studio Table Browser

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 450-550 |
| 400-line budget risk | Medium |
| Chained PRs recommended | No |
| Suggested split | Single PR (size:exception) |
| Delivery strategy | ask-on-risk |
| Chain strategy | size-exception |

Decision needed before apply: Yes
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: Medium

Rationale: proposal explicitly requires one bounded slice (unlike `real-row-crud`'s 3-PR
chain). Backend keyset SQL, response contract, and frontend pager consume the same contract
in lockstep — splitting server/UI into separate PRs would ship an unusable half-feature.
Flag `size:exception` for maintainer approval instead of chaining.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Full pagination slice: server + UI + tests | PR 1 (size:exception) | `node packages/cli/test/studio-pagination.mjs` | `withDatabase`+`withStudio` PGlite harness (existing, from `real-row-crud`) | Revert commit; additive-only read route, no schema/data migration |

## Phase 1: Backend Foundation

- [x] 1.1 `packages/cli/src/studio-server.ts`: add `resolveReadTarget(resolved, tableName)` returning `{table, quotedTable, pk: ResolvedColumn[]}`; allows empty `pk`, never rejects autoincrement columns.
- [x] 1.2 Add `buildKeysetSql(pk, op)` builder: single-PK `"col" op $1`; composite `(c1,c2) op ($1,$2)`; `ORDER BY` ASC for `>`, DESC for `<`.
- [x] 1.3 Add `parsePageParams(query)`: validates `limit` (absent→100; else exact member of `{25,50,100,200}` else 400 `"limit must be one of 25, 50, 100, 200"`, no SQL run), `direction` (`forward`/`backward`, else 400), `cursor` (base64url JSON PK tuple, else 400 `"Invalid cursor"`).
- [x] 1.4 Add `encodeCursor(pkValues)` / `decodeCursor(str, pk.length)` (arity-checked).

## Phase 2: Backend Route Integration

- [x] 2.1 Rewrite `GET /api/tables/:name` inside existing `db.readOnly` callback: call `resolveReadTarget`, `parsePageParams`.
- [x] 2.2 PK-less short-circuit (`pk.length === 0`): validate then ignore cursor/direction/limit; run today's exact `LIMIT 100` query, no `ORDER BY`; still run `SELECT count(*)::int`; return `{columns, rows, nextCursor:null, prevCursor:null, total, paginated:false}`.
- [x] 2.3 Paginated path: build keyset WHERE + `ORDER BY`, fetch `limit+1` rows; for `backward`, flip operator/`ORDER BY` then `.reverse()` the trimmed rows before responding.
- [x] 2.4 Compute `hasExtra`/trim, `nextCursor`/`prevCursor` per design's boundary rules; run `count(*)` in the same transaction; assemble `{columns, rows, nextCursor, prevCursor, total, paginated:true}`.
- [x] 2.5 Confirm zero changes to `resolveWriteTarget`, `db.writable`, and POST/PATCH/DELETE routes.

## Phase 3: Backend Tests (RED before GREEN)

- [x] 3.1 Create `packages/cli/test/studio-pagination.mjs` on the `withDatabase`+`withStudio` PGlite pattern from `studio-write.mjs`; add to `@indigodb/cli`'s test chain.
- [x] 3.2 RED+GREEN: 60-row single-PK table, `limit=25`, 3 forward pages, no dup/skip, `total===60` throughout.
- [x] 3.3 RED+GREEN: forward pages 1→2→3 then backward 3→2→1 returns byte-identical bodies to the forward pass.
- [x] 3.4 RED+GREEN: composite 2-col and 3-col PK tables (3-col with a repeated leading column) page correctly both directions.
- [x] 3.5 RED+GREEN: `limit` validation — valid set accepted, `0`/`1000`/`abc`/`50.0` → 400 exact message, absent defaults to 100.
- [x] 3.6 RED+GREEN: malformed/wrong-arity cursor → 400; unknown table → 404 unchanged.
- [x] 3.7 RED+GREEN: PK-less table → `paginated:false`, both cursors null, real total.
- [x] 3.8 RED+GREEN: first-page `prevCursor` null, last-page `nextCursor` null.
- [x] 3.9 Regression: run full suite, confirm `real-row-crud`'s write-path tests and existing read-only tests pass unmodified.

## Phase 4: Frontend Contract & State

- [x] 4.1 `apps/studio/src/lib/api.ts`: extend `fetchTableRows` with `cursor`/`direction`/`limit`; update return type to `{columns, rows, nextCursor, prevCursor, total, paginated}`.
- [x] 4.2 `apps/studio/src/store/useDataStore.ts`: add per-table pagination state (`cursor`, `direction`, `pageSize`, `nextCursor`, `prevCursor`, `total`, `paginated`) + `setTablePage`/`setPageSize` actions.
- [x] 4.3 `apps/studio/.../hooks/useTableData.ts`: delete `sort`, `cycleSort`, `compareRows`, `compareValues`; keep search; update `UseTableDataReturn` shape.

## Phase 5: Frontend UI Wiring

- [x] 5.1 `TableBrowserPage.tsx`: add prev/next pager buttons, disabled when the matching cursor is null or `paginated===false`.
- [x] 5.2 Add page-size selector (25/50/100/200, default 100); changing it resets to `cursor:null, direction:"forward"`.
- [x] 5.3 Add PK-less notice banner when `paginated:false`, following the `studio-ui-honesty` pattern.
- [x] 5.4 Add `SORT_DISABLED_TITLE` constant beside `READ_ONLY_TITLE`/`REFRESH_DISABLED_TITLE`; render sort control `disabled` with that title; remove any remaining sort UI entry points.
- [x] 5.5 Sweep all consumers of `useTableData`'s return shape for now-deleted sort fields.

## Phase 6: Frontend Tests (RED before GREEN)

- [x] 6.1 RED+GREEN: pager next/prev wiring and boundary-disabled states.
- [x] 6.2 RED+GREEN: page-size selector resets to page 1.
- [x] 6.3 RED+GREEN: PK-less notice banner renders on `paginated:false`.
- [x] 6.4 RED+GREEN: sort control renders disabled with `SORT_DISABLED_TITLE`, has no effect if triggered.

## Phase 7: Verification

- [x] 7.1 Run `pnpm build`, `pnpm lint`, `pnpm test` at repo root; confirm all pass.
- [x] 7.2 Confirm success criteria from `proposal.md` are all satisfied.
