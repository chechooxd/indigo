# Proposal: Studio read-only env var rejects malformed values

## Intent

`INDIGODB_STUDIO_READONLY=yes` silently resolves read-only **off** — no warning, exit 0,
Studio comes up fully writable against whatever database the operator just "protected".
This fails in the dangerous direction, defeating the whole purpose of `studio-readonly-mode`
("inspect, never mutate" on a shared/staging/production database).

Verified in source:

- `packages/cli/src/util.ts:218` — `isReadOnlyEnv(v) => v === "1" || v === "true"`;
  `:230` — `resolveStudioReadOnly(opt, env) => opt === true || isReadOnlyEnv(env)`.
- `openspec/specs/studio-readonly-mode/spec.md:18` makes it **normative**
  ("any other value MUST leave it off"), and the scenario at `:39`,
  "Malformed env values do not enable read-only mode", blesses `"yes"`/`"1.0"`/`""`
  resolving to `false`. This is a spec defect, not only a code defect.

`isReadOnlyEnv` is the last silent resolver in `util.ts`. `resolveStudioAuditLog` (`:360`),
`resolveGuardrailValue` (`:254`) and `resolveStudioEnvironment` (`:318`) all throw on invalid
input. This change makes the outlier conform.

## Scope

### In Scope

- Rewrite `INDIGODB_STUDIO_READONLY` parsing to the `resolveStudioAuditLog` accepted-set shape:
  `"1"`/`"true"` enable, `"0"`/`"false"` disable, **anything else throws** naming the env var
  and the accepted values.
- Catch and exit 1 in `packages/cli/src/index.ts`'s `studio` action, alongside the existing
  `resolveQueryTimeoutMs`/`resolveStudioEnvironment` try block (`index.ts:363-373`).
- Rewrite the `studio-readonly-mode` requirement text at `spec.md:18` and replace the
  "Malformed env values do not enable read-only mode" scenario, whose current title states
  the defect as intended behavior.
- Update `packages/cli/test/studio-readonly-resolution.mjs` (24 checks today, several of which
  assert the defect) and the `--read-only` flag help text (`index.ts:308`).

### Out of Scope — deliberate non-goals

`openspec/config.yaml` records silent scope creep between adjacent Studio epics as this repo's
most common review defect. The tempting creep here is "while we're in `util.ts`…":

- **No `--no-read-only` flag.** `resolveStudioReadOnly` stays OR-shaped on the flag side
  (`opt === true`). This change closes a silent-failure hole; it does not redesign the flag
  surface. A negatable flag is a separate change with its own precedence story.
- **No harmonisation of the other resolvers.** They already throw. No renames, no shared
  helper extraction, no touching `parseGuardrailInt`/`resolveGuardrailValue`.
- **No trimming or case folding.** `" 1 "` and `"TRUE"` become *rejected*, not accepted.
  Exact match stays the rule; only the failure mode changes.
- **No auth, pagination, audit-log or write-gate changes.** The `/api/rows/` gate,
  `studio-session-auth`, and `studio-audit-log` are untouched.

## Decisions this proposal settles

**Accepted set** — mirror `resolveStudioAuditLog` exactly: `"1"`/`"true"` → on,
`"0"`/`"false"` → off, anything else → throw. Rejecting *everything* that is not `1`/`true`
would break `INDIGODB_STUDIO_READONLY=false`/`=0`, which works today and means exactly what
the operator intended. Turning that into a startup failure would be a regression, not a fix.

**Migration impact**

| Existing value | Today | After |
|---|---|---|
| `1`, `true` | on | on (unchanged) |
| `0`, `false` | off | off (unchanged) |
| unset | off | off (unchanged) |
| `yes`, `on`, `TRUE`, `1.0`, `""`, `" 1 "` | off, silently | **exit 1** naming the accepted values |

Only the last row changes, and that loud failure is the entire point. Nothing in this repo is
published (pre-product, private), so no external consumer can be depending on the lenient path.

**`isReadOnlyEnv`** — disappears into `resolveStudioReadOnly`. A boolean-returning predicate
cannot express "reject", so keeping it as a public export would leave a second, still-lenient
door into the same decision. Its export is removed and its unit tests are rewritten as
`resolveStudioReadOnly` cases (the only consumer is `resolveStudioReadOnly` itself —
grep confirms no other production caller).

**Other dependents** — none. `resolveStudioReadOnly` has exactly one production call site
(`index.ts:363`). `studio-session-auth`'s status probe (`spec.md:203-222`) and
`studio-environment-badge` (`spec.md:150-156`) reference the *resolved* boolean, never the
parse rule, so neither spec restates the lenient behavior and neither needs a delta.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `studio-readonly-mode`: the "Read-only flag resolved once at startup" requirement — env var
  accepted set becomes `"1"`/`"true"`/`"0"`/`"false"`, any other value MUST be rejected with a
  startup error and non-zero exit. The "Malformed env values do not enable read-only mode"
  scenario is replaced (full prior requirement block copied before editing, per
  `config.yaml` specs rule).

## Approach

Replace `isReadOnlyEnv` + `resolveStudioReadOnly` with a single `resolveStudioReadOnly` whose
env branch is byte-for-byte the `resolveStudioAuditLog` shape, minus the tri-state flag
precedence (the flag stays enable-only). The resolver stays **pure and throws** — never
`process.exit` — per the established "resolvers are pure and throw" design decision;
`index.ts`'s action is the only caller that exits.

**Seam note:** no new seam. This narrows an existing `util.ts` resolver's accepted input set;
it does not widen any contract.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/cli/src/util.ts` | Modified | `isReadOnlyEnv` removed; `resolveStudioReadOnly` throws on unrecognized env |
| `packages/cli/src/index.ts` | Modified | Resolution moved into the existing try/catch; `--read-only` help text |
| `packages/cli/test/studio-readonly-resolution.mjs` | Modified | Rewritten: rejection assertions replace the "malformed → false" ones |
| `openspec/specs/studio-readonly-mode/spec.md` | Modified | Requirement + scenario rewritten via delta |

No `crates/` changes, so no `build:wasm` or WASM regression rerun is required.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| An operator's `.env` carries a fuzzy value and Studio now refuses to start | Low | Intended; error names the env var and the four accepted values |
| Removing the `isReadOnlyEnv` export breaks an unseen consumer | Low | Grep confirms one caller; `pnpm lint` (`tsc --noEmit`) catches any miss |
| Test rewrite loses near-miss coverage the archive report called out | Med | Keep every existing near-miss value (`"TRUE"`, `"yes"`, `"1.0"`, `""`, `" 1 "`, `"on"`), flipping each from "→ false" to "→ throws" |

## Rollback Plan

Revert the change commits. Short of revert, restoring `isReadOnlyEnv` and the OR-shaped
`resolveStudioReadOnly` body in `util.ts` returns the lenient behavior in one edit; the spec
delta reverts with the archive.

## Dependencies

- None. No open sibling change touches `studio-readonly-mode` (`openspec/changes/` holds no
  unarchived proposals).

## Success Criteria

- [ ] `INDIGODB_STUDIO_READONLY=yes` (and `on`, `TRUE`, `1.0`, `""`, `" 1 "`) exits 1 with a
      message naming `INDIGODB_STUDIO_READONLY` and the accepted values; nothing binds.
- [ ] `1`, `true`, `0`, `false` and unset behave exactly as they do today.
- [ ] `isReadOnlyEnv` is no longer exported and no longer referenced anywhere.
- [ ] The `studio-readonly-mode` spec no longer contains a scenario asserting that a malformed
      value resolves to `false`.
- [ ] `pnpm build && pnpm lint && pnpm test` green from repo root.

## Proposal question round

Ran in `auto` execution mode, so these were settled rather than asked. Correct any that are wrong:

1. `"0"`/`"false"` remain accepted (as *disable*) rather than rejected — protecting a
   working, intentional configuration outweighs a stricter one-value-only set.
2. A malformed value is a **startup failure**, not a warning-plus-default-on. Loud beats
   guessing at the operator's intent for a safety guardrail.
3. `--no-read-only` is a non-goal in this change.
