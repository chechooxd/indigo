# Proposal: Client Type Honesty

## Intent

The generated client and runtime make three claims that are not true, plus one that was never verified.
`bigint`-typed columns actually receive JS `string` at runtime (pg's default int8 parser; no `setTypeParser`
anywhere). Real Postgres failures (unique violation, FK violation, connection loss) escape the client
completely unwrapped, forcing callers to string-match SQLSTATE on an untyped `Error`. Nominal `enum`
emission forces `isolatedModules`/`erasableSyntaxOnly` consumers off the generated client. Closes epic 3/5
of the Phase 2 roadmap ("Type honesty", M). Nothing is published, so breaking the generated surface is
acceptable now and not later.

## Scope

### In Scope
- **`select` narrowing — verification only.** Confirmed already correct (`SelectedScalars` uses `Pick`,
  covered by `typecheck.mjs`'s real `tsc --noEmit` fixture). No code change; recorded as investigated
  and correct, closing the roadmap line.
- **Typed DB-error taxonomy.** New `IndigoDatabaseError extends Error` with a `code` field, distinguishing
  at minimum unique-violation (SQLSTATE `23505`) from other driver errors, wrapping pg errors at all exec
  sites in `packages/client/src/client.ts` (pool path, both `$withSession` raw `client.query` calls).
- **BigInt mapping.** `SCALAR_TO_TS[ScalarType.BigInt]`: `"bigint"` → `"string"`.
- **Const-object enums.** Replace `export enum X {...}` with `export const X = {...} as const` +
  `export type X = typeof X[keyof typeof X]`, so `X.Value` and `X`-as-a-type both keep compiling.
- Golden update `packages/generator/test/enum-mapping.mjs`; add an enum column to
  `packages/client/test/fixtures/typecheck-fixture.ts` (no enum coverage exists today).

### Out of Scope
- `pg.types.setTypeParser(20, BigInt)` (runtime-changing bigint option) — rejected; it ripples into
  JSON serialization at Studio/CLI API boundaries.
- Exhaustive SQLSTATE catalog, retry/backoff policy, error mapping for `$queryRaw` result shapes.
- Any `select`/`include` narrowing rework.

## Capabilities

### New Capabilities
- `client-database-errors`: typed wrapping of driver-level Postgres failures with a stable code taxonomy.

### Modified Capabilities
- `client-query-type-safety`: BigInt columns typed `string`; enums emitted as const-object + paired type;
  `select` narrowing reaffirmed as already-satisfied.

## Approach

Four independent edits, one PR — no shared surface, no ordering dependency (per exploration). Error wrapping
is a `try/catch` at the three exec sites reading pg's `DatabaseError.code`. Generator changes are two
localized emission edits. Test coverage moves with each change.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/client/src/client.ts` | Modified | Wrap pg errors at pool + `$withSession` exec sites |
| `packages/client/src/errors.ts` (or `delegate.ts`) | New | `IndigoDatabaseError` + code taxonomy |
| `packages/generator/src/client.ts` | Modified | `SCALAR_TO_TS` BigInt; enum emission block |
| `packages/generator/test/enum-mapping.mjs` | Modified | Golden expectation update |
| `packages/client/test/fixtures/typecheck-fixture.ts` | Modified | Add enum column coverage |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Breaking generated-client consumers (bigint/enum) | High (intended) | Nothing published; flagged on the "now-or-never" list |
| Const-object enum breaks a type-position reference | Med | Paired `type X` export; enum column added to typecheck fixture |
| Over-wrapping hides original pg error | Med | Preserve `cause` and original SQLSTATE on the wrapper |

## Rollback Plan

Single revert of the PR commit. Each sub-item is independently revertible: generator edits are two
isolated blocks plus their goldens; error wrapping is additive `try/catch` with no call-signature change.

## Dependencies

- None. No new packages; pg's `DatabaseError.code` already carries SQLSTATE.

## Success Criteria

- [ ] `pnpm test` and `packages/client/test/typecheck.mjs` pass, including a new enum-column fixture case
- [ ] A `23505` failure surfaces as `IndigoDatabaseError` with a unique-violation code, `cause` preserved
- [ ] Generated Row types map BigInt columns to `string`
- [ ] Generated enums compile under `erasableSyntaxOnly`; `X.Value` and `X`-as-type both still work
- [ ] `select` narrowing documented as verified-correct, no code change
