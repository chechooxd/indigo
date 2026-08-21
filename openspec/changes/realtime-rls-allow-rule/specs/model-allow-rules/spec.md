# Model Allow Rules Specification

## Purpose

Defines the `@@allow(action, condition)` model-level attribute: the closed action vocabulary,
the narrow equality condition grammar, the closed `auth.*` claim vocabulary, multi-rule support,
the `@@realtime` conflict rejection, and the resolved IR shape consumers read.

## Requirements

### Requirement: Action vocabulary and alias expansion

The compiler MUST accept `create`, `read`, `update`, `delete` as `@@allow` actions, and MUST
expand the sugar actions `write` (create, update, delete) and `all` (all four) into their
canonical set at resolve time. Actions MAY be comma-combined in one `@@allow` call.

#### Scenario: Canonical action accepted

- GIVEN `@@allow(read, auth.userId == this.ownerId)`
- WHEN the schema is resolved
- THEN the IR carries one resolved rule under the `read` action

#### Scenario: `write` expands to its canonical set

- GIVEN `@@allow(write, auth.userId == this.ownerId)`
- WHEN the schema is resolved
- THEN the IR carries the same rule duplicated under `create`, `update`, and `delete`

#### Scenario: `all` expands to every action

- GIVEN `@@allow(all, auth.userId == this.ownerId)`
- WHEN the schema is resolved
- THEN the IR carries the rule under `create`, `read`, `update`, and `delete`

### Requirement: Condition grammar is a single equality comparison

The compiler MUST accept, as an `@@allow` condition, exactly one equality comparison whose two
sides are each independently a `this.<field>` path, an `auth.<claim>` path, or a literal
(string, number, or boolean). Any other shape — boolean combinators, `in`, relation traversal,
function calls, or a non-equality comparator — MUST be rejected with a located diagnostic and
MUST NOT be silently accepted as a wider parse.

#### Scenario: Field-vs-claim equality accepted

- GIVEN `@@allow(read, auth.userId == this.ownerId)`
- WHEN the schema is validated
- THEN no diagnostic is produced for the condition

#### Scenario: Boolean combinator rejected

- GIVEN `@@allow(read, auth.userId == this.ownerId && this.isPublic == true)`
- WHEN the schema is validated
- THEN a located diagnostic is produced naming the unsupported combinator

### Requirement: Claim vocabulary is closed to `auth.userId`

The compiler MUST accept `auth.userId` as the only valid `auth.<claim>` path in an `@@allow`
condition. Any other claim name MUST produce a hard, located compiler error.

#### Scenario: `auth.userId` accepted

- GIVEN `@@allow(read, auth.userId == this.ownerId)`
- WHEN the schema is validated
- THEN no diagnostic is produced for the claim reference

#### Scenario: Unknown claim rejected

- GIVEN `@@allow(read, auth.role == this.role)`
- WHEN the schema is validated
- THEN a located diagnostic is produced naming `"auth.role"` as an unrecognized claim

### Requirement: Multiple `@@allow` rules per action are permitted

The compiler MUST allow more than one `@@allow` declaration for the same action on one model,
resolving each into a distinct, stably-ordered IR entry with no combination logic applied —
Postgres's native permissive-OR semantics govern runtime evaluation.

#### Scenario: Two rules on the same action

- GIVEN a model with `@@allow(read, auth.userId == this.ownerId)` and
  `@@allow(read, this.isPublic == true)`
- WHEN the schema is resolved
- THEN the IR carries two distinct, ordered rules under the `read` action

### Requirement: `@@realtime` and `@@allow` are mutually exclusive on one model

The compiler MUST reject a model that declares both `@@realtime` and `@@allow`, with a located
diagnostic, because the realtime fan-out path has no row-level filter.

#### Scenario: Combination rejected

- GIVEN a model with both `@@realtime` and `@@allow(read, auth.userId == this.ownerId)`
- WHEN the schema is validated
- THEN a located diagnostic is produced naming the conflicting attributes

### Requirement: Resolved allow rules are exposed on the table IR

`packages/core/src/ir.ts` MUST mirror the Rust-resolved allow rules as an ordered list per
action on `ResolvedTable`, using the same serde-contract convention as other IR fields (absent
key ≡ `undefined` for models without `@@allow`).

#### Scenario: Model without `@@allow` has no rules field populated

- GIVEN a model with no `@@allow` declarations
- WHEN the schema is resolved
- THEN the resulting `ResolvedTable` carries no allow-rules entries
