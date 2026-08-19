# Tasks: indigo-schema-printer

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~750-900 total (PR A ~500-600, PR B ~250-300) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR A (printer) → PR B (CLI wiring, targets PR A) |
| Delivery strategy | auto-chain |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Pure `printSchema` in core, no DB/CLI | PR A (base: feature/indigo-schema-printer) | `node packages/core/test/print.mjs` | N/A — pure function, no live DB required | Revert `packages/core/src/print.ts`, its export, and `print.mjs`; no downstream dependents yet |
| 2 | `db pull` CLI command + real-DB round trip | PR B (base: PR A branch) | `node packages/cli/test/pull.mjs && node packages/migrator/test/pull-roundtrip.mjs` | PGlite-backed `pull-roundtrip.mjs` (real introspect→print→parse→resolve→planMigration cycle) | Revert `db pull` registration, `resolveBareConnectionString`, and both new test files; PR A stays intact |

## Phase 1: PR A — Printer Core (RED -> GREEN)

- [x] 1.1 RED: `packages/core/test/print.mjs` — table/column emission: scalar type, `?` nullability suffix, `@default(...)` per kind (literal, function call, bare enum identifier), `@db.X` native-type override (spec: Table and Column Printing)
- [x] 1.2 GREEN: `packages/core/src/print.ts` — `printSchema(resolved)` emits model blocks with fixed field-attr order `@id`/`@unique`/`@default`/`@db.X`/`@map`/`@note`, name+type padding
- [x] 1.3 RED: `@map` emitted only when `dbName` diverges from field/model name; omitted when equal (spec: Table and Column Printing / Enum Printing)
- [x] 1.4 GREEN: implement conditional `@map` emission for fields, models, enum members
- [x] 1.5 RED: single-column PK emits field-level `@id`; composite PK emits repeated field-level `@id` on each PK column, no `@@id([...])` (design decision: `@@id` is compiler-rejected)
- [x] 1.6 GREEN: implement `@id` emission incl. composite-PK-as-repeated-field-`@id` path
- [x] 1.7 RED: THROW when `primaryKey` column order is not a subsequence of the table's column declaration order
- [x] 1.8 GREEN: implement subsequence check in `printSchema`, throw `IndigoPrintError` naming the table and offending PK order
- [x] 1.9 RED: enum blocks emit bare identifier members; `@map("...")` only when db value diverges from identifier (spec: Enum Printing With Member Mapping)
- [x] 1.10 GREEN: implement enum block emission
- [x] 1.11 RED: `@@index([...])`/`@@unique([...])` emit `name:` only for non-default names, `type:` only for non-default index types, fixed block order `@@map`/`@@unique`/`@@index`/`@@realtime`/`@@note` (spec: Index Printing)
- [x] 1.12 GREEN: implement index/unique block emission with name/type args and physical-column-to-field-name mapping
- [x] 1.13 RED: THROW when an index/FK column has no matching field `dbName` in the table
- [x] 1.14 GREEN: implement column-name resolution + throw path for unmatched index/FK columns
- [x] 1.15 RED: `@@realtime` emitted only on models resolved with realtime enabled (spec: @@realtime Printing)
- [x] 1.16 GREEN: implement `@@realtime` emission
- [x] 1.17 RED: raw FK-backed column prints as plain scalar field plus a structured comment `// @fk(fields: [...], references: [...], model: X, onDelete: ..., name: "...")`, with `refTable`/`refColumns` mapped back to model/field names and SQL action text inverted via the 5-entry REFERENTIAL_ACTIONS table; no `@relation(...)` synthesized (spec: Raw Foreign Key Output)
- [x] 1.18 GREEN: implement FK structured-comment emission and REFERENTIAL_ACTIONS mapping table
- [x] 1.19 RED: THROW when an FK's `refTable` has no matching table in the schema
- [x] 1.20 GREEN: implement refTable-lookup throw path
- [x] 1.21 RED: `IndigoPrintError` thrown (not partial output) for any unrepresentable IR construct; calling `printSchema` twice on the same IR returns byte-identical text (spec: Deterministic Text Emission, Loud Failure)
- [x] 1.22 GREEN: finalize `IndigoPrintError` class, LF-only output, single trailing newline, deterministic array-order-verbatim traversal
- [x] 1.23 RED: pure fixture round-trip — for each of the 17 `fixtures/*.indigo` corpus files, `resolve(parse(printSchema(resolved))) == normalizeForRoundTrip(resolved)` using the documented `normalizeForRoundTrip` helper (handles identity-column default asymmetry between introspect and resolve.rs)
- [x] 1.24 GREEN: wire round-trip test harness + `normalizeForRoundTrip` helper in `print.mjs`; fix any printer gaps surfaced by the corpus
- [x] 1.25 Export `printSchema` and `IndigoPrintError` from `packages/core/src/index.ts`
- [x] 1.26 Verify: `pnpm --filter @indigodb/core test` green; `pnpm --filter @indigodb/core lint` green

## Phase 2: PR B — CLI Wiring (RED -> GREEN, targets PR A branch)

- [x] 2.1 RED: `packages/cli/test/pull.mjs` — connection-resolution precedence: `--url` wins over `DATABASE_URL`; `DATABASE_URL` used when `--url` absent; error naming both missing inputs when neither resolves (spec: Connection Resolution Without a Pre-Existing Schema File)
- [x] 2.2 GREEN: `packages/cli/src/util.ts` — add `resolveBareConnectionString(options)` (does not depend on an existing schema file, unlike `resolveConnectionString`)
- [x] 2.3 RED: `db pull` writes to `./schema.indigo` by default, or `--schema <path>` when provided; datasource always synthesized as `url = env("DATABASE_URL")` even when `--url` was used (never writes credentials) (spec: Output Path Resolution; design: no-credentials rule)
- [x] 2.4 GREEN: `packages/cli/src/index.ts` — register `db pull` command with `-s/--schema`, `--url`, `--db-schema`, `--print` flags; wire `introspectResolvedSchema` -> `printSchema` -> file write
- [x] 2.5 RED: existing `schema.indigo` at the target path is overwritten by default — no confirmation prompt, no `--force` flag, and the CLI logs a visible overwrite warning (spec: Overwrite Existing Schema File By Default)
- [x] 2.6 GREEN: implement unconditional overwrite + `⚠️ Overwrote <path>` log line
- [x] 2.7 RED: `--print` writes nothing to disk — output goes to stdout only, no file created or modified
- [x] 2.8 GREEN: implement `--print` branch bypassing the file write
- [x] 2.9 RED: CLI emits a warning banner after every successful `db pull` stating FK constraints survive only as comments and will NOT be regenerated by `migrate dev` (a real, design-flagged risk, not optional)
- [x] 2.10 GREEN: implement the post-write warning banner
- [x] 2.11 RED: `packages/migrator/test/pull-roundtrip.mjs` — real-DB cycle: `renderPushSql` -> PGlite -> `introspectResolvedSchema` -> `printSchema` -> `parse`+`resolve` -> `planMigration` against the original schema yields ONLY FK-related statements (since FKs are comment-only after pull)
- [x] 2.12 GREEN: fix any pull/print/resolve gaps surfaced by the PGlite round trip until only FK statements remain
- [x] 2.13 Verify: `pnpm --filter @indigodb/cli test`, `pnpm --filter @indigodb/migrator test` green; `pnpm lint` green

## Phase 3: Integration

- [x] 3.1 Run full corpus + CLI + migrator suites together (`pnpm test`) to confirm PR A and PR B compose cleanly — green except the pre-existing fixture-13 (`13-ambiguous-relations.indigo`) diagnostic-ordering flake, unrelated to this change (no `crates/`/compiler edits made)
- [ ] 3.2 Confirm PR B diff is clean against PR A's branch (no PR A changes re-appearing in PR B's diff) — deferred: neither branch has commits yet (both are uncommitted working-tree state per instructions not to commit/push); re-check once PR A/PR B are actually committed
