# Tasks: Workspace-Wide Tarball Allowlists

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~140 (8 one-line manifest edits + one guard script) |
| Review budget (this project) | 800 |
| 800-line budget risk | Low |
| Chained PRs recommended | No — single PR |
| Delivery strategy | single PR |
| Decision needed before apply | No |

Route: **delegated-direct, not a full SDD phase chain.** The mechanism was already settled by the
archived `unblock-publishing` precedent (`files` allowlist + `npm pack --dry-run` verification), so
a proposal/design round would have reduced no ambiguity. These artifacts record the change because
it establishes a normative capability, not because the route required them.

## Phase 1: Allowlists

- [x] 1.1 Add `"files": ["dist"]` to `ast`, `cli`, `client`, `core`, `generator`, `migrator`,
      `parser`, `realtime`. Verified first that every one resolves `main`, `exports` and (`cli`)
      `bin` entirely from `dist/`, and that none carries a non-`dist` runtime asset the way
      `compiler` carries `wasm/`.
- [x] 1.2 Leave `compiler` (`["dist","wasm"]`) and `studio` (`["dist"]`) untouched — the precedent.

## Phase 2: The guard

- [x] 2.1 Add `scripts/check-pack-contents.mjs`: enumerate non-private workspace packages, require
      a non-empty `files` array, run `npm pack --dry-run --json`, reject any path outside the
      declared roots plus npm's automatic inclusions.
- [x] 2.2 Also require each package's own `main`/`bin` targets to be present in the tarball —
      without this, an allowlist naming the wrong directory yields no strays and passes.
- [x] 2.3 Wire it into the root `test` script (`turbo test && node scripts/check-pack-contents.mjs`)
      so it covers `ast` and `parser`, which have no `test` script to host a per-package check.

## Phase 3: Verification

- [x] 3.1 Measure every tarball before and after. `migrator` 191 files / 642 kB → 25 / 222 kB;
      `cli` 58 / 745 kB → 25 / 254 kB; `client` 102 / 840 kB → 54 / 321 kB;
      `realtime` 48 / 368 kB → 25 / 108 kB.
- [x] 3.2 Prove the guard bites, by mutation:
      - removing `files` from `migrator` → FAIL, "no `files` allowlist";
      - setting `files: ["src"]` → FAIL, "does not ship its own entry point(s): dist/index.js".
      Both reverted; guard green again afterwards.
- [x] 3.3 `pnpm build` 10/10, `pnpm lint` 19/19, `pnpm test --force` 18/18, exit 0, guard green
      across all ten packages including `compiler`'s `dist + wasm`.
