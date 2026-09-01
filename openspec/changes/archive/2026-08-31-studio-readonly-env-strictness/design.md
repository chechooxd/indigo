# Design: Studio read-only env var rejects malformed values

## Technical Approach

`isReadOnlyEnv` is deleted and its logic absorbed into a single `resolveStudioReadOnly` in
`packages/cli/src/util.ts`, whose env branch adopts `resolveStudioAuditLog`'s accepted-set shape:
`"1"`/`"true"` → on, `"0"`/`"false"` → off, anything else THROWS. The flag side keeps its
enable-only OR shape (no `--no-read-only`). The resolver stays pure and never calls
`process.exit`; `index.ts`'s `studio` action moves the call inside its existing try/catch so a
malformed value exits 1 before anything binds. No new seam, no new file.

## Architecture Decisions

### Decision: `isReadOnlyEnv` is removed, not retyped or renamed

**Choice**: Delete the export; fold the parse into `resolveStudioReadOnly`'s env branch.
**Alternatives considered**: keep it returning `boolean | undefined` or a tri-state union; rename to
`parseReadOnlyEnv` and let it throw.
**Rationale**: Verified importers are exactly two — `util.ts:231` and
`packages/cli/test/studio-readonly-resolution.mjs:18`. No other production, test, or Studio
consumer exists. A retyped predicate would still be an exported second door onto the same env var,
and a throwing `parseReadOnlyEnv` would be a one-caller indirection none of the sibling resolvers
have (`resolveStudioAuditLog` inlines its own accepted set). `parseGuardrailInt` is shared by two
resolvers and earns its export; this would not.

### Decision: rejection message mirrors `resolveStudioAuditLog` verbatim, value echoed via `JSON.stringify`

**Choice**: `INDIGODB_STUDIO_READONLY must be "1", "0", "true", or "false", got: ${JSON.stringify(env)}`
**Alternatives considered**: raw interpolation; omitting the value entirely.
**Rationale**: `JSON.stringify` is what all three siblings use, and it is load-bearing here — `""`
and `" 1 "` are indistinguishable from a valid value without quoting. Echoing is safe *for this
variable specifically*: it is a mode toggle whose domain is four literals, it never carries a
credential (unlike `INDIGODB_STUDIO_PASSWORD` or the realtime secret), and the message goes to the
operator's own stderr at startup — not to an HTTP response, not to the audit log, not to a client.

### Decision: a malformed env var fails even when `--read-only` was passed

**Choice**: parse the env value first into a local, then OR with the flag. Do **not** early-return
on `optionReadOnly === true`.
**Alternatives considered**: `resolveStudioAuditLog`'s shape — return early on an explicit flag,
before touching the env var.
**Rationale**: `resolveStudioAuditLog` returns early because its flag is authoritative in *both*
directions, so the env var is genuinely overridden. `--read-only` can only ever *add* read-only;
it expresses no intent to override the env var, so short-circuiting would silently swallow a
config error the operator never asked to suppress — and their next launch without the flag would
come up writable. Failing closed is safe: nothing has bound yet.

**Implementation trap**: `optionReadOnly === true || parseEnv(env)` short-circuits and never
evaluates the parse. The body must resolve the env branch into a variable first.

### Decision: signature unchanged

`(optionReadOnly: boolean | undefined, envValue: string | undefined) => boolean`, now
throwing. `index.ts` needs no new argument, and `--read-only` needs no commander change (its
declaration order matters only for tri-state flags like `--audit-log`).

## Data Flow

    loadEnv()
       │
       ├─ options.readOnly ─────────────┐
       └─ INDIGODB_STUDIO_READONLY ──┐  │
                                     ▼  ▼
                        resolveStudioReadOnly (pure)
                             │                │
                    throws Error         boolean
                             │                │
                index.ts catch → exit 1   startStudio({ readOnly })

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/cli/src/util.ts` | Modify | Delete `isReadOnlyEnv` (+ its doc comment); rewrite `resolveStudioReadOnly` with the accepted-set env branch and the "pure, throws" doc comment naming this decision |
| `packages/cli/src/index.ts` | Modify | Move the `resolveStudioReadOnly` call into the existing try block (line ~377) as the first resolution; update the surrounding comment; update `--read-only` help text (~308) to name all four accepted values and the reject behavior |
| `packages/cli/test/studio-readonly-resolution.mjs` | Modify | Migrate 24 checks (below); import `throws`; drop the `isReadOnlyEnv` import |

## Interfaces / Contracts

```ts
// packages/cli/src/util.ts — throws on any env value outside the accepted set
export function resolveStudioReadOnly(
  optionReadOnly: boolean | undefined,
  envValue: string | undefined,
): boolean;
```

## Test Migration Plan

The proposal's "flip → throws" is imprecise for two values and must not be applied blindly.
Both existing malformed lists contain `"0"` and `"false"`, which are **accepted** under the new
contract. Verified against the real file:

| Existing block | Values | Migration |
|---|---|---|
| `isReadOnlyEnv` positives (3 checks, lines 37–47) | `"1"`, `"true"`, `undefined` | Re-expressed as `resolveStudioReadOnly(undefined, v)`; expectations unchanged |
| `isReadOnlyEnv` malformed loop (9, line 49) | `"TRUE"`,`"True"`,`"yes"`,`""`,`" 1 "`,`"1.0"`,`"on"` | 7 → `throws(…, /INDIGODB_STUDIO_READONLY/)`, merged into the single rejection loop |
| ↑ same loop | `"0"`, `"false"` | → **accepted-disable** checks (`→ false`), NOT rejections. Value preserved, reason changed |
| `resolveStudioReadOnly` combos (6, lines 57–79) | flag/env pairs | Unchanged, all still pass |
| `resolveStudioReadOnly` malformed loop (6, line 81) | `"TRUE"`,`"yes"`,`""`,`" 1 "` | → rejections (absorbed by the merged loop) |
| ↑ same loop | `"0"`, `"false"` | → accepted-disable (dedup with the row above) |

Net: zero near-miss values lost. Every value covered today is still covered, as either a rejection
or an accepted-disable.

## Testing Strategy

One runtime test per scenario `sdd-spec` will write. Symmetric pairs are listed as separate rows
deliberately — do not collapse them.

| # | Scenario | Covering test |
|---|---|---|
| 1 | env `"1"` enables | `studio-readonly-resolution.mjs`: `resolveStudioReadOnly(undefined,"1") === true` |
| 2 | env `"true"` enables | same file: `(undefined,"true") === true` |
| 3 | env `"0"` disables (compatibility) | same file: `(undefined,"0") === false` |
| 4 | env `"false"` disables (compatibility) | same file: `(undefined,"false") === false` |
| 5 | unset env defaults off | same file: `(undefined,undefined) === false` |
| 6 | flag alone enables | same file: `(true,undefined) === true` |
| 7 | flag absent/false + no env → off | same file: `(false,undefined) === false` |
| 8 | flag `true` + env `"1"` → on | same file: `(true,"1") === true` |
| 9 | flag `false` + env `"1"` → on (env still enables) | same file: `(false,"1") === true` |
| 10 | flag `true` + env `"0"` → on (enable-only OR; flag wins over disable) | same file: `(true,"0") === true` |
| 11 | every malformed value throws | same file: loop over `"TRUE"`,`"True"`,`"yes"`,`""`,`" 1 "`,`"1.0"`,`"on"` → `throws(…, /INDIGODB_STUDIO_READONLY/)` |
| 12 | error message names all four accepted values | same file: `throws(…, /must be "1", "0", "true", or "false"/)` on one malformed value |
| 13 | error message echoes the offending value quoted | same file: `throws(() => …(undefined," 1 "), /" 1 "/)` |
| 14 | `--read-only` does NOT suppress a malformed env | same file: `throws(() => …(true,"yes"))` |
| 15 | `isReadOnlyEnv` no longer exported | same file: `const m = await import("../dist/util.js"); strictEqual(m.isReadOnlyEnv, undefined)` |
| 16 | malformed env exits 1 before binding | New check in the same file: `spawnSync(process.execPath, ["dist/index.js","studio"], { env: { …, INDIGODB_STUDIO_READONLY: "yes" }, cwd: <empty temp dir> })` → `status === 1` and stderr matches `/INDIGODB_STUDIO_READONLY/` |

Rows 1–15 are pure-resolver unit checks in the style of `studio-audit-resolution.mjs`.

Row 16 is a **new pattern** — no existing `packages/cli/test` file spawns the built CLI, and both
`studio-query-resolution.mjs` and `studio-readonly-resolution.mjs` say so explicitly in their
headers. It is still required: the resolver throwing is inert unless `index.ts` catches it, and the
call currently sits **outside** the try block, so the wiring is the actual regression surface and
no unit test can reach it. It is cheap and safe to run — `assertStudioAuthForHost` passes silently
on the default loopback host, and the try/catch precedes `loadSchema`/`resolveConnectionString`, so
the process exits 1 with no schema file, no `.env`, and no database. Run it in an empty temp `cwd`
so `loadEnv()` cannot pick up a stray `.env`.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. The change narrows an existing resolver's accepted input set.

## Migration / Rollout

No data migration. Behavioral migration only: `"1"`/`"true"`/`"0"`/`"false"`/unset are byte-for-byte
unchanged; only `yes`/`on`/`TRUE`/`True`/`1.0`/`""`/`" 1 "` change from silently-off to exit 1.
Repo is pre-product and private, so no external consumer depends on the lenient path. Rollback is
`git revert`, or restoring the OR-shaped body in one edit.

## Open Questions

None.
