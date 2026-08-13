# Proposal: Client Query Extension Seam

## Intent

`@indigodb/client` has no public way to observe or wrap query execution. The only lifecycle
interposition today is the private `wrapLog` (`packages/client/src/client.ts:114-125`), a
single-purpose boolean logger. Users who need timing/OpenTelemetry spans, slow-query logs, or
per-query metadata must fork the client or hand-wrap `db.exec` (which loses transaction-scoped
executors, since `$withSession` re-wraps its own). This is roadmap Phase 2 epic 5 — the smallest,
dependency-free slice, and it validates the composition pattern before the larger query-surface epics.

## Scope

### In Scope
- Public `QueryExtension` type in `packages/client/src/types.ts`, composing around the existing
  `Executor` (`next => Executor`), same shape `wrapLog` already uses.
- `IndigoClientOptions.extensions?: QueryExtension[]`; composed once in `IndigoClientBase`,
  applied to `this.exec` AND every session executor from `$withSession` (so `$transaction` and
  `$queryRaw` are covered identically).
- A `QueryContext` (`model`, `operation`) propagated from `ModelDelegate` via `AsyncLocalStorage`,
  so an extension sees more than raw SQL. `undefined` for `$queryRaw`/internal statements.
- Error path: extensions observe rejections; a throwing extension fails the query, unwrapped.
- Runtime tests in the existing PGlite harness (`packages/client/test/`).

### Out of Scope
- Where-clause rewriting APIs (soft delete, tenant scoping as *declarative* filters) — needs the
  recursive `WhereInput` from epic 1 (`client-where-composition`).
- Result-set transformation / model-method extensions (Prisma `$extends` `model`/`result`).
- Batch/aggregate, type-honesty, native-type-attribute work (separate changes).

## Capabilities

### New Capabilities
- `client-query-extensions`: user-supplied middleware composing around the query `Executor`, with
  per-query context, ordering, transaction coverage, and error semantics.

### Modified Capabilities
- `client-executor-injection`: `this.exec` and session executors gain extension composition around
  the injected/pool executor; all existing requirements must remain unchanged when `extensions` is absent.

## Approach

Formalize `wrapLog`, do not replace it. `Executor` stays the seam; `QueryExtension = (next: Executor)
=> Executor`. Compose right-to-left so `extensions[0]` is outermost (first to see the call, last to see
the result), with `wrapLog` innermost so logs reflect the SQL actually executed. Context comes from an
`AsyncLocalStorage` set once per delegate method, not from threading a parameter through ~10 `this.exec`
call sites.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/client/src/types.ts` | Modified | `QueryExtension`, `QueryContext` types |
| `packages/client/src/client.ts` | Modified | `extensions` option, compose helper, `$withSession` wrapping |
| `packages/client/src/delegate.ts` | Modified | Set context around delegate methods |
| `packages/client/test/` | New | Extension ordering/error/transaction tests |
| `packages/generator/src/client.ts` | None | Generated client passes options through unchanged |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Executor-level seam can't express soft delete/tenant scoping declaratively | High | Explicit non-goal; context makes SQL-level rewriting *possible*, epic 1 makes it *declarative* |
| `AsyncLocalStorage` context leaks across concurrent queries | Med | `.run()` per delegate call; concurrency test in harness |
| Composition order surprises | Med | Order fixed and specified; documented + tested |
| Perf overhead when no extensions given | Low | Skip composition entirely when array empty/absent |

## Rollback Plan

Revert the change: `extensions` is purely additive and off by default; `wrapLog` and `this.exec`
return to their current form. No schema, IR, WASM, or generated-output change, so no regeneration
or migration is involved.

## Dependencies

None. Independent of epics 1–4.

## Success Criteria

- [ ] An extension observes every query on both the `pg.Pool` and injected-executor paths.
- [ ] Extensions apply inside `$transaction`/`$withSession` and to `$queryRaw`.
- [ ] Extension receives `model`/`operation` context for delegate-issued queries.
- [ ] A timing/slow-query extension is demonstrated end-to-end in tests without forking the client.
- [ ] Zero behavior change when `extensions` is absent (existing suites green).

## Proposal question round

Direct questioning is unavailable in this executor context. These shape the spec; assumptions used
are stated so they can be corrected before `sdd-spec`.

1. Soft deletes / tenant scoping were named as target concerns, but the `Executor` boundary sees only
   SQL text + params. **Assumption**: this slice ships the seam plus context (enabling manual SQL-level
   rewriting), and declarative filter injection is deferred to epic 1. Correct?
2. Should an extension be allowed to *modify* `sql`/`params` and *short-circuit* (return rows without
   calling `next`, e.g. a cache)? **Assumption**: yes — it is a plain function, so both fall out for free
   and will be specified rather than blocked.
3. Should `extensions` be registrable after construction (`client.$use(ext)`) or constructor-only?
   **Assumption**: constructor-only, immutable — avoids mid-flight mutation semantics.
4. Does the existing `log: boolean` option get reimplemented as a built-in extension?
   **Assumption**: no — keep `wrapLog` as-is (innermost) to guarantee zero behavior change.
5. Should extension context include the generated model's `ModelMeta`, or just the model name string?
   **Assumption**: name + operation string only, keeping the public context surface minimal.
