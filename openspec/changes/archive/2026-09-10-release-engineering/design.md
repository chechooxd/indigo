# Design: Release Engineering

## Technical Approach

Three independent, independently-revertable pieces: a `.changeset/` fixed group, two mechanical
manifest fields ×11, and a documented + partly *verified* publish procedure. Nothing publishes.
Every claim below is proven by a real artifact (`npm publish --dry-run` output, a real `changeset
version` run, a real mutated `.changeset/config.json`) — never by reading back the field we just
wrote, which is the mock-the-compiler blindness class.

**Descope note (2026-09-10)**: a `/code-review` pass found the dependency-audit gate this design
originally specified blocks every push on this repo as landed (`pnpm audit --audit-level=high`
exits 1 with 15 high-severity advisories even with the documented `ignoreCves` valve in place,
and that valve cannot suppress at least one of them — `js-yaml`'s advisory is GHSA-only,
`ignoreCves` matches CVE-only). The maintainer decided to split it into its own change. Every
audit-gate decision, the data-flow line, the file-changes row, and the testing-strategy rows
below were removed as part of that descope; they are not restated here — see
`dependency-audit-gate` for their future home.

## Architecture Decisions

### Decision: no `.npmrc`; `engines` stays consumer-facing only

| Option | Tradeoff | Decision |
|---|---|---|
| Root `.npmrc` with `engine-strict=true` | Turns an `EBADENGINE` warning into a hard install failure for **contributors**, a capability nobody asked for, shipped as a side effect of a *publish-metadata* change | Rejected |
| `engines` on all 11 manifests only | Reaches the npm consumer (the actual gap); contributors keep the warning | **Chosen** |

**Rationale**: the gap is that a consumer of `@indigodb/client` learns no Node floor at all
(root `package.json:18-20` is `private`, so it never ships). Enforcing on contributors is a
separate change with a separate trigger (first `>=22`-only runtime API, or a Node matrix).
Verified absent: no `.npmrc` anywhere in the tree. **Trap**: `.npmrc` is also where npm's
once-per-repo `access=public` would live — if anyone later adds that file, it must not acquire
`engine-strict` by proximity.

### Decision: `publishConfig.access` — the premise was wrong; the field stays, its justification changes

The design phase had no fetch tool and substituted a local probe. **The orchestrator ran the
docs fetch afterwards, and it refuted the premise this change inherited from exploration.**

npm's own `npm publish` docs (cli/v11) give the `--access` default as: *"'public' for new
packages, existing packages it will not change the current level."* There is no
scoped-defaults-to-restricted rule in current npm. The widely-repeated belief that a scoped
package needs `--access public` to publish at all is **stale** — true in the npm 5/6 era, not
now. The `package.json` docs separately describe `publishConfig` only as a per-package field
and say nothing about root inheritance.

So two claims that were conflated must be separated:

| Claim | Verdict |
|---|---|
| `publishConfig` is a **per-package** field, not root-inherited | **True** — stands |
| `access: "public"` is **required** or the scoped publish fails | **False** on current npm |

**The field is still added to all 11 — the justification is now different.** Not "required to
publish at all", but: it pins the intent in the artifact itself, so a future npm CLI/registry
default flip, or a stray `--access restricted`, cannot silently turn eleven public packages
private. That is a cheap, explicit, greppable guarantee; relying on a CLI default is not.

**The probe still runs, and it is now MORE valuable — but its halt condition was a non
sequitur and is corrected here.** The original rule said: if the untouched sibling also reports
public, the per-package premise is false, stop and re-shape. That does not follow. Given the
default above, the sibling almost certainly *will* report public — and that refutes
*requiredness*, not *per-package-ness*. Corrected:

- **Expected**: both the edited package and the untouched sibling report public. This confirms
  the default and is **not** a halt condition.
- **Halt only if** the edited package reports something other than `public` — that would mean
  the field is not being read as written, which is the only outcome that actually invalidates
  the task shape.
- The probe's real job is now to capture the *observed* default as evidence in the change, so a
  later reader knows the field is belt-and-braces rather than load-bearing.

### Decision: co-publication is structural + verified pre-publish

Fixed versioning bumps all 11 at once, so all 11 are absent from the registry at the new
version and `changeset publish` from the root publishes the whole cohort — that is the
mechanism, not a documented step. What is *verifiable now* is parity:
`scripts/check-release-cohort.mjs` asserts every non-private workspace package carries the
identical `version`, chained into root `test`. Post-publish registry co-presence (the partial
`@indigodb/cli`-without-`@indigodb/studio` failure, `packages/cli/package.json:32`) can only be
checked at a real publish — out of scope, named as the follow-up.

### Decision: load-bearing flags live inside the script text

`"release:preflight": "pnpm clean && pnpm build --force && pnpm lint && pnpm test"`. pnpm
appends a caller's flags to the **last** chained command, so any `--force` passed by a human
lands inertly on `pnpm test`. Baking it in literally after `build` makes the trap harmless
instead of relying on the caller.

### Decision: commit between `changeset version` and publish; re-run the cohort guard after it

Two findings from reproducing the documented publish sequence end-to-end:

1. `changeset version` rewrites 11 manifests plus their CHANGELOGs and leaves the tree dirty.
   `pnpm publish -r --dry-run` run directly afterward, with no commit in between, aborts with
   `ERR_PNPM_GIT_UNCLEAN` — reproduced during this change's verification. The fix is a documented
   `git commit` step, not `--no-git-checks`: committing the bump is the honest record of what
   version was actually published, `--no-git-checks` would just hide the same unclean-tree fact.
2. `scripts/check-release-cohort.mjs` runs inside `pnpm test`, which the documented sequence
   places **before** `changeset version` — the only step that can actually cause the drift the
   guard exists to catch (its own header names this as the reason it exists). A guard that only
   ever sees pre-bump versions would still print PASSED if `changeset version` silently dropped a
   unit. The fix is re-running the guard (or all of `pnpm test`) after `changeset version` and its
   commit, immediately before publish.

## Data Flow

    git push ──→ pre-push: SKIP? ──→ deletion-only? ──→ for step in build lint test

    release: clean → build --force → lint → test(+cohort+pack guard) → changeset version →
             commit → cohort guard (re-run) → publish

## File Changes

| File | Action | Description |
|---|---|---|
| `.changeset/config.json` | Create | one `fixed` group, all 11 units |
| `packages/{ast,compiler,parser,core,migrator,generator,client,realtime,react,cli}/package.json` | Modify | `publishConfig.access` + `engines` (gated on the probe) |
| `apps/studio/package.json` | Modify | same two fields |
| `package.json` (root) | Modify | `@changesets/cli` devDep, `release:preflight`, cohort guard in `test` |
| `scripts/check-release-cohort.mjs` | Create | version-parity guard + fixed-group cross-check |
| `RELEASING.md` | Create | ordered procedure, `--force` in step one, commit + guard re-run before publish |
| `.npmrc` | **Not created** | deliberate, per decision 1 |

## Testing Strategy

Rows are scenario **combinations**, not one per requirement.

| # | Combination | Assertion (semantic artifact) |
|---|---|---|
| 8 | 11 manifests edited × `npm publish --dry-run` | the dry-run output reports public access and the engines floor — not a re-read of the JSON |
| 9 | real `changeset version` on a throwaway branch | all 11 versions equal and bumped; then reverted |
| 10 | drifted version × `check-release-cohort.mjs` | exit 1 naming both packages |
| 11 | stale `dist/` × `build` without `--force` | pack guard reports strays; with `--force` it does not |
| 12 | publishable package present, absent from `.changeset/config.json`'s `fixed` array (and the reverse) × `check-release-cohort.mjs` | exit 1 naming the mismatched package and the config path, on both sides of the mismatch |
| 13 | `changeset version` on a throwaway branch × `pnpm publish -r --dry-run` with no commit in between | `ERR_PNPM_GIT_UNCLEAN`; the documented commit step, then a re-run, succeeds |

**Mutation proofs are two-sided and must not pass by crashing.** Row 12: drop a publishable
package from `fixed` → the guard must fail naming that exact package, not the parity check; add
a phantom entry to `fixed` → the guard must fail naming that exact phantom entry. Each mutated
run must fail on the *asserted message*, not on a `TypeError` — a run whose only symptom is a
crash has proven nothing.

## Threat Matrix

| Boundary | Applicability | Design response | Planned RED tests |
|---|---|---|---|
| Documentation-like paths | N/A — no file-classification or executable-doc surface | — | — |
| Git repository selection | Applicable — the cohort guard must act on the repo root, not the caller's cwd | guard resolves root from `import.meta.url` (precedent: `check-pack-contents.mjs:25`) | run the guard from a subdirectory |
| Commit state | Applicable — `pnpm publish` requires a clean tree after `changeset version` | documented commit step between version and publish | reproduce `ERR_PNPM_GIT_UNCLEAN` with no commit, then prove the fixed sequence |
| Push state | N/A — no push-time gate remains in this change (moved to `dependency-audit-gate`) | — | — |
| PR commands | N/A — no PR automation in scope | — | — |

## Migration / Rollout

No migration. Each piece reverts alone: delete `.changeset/`, drop two fields per manifest, drop
`scripts/check-release-cohort.mjs`.

## Open Questions

- [x] `publishConfig.access` per-package vs once — **CLOSED** by an orchestrator docs fetch after
      this design was written. Per-package: confirmed. Required-for-scoped: refuted (npm's default
      is public for new packages). The field stays on all 11 as intent-pinning, not as a
      publish prerequisite; see the corrected decision above and its revised probe halt condition.
- [x] Exact `pnpm.auditConfig.ignoreCves` field name — **moot here**; the audit gate that needed
      it was descoped to `dependency-audit-gate` (see the descope note above).
- [ ] Provenance repo-visibility requirement stays unresolved; out of scope, blocks nothing.
