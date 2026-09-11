# Exploration: Release engineering

**Change**: `release-engineering`
**Phase**: explore
**Date**: 2026-09-10
**Roadmap item**: Phase 6 — changesets, `publishConfig`, `engines` floor, npm provenance, dependency-audit job
**Engram topic**: `sdd/release-engineering/explore` (observation #1204)

> Written by the orchestrator from the Engram artifact: the `sdd-explore` agent's toolset in
> this session carried no Write tool, so it persisted to Engram only. Content is the agent's;
> this file is the hybrid-store filesystem copy.

## Current State

**Confirmed correct (all re-verified against the tree):**

- No `.changeset/` anywhere — verified absent.
- No package declares `publishConfig` — `grep publishConfig **/package.json` returned zero matches.
- `engines: { node: ">=22" }` exists ONLY in root `package.json:18-20` (which is `private: true`).
  Zero workspace packages declare `engines`.
- `grep -n private **/package.json` returns exactly one hit, the root. So all 11 publishable units
  have no `private` field either — they are publishable-by-default the moment someone runs
  `npm publish` in their directory, **with no Node floor communicated to an npm consumer at all**.
- All 11 units at `version: "0.0.1"`; root is `0.0.0` and private, never itself published.
- `pnpm-workspace.yaml:1-3` globs `packages/*` and `apps/*`, so `apps/studio` IS a workspace member.
  Nothing would exclude it from a changesets config scoped to workspace packages.
- `@indigodb/studio` (`apps/studio/package.json:1-6`) has `files: ["dist"]` and no `private` key —
  genuinely publishable now, matching `openspec/config.yaml:39`.
- `scripts/check-pack-contents.mjs` (wired into `pnpm test` at `package.json:13`) enumerates every
  `packages/*` and `apps/*` package, skips private ones, requires a `files` allowlist, dry-run packs
  each, and fails on strays or missing entry points. **This already exists and is not a task here** —
  it is a dependency this change leans on.
- `.githooks/pre-push` runs `build → lint → test` on every push; `pnpm ci:local` (`act -j ts`) runs
  only the `ts` job of the disabled workflow in a container.

**Cross-package dependency shape relevant to versioning:** `packages/cli/package.json:26-34` depends
on `@indigodb/core`, `@indigodb/parser`, `@indigodb/generator`, `@indigodb/migrator`,
`@indigodb/realtime`, and **`@indigodb/studio`** — all as regular (not dev) `workspace:*`
dependencies. `@indigodb/client/package.json:26` depends on `@indigodb/realtime` the same way. This
is real coupling across the whole graph via `ResolvedSchema`.

## Corrections to the framing this exploration was given

1. **Provenance is not merely "in tension" with disabled CI — it is categorically impossible today**,
   not a matter of configuration. npm's own docs (`docs.npmjs.com/generating-provenance-statements`,
   `docs.npmjs.com/trusted-publishers`) require "a supported cloud CI/CD provider using a
   cloud-hosted runner" — GitHub Actions (GitHub-hosted runners only), GitLab CI/CD (GitLab.com
   shared runners), or CircleCI cloud. **Self-hosted runners are explicitly unsupported** ("planned
   for future releases"). `act` is a local Docker container impersonating a GitHub Actions runner —
   it is not GitHub's OIDC issuer and cannot mint a Sigstore-backed attestation. It fails the
   cloud-hosted-runner requirement by construction, not by a fixable config choice.

   Provenance is therefore achievable **only** by physically re-enabling
   `.github/workflows-disabled/ci.yml` and publishing from a job with `permissions: id-token: write`
   and `--provenance` — i.e. reversing the exact cost decision commit `8acd5d4` made. There is no
   middle path.

   One data point could not be corroborated cleanly: whether the *source repository* must be public,
   or only the published package. Two fetches of npm's own docs gave conflicting phrasing. This repo
   is currently private. **Flagged as must-verify-live** before any future change scopes provenance
   in; the fetched page referenced a 2026-09-03 trusted-publisher rollout, so this area is moving.

## Affected Areas

- Root `package.json` — a `release`/`changeset` script lands here. Root `engines` stays as the
  workspace baseline but does NOT propagate to consumers of any individual npm package.
- All 11 manifests — each needs `publishConfig` and `engines`.
- `.changeset/config.json` (new) — versioning strategy lives here.
- `.github/workflows-disabled/ci.yml` — only relevant IF provenance is scoped in; highest
  blast radius in the change, since it re-enables billed CI minutes repo-wide.
- `.githooks/pre-push` and root `ci:local` — candidate hosts for the dependency audit.
- `scripts/check-pack-contents.mjs` — already covers the no-strays/entry-point half; the publish
  procedure sequences around it, it does not need modification.

## Approaches

### 1. Changesets, fixed versioning across all 11 packages — RECOMMENDED

One shared version bumped together; single `.changeset/config.json` with all workspace packages in
one `fixed` group.

- **Pros:** matches this repo's own precedent of coupling everything to one `ResolvedSchema` IR
  revision (`openspec/config.yaml:9-13`). Avoids publishing `@indigodb/core` at a new minor while
  `@indigodb/cli` still declares an old range. Zero risk of a consumer installing
  `@indigodb/client@1.2.0` against `@indigodb/realtime@1.0.0` with an incompatible IR shape.
- **Cons:** forces a bump on `@indigodb/ast` (barely-changing pure types) every time Studio ships a
  UI fix — noisy changelogs for low-churn packages.
- **Effort:** Low.

### 2. Changesets, independent versioning per package

- **Pros:** `@indigodb/ast` stops bumping on unrelated Studio churn; matches conventional npm
  ecosystem expectations.
- **Cons:** real risk given the dependency shape. Independent versioning requires every internal
  consumer to carry a real semver range post-publish, and any manual or out-of-band version edit in
  that graph produces an install resolving to a `ResolvedSchema`-incompatible pair **with no
  toolchain error** — a silent runtime break, not a build break, since types across `dist/`
  boundaries are not rechecked once packages are independently range-pinned.
- **Effort:** Medium.

### 3. No tool — hand-edit `version` and hand-run `npm publish`

- **Pros:** zero new dependency, zero config.
- **Cons:** with 11 interdependent packages, a human must remember every release which packages
  changed, bump every transitive dependent, and write changelogs. pnpm rewrites `workspace:*` to the
  *local* package's own version at pack time, not its dependents' — so a forgotten bump in a
  dependent ships a stale, incompatible declared range in its published `package.json`. This repo
  already has one precedent of an almost-shipped defect from an unenforced manual step (the 32 dead
  files from stale `dist/`). A hand-run publish is a second instance of that same risk class.
- **Effort:** Low to set up, high/unbounded risk per release.

**Recommendation: Approach 1.** The `ResolvedSchema` coupling that this repo's own config rules treat
as non-negotiable is the deciding fact — fixed versioning is the only option that makes an
incompatible cross-package install *structurally impossible* rather than merely avoided by care.
Independent versioning can be revisited later as a deliberate single-package carve-out.

## Findings on each open item

**`publishConfig`:** a scoped `@indigodb/*` package defaults to restricted registry-side access
unless `publishConfig.access: "public"` is set. Needed **per package**, not once at the root, because
it is a `package.json` field rather than a workspace-level setting. Mechanical, high-file-count,
low-design-risk. *Flagged for one confirming docs fetch at propose/design time — this session's
confirmation came from general knowledge plus one indirect search hit, not a direct fetch.*

**`engines`:** advisory only by default (`EBADENGINE` warning), not enforced, unless the *installer's*
own `.npmrc` sets `engine-strict=true`. This repo has **no `.npmrc` at all** (verified absent), so
even the root `>=22` is non-enforcing today. For the floor to reach an npm consumer of
`@indigodb/client`, each publishable package needs its own `engines`; matching root's `>=22` is the
obvious choice. Whether to also add `engine-strict=true` to a root `.npmrc` — which would newly start
enforcing the floor for *contributors* — is a separate decision this change should make explicit
rather than accidentally ship as a side effect.

**Provenance:** categorically blocked (see Corrections). Honest options are (a) defer it and ship the
achievable four now, documenting it as a known gap tied to the `8acd5d4` cost tradeoff, or (b) accept
re-enabling GitHub Actions as an explicit, called-out scope item. **Recommend (a)** — record it as
explicitly deferred with its prerequisite named, rather than silently dropping it from the roadmap
card or letting it balloon this change.

**Dependency audit:** `pnpm audit` is the right tool — native to the package manager already in use,
no new dependency. Two candidate hosts:
- `.githooks/pre-push` — the only thing that runs automatically today, and the closest thing to a CI
  gate this repo has. Risk: it already runs ~8 minutes of build/lint/test, and the hook's own header
  is explicit that a hook which blocks too long gets bypassed and then abandoned. Audit needs no
  build, so it should run **first**, not appended last.
- `pnpm ci:local` — on-demand only; a human has to remember. Secondary at best.
- **Recommend `pre-push`, run early.** Hard-fail vs. soft-warn is unresolved: `check-pack-contents.mjs`
  and `check-realtime-projection-db-gate.mjs` both hard-fail `pnpm test`, suggesting hard-fail is the
  convention — but audit results churn independently of code changes in a way build/lint/test do not,
  which is a real argument for a softer gate. **Design-phase decision.**

## Publish procedure sequencing

1. `pnpm clean && pnpm build --force` — the `--force` is mandatory; plain `clean && build` restores
   cached `dist/` wholesale on a Turbo cache hit, stale files included. This already almost shipped
   32 dead files once.
2. `pnpm lint` and `pnpm test` (test already runs `check-pack-contents.mjs`, which requires step 1 to
   have completed since it inspects `dist/`).
3. `changeset version`, then `changeset publish` / `pnpm publish -r`. pnpm rewrites `workspace:*` to
   the real published semver at pack time — the mechanism that makes fixed versioning's parity
   guarantee hold at the dependency-declaration level, not just the version-number level.
4. The audit gates BEFORE publish, not after.

Nothing in the existing scripts needs to change for this sequencing to work.

**Gotcha for whoever writes the publish/audit script:** pnpm appends flags to the last chained
command, so `pnpm test --force` silently no-ops — the flag never reaches turbo. Any flag meant for an
earlier command in a chain must not be appended after a later one.

## Scope Boundary

**In scope:** changesets setup (config + fixed-versioning group of all 11 units + workflow docs);
`publishConfig.access: "public"` on all 11 manifests; `engines` floor on all 11 manifests; a
dependency-audit step wired into `.githooks/pre-push`; and a written/scripted publish procedure
sequencing `clean && build --force` → `lint && test` → `changeset version` → `changeset publish`.

**Explicitly deferred — named, not silently dropped:**

- **npm provenance** — categorically blocked without re-enabling GitHub Actions on a cloud-hosted
  runner. Prerequisite is a separate, explicit decision to reverse the `8acd5d4` cost tradeoff.
- **Actually running the first `npm publish`** — this change should build the machinery only. A real
  publish is irreversible (no true unpublish after 72h), it exposes the `@indigodb` scope publicly
  for the first time — a product decision, not an engineering one, in what the CI-disable commit
  itself calls a "private pre-product repo" — and the roadmap frames this phase as building the
  pipeline, not shipping v0.0.1 to the world. Verify the machinery by dry run
  (`npm pack --dry-run`, local `changeset version`) instead.
- Docs, LSP, benchmarks, second dialect — already separated by the roadmap; nothing here touches them.

## Risks

- **`publishConfig.access` semantics** deserve one confirming direct docs fetch before committing to
  "per package, not once."
- **Provenance repo-visibility requirement unresolved** — two fetches of npm's docs conflicted. Does
  not block this change (provenance is deferred), but must be resolved before any change that scopes
  it in.
- **`@indigodb/cli` → `@indigodb/studio` is a runtime, non-dev dependency.** Publishing the CLI
  requires Studio to be published too, or the CLI's runtime
  `require.resolve("@indigodb/studio/package.json")` fails for an npm consumer. Fixed versioning
  covers version parity but does NOT by itself guarantee all 11 get published together — that is a
  publish-procedure discipline question (e.g. `pnpm publish -r` from the root) to make explicit in
  propose/design.
- **Audit gate strictness** (hard-fail vs soft-warn) has no repo precedent either way.
- **File count is inherently double-digit** (11 manifests × 2 fields, plus `.changeset/` config, plus
  a hook change) even though each edit is mechanical. Small per-file diffs, but worth the
  delivery-strategy guard check during `sdd-tasks`.

## Ready for Proposal

Yes — with one product decision owed by the user first: whether provenance is deferred (recommended)
or whether re-enabling GitHub Actions is scoped in.
