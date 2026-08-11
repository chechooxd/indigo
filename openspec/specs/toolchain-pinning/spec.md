# Toolchain Pinning Specification

## Purpose

Declare, in-repo and machine-readable, the exact Rust, wasm-pack and Node
versions the project builds with. Pinning is a precondition for the WASM
drift check: rebuild-and-diff is only meaningful when every runner uses the
same toolchain that produced the committed artifact.

## Requirements

### Requirement: Rust toolchain pin

The repository MUST declare a `rust-toolchain.toml` at the repo root pinning
rustc `1.93.1` and the `wasm32-unknown-unknown` target.

#### Scenario: Local or CI invocation of cargo/rustup picks up the pin

- GIVEN `rust-toolchain.toml` exists at the repo root with `channel = "1.93.1"` and target `wasm32-unknown-unknown`
- WHEN any `cargo` or `rustup` command runs inside the repo
- THEN the toolchain resolved MUST be rustc 1.93.1 with the `wasm32-unknown-unknown` target installed

### Requirement: wasm-pack version pin

The repository MUST declare the exact wasm-pack version (`0.15.0`) used to
produce the committed WASM artifact, in a location CI reads to install it.

#### Scenario: CI installs the declared wasm-pack version

- GIVEN the declared wasm-pack version is `0.15.0`
- WHEN the WASM drift job installs wasm-pack
- THEN it MUST install exactly `0.15.0`, not a floating "latest"

### Requirement: Node engine floor

Root `package.json` MUST declare `engines.node: ">=22"`.

#### Scenario: Node floor is machine-readable

- GIVEN root `package.json` declares `"engines": { "node": ">=22" }`
- WHEN a tool or CI job inspects the repo's Node requirement
- THEN it MUST read `>=22` from `package.json` without needing external docs

### Requirement: Pins match the artifact-producing toolchain

The declared Rust and wasm-pack versions MUST be the exact combination
verified to reproduce the committed `packages/compiler/wasm/` artifact
byte-for-byte (rustc 1.93.1 + wasm-pack 0.15.0 + wasm-bindgen 0.2.126,
verified via SHA-256 `518f786a4cbbeaa5…` in this change's exploration).

#### Scenario: Pinned toolchain reproduces the committed artifact

- GIVEN a clean checkout using the pinned rustc and wasm-pack versions
- WHEN `packages/compiler/wasm/` is rebuilt from `crates/indigo-compiler/src`
- THEN the rebuilt output MUST be byte-identical to the committed artifact

#### Scenario: Pin drift is a false-positive source, not a real defect

- GIVEN a runner uses an unpinned or different toolchain version
- WHEN the WASM drift check runs
- THEN it MAY fail even though `crates/indigo-compiler/src` was not edited, because the toolchain itself does not match the pin
