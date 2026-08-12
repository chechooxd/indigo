# Parser Panic Safety Specification

## Purpose

Defines the property-based test that MUST prove the `.indigo` parser never
panics on malformed or adversarial input. A parser panic in WASM aborts the
Studio, the CLI, and every consumer sharing that WASM instance at once, so
this capability governs testing-depth guarantees only — it does not change
parser behavior. Any genuine panic discovered by this property test is a
finding to report, not a defect to fix within this change.

## Requirements

### Requirement: Panic-freedom property test

The test suite MUST include a `proptest`-based property test asserting that
`parse_source` returns a `Result` (either `Ok` with a parsed schema, or `Err`
with a clean parse error) for any generated `.indigo`-shaped input string,
and MUST NOT panic.

#### Scenario: Arbitrary generated input never panics

- GIVEN a `.indigo`-shaped input string produced by the property test's `Strategy`
- WHEN `parse_source` is called with that input
- THEN the call returns a `Result` value
- AND no panic, abort, or unwind occurs

### Requirement: Input strategy is biased toward valid token shapes

The property test's input `Strategy` MUST be biased toward `.indigo`-shaped
tokens — keywords (`Table`, `enum`, `datasource`, `generator`), braces,
identifiers, and common attribute names (`@id`, `@relation`, `@default`,
`@@index`, etc.) — rather than uniformly random bytes, so the generated
inputs exercise the parser's recovery paths beyond immediate lexer failure.

#### Scenario: Strategy generates structured near-valid input

- GIVEN the property test's `Strategy` definition
- WHEN a sample input is generated
- THEN the input is composed from `.indigo` keyword, brace, identifier, and attribute-name building blocks
- AND a uniformly random byte strategy is not used as the sole input source

### Requirement: Bounded, CI-reasonable case count

The property test MUST run a fixed, explicitly stated number of generated
cases (target: 256) rather than an unstated or framework-default count, to
keep `cargo test` runtime predictable in CI.

#### Scenario: Case count is explicit and bounded

- GIVEN the property test configuration
- WHEN inspecting its `ProptestConfig` (or equivalent)
- THEN the configured case count is an explicit number (256, or another value the change documents and justifies)
- AND `cargo test` completes within a time budget consistent with the rest of the `crates` test suite

### Requirement: A found panic is a reported finding, not an in-change fix

If the property test discovers a genuine parser panic, the test MUST fail
loudly (no silent catching, no `catch_unwind` suppression), and the failure
MUST be reported as a finding for a separate follow-up change rather than
fixed within this change.

#### Scenario: Discovered panic fails the test and is reported

- GIVEN the property test finds an input that panics `parse_source`
- WHEN `cargo test` runs
- THEN the test fails with the minimized panicking input
- AND the panic is NOT caught or suppressed
- AND the change's outcome reports the finding for a follow-up change instead of patching the parser here

#### Scenario: No panic found

- GIVEN the property test runs its full configured case count without a panic
- WHEN `cargo test` completes
- THEN the test passes
- AND no source under `crates/*/src/` is modified as a result
