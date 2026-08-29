# Proposal: Real pagination for the Studio Table Browser

## Intent

`GET /api/tables/:name` emits `SELECT ... FROM "table" LIMIT 100` with **no ORDER BY** and no
pagination params. Postgres may return rows in any physical order, so two loads of the same
table can disagree, and rows 101+ are simply unreachable. The Table Browser's search box and
column sort operate client-side over that arbitrary 100-row slice, so both silently answer a
question about the page, not the table. Users cannot browse or trust a real dataset.

## Scope

### In Scope
- Keyset cursor pagination on the read handler, keyed on the table's primary key, composite-safe
  via Postgres row-value comparison `(pk1, pk2) > ($1, $2)`.
- Stable `ORDER BY` on the PK column list (ascending) for every table read.
- Exact total row count (`SELECT count(*)::int`), returned with each page.
- **Bidirectional paging**: both next AND previous, via reverse keyset cursoring.
- **User-selectable page size** from a closed set (25 / 50 / 100 / 200; default 100), threaded
  to the server as a bounded `limit` and re-validated server-side against a hard maximum.
- Cursor-aware fetch contract in `api.ts` + cursor/total/page-size state in the data store.
- Cursor-driven pagination UI: prev/next controls, page-size selector, honest "Showing X of N".
- **PK-less tables**: one unpaginated page (today's `LIMIT 100`, no ORDER BY, unchanged for this
  case only) plus a UI notice stating the table has no primary key and cannot be paged stably.
- **Disable the per-column sort control** in the Table Browser — it would reorder only the
  loaded page and become misleading once pagination is real.

### Out of Scope
- Arbitrary-column server-side sort (heterogeneous-type cursors, NULLS ordering) — later epic.
- Server-side search/filtering; the search box stays client-side over the loaded page.
- Any write route or `resolveWriteTarget` change from `real-row-crud`.
- Approximate counts (`reltuples`) — no precedent in this codebase.
- OFFSET fallback for PK-less tables, and arbitrary/free-form page sizes.

## Capabilities

### New Capabilities
- `studio-table-pagination`: bidirectional keyset cursor contract, stable PK ordering, bounded
  page size, total count, PK-less single-page behavior, prev/next + page-size UI.

### Modified Capabilities
- `studio-readonly-queries`: `/api/tables/:name` accepts cursor/direction/limit params, validates
  `limit` against a hard cap, and runs a second count query inside the read-only transaction.
- `studio-ui-honesty`: the "pager removed entirely" requirement is replaced by a real cursor
  pager; the "Sort Grid changes row order" requirement is replaced by a disabled sort control
  with a stated reason.
- `studio-server-tests`: forward/backward pagination, composite-PK cursor, limit validation,
  PK-less short-circuit, and count coverage.
- `studio-ui-tests`: prev/next pager, page-size selector, PK-less notice, disabled-sort coverage.

## Approach

Mirror `@indigodb/client`'s `delegate.ts` cursor pattern (bound params, PK as order key), but
extend it: the client throws `CURSOR_COMPOSITE_PK`, while Studio's `ResolvedTable.primaryKey:
string[]` and `rowKey()` already support composite keys end-to-end, so build true row-value
comparison here. Add a read-side identifier validator as a sibling of `resolveWriteTarget`
(not a reuse — write rules such as rejecting autoincrement columns are wrong for reads). The
client builds the next cursor from the last row's PK tuple via the existing `pkValues()`.

Backward paging has no precedent anywhere in this repo — `delegate.ts` is forward-only and
rejects composite PKs outright — so `sdd-design` must pick between a reverse-cursor query
(flip the comparison operator and `ORDER BY ... DESC`, then re-reverse the rows before
returning) and a client-side stack of visited page-boundary cursors, and settle the resulting
first/last-page edge cases. `limit` is validated as a whole number inside the allowed set and
clamped to the hard maximum server-side; the client selector is a convenience, not the
authority. A table whose `primaryKey` list is empty short-circuits to the legacy single-page
read with a `paginated: false` flag the UI renders as an explicit notice.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/cli/src/studio-server.ts` | Modified | Cursor/direction/limit params, limit cap, PK ORDER BY (asc + reverse), row-value WHERE, count query, PK-less short-circuit |
| `apps/studio/src/lib/api.ts` | Modified | `fetchTableRows` params + `{rows, nextCursor, prevCursor, totalCount, paginated}` shape |
| `apps/studio/src/store/useDataStore.ts` | Modified | Cursor/total/page-size/direction state per table |
| `apps/studio/src/features/studio/browser/hooks/useTableData.ts` | Modified | Remove `cycleSort`/`compareRows`; keep search |
| `apps/studio/src/features/studio/browser/TableBrowserPage.tsx` | Modified | Prev/next pager, page-size selector, honest footer, PK-less notice, disabled sort headers |
| `packages/cli/test/studio-pagination.mjs` | New | Plain-Node coverage |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Exact `COUNT(*)` is a full scan on a million-row table | High | Accepted, stated tradeoff matching `delegate.ts`'s `count()`; single count per page request, never per row |
| Composite-PK row-value comparison is new, unprecedented code | Med | Dedicated tests for 1-, 2-, and 3-column PKs, including boundary and last-page cases |
| **Reverse keyset cursoring has no precedent in this codebase** — `delegate.ts` is forward-only and rejects composite PKs, so backward paging over a composite PK is designed from scratch | **High** | `sdd-design` must choose and justify the mechanism (flipped-operator reverse query with row re-reversal vs. client-side cursor stack) before apply; tests must cover paging forward then back to an identical first page, and prev at the first page / next at the last page |
| Client-supplied `limit` is untrusted input (oversized page → unbounded read) | Med | Server validates against the closed set and clamps to a hard maximum; reject or clamp non-integer and out-of-range values, with tests for each |
| PK-less table has no cursor key | Med | Detect at read time, return the single unpaginated page with a `paginated: false` signal, and surface an explicit UI notice rather than a fake pager |
| Users read the disabled sort as a regression | Low | Tooltip stating full-table sort is not yet available |

## Rollback Plan

Revert the change commit. The server change is purely additive to one read handler — a client
sending no cursor param receives a first page, so an older Studio build keeps working against a
newer server. Reverting restores client-side sort with no data migration and no schema change.

## Dependencies

- `real-row-crud` (shipped): `ResolvedTable.primaryKey`, `rowKey()`, `pkValues()`.

## Success Criteria

- [ ] Two consecutive loads of the same table return rows in the same order.
- [ ] Every row of a table larger than one page is reachable by paging forward.
- [ ] Paging forward then back returns the earlier page unchanged, with prev disabled on the
      first page and next disabled on the last.
- [ ] A composite-PK table pages correctly in both directions with no duplicated or skipped rows.
- [ ] Changing the page size re-reads from a well-defined position and never exceeds the
      server's hard maximum, whatever limit the client sends.
- [ ] A PK-less table shows its single page plus a notice explaining why it cannot be paged.
- [ ] The footer shows the real total row count, not the loaded-row count.
- [ ] No UI control claims a full-table sort that the server does not perform.
