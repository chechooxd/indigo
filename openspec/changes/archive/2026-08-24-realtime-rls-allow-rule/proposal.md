# Proposal: `@@allow` → Postgres Row-Level Security

Change: `realtime-rls-allow-rule` (Road to 1.0, Phase 4). First slice only, not the epic. Exploration: Engram #694; decisions: Engram #695.

## Intent

IndigoDB has no authorization surface at all — `@@allow`, RLS, and `POLICY` return zero matches across `crates/` and `packages/`. `RealtimeEngine` filters subscribers by table name only, so every subscriber to a `@@realtime` model sees every row. Authorization is the stated moat, and it must live in the schema and be enforced by Postgres, not by application code that a second client can bypass.

## Scope

### In Scope
- Model-level `@@allow(action, condition)` in `.indigo`.
- Closed action vocabulary `create|read|update|delete` (1:1 with INSERT/SELECT/UPDATE/DELETE), plus compiler-expanded sugar `write` = create,update,delete and `all`; comma-combinable.
- Condition grammar narrowed to a **single equality comparison**; each side is independently a `this.<field>` path, an `auth.<claim>` path, or a literal (string/number/bool). Anything else is a hard compiler error, never a silent wider parse.
- **Closed claim vocabulary: `auth.userId` is the only accepted claim in this slice.** `auth.<anything-else>` (e.g. `auth.role`) is a hard, located compiler error until a future slice deliberately opens the vocabulary.
- Multiple `@@allow` per action on one model are allowed; each compiles to its own `CREATE POLICY ... AS PERMISSIVE`.
- Hard rejection of `@@realtime` + `@@allow` on the same model (validation error, lifted by slice 2).
- IR field carrying resolved per-action rules (`crates/.../ir.rs` + `packages/core/src/ir.ts` mirror).
- DDL: `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + idempotent `CREATE POLICY` per rule per action in `db push`, and add/drop/alter policy in the versioned diff. The `current_setting(...)` cast is derived from the compared field's scalar type, never hardcoded.
- `@indigodb/client` `$auth({ userId })` binding via `SET LOCAL app.user_id` inside a transaction; policies read `current_setting('app.user_id')`.
- PGlite-harness tests asserting real enforcement (rows actually hidden), not just DDL text.

### Out of Scope
- WAL / logical replication / shape log — slice 2.
- Field-level and relation-level `@allow`.
- Boolean combinators (`&&`, `||`), `in`, relation traversal, function calls in conditions.
- Any auth claim beyond `auth.userId` (`auth.role`, `auth.tenantId`, …) and the open claim-bag `$auth({ userId, role, ... })` API it would require.
- JWT-claims binding; per-subscriber realtime row filtering (which is why `@@realtime` + `@@allow` is rejected, not silently permitted); Studio UI for policies.
- Boolean/`RESTRICTIVE` policy semantics — multi-rule combination is Postgres's native permissive OR, not IndigoDB logic.
- A Supabase-style migration-vs-runtime Postgres role split. IndigoDB has one role (`DATABASE_URL`); `FORCE ROW LEVEL SECURITY` covers owner-exemption without that architecture change. Possible future slice.

## Capabilities

### New Capabilities
- `model-allow-rules`: `@@allow` syntax, action vocabulary and alias expansion, condition grammar, closed `auth.userId`-only claim vocabulary, multi-rule-per-action support, `@@realtime` conflict rejection, rejection diagnostics, IR shape.
- `row-level-security-ddl`: enable-RLS + policy emission for push and versioned migrations, idempotency, ordering, diff completeness.
- `client-auth-context`: `$auth` API, mandatory transaction scoping, `SET LOCAL` (never `SET`) and pool-leak prevention.

### Modified Capabilities
- `attribute-validation`: whitelist gains `@@allow` with a new `ArgShape`; arity and argument-type checks extend to it.

## Approach

Extend the closed attribute whitelist at its single source of truth: one `(Model, "allow", ArgShape::…)` row in `crates/indigo-compiler/src/rules.rs`, read by both `resolve.rs` (emit) and `validate.rs` (reject) so accept and reject cannot diverge. `ast.rs`/`parser.rs` gain a minimal equality-expression node whose two operands are each a path (`this.<field>` / `auth.<claim>`) or a literal; `ir.rs` + `packages/core/src/ir.ts` mirror the resolved rules as an ordered list per action (serde attrs are the JSON contract). `validate.rs` owns the three hard rejects: non-conforming conditions, unknown `auth.<claim>` names (only `auth.userId` is whitelisted), and `@@realtime` co-declared with `@@allow`. `packages/migrator/src/postgres.ts` grows `renderEnableRls`/`renderPolicy` following the existing `renderCreateTrigger` DROP-IF-EXISTS-then-CREATE pattern; `migrate.ts` diffs policies. `packages/client` adds `$auth`, which opens a transaction and issues `SET LOCAL` before delegating.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `crates/indigo-compiler/src/rules.rs` | Modified | `@@allow` whitelist entry + arg shape |
| `crates/indigo-compiler/src/{ast,parser}.rs` | Modified | equality-condition node, narrow parse |
| `crates/indigo-compiler/src/{resolve,validate}.rs` | Modified | alias expansion, emit, hard rejects |
| `crates/indigo-compiler/src/ir.rs`, `packages/core/src/ir.ts` | Modified | resolved allow rules on the table IR |
| `packages/compiler/wasm/` | Modified | rebuilt artifact (CI is byte authority) |
| `packages/migrator/src/postgres.ts` | Modified | enable-RLS + `CREATE POLICY` |
| `packages/migrator/src/migrate.ts` | Modified | policy add/drop/alter diff |
| `packages/client/src/` | Modified | `$auth` + transaction-scoped `SET LOCAL` |
| `packages/compiler/test/`, `packages/migrator/test/` | Modified | goldens + PGlite enforcement tests |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Auth identity leaks across pooled connections | High | `SET LOCAL` only, inside a transaction; test asserts a recycled connection sees no prior identity |
| Queries outside `$auth` silently see everything | Med | Resolved: RLS-enabled + no matching policy = zero rows, native Postgres deny-by-default; `current_setting(..., true)` NULL path tested |
| Table owner / superuser bypasses RLS | Med | Resolved: emit `FORCE ROW LEVEL SECURITY` by default — IndigoDB has a single `DATABASE_URL` role, so the owner is the app role; superuser bypass documented |
| Narrow grammar locks in premature `.indigo` syntax | Med | Rules are additive; unsupported shapes error rather than parse |
| Existing deployments gain RLS and lose rows on upgrade | Med | RLS applies only to models that declare `@@allow` |
| Realtime fan-out leaks RLS-hidden rows | High | Resolved: `@@realtime` + `@@allow` on one model is a hard compiler error until slice 2 adds row-level realtime filtering |
| `auth.<claim>` vocabulary is undefined beyond `userId` | High | Resolved: fixed, closed vocabulary — `auth.userId` only, mapped to the single `app.user_id` setting; every other `auth.<claim>` is a hard compiler error. No open claim bag, no per-claim `SET LOCAL` key, no literal-compared-claim cast rule in this slice |

## Rollback Plan

1. Revert the `rules.rs` entry, AST/parse node, resolve/validate handling, IR fields; rebuild WASM and regenerate goldens.
2. Revert `postgres.ts`/`migrate.ts` policy rendering — no policy is emitted for schemas without `@@allow`.
3. Revert `$auth` (additive API, no existing call site changes).
4. Already-applied migrations need a manual `DROP POLICY` / `DISABLE ROW LEVEL SECURITY`; no data change occurs.

## Dependencies

- None beyond `main` @ `c019bc3`. Existing PGlite harness (`packages/migrator/test/pg-harness.mjs`) is sufficient — no new CI infra.

## Success Criteria

- [ ] `@@allow('read', auth.userId == this.ownerId)` compiles and emits enable-RLS + a SELECT policy
- [ ] `write` / `all` expand to the correct canonical action set
- [ ] Any non-equality condition fails compilation with a clear, located diagnostic
- [ ] Two `@@allow(read, ...)` rules on one model emit two permissive SELECT policies; a row matching either is visible
- [ ] `auth.role` (or any claim other than `auth.userId`) fails compilation with a clear, located diagnostic
- [ ] A model declaring both `@@realtime` and `@@allow` fails compilation with a located diagnostic
- [ ] A String/UUID owner key emits the correct cast, not `::int`
- [ ] Under PGlite, `$auth({ userId })` returns only owned rows; a different id returns none
- [ ] A query run without `$auth` does not see protected rows
- [ ] A second query on a recycled pooled connection carries no prior identity
- [ ] Adding/removing `@@allow` produces the correct versioned-migration diff
- [ ] `pnpm build`, `lint`, `test` and `cd crates && cargo test` green; WASM rebuilt and committed

## Proposal question round (executor could not ask interactively)

### Resolved

1. **RESOLVED — Unset `app.user_id` / no `$auth` context: deny-all, and it costs us nothing.**
   This is not a behavior IndigoDB has to implement: Postgres already gives it for free.
   A table with `ROW LEVEL SECURITY` enabled and no policy matching the current
   operation returns zero rows for that operation. With no `$auth` context the
   `USING` predicate cannot match, so the read yields nothing. Deny-by-default is
   native Postgres semantics, not IndigoDB logic. The spec fixes this as the
   contract and the PGlite harness asserts it (protected rows invisible without
   `$auth`); no error path, no extra DDL.

3. **RESOLVED — Yes, emit `FORCE ROW LEVEL SECURITY` by default.**
   Postgres exempts a table's *owner* from its own RLS policies. Supabase sidesteps
   this by running the runtime under a separate non-owner role, but IndigoDB today
   has exactly one Postgres role: the single `DATABASE_URL` connection string shared
   by migrations (`packages/cli`) and runtime (`packages/client`) alike — verified,
   there is no migration-vs-app role split anywhere in the codebase. So the owner
   *is* the app role, and without `FORCE`, RLS would be silently inert for every
   real query. `FORCE ROW LEVEL SECURITY` delivers the same safety guarantee without
   touching the connection/role model, which keeps a role split out of this slice.
   A future slice may introduce a Supabase-style dedicated runtime role as an
   alternative or complement; `FORCE` remains correct either way.

2. **RESOLVED — Derive the cast from the referenced field's scalar type.**
   `current_setting('app.user_id')::int` is not hardcoded. The compiler reads the
   scalar type of the `this.<field>` side of the equality and emits the matching
   cast, so String/UUID owner keys work without a schema-shape assumption. The
   same principle applies to every rule in the multi-rule case below.

4. **RESOLVED — Block `@@realtime` + `@@allow` on the same model (hard compiler error).**
   `RealtimeEngine` fans SSE events out by table name only; it has no row-level
   filter. A model that is both realtime and RLS-protected would push rows over
   the realtime channel that the RLS policy hides from a normal read — a silent
   authorization bypass, worse than either feature alone. So the combination is
   rejected at compile time in the same closed-whitelist validation layer
   (`crates/indigo-compiler/src/validate.rs`, alongside `rules.rs`) rather than
   emitted with a warning. The restriction lifts when the WAL/shape-log slice
   (slice 2) gives the realtime path row-level filtering.

5. **RESOLVED — Multiple `@@allow` for the same action are allowed; Postgres ORs them.**
   A model may declare more than one rule per action, e.g. an owner rule plus a
   public-visibility rule:

   ```
   model Post {
     ownerId  Int
     isPublic Boolean
     @@allow(read, auth.userId == this.ownerId)
     @@allow(read, this.isPublic == true)
   }
   ```

   > Earlier discussion used `@@allow(read, auth.role == 'admin')` to illustrate
   > the multi-rule/OR concept. That is **not valid slice-1 syntax** — see Q6.
   > An admin-sees-everything pattern must compare against a schema field in this
   > slice (e.g. `this.isPublic`, or an `isAdmin`-style column), not an auth claim.

   No combination logic in the compiler: each rule compiles to its own
   `CREATE POLICY ... AS PERMISSIVE` (Postgres's default policy type), and Postgres
   natively ORs multiple permissive policies for the same command. IndigoDB only
   has to emit stable, distinct policy names so the versioned diff can add/drop
   individual rules. This also generalizes the condition grammar: it is
   **one equality comparison, either side a `this.<field>` path, an `auth.<claim>`
   path, or a literal** — not the userId/ownerId shape specifically.

6. **RESOLVED — Fixed, closed claim vocabulary: `auth.userId` only (Option A).**
   Slice 1 accepts exactly one claim path, `auth.userId`, bound to the single
   `SET LOCAL app.user_id` setting that `$auth({ userId })` already implies. Every
   other `auth.<claim>` — `auth.role`, `auth.tenantId`, anything — is a **hard,
   located compiler error**, not a silent pass-through and not a runtime NULL.
   Rejected here rather than deferred, because an open claim bag would widen three
   contracts at once: the compiler's accept surface, the `SET LOCAL app.*` key
   namespace, and the `client-auth-context` API. None of them is needed to ship
   owner-scoped RLS, and each is cheaper to add later than to narrow later.
   Consequences: no cast rule is needed for claims compared against literals
   (the only claim is compared against a schema field, whose scalar type drives
   the cast per Q2); role/tenant-style rules must model the predicate as a schema
   field (`this.isPublic`, `this.isAdmin`, …) in this slice; and the `auth.role`
   example used earlier in discussion is illustrative-only and invalid syntax here.
   A future slice may open the vocabulary deliberately, with its own `$auth` shape.

### Still open

None. All six proposal questions are resolved; the proposal has **zero open questions**
and is ready for sdd-spec / sdd-design.
