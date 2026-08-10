# Proposal: CI Floor

## Intent

No `.github/` exists: nothing runs build, lint or tests on any commit or PR. Every quality control is voluntary, on one machine, on one toolchain. The repo gained its first remote this session, so a workflow finally has somewhere to run.

The load-bearing problem is **Rust→WASM drift**. `packages/compiler/wasm/` is a deliberately committed build artifact so TS-only contributors never need the Rust toolchain — but nothing compares it against `crates/indigo-compiler/src`. Editing the Rust, passing `cargo test` (new code) and `pnpm test` (stale binary), then committing ships behaviour no test exercised. CLAUDE.md states the manual rebuild rule with zero mechanical enforcement.

A rebuild-and-diff job closes this, but only if the toolchain is pinned to exactly what produced the committed bytes; otherwise the job is permanently red. Pinning is therefore a precondition, not an extra. Reproducibility was verified this session: rebuilding with rustc 1.93.1 + wasm-pack 0.15.0 + wasm-bindgen 0.2.126 produced byte-identical output (SHA-256 `518f786a4cbbeaa5…`).

## Scope

### In Scope
- `rust-toolchain.toml` pinning `1.93.1` and the `wasm32-unknown-unknown` target.
- Pin the wasm-pack version CI installs; declare `engines.node` in the root `package.json`.
- `.github/workflows/ci.yml` with three jobs on push and pull_request:
  - **TS** — install, `pnpm build`, `pnpm lint`, `pnpm test`; deliberately Rust-free.
  - **Rust** — `cd crates && cargo test`.
  - **WASM drift** — `pnpm --filter @indigodb/compiler build:wasm` then `git diff --exit-code -- packages/compiler/wasm/`.

### Out of Scope
- Release automation / npm publishing (independently blocked: `@indigodb/cli` depends on `private: true` `@indigodb/studio`).
- Coverage measurement, dependency-audit automation.
- OS/Node matrices beyond one baseline.
- LICENSE file (adjacent, its own change).

## Capabilities

### New Capabilities
- `toolchain-pinning`: the exact Rust, wasm-pack and Node versions the project builds against are declared in-repo and machine-readable.
- `ci-pipeline`: build, lint and tests run automatically on every push and pull request.
- `wasm-artifact-integrity`: the committed WASM artifact is mechanically proven to match `crates/indigo-compiler` source.

### Modified Capabilities
- None.

## Approach

Pin first, then verify. The pins encode a measured, reproducible combination rather than a guess. CI mirrors the documented local workflow one-to-one so a green pipeline means the same thing as a green machine.

Three independent jobs, not one, so a Rust failure never masks a TS failure and the TS job stays installable without `cargo`. The drift job asserts the invariant CLAUDE.md only asks for: rebuild, then fail if the tree is dirty.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `.github/workflows/ci.yml` | New | Three-job pipeline |
| `rust-toolchain.toml` | New | Pins 1.93.1 + wasm target |
| `package.json` | Modified | Adds `engines.node` |

No source under `packages/`, `apps/` or `crates/` changes.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Drift job red from toolchain mismatch, not real drift | Med | Pins derived from a verified byte-identical rebuild; failure message must name both causes |
| `cargo update` moves wasm-bindgen off 0.2.126 and changes bytes | Low | `crates/Cargo.lock` is committed and CI must not update it |
| PGlite suite (~70s) slows every PR | Low | Accepted; no Docker or service container needed |
| `build:wasm` uses shell `$(pwd)`/`rm` | Low | CI runs on Linux with bash |

## Rollback Plan

Delete `.github/workflows/ci.yml` (or disable the workflow in repo settings) and revert `rust-toolchain.toml` plus the `engines.node` addition. Nothing in the build pipeline or published artifacts depends on these files, so removal restores the exact prior state.

## Dependencies

- GitHub remote `chechooxd/indigo` (exists, private) with Actions enabled.

## Success Criteria

- [ ] A pull request that changes `crates/` without rebuilding the WASM artifact fails CI.
- [ ] A pull request that changes `crates/` *with* a committed rebuild passes CI.
- [ ] The TS job completes without any Rust toolchain installed.
- [ ] `pnpm build`, `pnpm lint` and `pnpm test` all run and pass on `main`.
- [ ] Rust, wasm-pack and Node floors are all readable from repo files.
