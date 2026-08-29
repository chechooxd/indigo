# Proposal: Real row CRUD

## Intent

Studio's record inspector is hardcoded to a `users`-shaped schema: `RecordInspector.tsx`
hand-renders exactly `email` / `role` (fixed ADMIN|USER|MODERATOR) / `metadata`, all
`readOnly`, and `useRecordEditor.ts` holds only those three named strings. On any other
schema it renders empty inputs. Studio is the product's proof that IndigoDB is schema-first;
its one editing surface contradicts that. Everything else — Data Grid, Structure Specs — is
already generic via `schema-adapter.ts`. Make row editing generic and actually persist.

## Scope

### In Scope
- Writable transaction path in `packages/cli/src/studio-server.ts`, distinct from the
  read-only pool, with table/column identifier re-validation against `resolved.tables`.
- `POST` / `PATCH` / `DELETE` row routes keyed on `ResolvedTable.primaryKey` (composite-safe).
- `createRow` / `updateRow` / `deleteRow` in `apps/studio/src/lib/api.ts`, fail-soft pattern.
- Schema-driven widget map per `ResolvedColumn` (text, number, boolean, DateTime, enum from
  `ResolvedEnum.values`, JSON with parse validation, generated-PK read-only).
- Generic edit buffer + dirty tracking; row selection keyed by **PK value, not array index**.
- DELETE, gated by a confirmation dialog **and** the "Safe Updates" toggle wired as a real gate.
- PGlite-backed test harness for the new write routes (`strict_tdd: true`).

### Out of Scope
- **Sibling epic "Auth and production guardrails"**: session auth, environment badges,
  statement timeouts, row caps, query cancellation, audit logging. Only the Safe Updates
  toggle is wired here.
- **Sibling epic "Real pagination, filtering, sorting"**: keyset pagination, stable ORDER BY,
  total counts. PK-keyed selection here is write-target identity, not pagination.
- `@indigodb/client` `ModelDelegate` reuse (Studio is codegen-less by design).

**DELETE ships here** by explicit user decision: a write path is destructive-capable the
moment it exists, so the guard belongs with it, and blocking on full session auth would
delay the roadmap's stated pain point. Its blast radius is contained by its own slice,
confirmation dialog, and the Safe Updates gate.

## Capabilities

### New Capabilities
- `studio-row-writes`: writable transaction, identifier validation, PK-keyed INSERT/UPDATE/DELETE.
- `studio-record-editor`: schema-driven inspector and create form from the resolved IR.
- `studio-write-guards`: Safe Updates toggle as an enforced gate + destructive confirmation.

### Modified Capabilities
- `studio-readonly-queries`: read-only guard scope restated; write routes MUST NOT share it.
- `studio-ui-honesty`: "write actions disabled unconditionally" becomes conditional on a
  real backend and the Safe Updates gate.
- `studio-server-tests`: write-route coverage.
- `studio-ui-tests`: schema-driven editor coverage.

## Approach

One coherent design, chained delivery (`delivery_strategy: auto-chain`, budget 800 lines):
(a) write-transaction infra + identifier validation + UPDATE + widget map; (b) INSERT
("Add Record"); (c) DELETE behind confirmation + Safe Updates. Slice (a) fixes the stated
defect at the smallest safe increment; (b) and (c) reuse its plumbing.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/cli/src/studio-server.ts` | Modified | Write transaction, 3 routes, validation |
| `apps/studio/src/lib/api.ts` | Modified | Three write functions |
| `.../browser/components/RecordInspector.tsx` | Modified | Rewritten data-driven |
| `.../browser/hooks/useRecordEditor.ts` | Modified | Generic buffer, PK selection |
| `.../browser/TableBrowserPage.tsx` | Modified | Sync effect, Add/Delete wiring |
| `.../settings/hooks/useSettingsForm.ts` + `QueryGuardsCard.tsx` | Modified | Real toggle |
| `packages/cli/test/` | New | PGlite write-route harness |
| `packages/core/src/ir.ts` | Unchanged | `primaryKey` / `isPk` already sufficient |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| SQL injection via identifiers from URL/body | Med | Validate against `resolved.tables`/`columns` before building SQL; values always parameterized |
| Index-based row selection breaks under sibling pagination epic | High | Select by PK value from slice (a) |
| Unguarded DELETE against real data at localhost | Med | Own slice, confirmation dialog, Safe Updates gate, existing loopback/Host check |
| No write test harness exists (`strict_tdd`) | High | Build PGlite `StudioDb` harness first in slice (a) |
| Composite / generated PKs mishandled | Med | Drive `WHERE` from `table.primaryKey`; explicit composite fixtures |
| Aggregate size exceeds review budget | Med | Three chained PRs decided at `sdd-tasks` |

## Rollback Plan

Per slice: revert its PR. The write routes are additive — reverting `studio-server.ts` and
`api.ts` restores the read-only-only server; reverting the UI restores the disabled
inspector. No schema, IR, migration, or data-format change, so nothing to un-migrate.
Emergency partial rollback: flip Safe Updates to disallow writes without reverting code.

## Dependencies

- None external. `ResolvedTable.primaryKey` / `ResolvedColumn.isPk` already exist.
- Soft: coordinate row-identity primitive with "Real pagination, filtering, sorting".

## Success Criteria

- [x] Record inspector renders correct widgets for any `.indigo` schema, zero hardcoded names.
- [x] UPDATE, INSERT, DELETE persist to Postgres and survive a refresh.
- [x] Write routes reject unknown table/column identifiers and never use the read-only pool.
- [x] Rows are identified by PK value; composite PKs work.
- [x] DELETE is impossible without confirmation and Safe Updates disabled (both required).
- [x] Write routes covered by the new PGlite harness; `pnpm build|lint|test` green.
