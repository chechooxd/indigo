# CI Pipeline Specification

## Purpose

Run build, lint and tests automatically on every push to `main` and every
pull request, replacing the current fully manual, single-machine quality
control with an enforced, repeatable check.

## Requirements

### Requirement: Pipeline triggers

The CI workflow MUST run on `push` to `main` and on `pull_request`.

#### Scenario: Push to main triggers CI

- GIVEN a commit is pushed directly to `main`
- WHEN the push completes
- THEN the CI workflow MUST run

#### Scenario: Pull request triggers CI

- GIVEN a pull request is opened or updated against any base branch
- WHEN the PR event fires
- THEN the CI workflow MUST run

#### Scenario: Push to a non-main branch does not trigger CI

- GIVEN a commit is pushed to a branch other than `main` with no open pull request
- WHEN the push completes
- THEN the CI workflow MUST NOT run for that push

### Requirement: TS job stays Rust-free

The TS job MUST install dependencies, build, lint and test the workspace,
and MUST NOT install or require any Rust toolchain (`cargo`, `rustc`, or
`rustup`).

#### Scenario: TS job succeeds without Rust installed

- GIVEN the TS job's runner has no Rust toolchain installed and none is added during the job
- WHEN `pnpm install`, `pnpm build`, `pnpm lint`, and `pnpm test` run
- THEN all four MUST succeed using only the committed `packages/compiler/wasm/` artifact

#### Scenario: A TS job step requiring Rust is a contract violation

- GIVEN the TS job workflow definition
- WHEN it is inspected for any step invoking `cargo`, `rustc`, `rustup`, or installing a Rust toolchain action
- THEN no such step MUST be present, because the committed WASM artifact exists precisely so TS-only contributors need no Rust

### Requirement: Rust job runs cargo test

The Rust job MUST run `cargo test --locked` against `crates/indigo-compiler`.

#### Scenario: Rust job passes on unmodified source

- GIVEN `crates/indigo-compiler` source is unchanged from `main`
- WHEN the Rust job runs `cargo test --locked`
- THEN it MUST pass and MUST NOT run `cargo update`

#### Scenario: Rust job fails on a broken change

- GIVEN a pull request introduces a failing Rust test
- WHEN the Rust job runs
- THEN it MUST fail and the overall workflow run MUST report failure

### Requirement: WASM drift job

A dedicated job MUST rebuild `packages/compiler/wasm/` from
`crates/indigo-compiler/src` using the pinned toolchain and assert no diff
against the committed artifact.

#### Scenario: Drift job passes when artifact matches source

- GIVEN the committed `packages/compiler/wasm/` was produced by the pinned toolchain from the current `crates/indigo-compiler/src`
- WHEN the drift job rebuilds the artifact and runs `git diff --exit-code`
- THEN the job MUST pass

#### Scenario: Drift job fails when Rust changed without a rebuild

- GIVEN `crates/indigo-compiler/src` was edited but `packages/compiler/wasm/` was not regenerated and committed
- WHEN the drift job runs
- THEN it MUST fail

### Requirement: Any failing job fails the run

If any of the three jobs (TS, Rust, WASM drift) fails, the overall workflow
run MUST report failure.

#### Scenario: One red job reds the whole run

- GIVEN the TS and Rust jobs pass but the WASM drift job fails
- WHEN the workflow run completes
- THEN the overall run status MUST be failure
