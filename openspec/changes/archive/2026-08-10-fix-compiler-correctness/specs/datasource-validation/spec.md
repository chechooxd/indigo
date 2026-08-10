# Datasource Validation Specification

## Purpose

Validates the `datasource.provider` value and rejects multiple `datasource` blocks in one schema. Does NOT touch `generator.provider`, whose value domain (`"indigodb-client-ts"`) is unrelated and out of scope.

## Requirements

### Requirement: `provider` accepts only `"postgresql"`

The compiler MUST accept `"postgresql"` as the only valid `datasource.provider` value. Any other value, including an absent/empty provider, MUST produce a diagnostic naming the invalid value and stating `postgresql` as the only supported provider.

#### Scenario: Valid provider

- GIVEN `datasource db { provider = "postgresql" url = env("DATABASE_URL") }`
- WHEN the schema is validated
- THEN no datasource diagnostic is produced

#### Scenario: Unsupported provider

- GIVEN `datasource db { provider = "mysql" url = env("DATABASE_URL") }`
- WHEN the schema is validated
- THEN a diagnostic is produced naming `"mysql"` and stating `"postgresql"` is the only supported provider

#### Scenario: Missing provider

- GIVEN a `datasource` block with no `provider` assignment
- WHEN the schema is validated
- THEN a diagnostic is produced, since the empty default does not equal `"postgresql"`

### Requirement: Only one `datasource` block is allowed

The compiler MUST produce a diagnostic when a schema declares more than one `datasource` block, instead of silently keeping only the first and dropping the rest.

#### Scenario: Duplicate datasource blocks

- GIVEN a schema with `datasource db1 { provider = "postgresql" ... }` and `datasource db2 { provider = "postgresql" ... }`
- WHEN the schema is validated
- THEN a diagnostic is produced naming both datasource block names and stating only one `datasource` block is supported

### Requirement: `generator.provider` is out of scope for this validation

Datasource provider validation MUST NOT apply to `generator` blocks; `generator.provider` (e.g. `"indigodb-client-ts"`) has a distinct, unrelated value domain and remains unvalidated by this change.

#### Scenario: Generator provider is untouched

- GIVEN `datasource db { provider = "postgresql" ... }` and `generator client { provider = "indigodb-client-ts" ... }` in the same schema
- WHEN the schema is validated
- THEN no diagnostic is produced for `generator.provider`, regardless of its value
