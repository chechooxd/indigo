# Design: `@@allow` → Postgres Row-Level Security

Verified live against `main` @ `c019bc3`: `rules.rs:58-96` (`ArgShape` / `ATTRIBUTE_RULES`,
`@@realtime` is `(Model, "realtime", ArgShape::None)`), `ast.rs:19-28` (`AttributeValue`,
`#[serde(tag="kind", rename_all="lowercase")]`) mirrored by `packages/ast/src/index.ts:36-42`,
`lexer.rs:42-43` (`=` is `Equals`; **no `==` token exists**), `parser.rs:290-299`
(`parse_attribute_arg`) and `347-366` (`parse_function_call_or_reference` — bare identifier
only, **no dotted paths**), `validate.rs:74-84` (the `@@realtime` model-level check to sit
beside), `ir.rs:141-158` (`ResolvedTable`, `realtime` last-but-two),
`postgres.ts:37-61` (`mapScalarToPg`), `128-151` (`renderColumn`'s type chain), `277-289`
(`renderCreateTrigger` DROP+CREATE pattern), `295-337` (`renderPushSql`'s 5 numbered blocks),
`migrate.ts:349-358` / `763-765` (realtime create/toggle), `client.ts:195-236`
(`$withSession` owns BEGIN/COMMIT via `txHook`), `generator/src/client.ts:461-482`
(generated `$transaction` = `$withSession` + `__delegates(exec, …)`).

## Technical Approach

Same closed-whitelist extension used by `native-type-attributes` and `named-typed-indexes`:
one row in `ATTRIBUTE_RULES`, a bespoke `ArgShape`, hard diagnostics in `validate.rs`, one
resolve pass into the IR, migrator/client read the IR. Unlike those changes this one **does**
need lexer + parser work: `==` is not a token and `this.ownerId` is not parseable today.

    @@allow(read, auth.userId == this.ownerId)
      │ lexer: new EqEq token   parser: dotted Path + arg-level Comparison
      ▼
    AttributeValue::Comparison{ op:"==", left:Path["auth","userId"], right:Path["this","ownerId"] }
      │ validate.rs::validate_allow  (6 hard rejects — see table)   ← PR A stops here
      ▼
    resolve.rs  ──> ResolvedTable.allow: [ AllowRule{ action:Read, left:Claim, right:Field("ownerId") } ]
      │
      ├── postgres.ts  renderRlsBlock(table)  ─> ENABLE+FORCE RLS, prune, DROP+CREATE POLICY
      ├── migrate.ts   diffPolicies(prev,next) ─> DROP/CREATE POLICY, ENABLE/DISABLE toggle
      └── client.ts    $auth({userId}, fn)     ─> $withSession + set_config('app.user_id', $1, true)

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| 1 | `==` token | New `RawToken::EqEq` `#[token("==")]` + `TokenKind::EqEq`, `describe()` → `"'=='"` | reuse two `Equals`; a `Comparison` keyword | logos is longest-match, so `==` wins over `=` deterministically. No existing production has two adjacent `=`, so every fixture is byte-stable |
| 2 | Where comparison parses | At **arg level** in `parse_attribute_arg`: parse a value, then if `at(EqEq)` consume and wrap. Generic — any attribute *parses* it, only `@@allow` *accepts* it | attribute-specific parse context; a full expression grammar | Same grain as named args (`parser.rs` accepts `ident:` for every attribute; `rules.rs` decides legality). Keeps the parser context-free and puts the whole accept surface in one reviewable table |
| 3 | Dotted paths | New `AttributeValue::Path { segments }` (kind `"path"`), produced by `parse_function_call_or_reference` when a `Dot` follows the identifier | reuse `Reference{value:"this.ownerId"}` with a string split | A string carrying structure re-invites the accept/reject divergence `rules.rs` exists to kill. Cost: `@map(a.b)` now parses and is rejected in validate instead of at the Dot — an acceptable, tested diagnostic move |
| 4 | AST mirror | Both new variants added to `packages/ast/src/index.ts` `AttributeValue` in the same PR as `ast.rs` | Rust-only | serde attrs ARE the JSON contract (CLAUDE.md); the parity harness deep-equals AST JSON |
| 5 | Action arg form | `ArgShape::Allow`: positional 0 is a bare reference (`read`) **or** a reference array (`[create, update]`); positional 1 is the comparison. `write`/`all` expand in `resolve.rs` | ZenStack's comma-in-a-string `@@allow('create,update', …)`; variadic positionals | Arrays and bare references already parse (`as_reference_list` handles both), so no third grammar. Variadic positionals make arity checking guesswork |
| 6 | Alias expansion site | `resolve.rs` expands `write`→create,update,delete and `all`→all four into one `AllowRule` per canonical action, preserving declaration order | keep the alias in the IR | Consumers stay dumb: the migrator never learns a vocabulary. Mirrors `action_sql`'s "compiler hands SQL-ready values" rule |
| 7 | IR operand form | `AllowOperand::Field` carries the **physical `dbName`**, not the logical field name | logical name + migrator lookup | Consistent with `ForeignKey.columns` / `ResolvedIndex.columns`; `migrate.ts::remapPhysicalNames` then remaps allow rules for free on a `@map` rename |
| 8 | Cast derivation | The migrator derives the cast from the referenced **column's SQL type** via a new `columnSqlType(column)` extracted from `renderColumn:131-141`; compiler emits no cast text | compiler emits `"::int"`; hardcode `::int` | `@db.Uuid`/`@db.VarChar` change the physical type without changing the scalar type. Extracting the existing chain means the cast can never disagree with the column DDL |
| 9 | `auth.<claim>` vs literal | Hard reject in slice 1 (`auth.userId == "42"`) | permit as a text comparison | Decision 9 (Engram #695) states the cast rule is total only because the claim is always compared to a field. Rejecting keeps that invariant provable instead of documented |
| 10 | Constant predicate | Hard reject when **both** operands are literals (`true == true`) | permit | An always-true policy is an authorization bypass that reads like a rule. Silence is the failure mode this project systematically kills |
| 11 | Policy naming | `indigo_p_<dbName>_<action>_<ordinal>`, ordinal = the rule's index among that table's rules for that action | hash of the condition | Readable in `pg_policies` and derivable from the IR alone. Cost: removing rule 0 renumbers rule 1 into a DROP+CREATE — DDL-only churn, no data effect. `MAX_IDENTIFIER_BYTES` (63) is validated at compile time, since Postgres silently truncates |
| 12 | Command mapping | read→`FOR SELECT USING`, delete→`FOR DELETE USING`, create→`FOR INSERT WITH CHECK` (**no** `USING` — Postgres forbids it), update→`FOR UPDATE USING (…) WITH CHECK (…)` from the same condition | one `USING` shape for all four | `WITH CHECK` on UPDATE is what stops a row being updated *out of* the caller's ownership; omitting it makes the update policy half-enforced |
| 13 | Push idempotency | Per table: `ALTER TABLE … ENABLE/FORCE ROW LEVEL SECURITY` (both no-ops when already set, so no `DO` guard), then a `DO $$` prune loop dropping `pg_policies` rows matching `indigo\_p\_<table>\_%` that are not in the current name set, then `DROP POLICY IF EXISTS` + `CREATE POLICY` per rule | create-only; drop-all-then-create | Rule *count* can shrink, so stale ordinals must be pruned or push stops converging. Mirrors `renderPushSql`'s block 5, which already drops triggers for no-longer-realtime tables. Tables with no rules get the prune + `DISABLE`/`NO FORCE` |
| 14 | Versioned diff | `migrate.ts` compares prev/next policy `(name, definition)` sets — both sides known from the IR, so plain `DROP POLICY IF EXISTS` / `CREATE POLICY`, no catalog query. Classified `safe()` | destructive classification | No policy statement touches data. Adding a policy widens access; dropping the last one leaves RLS on and denies by default — the safe direction |
| 15 | `$auth` transport | `SELECT set_config('app.user_id', $1, true)` | `SET LOCAL app.user_id = $1` | **`SET` does not accept bind parameters.** `set_config(..., is_local=true)` is the parameterized equivalent, so the user id is never string-interpolated into SQL |
| 16 | `$auth` shape | Callback form on `IndigoClientBase` built on `$withSession`; the generator emits a typed `$auth` override next to `$transaction` (`generator/src/client.ts:461-482`) | a scoped client object returned by `$auth({…})` | `$withSession` already owns BEGIN/COMMIT and the nesting guard, so `SET LOCAL` dies at COMMIT/ROLLBACK — the pooled-identity-leak mitigation is structural, not a convention. A returned scoped client would have to pin a session across arbitrary awaits |
| 17 | PGlite enforcement tests | Run assertions under `SET ROLE` to a purpose-created `NOLOGIN` non-superuser | assert as PGlite's default role | PGlite's default role is a superuser and **superusers bypass RLS even with `FORCE`** — testing as-is would assert nothing. See Risks |

## Interfaces

```rust
// ast.rs — two new variants; packages/ast/src/index.ts mirrors both
Path { segments: Vec<String> },                                        // kind "path"
Comparison { op: String, left: Box<AttributeValue>, right: Box<AttributeValue> }, // kind "comparison"

// rules.rs
ArgShape::Allow,                                            // (Model, "allow", ArgShape::Allow)
pub const ALLOW_ACTIONS: [&str; 4] = ["create", "read", "update", "delete"];
pub const ALLOW_ALIASES: [(&str, &[&str]); 2] =
    [("write", &["create", "update", "delete"]), ("all", &ALLOW_ACTIONS)];
pub const AUTH_CLAIMS: [&str; 1] = ["userId"];              // closed, one member (decision 9)
pub const AUTH_SETTING: &str = "app.user_id";

// ir.rs — ResolvedTable gains ONE field, declared LAST (after `group`) and omitted when
// absent, so every existing fixture snapshot stays byte-identical.
#[serde(skip_serializing_if = "Option::is_none", default)] pub allow: Option<Vec<AllowRule>>,

#[serde(rename_all = "camelCase")] pub struct AllowRule { action: AllowAction, left: AllowOperand, right: AllowOperand }
#[serde(rename_all = "lowercase")] pub enum AllowAction { Create, Read, Update, Delete }
#[serde(tag = "kind", rename_all = "camelCase")] pub enum AllowOperand {
    Field { name: String },   // physical dbName (decision 7)
    Claim { name: String },   // always "userId" in slice 1
    String { value: String }, Number { value: f64 }, Boolean { value: bool },
}
```

```ts
// packages/migrator/src/postgres.ts — exported so migrate.ts reuses them (decision 8/11)
export function columnSqlType(column: ResolvedColumn): string;            // extracted from renderColumn
export function policyName(table: ResolvedTable, rule: AllowRule, ordinal: number): string;
export function renderPolicy(table: ResolvedTable, rule: AllowRule, ordinal: number): string;
export function renderRlsBlock(table: ResolvedTable): string[];           // enable/force + prune + policies
export function renderDisableRls(table: ResolvedTable): string[];         // prune + disable/no force

// packages/client/src/client.ts
protected async $auth<T>(ctx: { userId: string | number }, fn: (exec: Executor) => Promise<T>): Promise<T>;
```

Emitted shape for `model Post { ownerId Int … @@allow(read, auth.userId == this.ownerId) }`:

```sql
ALTER TABLE "Post" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Post" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "indigo_p_Post_read_0" ON "Post";
CREATE POLICY "indigo_p_Post_read_0" ON "Post" AS PERMISSIVE FOR SELECT
  USING (current_setting('app.user_id', true)::integer = "ownerId");
```

`current_setting(…, true)` returns NULL when unset ⇒ the predicate is NULL ⇒ not true ⇒ deny.
Operand order in SQL follows declaration order; the compiler never normalizes sides.

## Diagnostics (`validate.rs::validate_allow`, all `model: Some(..)`, `field: None`)

`ValidationError` carries `model`/`field`, **not** line/column — "located" in this repo means
model-scoped, matching every existing Phase-3 message.

| Case | Message |
|---|---|
| wrong arity / arg 1 not a comparison | `Attribute "@@allow" on model "Post" requires an action and a single equality condition.` |
| non-`==` operator | `Unsupported operator "!=" in @@allow on model "Post". Only "==" is supported.` |
| unknown action | `Invalid @@allow action "select" on model "Post". Allowed: create, read, update, delete, write, all.` |
| unknown claim (decision 9) | `Unknown auth claim "role" in @@allow on model "Post". Only auth.userId is supported.` |
| bad path root / arity | `Invalid path "post.ownerId" in @@allow on model "Post". Each side must be this.<field>, auth.userId or a literal.` |
| unknown / non-scalar field | `@@allow references unknown or non-scalar field "owner" on model "Post".` |
| claim vs literal (decision 9) | `auth.userId in @@allow on model "Post" must be compared against a this.<field> reference.` |
| constant predicate (decision 10) | `@@allow condition on model "Post" references neither a field nor auth.userId.` |
| policy name > 63 bytes | `Generated policy name for model "Post" exceeds 63 bytes; shorten the model or @@map name.` |
| `@@realtime` + `@@allow` | `Model "Post" cannot be both @@realtime and @@allow — realtime fan-out has no row-level filter yet.` |

## File Changes

| File | PR | Action | Description |
|---|---|---|---|
| `crates/indigo-compiler/src/lexer.rs` | A | Modify | `EqEq` raw token + `TokenKind` + `describe()` |
| `crates/indigo-compiler/src/ast.rs` | A | Modify | `Path`, `Comparison` variants + serde tests |
| `packages/ast/src/index.ts` | A | Modify | mirror both variants on `AttributeValue` |
| `crates/indigo-compiler/src/parser.rs` | A | Modify | dotted path in `parse_function_call_or_reference`; `EqEq` wrap in `parse_attribute_arg` |
| `crates/indigo-compiler/src/rules.rs` | A | Modify | `ArgShape::Allow`, `ATTRIBUTE_RULES` row, `ALLOW_ACTIONS`/`ALLOW_ALIASES`/`AUTH_CLAIMS`/`AUTH_SETTING` + unit tests |
| `crates/indigo-compiler/src/validate.rs` | A | Modify | `validate_allow` + the `@@realtime` conflict beside `validate.rs:75` |
| `fixtures/18-allow-rules.indigo` / `19-rejected-allow.indigo` + snapshots | A | Create | accepted forms (IR shows **no** `allow` yet) and one instance per rejection class |
| `crates/indigo-compiler/src/{resolve,ir}.rs` | B | Modify | alias expansion, operand resolution to `dbName`, `ResolvedTable.allow` |
| `packages/core/src/ir.ts` | B | Modify | `AllowRule`/`AllowAction`/`AllowOperand` + `ResolvedTable.allow?` |
| `fixtures/snapshots/18-*.json` | B | Modify | regenerated — now carries `allow` |
| `packages/compiler/wasm/*` | A, B | Modify | rebuilt + committed (CI is byte authority) |
| `packages/migrator/src/postgres.ts` | C | Modify | `columnSqlType`, `policyName`, `renderPolicy`, `renderRlsBlock`, `renderDisableRls`; new block 6 in `renderPushSql` |
| `packages/migrator/src/migrate.ts` | C | Modify | policies in `createTable`, `diffPolicies` in `diffTable`, remap on rename |
| `packages/client/src/client.ts` | C | Modify | `$auth` on `IndigoClientBase` |
| `packages/generator/src/client.ts` | C | Modify | typed `$auth` override beside `$transaction` (**not in the proposal's affected areas — added here**) |
| `packages/migrator/test/{fixtures,pg-harness.mjs}` | C | Modify | policy goldens + non-superuser `SET ROLE` enforcement helper |

## Testing Strategy

| Layer | What | How |
|---|---|---|
| Rust unit | `EqEq` lexes over `=`; dotted path node; comparison at arg level | `lexer.rs`/`parser.rs` `#[cfg(test)]` |
| Rust unit | every diagnostic in the table fires exactly once; accepted forms produce zero | `validate.rs` `#[cfg(test)]`, shape of the `db_namespace_*` tests |
| Rust unit | `write`/`all` expand to the right canonical set in declaration order; `Field` carries `dbName` under `@map`; `allow` omitted when absent | `resolve.rs` + `ir.rs` `#[cfg(test)]` |
| Rust corpus | all 19 fixtures compile; 01–17 gain zero new diagnostics | `crates/indigo-compiler/tests/fixtures.rs` |
| TS parity | AST + `ResolvedSchema` vs goldens; **01–17 byte-identical** | `packages/compiler/test/parity.mjs` |
| Migrator golden | allow-added / allow-removed / rule-added / rule-reordered / action-changed / `@map`-renamed-owner-column | `packages/migrator/test/migrator.mjs` + `regen-goldens.mjs` |
| Migrator unit | INSERT policy has `WITH CHECK` and no `USING`; UPDATE has both; `@db.Uuid` owner emits `::UUID`, `Int` emits `::integer` | assertions in the migrator harness |
| PGlite E2E | under `SET ROLE app`: `$auth({userId})` sees only owned rows; a different id sees none; **no** `$auth` sees none; two permissive read rules OR; a recycled session carries no prior identity | `packages/migrator/test/pg-harness.mjs` |

## Threat Matrix

No routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary — those rows are `N/A`. Three input rows are applicable and are
design requirements:

| Row | Applicable | Safe behavior | RED test |
|---|---|---|---|
| SQL injection via the auth value | Yes | bound as `$1` to `set_config`, never interpolated (decision 15) | `$auth({userId: "1'; DROP TABLE …"})` leaves the table intact |
| SQL injection via schema-authored identifiers/literals | Yes | field sides go through `quoteIdent`; string literals through `escapeLiteral`; policy names validated ≤63 bytes and derived, never user-free-form | a fixture with a quote-bearing `@map` name and a quote-bearing string literal |
| Privilege bypass (authorization) | Yes | `FORCE ROW LEVEL SECURITY` on every RLS table; missing context ⇒ NULL predicate ⇒ deny; constant predicates rejected at compile time (decision 10) | the PGlite deny-by-default and no-`$auth` cases above |

## Migration / Rollout

Additive: a schema with no `@@allow` emits byte-identical DDL, so existing deployments gain
nothing and lose nothing. Per-slice toolchain order, mandatory (CLAUDE.md):
`cd crates && cargo test` → `pnpm --filter @indigodb/compiler build:wasm` (**commit the
artifact**) → `node packages/compiler/test/regen-snapshots.mjs` (the diff is the review
artifact; 01–17 must show **no** diff) → `node packages/migrator/test/regen-goldens.mjs`
(PR C) → `pnpm build && pnpm lint && pnpm test` → push and let CI's `wasm-drift` job self-heal
`main`. **Never hand-compare local WASM bytes against the committed artifact** — identical
toolchains produce different bytes on different host OSes; CI is the byte authority.
Rollback = per-slice `git revert` + rerun the same sequence; already-applied migrations need a
manual `DROP POLICY` / `DISABLE ROW LEVEL SECURITY`, and no data changes either way.

## Slice Plan

Three chained PRs (Feature Branch Chain: B targets A, C targets B). Goldens and WASM are
excluded from authored risk.

- **PR A — grammar + validation.** lexer/parser/AST (+ `packages/ast`), `rules.rs`,
  `validate.rs`, fixtures 18/19, WASM. IR deliberately **not** populated, so no consumer can
  start emitting half-enforced policies. ≈ 320 authored lines.
- **PR B — resolve + IR.** alias expansion, `ResolvedTable.allow`, `ir.ts`, snapshot 18 regen.
  ≈ 140 lines.
- **PR C — DDL + diff + client.** `postgres.ts`, `migrate.ts`, `$auth`, generator override,
  migrator goldens, PGlite enforcement suite. ≈ 380 lines.

`400-line budget risk: High` as one PR, `Low` per slice. `Chained PRs recommended: Yes`.

## Risks (design-level, beyond the proposal's)

| Risk | Mitigation |
|---|---|
| **PGlite's default role is a superuser, and superusers bypass RLS even with `FORCE`** — the enforcement suite would silently assert nothing | Decision 17: every enforcement assertion runs under `SET ROLE` to a `NOLOGIN` non-superuser created in the harness. **PR C must begin with a spike confirming PGlite supports `CREATE ROLE`/`SET ROLE`**; if it does not, the enforcement tests need a Docker Postgres service and PR C's scope grows |
| `packages/generator` was not in the proposal's affected areas, but a `$auth` that cannot hand typed delegates is unusable | Decision 16 adds a ~12-line generator override mirroring `$transaction`; flagged for the tasks phase |
| Adding `Path`/`Comparison` to `AttributeValue` widens a shared union that `apps/studio` also consumes | Studio reads the IR through `schema-adapter.ts`, not raw `AttributeValue`; `tsc --noEmit` across the workspace is the guard |

## Open Questions

- [ ] Non-blocking: decision 5 reads "comma-combinable" as a reference **array**
      (`@@allow([create, update], …)`). If the intended surface was ZenStack's
      `@@allow('create,update', …)` string, only `ArgShape::Allow`'s arg-0 branch changes.
- [ ] Non-blocking: policy ordinals (decision 11) churn on rule removal. A content hash would
      be stable but unreadable in `pg_policies`; revisit if operators complain.
