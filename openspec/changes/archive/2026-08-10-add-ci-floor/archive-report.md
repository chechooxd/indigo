# Archive Report: add-ci-floor

## Status

Complete. Closed iteratively against live CI feedback rather than through a
formal `sdd-verify` pass — this is noted honestly rather than backfilled.

## What shipped

Three independent GitHub Actions jobs (`ts`, `rust`, `wasm-drift`) plus toolchain
pinning (`rust-toolchain.toml`, `engines.node`). Full history in `tasks.md` and
the six `ci:`-prefixed commits on `main` (`dc76c1e` through `4b9abc1`).

## Why this wasn't a standard verify → archive cycle

The first three real CI runs each surfaced something the planning phase could
not have found without a live GitHub Actions runner:

1. **Run 1** — the `wasm-drift` job failed with a genuine toolchain-vs-artifact
   mismatch: `$HOME/.cargo/registry/src` paths embedded in the WASM binary,
   different on every machine. Fixed via `RUSTFLAGS=--remap-path-prefix` in
   `build:wasm`.
2. **Run 2** — still failed after the path fix. Diagnosed as low-level
   LLVM/rustc codegen non-determinism between macOS and the Linux runner, not
   a configuration problem. This was a genuine architecture question (chase
   full cross-host byte-determinism, or redesign the check), surfaced to the
   user, who chose: **CI is the source of truth for the artifact's bytes**.
   The `wasm-drift` job was redesigned to self-heal on push to `main` instead
   of failing on cross-host noise, with a loop guard against runaway commits.
3. **Run 3** — the self-heal path itself had a wrong assumption in its own
   documentation (claimed the bot's push would trigger a fresh verifying run;
   `GITHUB_TOKEN` pushes deliberately don't chain workflow runs). Caught and
   corrected before it could mislead a future reader.

Each of these was validated against a real CI run, which is a stronger
verification signal than a `sdd-verify` agent could produce locally (no GitHub
Actions runner available offline). Formal specs (`ci-pipeline`,
`toolchain-pinning`, `wasm-artifact-integrity`) were written and promoted to
`openspec/specs/` retroactively as part of this archive, so the capability
contract exists going forward even though the original delivery didn't route
through the standard phase sequence.

## Final state (verified at archive time)

- Three CI jobs green on `main` at `e69fad8` and every commit since.
- `wasm-drift` confirmed stable Linux-to-Linux (self-heal skipped, `matches:
  true`) on the two most recent real pushes.
- No known open issues.

## Follow-ups

None blocking. Cross-host (macOS-to-Linux) WASM byte-determinism remains
unsolved and undocumented as a non-goal — contributors rebuild locally to
develop and test, but `main`'s committed bytes are CI's own build, never a
laptop's.
