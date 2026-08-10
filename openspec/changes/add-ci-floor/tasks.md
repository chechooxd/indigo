# Tasks: CI Floor

> `sdd-design` was deliberately skipped for this change: every architectural
> question (blocking vs advisory drift check, trigger set, PGlite placement,
> node/rust/wasm-pack pins, lockfile policy, Rust-free TS job) was already
> resolved during proposal/spec with measured evidence (byte-identical
> rebuild, SHA-256 `518f786a4cbbeaa5…`) and no remaining fork. This is
> recorded explicitly so the skip is auditable, not silent.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~90-130 (3 new/modified config files, no source touched) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main (single slice) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: stacked-to-main
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Toolchain pins + engines.node + CI workflow (3 jobs) | PR 1 | `pnpm build && pnpm lint && pnpm test`; `cd crates && cargo test --locked` | Local drift RED/GREEN proof (see 3.1-3.3); GH Actions run on push | Delete `.github/workflows/ci.yml`, revert `rust-toolchain.toml` and `engines.node`; no other file depends on them |

Single PR is sufficient: 3 files, no production code, no shared-state risk. Stacks on `test/migrator-postgres-appliability` (HEAD `ffcf7f6`).

## Phase 1: Toolchain Pinning (Foundation)

- [x] 1.1 Create `rust-toolchain.toml` at repo root pinning `channel = "1.93.1"` and `targets = ["wasm32-unknown-unknown"]`. Satisfies `toolchain-pinning` req "Rust toolchain pin".
- [x] 1.2 Add `"engines": { "node": ">=22" }` to root `package.json`. Satisfies `toolchain-pinning` req "Node engine floor".
- [x] 1.3 Confirm `crates/Cargo.lock` is committed and untouched (wasm-bindgen held at 0.2.126); do not run `cargo update`. Satisfies `toolchain-pinning` req "Pins match the artifact-producing toolchain".

## Phase 2: CI Workflow

- [x] 2.1 Create `.github/workflows/ci.yml` with `on: push: branches: [main]` and `on: pull_request`. Satisfies `ci-pipeline` req "Pipeline triggers".
- [x] 2.2 Add `ts` job: checkout, pnpm setup (via `packageManager` field, no cargo/rustc/rustup step), `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm test`. Satisfies `ci-pipeline` req "TS job stays Rust-free".
- [x] 2.3 Add `rust` job: checkout, install rustup toolchain from `rust-toolchain.toml`, `cd crates && cargo test --locked`. Satisfies `ci-pipeline` req "Rust job runs cargo test".
- [x] 2.4 Add `wasm-drift` job: checkout, install pinned Rust toolchain + wasm-pack 0.15.0 + wasm32-unknown-unknown target, `pnpm --filter @indigodb/compiler build:wasm`, then `git diff --exit-code -- packages/compiler/wasm/`; on failure print message naming both possible causes (stale artifact not rebuilt / runner toolchain mismatch vs pin). Satisfies `ci-pipeline` req "WASM drift job" and `wasm-artifact-integrity` reqs "Rebuild-and-diff check" + "Actionable dual-cause failure message".
- [x] 2.5 Verify all three jobs run independently (no `needs:` chaining) so one red job never masks another. Satisfies `ci-pipeline` req "Any failing job fails the run".

## Phase 3: Local Verification (the genuine RED/GREEN this change permits)

- [x] 3.1 RED: locally edit a trivial line in `crates/indigo-compiler/src` (e.g. a comment) WITHOUT rebuilding `packages/compiler/wasm/`; run `pnpm --filter @indigodb/compiler build:wasm && git diff --exit-code -- packages/compiler/wasm/` and confirm it exits non-zero — this is the drift check's failure path.
- [x] 3.2 Confirm the failure surface names both causes (stale artifact vs toolchain mismatch) per `wasm-artifact-integrity` — if the raw `git diff --exit-code` output alone doesn't, wrap it in the workflow step with an explanatory `echo`/`if` block before the diff (documented as part of 2.4, verified here).
- [x] 3.3 GREEN: revert the trivial edit, rerun `pnpm --filter @indigodb/compiler build:wasm && git diff --exit-code -- packages/compiler/wasm/`, confirm exit 0 and `git status` clean.
- [x] 3.4 Run all four gates at HEAD locally to reconfirm baseline still green before pushing: `pnpm build`, `pnpm lint`, `pnpm test`, `cd crates && cargo test --locked`.
- [x] 3.5 Validate `.github/workflows/ci.yml` is well-formed YAML (`node -e "require('yaml').parse(...)"` or `yamllint`/GH Actions online linter) and that every command in it matches an already-verified local command from 3.4 and 3.1-3.3.

## Phase 4: Documentation

- [x] 4.1 Add a short note to `CLAUDE.md` (or a `.github/workflows/ci.yml` header comment) documenting the known non-portability limitation: `build:wasm` uses `$(pwd)` and `rm -f`, correct on Linux CI/Unix dev, would need adjustment if a Windows runner is ever added. Satisfies `wasm-artifact-integrity` req "Documented non-portability limitation".
- [ ] 4.2 Push the branch, open the PR against `main` from `test/migrator-postgres-appliability`, and confirm the three jobs appear and run (do not require branch protection — out of scope per settled decisions).
