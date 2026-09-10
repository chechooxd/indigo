# Design: Release Engineering

## Technical Approach

Four independent, independently-revertable pieces: a `.changeset/` fixed group, two mechanical
manifest fields ×11, an audit step in `.githooks/pre-push`, and a documented + partly *verified*
publish procedure. Nothing publishes. Every claim below is proven by a real artifact (`npm
publish --dry-run` output, a real `changeset version` run, a real seeded advisory) — never by
reading back the field we just wrote, which is the mock-the-compiler blindness class.

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

### Decision: `pnpm audit --audit-level=high`, hard-fail, with `ignoreCves` as the pressure valve

`critical`-only is too permissive (most exploitable advisories land at `high`).
`moderate`/`low` admits the dev-transitive noise that appears with **no code change** — exactly
the block-on-something-unrelated that `.githooks/pre-push:10-13` argues gets bypassed and then
abandoned. `high` is the bounded set. The valve is **not** lowering the level: it is a dated,
greppable, reviewable `pnpm.auditConfig.ignoreCves` entry in the root `package.json`.
`SKIP_PREPUSH=1` stays the last resort. **Accepted failure mode**: the gate needs the network,
so an offline push fails; the message names both exits. Fail-open on network error is rejected —
an indistinguishable-from-clean gate is not a gate.

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

## Data Flow

    git push ──→ pre-push: SKIP? ──→ deletion-only? ──→ [NEW] pnpm audit --audit-level=high
                                                              │ fail → exit 1 (build never runs)
                                                              ↓ pass
                                                    for step in build lint test

    release: clean → build --force → lint → test(+cohort+pack guard) → changeset version → publish

## File Changes

| File | Action | Description |
|---|---|---|
| `.changeset/config.json` | Create | one `fixed` group, all 11 units |
| `packages/{ast,compiler,parser,core,migrator,generator,client,realtime,react,cli}/package.json` | Modify | `publishConfig.access` + `engines` (gated on the probe) |
| `apps/studio/package.json` | Modify | same two fields |
| `.githooks/pre-push` | Modify | audit block inserted after line 49, before the `for` loop at :55 |
| `package.json` (root) | Modify | `@changesets/cli` devDep, `release:preflight`, cohort guard in `test`, `pnpm.auditConfig` |
| `scripts/check-release-cohort.mjs` | Create | version-parity guard |
| `scripts/test-audit-gate.mjs` | Create | fixture-based gate proof |
| `RELEASING.md` | Create | ordered procedure, `--force` in step one |
| `.npmrc` | **Not created** | deliberate, per decision 1 |

## Testing Strategy

Rows are scenario **combinations**, not one per requirement.

| # | Combination | Assertion (semantic artifact) |
|---|---|---|
| 1 | high advisory × content push | exit 1 **and** the `build` marker file is absent — proves ordering, not just failure |
| 2 | high advisory × deletion-only refs | exit 0; audit never runs (short-circuit at `:46-49` precedes it) |
| 3 | high advisory × `SKIP_PREPUSH=1` | exit 0, skip message |
| 4 | moderate-only advisory × content push | exit 0 — negative control for `high` |
| 5 | clean tree × content push | all four steps run, in order |
| 6 | `ignoreCves` entry × the matching high advisory | exit 0; removing the entry restores exit 1 |
| 7 | registry unreachable × content push | exit 1, message names `ignoreCves` **and** `SKIP_PREPUSH=1` |
| 8 | 11 manifests edited × `npm publish --dry-run` | the dry-run output reports public access and the engines floor — not a re-read of the JSON |
| 9 | real `changeset version` on a throwaway branch | all 11 versions equal and bumped; then reverted |
| 10 | drifted version × `check-release-cohort.mjs` | exit 1 naming both packages |
| 11 | stale `dist/` × `build` without `--force` | pack guard reports strays; with `--force` it does not |

**Mutation proofs are two-sided and must not pass by crashing.** Flip `--audit-level` to
`moderate` → row 4 must go red; flip to `critical` → row 1 must go red. Each mutated run must
fail on the *asserted message/marker*, not on a `TypeError`; a run whose only symptom is a crash
has proven nothing. Row 1's build-marker assertion is what makes the ordering claim falsifiable.

**Staging/teardown of the vulnerable dep**: never in the real tree or lockfile. `scripts/test-audit-gate.mjs`
builds a **temp fixture workspace** (own `package.json` + lockfile pinning a known-high advisory,
`build`/`lint`/`test` scripts that only touch marker files) and invokes the real
`.githooks/pre-push` against it with synthetic stdin ref lines. Teardown removes the tempdir; the
repo lockfile is never mutated. The suite needs network, so it follows the existing
`INDIGODB_TEST_DATABASE_URL` precedent: unset opt-in env var → print `SKIP` and pass.

## Threat Matrix

| Boundary | Applicability | Design response | Planned RED tests |
|---|---|---|---|
| Documentation-like paths | N/A — no file-classification or executable-doc surface | — | — |
| Git repository selection | Applicable — the hook and both guards must act on the repo root, not the caller's cwd | guards resolve root from `import.meta.url` (precedent: `check-pack-contents.mjs:25`); the fixture proves cwd independence | run guards from a subdirectory |
| Commit state | N/A — pre-push reads refs, never the index or worktree | — | — |
| Push state | Applicable — first push, deletion-only, explicit refspec, empty stdin | audit sits **after** the `has_content` short-circuit (`:39-49`), so ref shape decides before any network call | rows 2, 5; plus empty-stdin and first-push (all-zero remote sha) cases |
| PR commands | N/A — no PR automation in scope | — | — |

## Migration / Rollout

No migration. Each piece reverts alone: delete `.changeset/`, drop two fields per manifest,
remove the audit block, drop the two scripts.

## Open Questions

- [x] `publishConfig.access` per-package vs once — **CLOSED** by an orchestrator docs fetch after
      this design was written. Per-package: confirmed. Required-for-scoped: refuted (npm's default
      is public for new packages). The field stays on all 11 as intent-pinning, not as a
      publish prerequisite; see the corrected decision above and its revised probe halt condition.
- [ ] Exact `pnpm.auditConfig.ignoreCves` field name is unverified here; the row-6 test is what
      confirms it, and it must run before the valve is documented in `RELEASING.md`.
- [ ] Provenance repo-visibility requirement stays unresolved; out of scope, blocks nothing.
