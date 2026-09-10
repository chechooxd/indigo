# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

IndigoDB is a schema-first database toolkit built around a custom `.indigo` schema language.
It is a **pnpm + Turborepo monorepo** (`packageManager: pnpm@10.28.1`) with ESM-only TypeScript
packages, plus one Rust crate: the `.indigo` compiler (`crates/indigo-compiler`), compiled to
WASM and consumed through `packages/compiler`.

## Commands

All commands run from the repo root and fan out through Turborepo:

- `pnpm install` — install workspace deps
- `pnpm dev` — run all `dev` tasks (Studio dev server on :5555); `dev` depends on `^build`
- `pnpm build` — build every package (`tsc`) and the Studio app (`tsc -b && vite build`)
- `pnpm lint` — typecheck-as-lint: every package's `lint` is `tsc --noEmit`, except
  `apps/studio`, whose `lint` is `tsc -b --noEmit`. The `-b` is load-bearing there: Studio's
  root `tsconfig.json` is `files: []` plus project references, and plain `tsc --noEmit` does
  not follow references — it silently typechecked **zero** files, so a blatant type error
  passed `pnpm lint` with exit 0. `pnpm build` (`tsc -b && vite build`) always did catch it;
  lint did not. Don't drop the `-b`.
- `pnpm test` — wired via Turbo (`turbo test`, depends on `build`) and fans out to every
  package's own plain-Node test script (no shared runner/framework — each package's `test`
  is a `node test/a.mjs && node test/b.mjs && ...` chain, plus `apps/studio`'s `vitest run`).
  Run a single file directly, e.g. `node packages/client/test/live.mjs`, or scope one
  package with `pnpm test --filter=@indigodb/client`. `@indigodb/compiler`'s suite
  (`test/parity.mjs`) checks the WASM artifact against golden snapshots in
  `fixtures/snapshots/`. `@indigodb/realtime`'s Postgres-backed suites (`wal-source.mjs`,
  `pg-harness.mjs`) are gated on `INDIGODB_TEST_DATABASE_URL` — unset, they print `SKIP` and
  pass; to actually exercise them, point that env var at a real Postgres (see the docker
  one-liner in `packages/realtime/test/pg-harness.mjs`'s header).
- `pnpm clean` — remove `dist/` and `.turbo/` across packages

Rust compiler workflow (build:wasm, freshness guard, CI notes) is documented in
`crates/CLAUDE.md` — only loads when working under `crates/`.

Scope to one package with Turbo filters, e.g. `pnpm build --filter=@indigodb/parser`
or `pnpm --filter @indigodb/studio dev`.

## CI

**GitHub Actions is disabled; verification runs locally instead.** The workflow was moved to
`.github/workflows-disabled/ci.yml` in commit `8acd5d4` ("private pre-product repo, billed
minutes with no payoff yet"), and `.github/workflows/` is empty. Verification is
local: `pnpm build`, `pnpm lint`, `pnpm test` before landing on `main`.

The checks themselves survived the switch-off; what was missing was a trigger, so
**`.githooks/pre-push` runs all three on every push**. It is wired by the root `prepare`
script (`git config core.hooksPath .githooks`), which pnpm runs on install — so a fresh clone
arms it after `pnpm install`, with no per-clone setup step to forget. It runs on push rather
than commit deliberately: the full suite is ~8 minutes, and a hook that blocks every commit for
that long gets bypassed and then abandoned. Use `SKIP_PREPUSH=1 git push` when you genuinely
need to bypass it — greppable in shell history, and it skips only this hook, unlike
`--no-verify`.

Each CI job now has a local equivalent: `ts` is the hook's build/lint/test; `rust` is
`cd crates && cargo test`; and `wasm-drift` — the one guarantee that could not survive being
switched off, nobody noticing a stale WASM artifact — is enforced by
`packages/compiler/test/wasm-freshness.mjs` (see the `build:wasm` bullet above).

That gap — reproducibility from a clean clone — is covered by
[`act`](https://nektosact.com), configured in `.actrc`: **`pnpm ci:local`** runs the real
workflow's `ts` job in a container, installing with `--frozen-lockfile` from scratch. That is
precisely the check a warm local install hides. The hook is the cheap trigger on every push; act
is the expensive, occasional check in a clean environment.

**Run `pnpm ci:local`, never a bare `act`.** A bare `act` runs every job, and `wasm-drift` must
not run locally: its self-heal step fires when the rebuild differs from the committed artifact AND
the event is a push AND the actor is not `github-actions[bot]` — under act the last two are true by
default, and the first is all but guaranteed, since this workflow's own header states identical
toolchains produce different bytes on different hosts. It would then `git commit` as the bot and
`git push origin HEAD:main`; the push fails without credentials, but under `act --bind` the commit
can land in your real tree. That job assumes CI is the canonical source of those bytes — a premise
that is false locally. Staleness is already covered by `wasm-freshness.mjs`.

**`pnpm clean && pnpm build` does NOT purge stale build output.** Turbo caches build outputs and
restores `dist/` wholesale on a cache hit, stale files included — `clean` removes the directory,
then the very next build puts the same dead files back. This is not theoretical: it was found by
diffing act's container build against the local one, which disagreed on two packages.
`packages/parser/dist/` still carried `lexer.js`/`parser.js` (the pre-Rust Chevrotain lexer and
parser) and `packages/core/dist/legacy/` still carried the pre-Rust resolver/validator, long after
those sources were deleted — 32 dead files that a publish from that machine would have shipped.
The cure is **`pnpm clean && pnpm build --force`**; do that before any real publish. The
`check-pack-contents` guard counts what is in `dist/`, so it cannot tell fresh output from
resurrected output on its own.

If it is re-enabled, move the file back; it still describes three independent jobs (no
`needs:`, so one red job never hides another):

- **`ts`** — `pnpm install/build/lint/test`. Installs **no** Rust toolchain, deliberately: the
  committed WASM artifact exists so TypeScript-only contributors never need cargo. If this job
  ever grows a Rust step, committing the artifact stops buying anything.
- **`rust`** — `cargo test --locked`. `--locked` is what actually pins `wasm-bindgen`, since the
  manifest carries a caret range and only the committed lockfile holds it at 0.2.126.
- **`wasm-drift`** — rebuilds the artifact. On `push` to `main`, if the rebuild differs from what's
  committed, it commits its own rebuild back as `github-actions[bot]` (loop-guarded: a commit
  already authored by the bot that still doesn't match fails loudly instead of committing forever).
  On a PR, it only reports drift — pushing to a PR branch isn't safe, especially from a fork.

Build order matters: `@indigodb/ast` is the base type contract; `@indigodb/core`
(the relational IR + resolver) sits on top of `ast` + `parser` and is the hub every other
package consumes. Turbo's `^build` handles ordering, so build from the root rather than
per-package when types cross package boundaries.

## Architecture

The whole system speaks **one `.indigo` language** (Prisma-style). The pipeline is:
`parser` (source → AST) → `core` (AST → resolved relational IR) → consumers
(`migrator`, `generator`, `docs`, `client`, `studio`). **`@indigodb/core`'s `ResolvedSchema`
is the central contract** — when adding a feature, resolve it once in `core` and let consumers
read the IR rather than re-deriving structure from the raw AST.

### Packages (`packages/*`) and the Studio app

Per-package detail lives in `packages/CLAUDE.md`; the Studio SPA and its CLI-side
server live in `apps/studio/CLAUDE.md`. Both load automatically when you work under
those directories, the same way `crates/CLAUDE.md` does for the Rust compiler.

Build order matters regardless of which one you are in: `@indigodb/ast` is the base
type contract; `@indigodb/core` (the relational IR + resolver) sits on top of `ast` +
`parser` and is the hub every other package consumes. Turbo's `^build` handles
ordering, so build from the root rather than per-package when types cross package
boundaries.

## Conventions

- ESM only (`"type": "module"`); packages compile with `tsc` to `dist/`, `strict` mode on.
- Packages reference each other via `workspace:*` and consume built output (`dist/`), so a
  cross-package type change needs a rebuild of the dependency before dependents see it.
