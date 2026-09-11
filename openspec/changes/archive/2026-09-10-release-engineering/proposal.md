# Proposal: Release Engineering

## Intent

All 11 publishable units sit at `version: "0.0.1"` with no release machinery: no `.changeset/`
(verified absent), no `publishConfig` in any manifest (zero grep matches), and `engines` only in
the private root (`package.json:18-20`). None declares `private`, so any `npm publish` in a
package directory ships today with no Node floor communicated to consumers and — for scoped
`@indigodb/*` — likely a restricted-access failure. Versioning would be hand-maintained across a
graph coupled by `ResolvedSchema`, the one non-negotiable dependency direction
(`openspec/config.yaml:9-13`). Success: a repeatable, dry-run-verified release pipeline.

## Scope

### In Scope
- Changesets with **fixed** versioning: one group covering `@indigodb/{ast,compiler,parser,core,migrator,generator,client,realtime,react,cli}` + `@indigodb/studio` (`apps/studio`).
- `publishConfig.access: "public"` on all 11 manifests.
- `engines` floor on all 11 manifests, matching root `>=22`.
- A documented publish procedure, verified by dry run only.

### Out of Scope
- **npm provenance — deferred, not dropped.** Named prerequisite: reversing `8acd5d4` to re-enable GitHub Actions on a cloud-hosted runner. npm requires a cloud-hosted OIDC issuer; self-hosted runners and `act` are unsupported, so it is categorically impossible today.
- **The first real `npm publish`** — irreversible and exposes the `@indigodb` scope publicly; a separate human decision.
- Docs, LSP, benchmarks, second dialect (bundled in the roadmap card, not here).
- `scripts/check-pack-contents.mjs` (`package.json:13`) — an existing dependency, not a task.
- Re-enabling `.github/workflows-disabled/ci.yml`; no `ci-pipeline` spec change.
- **The dependency-audit gate — descoped 2026-09-10, moved to its own change.** A
  `/code-review` pass found the gate as landed blocks every push on this repo:
  `pnpm audit --audit-level=high` exits 1 with 53 vulnerabilities (15 high) even against
  `pnpm.auditConfig.ignoreCves: []`, 14 of the 15 pre-existing in `apps/studio`'s tooling tree
  and the 15th introduced by this very change (`js-yaml` via `@changesets/cli`). The
  documented valve cannot even suppress that 15th advisory: its GHSA
  (`GHSA-5p4m-2wfm-xmqj`) has `cves: []`, and `ignoreCves` only matches on CVE —
  `pnpm.auditConfig.ignoreGhsas` is the field that actually covers GHSA-only advisories, and
  this change never wired it. The gate needs its own triage of the pre-existing Studio
  tooling advisories and a correct valve field before it can land; that work belongs in a
  dedicated `dependency-audit-gate` change, not folded into release-engineering's descope
  fix. Everything the gate touched (`.githooks/pre-push`'s audit block, `pnpm.auditConfig`,
  `scripts/test-audit-gate.mjs`, and its `Testing Strategy`/tasks rows) has been removed from
  this change back to its pre-change state.

## Capabilities

### New Capabilities
- `release-versioning`: changesets config, fixed group, version-bump behavior.
- `package-publish-metadata`: per-manifest `publishConfig.access` and `engines`.
- `publish-procedure`: ordered release sequence and all-11-together discipline.

### Modified Capabilities
- None.

### Descoped Capabilities
- `dependency-audit-gate` — see "Out of Scope" above. Moved to its own change, not dropped.

## Approach

Fixed versioning across one group. Rationale: the `ResolvedSchema` coupling makes an incompatible
cross-package install *structurally impossible* rather than merely avoided by care. Rejected:
independent versioning (a silent runtime break, not a build break, when ranges drift — remains
available later as a deliberate single-package carve-out) and hand-edited versions (the same
unenforced-manual-step class that almost shipped 32 dead files).

Publish sequence: `pnpm clean && pnpm build --force` → `pnpm lint && pnpm test` → `changeset
version` → commit the version bump → re-run the cohort guard → publish. The `--force` is
load-bearing: plain `clean && build` restores cached `dist/` wholesale on a Turbo cache hit. The
commit step exists because `pnpm publish` refuses an unclean tree, and `changeset version`
always leaves one. The cohort-guard re-run exists because `changeset version` is the only step
that can actually cause the version drift the guard checks for, and the first guard run (inside
`pnpm test`, before `changeset version`) cannot see that yet.

`@indigodb/cli` depends on `@indigodb/studio` as a **runtime** (non-dev) `workspace:*` dep
(`packages/cli/package.json:32`). Fixed versioning gives version parity but does not by itself
guarantee all 11 publish together — that is publish-procedure discipline (e.g. `pnpm publish -r`
from the root) and must be stated explicitly.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `.changeset/config.json` | New | Fixed group of all 11 units |
| `packages/*/package.json`, `apps/studio/package.json` | Modified | `publishConfig` + `engines` ×11 |
| `package.json` (root) | Modified | Release/changeset scripts |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Provenance may require a **public source repo** — two npm docs fetches conflicted; this repo is private | Med | Irrelevant while deferred; MUST be resolved before any future change scopes provenance in |
| `publishConfig.access` per-package vs. once is not directly confirmed | Med | Design closes it with one docs fetch before 11 mechanical edits |
| `engine-strict=true` in a root `.npmrc` would newly enforce the floor on **contributors** | Med | Open design question — an explicit decision, never an accidental side effect |
| A new chained script silently no-ops: pnpm appends flags to the **last** chained command | Med | Any early-command flag must not be appended after a later one |
| 11 manifests × 2 fields inflates file count | Low | Small per-file diffs; `sdd-tasks` runs the 800-line budget check |
| `pnpm publish` refuses an unclean tree after `changeset version` | Med | Documented commit step between version and publish (reproduced, then fixed) |
| Cohort guard runs before the only step that can break parity | Med | Guard re-runs after `changeset version`, before publish |

## Rollback Plan

Revert the change's commit range. Each piece is independently revertable: delete `.changeset/`,
drop the two added fields per manifest. Nothing is published, so no registry state exists to
undo.

## Dependencies

- `scripts/check-pack-contents.mjs`, already wired into `pnpm test`; requires a completed build.
- `@changesets/cli` is the one new devDependency.
- No `crates/` change, so no `build:wasm` or regression-harness rerun.

## Success Criteria

- [ ] `changeset version` run locally bumps all 11 units in lockstep.
- [ ] `npm pack --dry-run` on every unit shows `access: public`, the `engines` floor, and no strays.
- [ ] The publish procedure is documented with `--force` in step one and a commit step between
      `changeset version` and publish.
- [ ] `scripts/check-release-cohort.mjs` cross-checks the publishable set against the `fixed`
      group by name, in both directions.
- [ ] Nothing is published to the real registry by this change.
