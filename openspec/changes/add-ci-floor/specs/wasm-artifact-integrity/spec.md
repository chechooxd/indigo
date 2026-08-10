# WASM Artifact Integrity Specification

## Purpose

Mechanically prove that the committed `packages/compiler/wasm/` artifact
matches its `crates/indigo-compiler/src` source, closing the gap where
Rust changes can ship with a stale, untested WASM binary.

## Requirements

### Requirement: Rebuild-and-diff check

The system MUST rebuild `packages/compiler/wasm/` from
`crates/indigo-compiler/src` using the pinned toolchain, then run
`git diff --exit-code` scoped to `packages/compiler/wasm/`, treating any
diff as failure.

#### Scenario: Clean rebuild passes

- GIVEN the committed WASM artifact was generated from the current Rust source with the pinned toolchain
- WHEN the artifact is rebuilt and diffed
- THEN `git diff --exit-code -- packages/compiler/wasm/` MUST exit `0`

#### Scenario: Stale artifact fails

- GIVEN `crates/indigo-compiler/src` changed since the last commit to `packages/compiler/wasm/`
- WHEN the artifact is rebuilt and diffed
- THEN `git diff --exit-code -- packages/compiler/wasm/` MUST exit non-zero and the job MUST fail

### Requirement: Actionable dual-cause failure message

When the drift check fails, the failure output MUST explicitly name both
possible causes: (a) the committed artifact is stale because Rust source
was edited without a rebuild, and (b) the runner's toolchain does not
match the pinned toolchain that produced the committed bytes. A bare
"files differ" message is insufficient because the two causes require
different fixes and the diff alone cannot distinguish them.

#### Scenario: Failure message states both causes

- GIVEN the drift check fails for any reason
- WHEN the failure output is inspected
- THEN it MUST state that the diff may indicate either a stale artifact (edit Rust, forgot to rebuild) or a toolchain mismatch (runner not on the pinned rustc/wasm-pack version)

#### Scenario: Ambiguity is inherent, not a check defect

- GIVEN a diff exists between the rebuilt and committed artifact
- WHEN determining root cause
- THEN the check itself MUST NOT claim to distinguish stale-artifact from toolchain-mismatch automatically — that determination is left to the developer investigating the failure

### Requirement: Documented non-portability limitation

The `build:wasm` script's use of shell-specific `$(pwd)` and `rm -f` MUST be
recorded as a known limitation: correct for the Linux CI runner and local
Unix-like development, but non-portable if a Windows runner is ever added
to the matrix. This is documentation, not a defect requiring a fix in this
change.

#### Scenario: Limitation is documented, not silently broken

- GIVEN the `build:wasm` script uses `$(pwd)` and `rm -f`
- WHEN a Windows runner is proposed for a future CI matrix
- THEN the existing documented limitation MUST inform that proposal instead of surfacing as a surprise CI failure
