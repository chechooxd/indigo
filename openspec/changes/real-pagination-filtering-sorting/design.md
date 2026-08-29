# Design: Real pagination for the Studio Table Browser

## Technical Approach

`GET /api/tables/:name` becomes a stateless, bidirectional PK keyset paginator. Every quoted
identifier still comes from `ResolvedSchema` (never request text); the only request-derived
values are bound parameters. The handler stays inside the existing `db.readOnly`
(`SET TRANSACTION READ ONLY`) callback, so the page query and the count query share one
read-only transaction and therefore one consistent snapshot. `resolveWriteTarget` and every
write route are untouched.

## Architecture Decisions

### Decision: read-side target resolver, not `resolveWriteTarget` reuse

**Choice**: new `resolveReadTarget(resolved, tableName): { table, quotedTable, pk: ResolvedColumn[] }`
in `studio-server.ts`, a sibling of `resolveWriteTarget`. Returns `pk: []` for a PK-less table
instead of throwing.
**Alternatives**: reuse `resolveWriteTarget`.
**Rationale**: its rules are write rules — it throws on a missing PK (a legal read) and on
autoincrement columns (which are exactly the PKs we must order by).

### Decision: row-value comparison for composite-safe keyset

**Choice**: one builder shared by both directions.

```ts
// pk in ResolvedTable.primaryKey order; op is ">" (forward) or "<" (backward)
const cols = pk.map((c) => `"${c.dbName}"`).join(", ");
const holes = pk.map((_, i) => `$${i + 1}`).join(", ");
const where = pk.length === 1 ? `${cols} ${op} ${holes}` : `(${cols}) ${op} (${holes})`;
const orderBy = pk.map((c) => `"${c.dbName}" ${op === ">" ? "ASC" : "DESC"}`).join(", ");
```

**Alternatives**: expanded OR-chains (`a > $1 OR (a = $1 AND b > $2)`).
**Rationale**: row-value comparison is index-friendly, correct for N columns with no
combinatorial expansion, and cannot drift out of sync with `ORDER BY`. `@indigodb/client`'s
`delegate.ts` rejects composite PKs outright, so nothing is portable from there.

### Decision: backward paging = reverse query + application-side re-reversal (approach a)

**Choice**: backward requests run `< cursor ORDER BY pk DESC LIMIT n+1`, then the handler
`.reverse()`s the trimmed rows before responding, so the client always receives ascending rows.
**Alternatives**: (b) a client-held stack of visited boundary cursors.
**Rationale / tradeoffs**:

| | (a) reverse query | (b) client cursor stack |
|---|---|---|
| Server state | none — every request self-describing | none, but correctness moves into the client |
| Data changed since visit | prev page reflects current data (correct) | replays a stale boundary; deleted boundary row → wrong/empty page |
| Page-size change mid-session | stack semantics undefined: the remembered boundaries belong to a different page grid, so the stack must be discarded or it lands the user at arbitrary offsets | no stack to invalidate; a size change simply resets to the first page (`cursor: null`), which is honest and predictable |
| Cost | one extra `ORDER BY DESC` plan + an in-memory `reverse()` of ≤200 rows | none |
| Deep-link / refresh | a cursor URL is complete | history lost on reload, prev silently dies |

(a) wins: it keeps the server the single authority (the studio-ui-honesty stance), costs a
bounded reverse of at most 200 rows, and removes the page-size-change hazard entirely.

### Decision: invalid `limit` is REJECTED (400), never clamped

**Choice**: `limit` absent → 100. Present → must be an exact decimal-integer string that is a
member of `{25, 50, 100, 200}`; anything else (`0`, `1000`, `50.0`, `abc`, `""`, repeated param)
→ `400 { error: "limit must be one of 25, 50, 100, 200" }`, no SQL run. Same for a malformed
cursor (`400 { error: "Invalid cursor" }`) and an unknown `direction`.
**Alternatives**: clamp to nearest/default.
**Rationale**: clamping returns 25 rows to a caller who asked for 1000 and says nothing — the UI
would then render an honest-looking pager over a page size the user never chose. Rejecting is
still server-authoritative (the client selector is a convenience) and is loudly debuggable. The
spec must state reject, not clamp.

### Decision: exact `COUNT(*)`, one per request

Matches `delegate.ts`'s `count()`. Full-scan cost accepted and stated; never per row.

## Data Flow

    TableBrowserPage ──fetchTableRows(name, {cursor, direction, limit})──→ GET /api/tables/:name
          │                                                                      │
          │                                              resolveReadTarget → pk[]│
          │                                     ┌── pk.length === 0 → LIMIT 100, no ORDER BY
          │                                     └── keyset WHERE + ORDER BY, LIMIT n+1
          │                                            + SELECT count(*)::int   (same txn)
          └──← {columns, rows, nextCursor, prevCursor, total, paginated} ────────┘

## Interfaces / Contracts

```ts
// Cursor = base64url(JSON.stringify(pkTupleInPrimaryKeyOrder)). Opaque to the client.
type Direction = "forward" | "backward";

interface TablePage {
  columns: string[];
  rows: Record<string, unknown>[];   // always ascending PK order
  nextCursor: string | null;         // null ⇒ last page
  prevCursor: string | null;         // null ⇒ first page
  total: number;                     // exact count(*)
  paginated: boolean;
}
```

Boundary detection (server, `n = limit`, fetched `n + 1`):

- `hasExtra = fetched.length > n`; trim to `n`.
- forward: `nextCursor = hasExtra ? cursorOf(last) : null`; `prevCursor = requestCursor ? cursorOf(first) : null`.
- backward (after `reverse()`): `prevCursor = hasExtra ? cursorOf(first) : null`; `nextCursor = cursorOf(last)`.
- An empty `rows` array yields both cursors `null` (a page past the end collapses to a terminal page).

PK-less short-circuit (`pk.length === 0`) — today's query verbatim (`LIMIT 100`, no `ORDER BY`),
`limit`/`cursor`/`direction` still validated then ignored, and:

```json
{ "columns": [...], "rows": [...], "nextCursor": null, "prevCursor": null,
  "total": 1234, "paginated": false }
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/cli/src/studio-server.ts` | Modify | `resolveReadTarget`, `parsePageParams` (limit/direction/cursor validation), `buildKeysetSql`, `encodeCursor`/`decodeCursor`, rewritten `/api/tables/:name` |
| `apps/studio/src/lib/api.ts` | Modify | `fetchTableRows(name, opts?)` → `TablePage \| null`; `QueryResult` stays for `/api/query` |
| `apps/studio/src/store/useDataStore.ts` | Modify | `pagination: Record<string, TablePageState>` + `setTablePage`, `setPageSize` |
| `apps/studio/src/features/studio/browser/hooks/useTableData.ts` | Modify | Delete `sort`, `cycleSort`, `compareRows`, `compareValues`; keep search |
| `apps/studio/src/features/studio/browser/TableBrowserPage.tsx` | Modify | Pager (prev/next), page-size `<select>`, honest footer, PK-less notice, disabled sort headers |
| `packages/cli/test/studio-pagination.mjs` | Create | Round-trip pagination suite |

Frontend state (per table, keyed by table name):

```ts
interface TablePageState {
  cursor: string | null;            // cursor used for the currently displayed page
  direction: Direction;             // direction used for it
  pageSize: 25 | 50 | 100 | 200;    // default 100
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  paginated: boolean;
}
```

Next → refetch with `{cursor: nextCursor, direction: "forward"}`. Prev → `{cursor: prevCursor,
direction: "backward"}`. Buttons are `disabled` when the corresponding cursor is `null` or
`paginated === false`. **Changing `pageSize` resets `cursor: null, direction: "forward"`** —
jumping back to page one; row identity across differently-sized page grids is not well defined,
and silently landing somewhere approximate would be dishonest.

## Sort control (studio-ui-honesty)

The header button becomes `disabled` with `title={SORT_DISABLED_TITLE}` — a module constant next
to the existing `READ_ONLY_TITLE` / `REFRESH_DISABLED_TITLE`, reading: *"Sorting is disabled:
rows are ordered by primary key across all pages. Full-table sort on other columns is not
available yet."* The icon renders at reduced opacity with no `ArrowUp`/`ArrowDown` state. The
comparator and sort state are **deleted**, not merely hidden: unreferenced exports would trip
`tsc --noEmit` (`pnpm lint`) and leaving a working-but-unreachable client-side sorter invites
someone to re-enable a control that reorders one page while claiming to sort a table.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Integration | forward/backward round-trip, composite PK, validation, PK-less, count | new `packages/cli/test/studio-pagination.mjs`: real HTTP against `withDatabase` + `withStudio` (PGlite), the `studio-write.mjs` pattern but read-only. Wire into `packages/cli`'s `test` script chain. |
| UI | pager enable/disable, page-size reset, PK-less notice, disabled sort header | `apps/studio` vitest against `TableBrowserPage` with a mocked `api.ts` |

Concrete cases: 60-row single-PK table at `limit=25` → 3 pages, no duplicate/skipped rows,
`total === 60` on every page; page 1 → 2 → 3 → back to 2 → back to 1 returns byte-identical page
bodies to the forward pass; `prevCursor === null` on page 1 and `nextCursor === null` on page 3;
composite PK (2-col and 3-col, with a repeated leading column so row-value comparison is actually
load-bearing) paged both ways; `limit` of `0`/`1000`/`abc`/`50.0` → 400 with no rows; malformed
and wrong-arity cursors → 400; unknown table → 404 (unchanged); PK-less table → `paginated: false`,
both cursors `null`, real `total`; rows always ascending regardless of direction.

## Threat Matrix

N/A — no routing (in the agent/command sense), shell, subprocess, VCS/PR automation,
executable-file classification, or process-integration boundary. The one adversarial surface is
SQL identifier injection, already answered by the design: identifiers come only from
`ResolvedSchema`, cursor values are bound parameters, and `limit` is an allowlisted literal.

## Migration / Rollout

No migration. Purely additive to one read handler: a client sending no params gets page one, so an
older Studio build keeps working against a newer server.

## Open Questions

None.
