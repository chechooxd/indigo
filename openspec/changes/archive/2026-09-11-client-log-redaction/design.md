# Design: Redact bound parameter values from client statement logging

## Technical Approach

`wrapLog` (`client.ts:249-254`) keeps its position — innermost, after extensions rewrite
`sql` — and keeps logging the SQL in full. Only its third argument changes: instead of the
`params` array, it emits a positional placeholder string derived **from the array's indices
only**. The values are never read, so no formatting branch can leak one. Both executor
construction sites compose `wrapLog` identically (`client.ts:304` for `$withSession`, hence
`$transaction`), so one function body covers every path.

## Architecture Decisions

### Decision: Emitted shape — keep three arguments, replace only the third

**Choice**: `console.log("[indigodb]", sql, redactParams(params))`. Prefix stays at argument
0, SQL stays at argument 1, argument 2 becomes a single string:
`"$1=<redacted>, $2=<redacted>"`. Empty array prints the constant `"(0 params)"`.

**Alternatives considered**: one pre-formatted string (`"[indigodb] SELECT ... | $1=..."`);
keeping a structured array of placeholder strings; dropping argument 2 when empty.

**Rationale**: the existing assertion at `extensions.mjs:110` is positional —
`logged.find((args) => args[0] === "[indigodb]")?.[1]`. This shape keeps it passing
**unchanged**; a single formatted string would break it and force an edit to a test that is
currently load-bearing evidence for a different requirement. Explicitly: **that test needs no
change.** Today empty params print `[]`; `"(0 params)"` is chosen over `""` because a trailing
empty argument prints as a dangling space that reads like truncated output. That is the only
branch in the function, it is over `params.length === 0`, and it emits a constant — it is
unreachable while any parameter exists.

### Decision: Uniform placeholder, value never referenced

**Choice**: `params.map((_, i) => `$${i + 1}=<redacted>`)`. Every position is identical
regardless of type — arrays, `null`, `undefined`, `Buffer`, `Date` all render `<redacted>`.

**Alternatives considered**: type tags (`$1=<string>`), null/undefined passthrough, length
hints.

**Rationale**: the callback's first parameter is discarded (`_`), so the value is not in scope
of any expression that reaches stdout. Leakage becomes structurally impossible rather than
conditionally absent, and a reviewer confirms it by inspection. Any type-sensitive branch is a
branch that can leak (`typeof null === "object"`, `Date`/array coercion).

### Decision: Module-scope helper, not exported

**Choice**: `function redactParams(params: unknown[]): string` at module scope in
`client.ts`. Not exported from `client.ts` and not re-exported from `src/index.ts`.

**Alternatives considered**: inline expression in `wrapLog`; exported helper for unit testing.

**Rationale**: exporting would widen the public API of a package whose surface is a deliberate
contract, to buy a unit test that asserts the **wrong artifact**. The semantic artifact here is
captured stdout, not a helper's return value; a green helper test with a broken call site is
exactly the 2026-09-08 ERD defect (suite mocked the thing that assigns meaning). A named
module-scope function still gives the call site one reviewable definition.

### Decision: `log?: boolean` doc comments — corrected location

**Verified**: the option is declared at `client.ts:56-57`. `packages/client/src/types.ts`
contains **no** `log?:` declaration (grep: only `Executor` at `types.ts:478`). `proposal.md:24`
and `exploration.md:56` both cite `types.ts:56-57`; that citation is wrong and apply must not
follow it.

Required text, three sites:
- `client.ts:56-57` — must state: logs every executed statement's SQL for debugging; bound
  parameter **values are never printed**, only positional placeholders (`$1=<redacted>`)
  preserving order and arity; output format is a debugging aid, not a parsing contract.
- `client.ts:248` (`wrapLog` doc) — must say it logs SQL plus redacted positional
  placeholders, never values.
- `client.ts:60-68` (`extensions` doc) — the phrase "keeps logging the SQL actually sent"
  stays true; append "with parameter values redacted". No other edit.

## Data Flow

    caller ─→ extensions[0..n] ─→ wrapLog ─→ base executor
                                    │
                                    ├─ console.log("[indigodb]", sql, redactParams(params))
                                    └─ run(sql, params)   ← real values, untouched

`$withSession`/`$transaction` builds the same `applyExtensions(this.wrapLog(sessionExec))`
chain at `client.ts:304`. Redaction is in the shared function, so the paths cannot drift.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/client.ts:249-254` | Modify | `wrapLog` emits `redactParams(params)`; add module-scope `redactParams` |
| `packages/client/src/client.ts:56-57, 60-68, 248` | Modify | Doc comments per decision 4 |
| `packages/client/test/extensions.mjs` | Modify | **Append** redaction cases; `:98-115` unchanged |
| `openspec/changes/.../specs/` | — | Owned by `sdd-spec`; not touched here |

## Interfaces / Contracts

```ts
/** Positional placeholders for bound params. Never reads a value: the map
 *  callback discards its element argument, so no parameter value can reach
 *  stdout through any branch. */
function redactParams(params: unknown[]): string {
  if (params.length === 0) return "(0 params)";
  return params.map((_, i) => `$${i + 1}=<redacted>`).join(", ");
}
```

## Testing Strategy

Rows are scenario **combinations**. Every row marked (S) MUST pass a non-empty params array
carrying the sentinel `"hunter2-SENTINEL"` and assert it appears in **no** captured
`console.log` argument, mirroring `studio-audit-log/spec.md:61-65`. Capture via the
`console.log` swap already used at `extensions.mjs:101-109`. All rows use the hermetic
`stubExecutor` (`extensions.mjs:35`) — no DB gating.

| # | Combination | Assertion |
|---|---|---|
| 1 (S) | non-empty params × `log: true` × no extensions | sentinel absent from every captured arg; `args[2] === "$1=<redacted>"`; `args[1]` is the SQL |
| 2 (S) | non-empty params × `log: false` (and `log` omitted) | zero captured lines with `args[0] === "[indigodb]"` |
| 3 (S) | non-empty params × SQL-rewriting extension | sentinel absent **and** `args[1] === "SELECT 1 -- rewritten"` — proves redaction did not displace the `:98-115` requirement |
| 4 | empty params × `log: true` | `args[2] === "(0 params)"`; arity/shape still 3 args |
| 5 (S) | non-empty params × `log: true` × `$transaction` | inject `db: { exec, transaction: async (fn) => fn(exec) }`; sentinel absent from captured stdout; placeholders present — proves `client.ts:304` composes identically instead of assuming it |
| 6 | multi-param with mixed shapes (`Date`, `null`, `["a","b"]`, `Buffer`) × `log: true` | every position renders `<redacted>`; no shape-specific output |
| 7 | any row × base executor | `calls[0].params` still holds the **real** values — redaction is display-only |

**Mutation proof (mandatory, two-sided).** Reverting `wrapLog` to
`console.log("[indigodb]", sql, params)` MUST turn rows 1, 3 and 5 red **on their own
assertion**, with the failure message naming the leaked sentinel — e.g.
`` `expected the sentinel to be absent from stdout; found it in: ${JSON.stringify(args)}` ``.
The assertion must therefore be a membership check over stringified captured args, not a
property access that would throw a `TypeError` on the reverted shape. Apply MUST run the
mutation and record the observed red output. A red produced by a crash does not count.

Row 3's fixture is the one this repo's `C1.3a` defect class demands scrutiny of: the existing
`:98-115` case calls `$queryRaw("SELECT 1", [])` with an **empty** array and could never have
reached the leak. Row 3 is that same scenario re-run with a non-empty sentinel array.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. One function body inside a library, no new I/O.

## Migration / Rollout

No migration required. Single-commit revert restores prior behaviour and prior spec text
together. No config knob, so nothing to flip at runtime.

## Out of Scope (named, not dropped)

- PGlite adapter's missing rollback diagnostic (`adapters/pglite.ts` logs nothing where
  `adapters/pg.ts:88` logs errors). A missing log, not a leaking one.
- Structured logging, tracing, metrics, compiler benchmarks.

## Open Questions

None. Emitted shape, redaction location, uniformity, and doc text are all decided above.
