# Release Notes: Fix `.indigo` Compiler Correctness

Root cause: "what is legal" lived only inside `resolve.rs`, implicitly, with
no `validate.rs` counterpart. `rules.rs` is now the single legality-table
home, read by both. **Behavior change, no deprecation window** (packages are
`0.0.1`, unpublished): every item below compiled/lexed silently before and
is now a compile-time diagnostic.

## New rejection classes (were silent, now hard errors)

| Class | Before | Fix |
|---|---|---|
| Unknown string escape (`\q`) | Passed through literally | Use `\\ \" \n \r \t` only |
| **`@@id([a, b])`** composite PK | Ignored; single-column `@id` only | Not supported yet — use one `@id` field |
| **`@updatedAt`** | Behaved like a plain column | Remove — never did anything |
| **`@@ignore`** | Model never actually excluded | Remove — never did anything |
| Other unknown/misapplied attribute | Silently dropped | Fix the name/arity/type |
| Unknown `@relation` arg (`onDlete`) | Silently dropped, FK lost the value | Use `fields, references, onDelete, onUpdate` |
| Invalid/lowercase referential action | Silently resolved to no action | Use exact-case `Cascade, Restrict, SetNull, SetDefault, NoAction` |
| **Implicit many-to-many** (reciprocal lists, no `@relation`) | Two disconnected, useless one-to-many relations | Define an **explicit join model** with two `@relation(fields:, references:)` legs — deliberate product non-goal |
| `datasource.provider` != `"postgresql"` (incl. absent) | Silently accepted | Set `provider = "postgresql"` |
| More than one `datasource` block | Silently kept only the first | Keep exactly one block |

`generator.provider` (e.g. `"indigodb-client-ts"`) is untouched by
datasource validation regardless of value — a distinct, unrelated key.

## Diagnostics stay positionless for these checks

`validate()` is a separate WASM export taking `Schema` JSON — it never sees
source text, and AST nodes carry no spans. Every new diagnostic names
`model`/`field` instead of a line/column. Spans are a separate follow-up
(`compiler-source-spans`), not delivered here.

## Tracked incompletenesses (handed to `fix-migrator-correctness`)

- `ForeignKey.onUpdate` reaches the IR; no `ON UPDATE` DDL yet.
- `ResolvedEnum.members` reaches the IR; the migrator/generator/studio still
  read `values: string[]` only.

Both are documented handoffs, not silent no-ops of the kind this change
exists to eliminate.
