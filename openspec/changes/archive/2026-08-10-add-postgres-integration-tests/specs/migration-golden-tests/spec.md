# Delta for Migration Golden Tests

## MODIFIED Requirements

### Requirement: Golden fixtures pin generated text, applicability is proven separately

Golden fixtures assert exact SQL **text** (or diagnostic content) produced by
the migrator; passing this suite alone MUST NOT be read as proof that the
DDL applies successfully against a real PostgreSQL server — that proof is
the responsibility of the `migration-appliability-tests` capability, which
executes the same fixtures against a real PostgreSQL engine (PGlite).

(Previously: this requirement stated "No PostgreSQL instance runs in this
suite or in CI" and named integration testing as an unscoped follow-up.
That is now factually superseded — a PostgreSQL engine does run, in the
sibling `migration-appliability-tests` suite. This requirement is narrowed
to describe what the golden suite itself still does: pin text, not prove
execution.)

#### Scenario: Text-correct fixture with separately-verified applicability

- GIVEN a fixture asserting exact SQL text for a diff that is textually correct per manual review of PostgreSQL semantics
- WHEN the golden harness passes
- THEN this confirms the text matches the approved golden — it does NOT by itself confirm the SQL executes successfully; that confirmation comes from the `migration-appliability-tests` suite, which runs the same fixture's DDL against a real PostgreSQL engine
