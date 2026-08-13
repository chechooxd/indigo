# Delta for Client Query Type Safety

## ADDED Requirements

### Requirement: BigInt scalar columns are typed as `string`

Generated Row/Create/Update interfaces MUST map `ScalarType.BigInt` columns
to TypeScript `string`, not `bigint`, because pg's default int8 result
parser returns a JS `string` at runtime with no `setTypeParser` override
present anywhere in the client. This is a type-only correction; no runtime
behavior changes.

#### Scenario: Generated Row type maps BigInt to string

- GIVEN a model with a field of scalar type `BigInt`
- WHEN the client is generated
- THEN the field's type in the generated `Row` interface MUST be `string`
- AND MUST NOT be `bigint`

#### Scenario: No runtime change accompanies the type fix

- GIVEN a query returns a BigInt-typed column value
- WHEN the value is read at runtime
- THEN the returned JS value MUST remain a `string`, unchanged from
  pre-existing runtime behavior

### Requirement: Generated enums emit as a const object with a paired type

Generated enum types MUST be emitted as `export const X = {...} as const`
paired with `export type X = typeof X[keyof typeof X]`, sharing the name
`X` for both the value-position const and the type-position alias, instead
of a nominal `export enum X {...}`. This MUST compile under
`isolatedModules`/`erasableSyntaxOnly` consumers of the generated client.

#### Scenario: Value-position usage compiles

- GIVEN a generated enum `Status` with member `Active`
- WHEN calling code writes `Status.Active`
- THEN this MUST type-check and resolve to the correct literal value

#### Scenario: Type-position usage compiles in function signatures

- GIVEN a generated enum `Status`
- WHEN a generated or hand-written function signature declares a parameter
  or return type as `Status` (e.g. `function setStatus(s: Status): void`)
- THEN this MUST type-check as a valid type reference
- AND MUST NOT require importing a separately-named type (no `StatusValue`
  or similar split name)

#### Scenario: Enum-bearing model compiles under erasableSyntaxOnly

- GIVEN a generated client containing at least one enum column
- WHEN the generated file is type-checked with `erasableSyntaxOnly` enabled
- THEN compilation MUST succeed with no errors attributable to the enum
  emission

### Requirement: `select` scalar narrowing remains correct (regression guard)

`SelectedScalars` MUST continue to narrow via TypeScript's `Pick` utility
type so that a `select`-scoped read method's inferred return type contains
exactly the requested scalar fields. This requirement records verification
of pre-existing, already-correct behavior — no code change accompanies it —
and exists so the guarantee stays covered by an automated regression check
going forward.

#### Scenario: select narrowing remains verified by the typecheck fixture

- GIVEN `packages/client/test/typecheck.mjs`'s `tsc --noEmit` fixture
- WHEN the fixture is run against a `select`-scoped `findMany` call
- THEN excluded scalar fields MUST remain compile errors to access
- AND this MUST hold with no change to `SelectedScalars`'s implementation
</content>
