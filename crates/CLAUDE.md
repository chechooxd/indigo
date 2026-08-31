# CLAUDE.md (crates/)

Moved here from the root `CLAUDE.md` — this only matters when touching `crates/`, so it
loads only for sessions working under this directory.

Rust compiler (requires `cargo`, the `wasm32-unknown-unknown` target and `wasm-pack`):

- `cd crates && cargo test` — native tests over the shared `fixtures/*.indigo` corpus
- `pnpm --filter @indigodb/compiler build:wasm` — rebuild the WASM artifact. **The artifact
  (`packages/compiler/wasm/`) is committed** so TS-only devs and CI never need the Rust
  toolchain — if you change `crates/`, you MUST run `build:wasm` and commit the result,
  then run the regression harness. Regenerate golden snapshots only on intentional contract
  changes (`node packages/compiler/test/regen-snapshots.mjs`; the diff is the review artifact).
  **This rule is enforced locally by `packages/compiler/test/wasm-freshness.mjs`**, which runs
  first in `@indigodb/compiler`'s `test` script (so on every `pnpm test`). It does NOT diff the
  `.wasm` bytes — those are not reproducible across machines: `build:wasm` sets
  `RUSTFLAGS=--remap-path-prefix` so the artifact never embeds your `$HOME`, but even past that,
  identical rustc/wasm-pack/wasm-bindgen still produce different bytes on different host OSes
  (low-level codegen ordering). Instead it hashes the **inputs** — every `.rs`/`Cargo.toml`,
  `crates/Cargo.lock` and `rust-toolchain.toml` — into `packages/compiler/wasm-sources.sha256`,
  which `build:wasm` rewrites on every rebuild. Sources moved but artifact didn't ⇒ the test
  fails and tells you to rebuild. That is the failure that actually bites: without it, editing
  `crates/` and forgetting the rebuild leaves every TypeScript test passing against the **stale**
  compiler — green and wrong. It proves freshness, not byte-correctness; hermetic byte
  verification stays out of scope (see `rust-toolchain.toml`'s header).
  Because `crates/` lives outside every package, Turbo would otherwise replay a cached `test`
  and never run the guard, so the Rust sources are declared in `turbo.json`'s
  `globalDependencies` — don't remove them, that silently disarms the check.
  **CI is currently disabled** (`.github/workflows-disabled/`, commit `8acd5d4`), so its
  `wasm-drift` job — which used to be the source of truth for the exact bytes and self-healed
  `main` on push — is not running. If you re-enable it, it and this local guard are
  complementary: the guard catches "you forgot to rebuild", CI catches "your bytes differ".
  The toolchain is still pinned (`rust-toolchain.toml` → rustc 1.93.1, wasm-pack 0.15.0,
  wasm-bindgen 0.2.126 via the committed `crates/Cargo.lock`) to keep local dev and CI on the same
  footing. `build:wasm` uses `$(pwd)` and `rm -f`, so it is Unix-only — it would need adjusting
  before a Windows runner could be added.
