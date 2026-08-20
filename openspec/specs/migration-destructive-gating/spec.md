# Migration Destructive Gating Specification

## Purpose

Defines a two-category risk classification (`safe` vs `requires-force`) for
generated migration statements, assigned at statement-generation time from
the semantics already known at each emit call site (never by re-parsing
rendered SQL). Defines the `--force` gate that applies this classification
symmetrically to `migrate dev` and `migrate deploy`: a plan containing any
`requires-force` statement is refused before anything is applied unless
`--force` is passed, in which case the entire plan applies unchanged.

## Requirements

### Requirement: Every generated migration statement is classified `safe` or `requires-force` at generation time

The system MUST classify each statement produced by the migration diff/plan
step into exactly one of two categories: `safe` or `requires-force`. There
MUST NOT be an intermediate or additional category. Classification MUST be
assigned at the existing call sites in the migrator that already emit each
statement, based on the semantics those call sites already know, and MUST
NOT be derived by parsing or pattern-matching the rendered SQL text.

#### Scenario: A DROP TABLE statement is classified requires-force

- GIVEN a schema diff that removes a model
- WHEN the migration plan is generated
- THEN the emitted `DROP TABLE` statement is classified `requires-force`

#### Scenario: A DROP COLUMN statement is classified requires-force

- GIVEN a schema diff that removes a field from a model
- WHEN the migration plan is generated
- THEN the emitted `DROP COLUMN` statement is classified `requires-force`

#### Scenario: A DROP CONSTRAINT statement is classified requires-force

- GIVEN a schema diff that removes a constraint (foreign key, primary key, or similar)
- WHEN the migration plan is generated
- THEN the emitted `DROP CONSTRAINT` statement is classified `requires-force`

#### Scenario: A column type-narrowing ALTER is classified requires-force

- GIVEN a schema diff that changes a column to a narrower or incompatible type
- WHEN the migration plan is generated
- THEN the emitted `ALTER COLUMN ... TYPE` statement is classified `requires-force`

#### Scenario: ADD COLUMN with NOT NULL and no default or backfill is classified requires-force

- GIVEN a schema diff that adds a required column with no default value and no backfill
- WHEN the migration plan is generated
- THEN the emitted statement adding that column is classified `requires-force`

#### Scenario: Purely additive statements are classified safe

- GIVEN a schema diff that only creates tables, adds nullable or defaulted columns, creates indexes, adds constraints, or adds an enum value
- WHEN the migration plan is generated
- THEN every emitted statement for that diff is classified `safe`

### Requirement: A plan containing any requires-force statement is refused without `--force`, under both `migrate dev` and `migrate deploy`

When a generated migration plan contains one or more `requires-force`
statements and the `--force` flag was not passed, the system MUST refuse to
apply any statement in the plan, MUST set `process.exitCode = 1`, and MUST
report a clear message identifying which specific statements triggered the
refusal — not a generic "some statements are destructive" message — without
throwing. This gate MUST apply identically to `migrate dev` and
`migrate deploy`: neither command is exempt, and neither treats
`requires-force` statements more leniently than the other.

#### Scenario: `migrate dev` refuses a plan with a DROP COLUMN, without `--force`

- GIVEN a migration plan containing a `DROP COLUMN` statement
- WHEN `migrate dev` runs without `--force`
- THEN nothing in the plan is applied, `process.exitCode` is set to `1`, and the refusal message names the `DROP COLUMN` statement specifically

#### Scenario: `migrate deploy` refuses a plan with a DROP TABLE, without `--force`

- GIVEN a pending migration file whose plan contains a `DROP TABLE` statement
- WHEN `migrate deploy` runs without `--force`
- THEN nothing in the plan is applied, `process.exitCode` is set to `1`, and the refusal message names the `DROP TABLE` statement specifically

#### Scenario: Refusal message lists every offending statement, not just one

- GIVEN a migration plan containing multiple `requires-force` statements (for example a `DROP COLUMN` and a type-narrowing `ALTER COLUMN`)
- WHEN the plan is refused without `--force`
- THEN the refusal message identifies each `requires-force` statement that triggered the refusal

### Requirement: `--force` applies the full plan unchanged, with no distinction between safe and requires-force statements

When `--force` is passed, the system MUST apply every statement in the plan
— `safe` and `requires-force` alike — with no difference in execution
behavior between the two categories. `--force` MUST NOT change which
statements are generated, their order, or how they are executed; its only
effect is bypassing the refusal defined above.

#### Scenario: `--force` applies a plan containing requires-force statements

- GIVEN a migration plan containing a `DROP COLUMN` statement
- WHEN `migrate dev` or `migrate deploy` runs with `--force`
- THEN every statement in the plan applies, including the `DROP COLUMN` statement, with no refusal

#### Scenario: `--force` on a purely safe plan is a no-op with respect to gating

- GIVEN a migration plan containing only `safe` statements
- WHEN `migrate dev` or `migrate deploy` runs with `--force`
- THEN the plan applies exactly as it would without `--force`

### Requirement: A purely safe plan is unaffected by this gate

When a generated migration plan contains no `requires-force` statements, the
system MUST apply it without requiring `--force` and without any refusal,
under both `migrate dev` and `migrate deploy`.

#### Scenario: A safe-only plan applies without `--force`

- GIVEN a migration plan containing only `CREATE TABLE`, `ADD COLUMN` (nullable or defaulted), `CREATE INDEX`, and enum `ADD VALUE` statements
- WHEN `migrate dev` or `migrate deploy` runs without `--force`
- THEN the plan applies with no refusal and no gating message

### Requirement: There is no override beyond `--force` itself

The system MUST NOT provide any mechanism to force some statements in a plan
while refusing others in the same run, and MUST NOT provide an environment
variable, configuration option, or any other bypass of the refusal.
`--force` MUST be the sole override, and it MUST be all-or-nothing for the
plan being applied.

#### Scenario: No partial-force exists

- GIVEN a migration plan containing both `safe` and `requires-force` statements
- WHEN the user wants to apply only the `safe` statements while still being refused on the `requires-force` ones
- THEN no documented flag or option provides this partial application; `--force` applies the whole plan or the whole plan is refused

#### Scenario: No environment variable bypasses the refusal

- GIVEN a migration plan refuses due to a `requires-force` statement
- WHEN the user attempts to proceed without passing `--force`
- THEN no environment variable or configuration setting bypasses the acquisition of `--force` or the refusal
