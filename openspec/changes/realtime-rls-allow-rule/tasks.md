# Tasks: `@@allow` → Postgres Row-Level Security

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~320 (A) + ~140 (B) + ~380 (C) ≈ 840 total, authored risk excludes WASM/goldens |
| 400-line budget risk | High as one PR, Low per slice |
| Chained PRs recommended | Yes |
| Suggested split | PR A → PR B → PR C |
| Delivery strategy | Feature Branch Chain (per design) |
| Chain strategy | feature-branch-chain |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|----|----|------------------|--------------------|
| 1 | Grammar + validation, IR untouched | A (base=tracker) | `cd crates && cargo test` | `node packages/compiler/test/parity.mjs` | Revert PR A only; no consumer reads the new grammar yet |
| 2 | Resolve + IR population | B (base=A) | `cd crates && cargo test resolve` | `node packages/compiler/test/parity.mjs` | Revert PR B; PR A's grammar/validation stays intact |
| 3 | DDL + diff + client + generator + enforcement | C (base=B) | `node packages/migrator/test/migrator.mjs` | `node packages/migrator/test/pg-harness.mjs` (PGlite, `SET ROLE`) | Revert PR C; manual `DROP POLICY`/`DISABLE ROW LEVEL SECURITY` for already-applied migrations |

## PR A — Grammar + Validation (base = tracker)

- [x] A1.1 [RED] `lexer.rs`: `==` lexes to `TokenKind::EqEq`, `=` still `Equals`, `describe()`→`"'=='"`.
- [x] A1.2 [GREEN] add `RawToken::EqEq #[token("==")]` + `TokenKind::EqEq` + `describe()` arm.
- [x] A2.1 [RED] `parser.rs`: `this.ownerId`/`auth.userId` parse to `Path{segments}`; `auth.userId == this.ownerId` parses to `Comparison{op:"==",left,right}` at arg level; bare `read` and `[create,update]` still parse unchanged (regression).
- [x] A2.2 [GREEN] dotted-path branch in `parse_function_call_or_reference`; `EqEq`-wrap in `parse_attribute_arg`.
- [x] A3.1 [RED] `ast.rs`: `Path` serializes `kind:"path"`; `Comparison` serializes `kind:"comparison",op,left,right`.
- [x] A3.2 [GREEN] add `AttributeValue::Path{segments}` / `Comparison{op,left,right}` to `ast.rs`.
- [x] A3.3 [GREEN] mirror both variants on `AttributeValue` in `packages/ast/src/index.ts`.
- [x] A4.1 [RED] `rules.rs`: `ATTRIBUTE_RULES` carries `(Model,"allow",ArgShape::Allow)`; `ALLOW_ACTIONS`/`ALLOW_ALIASES`/`AUTH_CLAIMS=["userId"]`/`AUTH_SETTING="app.user_id"` match design.
- [x] A4.2 [GREEN] add `ArgShape::Allow`, the whitelist row, and the four constants.
- [x] A5.1 [RED] `validate.rs::validate_allow` — one test per diagnostic: wrong arity/non-comparison; unknown action; unknown claim (`auth.role`, names "role"); bad path root/arity (`post.ownerId`); unknown/non-scalar field; `auth.userId` vs literal; constant predicate (`true==true`); policy name >63 bytes; `@@realtime`+`@@allow` co-declared (names both).
- [x] A5.2 [RED] accepted forms produce zero diagnostics: bare single action (`read`), action array (`[create,update]`), `auth.userId == this.field`, multiple `@@allow` on one action.
- [x] A5.3 [GREEN] implement `validate_allow` with all 9 diagnostics; normalize a bare single-action reference to a one-element list internally; wire beside the `@@realtime` check (`validate.rs:75`).
- [x] A6.1 create `fixtures/18-allow-rules.indigo` (accepted forms, incl. array + bare action) — IR must show **no** `allow` key yet.
- [x] A6.2 create `fixtures/19-rejected-allow.indigo` — one instance per rejection class.
- [x] A6.3 confirm fixtures 01–17 unchanged (zero new diagnostics/snapshot diff).
- [x] A6.4 [VERIFY] `cd crates && cargo test` → `pnpm --filter @indigodb/compiler build:wasm` (commit artifact) → `node packages/compiler/test/regen-snapshots.mjs` (18/19 new, 01–17 no diff) → `node packages/compiler/test/parity.mjs`.
- [x] A6.5 [VERIFY] `pnpm build && pnpm lint` (workspace typecheck, incl. `@indigodb/ast`).
- [x] A6.6 [COMMIT] `feat(compiler): add @@allow grammar and validation`.

## PR B — Resolve + IR (base = PR A)

- [x] B1.1 [RED] `resolve.rs`: `write` expands to create/update/delete, `all` to all four, in declaration order; array `[create,update]` and bare single action both expand with no duplicates; `AllowOperand::Field` carries physical `dbName` (not logical name); multiple rules on one action preserve declaration order as distinct entries.
- [x] B1.2 [GREEN] implement alias expansion + operand resolution into `ResolvedTable.allow`.
- [x] B2.1 [RED] `ir.rs`: `allow` field omitted (not `null`) when absent, declared LAST after `group`.
- [x] B2.2 [GREEN] add `AllowRule`/`AllowAction`/`AllowOperand` + `ResolvedTable.allow: Option<Vec<AllowRule>>` per design Interfaces.
- [x] B3.1 [GREEN] mirror `AllowRule`/`AllowAction`/`AllowOperand`/`ResolvedTable.allow?` in `packages/core/src/ir.ts`.
- [x] B3.2 regenerate fixture 18's snapshot (now carries `allow`); confirm 01–17 unchanged. (Fixture 19's snapshot also changed — see apply notes: `regen-snapshots.mjs` always resolves regardless of validation errors, same pre-existing behavior as fixtures 09/10/11/15/17; not a regression.)
- [x] B3.3 [VERIFY] `cargo test` → `build:wasm` (commit) → `regen-snapshots.mjs` (18 and 19 diff, 01–17 zero diff) → `parity.mjs`.
- [x] B3.4 [VERIFY] `pnpm build && pnpm lint` (incl. `@indigodb/core`); also fixed `packages/core/test/print.mjs`'s round-trip normalizer to drop the new `allow` field (out of `printSchema`'s scope, same pattern as `color`/`group`).
- [x] B3.5 [COMMIT] `feat(compiler): resolve @@allow rules into IR`.

## PR C — DDL + Diff + Client (base = PR B)

- [ ] C0.1 [SPIKE — MUST run first] `packages/migrator/test/pg-harness.mjs`: confirm PGlite supports `CREATE ROLE ... NOLOGIN` + `SET ROLE`, and that role is actually subject to `FORCE ROW LEVEL SECURITY`. If unsupported, escalate: add a Docker Postgres CI service before continuing.
- [ ] C1.1 [RED] `postgres.ts`: `columnSqlType` returns the column's SQL type; `policyName` → `indigo_p_<dbName>_<action>_<ordinal>`, rejects >63 bytes; `renderPolicy` — read/delete → `USING`, create → `WITH CHECK` only (no `USING`), update → both from the same condition; cast matches field type (`Int`→`::integer`, `Uuid`→`::UUID`, `String`→none).
- [ ] C1.2 [RED] `renderRlsBlock`: `ENABLE`+`FORCE ROW LEVEL SECURITY`, prune loop dropping stale `indigo_p_<table>_%`, `DROP POLICY IF EXISTS`+`CREATE POLICY` per rule; zero-rule table → `renderDisableRls` (prune + `DISABLE`/`NO FORCE`); untouched table gets no RLS DDL.
- [ ] C1.3 [RED — threat: SQL injection via schema identifiers] quote-bearing `@map` name and quote-bearing string literal render safely via `quoteIdent`/`escapeLiteral`, never interpolated raw.
- [ ] C1.4 [GREEN] implement `columnSqlType`, `policyName`, `renderPolicy`, `renderRlsBlock`, `renderDisableRls`; wire new block 6 into `renderPushSql`.
- [ ] C2.1 [RED] `migrate.ts`: adding `@@allow` → migration includes `ENABLE`/`FORCE`+`CREATE POLICY`; removing → `DROP POLICY`(+disable); rule added/removed/reordered/action-changed → correct `DROP`+`CREATE`; `@map` rename remaps the owner column via `remapPhysicalNames`; policy statements classified `safe()`.
- [ ] C2.2 [GREEN] implement `diffPolicies` in `diffTable`, wire `createTable`'s initial policy emission.
- [ ] C3.1 [RED] `client.ts`: `$auth({userId}, fn)` issues `SELECT set_config('app.user_id', $1, true)` as a bound param before delegating to `fn`.
- [ ] C3.2 [RED — threat: SQL injection via auth value] `$auth({userId:"1'; DROP TABLE ..."})` leaves the schema intact.
- [ ] C3.3 [RED] `$auth` built on `$withSession`; identity dies at `COMMIT`/`ROLLBACK` (no leak across recycled pooled connection); models without `@@allow` unaffected.
- [ ] C3.4 [GREEN] implement `$auth` on `IndigoClientBase` per design Interfaces.
- [ ] C4.1 [GREEN] `packages/generator/src/client.ts`: emit typed `$auth` override beside `$transaction` + golden/snapshot test.
- [ ] C5.1 [RED — threat: privilege bypass, PGlite under `SET ROLE` from C0] `$auth({userId:X})` on `@@allow(read, auth.userId==this.ownerId)` sees only X's rows; a different id sees none; no `$auth` sees none; two permissive read rules OR.
- [ ] C5.2 [GREEN] wire the C0 harness into the suite; confirm C5.1 passes against real Postgres semantics.
- [ ] C6.1 [VERIFY] `node packages/migrator/test/regen-goldens.mjs` — review diff.
- [ ] C6.2 [VERIFY] `pnpm build && pnpm lint && pnpm test` + `cd crates && cargo test` (sanity, no crates touched in PR C).
- [ ] C6.3 [COMMIT] `feat(migrator,client): enforce @@allow via Postgres RLS`.

## Post-slice cleanup

- [ ] D1 Confirm proposal Success Criteria fully met across PR A–C (grammar, IR, DDL, `$auth`, closed claim vocabulary, deny-by-default).
- [ ] D2 Merge the 4 delta specs into `openspec/specs/{model-allow-rules,row-level-security-ddl,client-auth-context,attribute-validation}/spec.md` once this change archives.
- [ ] D3 Log follow-up (non-blocking): policy-ordinal churn on rule removal — revisit if operators complain.
