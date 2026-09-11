# Releasing IndigoDB

All 11 publishable units — `@indigodb/{ast,compiler,parser,core,migrator,generator,client,
realtime,react,cli}` and `@indigodb/studio` (`apps/studio`) — are versioned together as one
Changesets **fixed** group (`.changeset/config.json`) and MUST be published together in one
operation. This document is the ordered, verified procedure. **No real `npm publish` has been
run to produce this document — everything below is verified by dry run only.**

## Why co-publication is mandatory

`@indigodb/cli` depends on `@indigodb/studio` as a runtime (non-dev) `workspace:*` dependency
(`packages/cli/package.json:32`). Fixed versioning guarantees version *parity* across all 11
units, but parity alone does not guarantee all 11 exist on the registry at that version — that is
a publish-procedure discipline, not a changesets guarantee. A partial publish (`@indigodb/cli`
without `@indigodb/studio`) would break `require.resolve("@indigodb/studio/package.json")` for
any consumer who installs `@indigodb/cli` alone.

## The ordered sequence

Run every step from the repo root, in this exact order:

```sh
pnpm clean && pnpm build --force
pnpm lint && pnpm test
pnpm changeset version
git add -A && git commit -m "chore: version packages"
node scripts/check-release-cohort.mjs
pnpm publish -r --dry-run   # replace with `pnpm publish -r` for the real thing — see below
```

### 1. `pnpm clean && pnpm build --force` — `--force` is not optional

`pnpm clean && pnpm build` (**without** `--force`) is insufficient before a publish-intent
build. Turbo caches build outputs and restores `dist/` wholesale on a cache hit — including
files a prior build produced that current sources no longer emit. This is not theoretical: a
manually seeded stale `packages/parser/dist/lexer.js` survived exactly this sequence in this
change's own verification (`clean && build` restored it from cache; `clean && build --force` did
not — `--force` bypasses the cache and runs the real compiler against the already-emptied
directory). `check-pack-contents.mjs` (wired into `pnpm test`) only enforces the `files`
allowlist boundary — it does **not** detect a stale file that still falls inside `dist`, so a
resurrected stray like `lexer.js` passes it silently. `--force` at the build step is the actual
guard against this class of bug, not the pack-contents check downstream of it.

### 2. `pnpm lint && pnpm test`

`pnpm test` runs `check-pack-contents.mjs` (dist-vs-`files` allowlist), the release cohort
version-parity guard (`scripts/check-release-cohort.mjs`), and the realtime DB-gate reachability
check. All of these inspect `dist/` or the manifests, so they MUST run after step 1, never
before. At this point the cohort guard is only asserting parity across the **pre-bump**
versions — it has not yet seen anything `changeset version` is about to touch.

### 3. `pnpm changeset version`

Bumps all 11 units to the identical next version, driven by whatever changesets exist in
`.changeset/`. The root `package.json` (`private: true`, `version: "0.0.0"`) is excluded from the
fixed group and is never touched by this step. This step rewrites all 11 manifests plus their
CHANGELOGs and leaves the working tree dirty.

### 4. `git add -A && git commit -m "chore: version packages"`

`changeset version` leaves the tree dirty (11 manifests + CHANGELOGs rewritten), and `pnpm
publish` refuses to run against an unclean tree (`ERR_PNPM_GIT_UNCLEAN`) — confirmed by
reproducing the failure during this change's verification: running `pnpm publish -r --dry-run`
directly after `changeset version`, with no commit in between, aborted with exactly that error.
Committing the version bump is the missing step; skipping straight from step 3 to publish does
not work. `--no-git-checks` is not used here — committing the bump is the honest record of what
version was actually published, not a workaround to route around the check.

### 5. `node scripts/check-release-cohort.mjs` — re-run after the bump, not just before it

The cohort guard's whole reason to exist (see its header) is to catch `changeset version`
dropping a unit from the fixed group — but step 2's guard run happens **before** step 3, the only
step that can actually cause that drift. A guard that only ever runs against pre-bump versions
would pass even if `changeset version` silently excluded a package. Re-running the guard here,
after the commit and before publish, is what actually closes that gap; re-running all of `pnpm
test` is an acceptable heavier alternative if you want the other checks re-verified too.

### 6. Publish — one all-11 operation, never per-package

The final step MUST be a single recursive/group publish command — `pnpm publish -r` from the
repo root, or `changeset publish` run once with all 11 group members present — never 11 separate
per-package `npm publish` invocations. That is what keeps `@indigodb/cli` and `@indigodb/studio`
co-published. **This change verifies the dry-run path only** (`pnpm publish -r --dry-run`, or
equivalently `npm pack --dry-run` run per package); the first real, irreversible `npm publish` is
a separate, explicit human decision, out of scope here.

## Flags never land on the wrong command

pnpm appends a caller's flags only to the **last** command in a `&&` chain. A `--force` passed by
a human to `pnpm release:preflight` (the convenience script wrapping steps 1–2) would silently
land on `pnpm test` and do nothing — `pnpm test` doesn't recognize `--force`. For that reason
`--force` is baked literally into the `release:preflight` script text after `build`, never left
for a caller to supply:

```json
"release:preflight": "pnpm clean && pnpm build --force && pnpm lint && pnpm test"
```

## `.npmrc` is deliberately not created

No root `.npmrc` exists, and none is added by this procedure. `.npmrc` is also where npm's
once-per-repo `access=public` and an `engine-strict=true` enforcement would live — this change
does not ship either. `publishConfig.access` is set per-manifest instead (see below), which is
intent-pinning, not a publish prerequisite: npm's own `--access` default is already `"public" for
new packages, existing packages it will not change the current level"` (npm CLI v11 docs) — there
is no scoped-defaults-to-restricted rule on current npm. The widely repeated belief that a scoped
package needs `--access public` to publish at all is stale (true in the npm 5/6 era, not now).
Setting it explicitly on all 11 manifests means a future npm CLI/registry default flip, or a
stray `--access restricted`, cannot silently turn eleven public packages private — a cheap,
explicit, greppable guarantee that relying on a CLI default is not. `engines.node: ">=22"` on
each manifest similarly reaches the npm consumer directly; the root `engines` field is
non-propagating (root is `private`, so it never ships) and enforcing the floor on
**contributors** via `engine-strict` remains a separate, undecided change.
