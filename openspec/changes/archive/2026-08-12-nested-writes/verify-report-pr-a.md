# Verify Report: nested-writes — PR A (Metadata + Atomicity Plumbing)

**Scope**: PR A only (8 tasks: RelationMeta.fkSide/optional/optionalFk, ModelMeta.name,
typed nested-relation input unions, `runAtomic` seam threaded through
`__delegates`/`$transaction`). PR B (create planner) and PR C (update planner) are
NOT implemented — intentionally out of scope, confirmed unchanged (`[ ]` in tasks.md).

## Completeness — Tasks

| Task | Status | Evidence |
|---|---|---|
| A1.1 RED nested-write-emission.mjs | [x] | file exists, asserts fkSide/optional/optionalFk/name |
| A1.2 GREEN generator/src/client.ts emits fields | [x] | `RelationInfo.fkSide/optionalFk`, `relationMetaEntry` verified in source |
| A2.1 RED typecheck-fixture.ts typed relation members | [x] | fixture has `author`/`posts` members, `@ts-expect-error` cases |
| A2.2 GREEN types.ts input unions + RunAtomic | [x] | `ToOneRelationInput`/`ToManyRelationInput`(+Update) present, generator references them |
| A3.1 RED runAtomic default/override unit test | [x] | `atomicity.mjs` present, 4 checks pass |
| A3.2 GREEN delegate.ts ctor + client.ts wiring | [x] | `RunAtomic` type, 4th ctor param, `__delegates(exec, realtime, runAtomic?)`, generated `$transaction` omits 3rd arg |
| A4.1 GREEN index.ts exports | [x] | `export type { SiblingRegistry, RunAtomic }` present |
| A4.2 Scalar-only SQL byte-identical | [x] | `relations.mjs` test 3.9 passing; full client suite green |

8/8 PR A tasks complete and verified against actual source (not just tasks.md checkmarks).
Note: this work is currently uncommitted (working tree changes vs. `main`) — commit/PR creation
was not part of this verify scope.

## Runtime Evidence

| Command | Result |
|---|---|
| `pnpm build --force` | PASS — all 10 packages, incl. `@indigodb/generator`, `@indigodb/client` |
| `pnpm lint` (tsc --noEmit per package) | PASS — 18/18 tasks green |
| `pnpm test --force` | PASS — 16/16 package test tasks green, no `not ok`/failures |
| `pnpm --filter @indigodb/generator test` | PASS — incl. new `nested-write-emission.mjs` (9 assertions) |
| `pnpm --filter @indigodb/client test` | PASS — incl. new `atomicity.mjs` (4 assertions) and `relations.mjs` 3.9 (SQL parity) |

## Spec Compliance Matrix (PR A-relevant deltas only)

### client-query-type-safety (ADDED)

| Requirement/Scenario | Status | Covering Test |
|---|---|---|
| CreateInput/UpdateInput typed relation members (to-one union) | PASS | typecheck-fixture.ts `author`/`posts` members + `typecheck.mjs` |
| ...to-many array-form union | PASS | typecheck-fixture.ts `posts?: ToManyRelationInput<...>` |
| Composite-key relation omitted from union | PASS | `relation-emission.mjs` composite-key assertions (pre-existing pattern, still enforced) |
| `__meta.relations[<name>].optional` reflects nullable FK | PASS | `nested-write-emission.mjs` required=false/optional=true cases |

### client-transactions (ADDED)

| Requirement/Scenario | Status | Covering Test |
|---|---|---|
| Nested writes reuse in-flight session via runAtomic seam | PASS (plumbing only; planner not yet built) | `atomicity.mjs`: default identity, explicit override, real top-level thunk |
| Top-level nested create opens exactly one transaction | PARTIAL — seam proven, no planner yet to invoke it end-to-end | `atomicity.mjs` "top-level real thunk" case proves the shape; full E2E nested-create scenario belongs to PR B |
| Nested create inside active $transaction joins session, no double-open | PARTIAL — seam proven at unit level (`runAtomic` defaults to identity inside `$transaction`); no planner yet | `atomicity.mjs` default-identity case |

Both client-transactions scenarios are written against the FULL nested-write feature
(parent + relation ops via `create()`/`update()`), which is PR B/C scope. PR A correctly
proves only the underlying seam is wired correctly and inert until PR B/C's planner calls it.
This matches the tasks.md/apply-progress.md framing ("no planner logic"). Not a PR A defect.

## Correctness Notes

- `resolveRelationInfo` FK-owner-column lookup correctly branches on `rel.inverse` to find the
  physical FK column on the right table, defaulting `optionalFk: true` (conservative/safe) when
  unresolvable (composite relations).
- `relationInputType()` correctly restricts `disconnect`/`set` on update to `optionalFk` cases only,
  matching spec Requirement 4 (required to-one has no disconnect/set member) — verified via
  `@ts-expect-error` in the fixture.
- Generated `$transaction` deliberately omits the `runAtomic` 3rd arg to `__delegates`, defaulting
  nested delegates to identity — prevents double-open, matches client-transactions ADDED delta.

## Design Coherence

- `RunAtomic` placed in `delegate.ts` instead of `types.ts` (documented deviation, avoids
  type-only circular import) — WARNING-level, non-blocking, still exported from `index.ts` barrel
  exactly as designed.
- Generated constructor cast `(fn) => this.$transaction(fn as never)` — documented scoped cast for
  a structural mismatch between `SiblingRegistry` and `TransactionClient`; inline comment present
  in generated code. WARNING-level, non-blocking.

## Issues

### CRITICAL
None.

### WARNING
1. Pre-existing, already-tracked, OUT OF SCOPE: generated `IndigoClient.$transaction` override
   has a TS2416 base-signature incompatibility (Engram id 533, confirmed via `git stash` to predate
   this change). Did not resurface in `pnpm build`/`pnpm lint` (those don't run a full generated-client
   `tsc --noEmit`, matching how apply-progress originally surfaced it — an ad hoc check, not a
   committed test). No action required for PR A; tracked separately.
2. `RunAtomic` location deviates from design.md's File Changes table (documented, low-risk).

### SUGGESTION
1. PR A's changes are currently uncommitted on the working tree — no commit/PR exists yet for this
   slice. Recommend committing PR A before starting PR B so the chained-PR boundary (stacked-to-main)
   is real, not just planned.

## Verdict

**PASS WITH WARNINGS** — PR A's 8 tasks are complete, verified live against source (not just
task-list claims), build/lint/test all green, and both PR-A-relevant spec deltas are satisfied
at the plumbing level with real runtime test coverage. The two client-transactions scenarios that
describe full nested-write behavior are correctly deferred to PR B/C (by design) and are not a PR A
gap. No CRITICAL issues. One pre-existing, already-tracked, non-blocking WARNING and one documented
design deviation.
