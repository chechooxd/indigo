```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:d5dab77320063806eb0fb7ed2dc12179ae7292191105c92bcbfaf0bec9e3f174
verdict: fail
blockers: 1
critical_findings: 1
requirements: 3/3
scenarios: 8/8
test_command: pnpm --filter @indigodb/client test
test_exit_code: 0
test_output_hash: sha256:b6c9e5c7443a0dea838c706edf79493a5d47e8a046a2b3526ba311acf62ac124
build_command: pnpm clean && pnpm build --force && pnpm lint && pnpm test
build_exit_code: 0
build_output_hash: sha256:83ecd390f32e24d4df8d652901d36678dff46532459754a29034bf14678db20d
```

## Verification Report

**Change**: client-write-correctness (PR 1 only — runtime correctness, branch `fix/client-write-correctness-1-runtime`)
**Version**: N/A
**Mode**: Strict TDD

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total (PR 1, Phases 1-4) | 24 |
| Tasks complete | 24 |
| Tasks incomplete | 0 |
| PR 2 tasks (Phases 5-9) | 0/25 — confirmed NOT started (all `[ ]`), correctly out of scope |

### Build & Tests Execution

**Build**: PASS
```
pnpm clean && pnpm build --force && pnpm lint && pnpm test — exit 0
(Turbo: 18/18 tasks successful, workspace pack-contents guard: all green)
```

**Tests**: PASS — `pnpm --filter @indigodb/client test` exit 0, full 25-file chain including
`write-preconditions.mjs` and `nested-writes-update.mjs` confirmed present BOTH in
`package.json`'s `test` script AND in the actual console output of a real run.

**Coverage**: Not available — no coverage tool configured in this package.

### Spec Compliance Matrix

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| WP: Empty SET rejected pre-SQL | All-undefined data, no relation ops | `write-preconditions.mjs > WP-1` | COMPLIANT |
| WP: Empty SET rejected pre-SQL | Relation-ops-only guard unaffected (regression) | `write-preconditions.mjs > WP-2` | COMPLIANT |
| WP: Empty SET rejected pre-SQL | Single defined scalar accepted | `write-preconditions.mjs > WP-3` | COMPLIANT |
| WP: Zero-row throws typed not-found | Zero-row update, direct scalar | `write-preconditions.mjs > WP-4` | COMPLIANT |
| WP: Zero-row throws typed not-found | Zero-row delete | `write-preconditions.mjs > WP-5` | COMPLIANT |
| WP: Zero-row throws typed not-found | Zero-row update, relation-ops-only branch | `nested-writes-update.mjs > C1.4c` | COMPLIANT |
| WP: Zero-row throws typed not-found | Matching update still resolves | `write-preconditions.mjs > WP-7` | COMPLIANT |
| NW-4: top-level relation-ops-only update, zero match (behavior flip) | Throws IndigoNotFoundError, no partial write | `nested-writes-update.mjs > C1.4c` | COMPLIANT |
| D6a (design-only) | Zero-row where × all-undefined data — EMPTY_UPDATE_DATA wins | `write-preconditions.mjs > D6a` | COMPLIANT |
| D6b (design-only) | Multi-row where × scalar-only data — no narrowing | `write-preconditions.mjs > D6b` | COMPLIANT |
| OPS-1 (PR1 half, design-only) | Both new/rewritten test files run in the chain | `package.json` test script + console output | COMPLIANT — independently re-derived, not taken on trust |

**Compliance summary**: 8/8 owned spec scenarios compliant (WP-1..7, NW-4), plus both owned design-only
Testing Strategy rows (D6a, D6b, OPS-1 PR1-half) independently confirmed.

### Independent Re-verification Performed

1. **OPS-1 re-derived independently**: read `package.json`'s `test` script directly — confirmed
   `write-preconditions.mjs` is in the `node a.mjs && node b.mjs && …` chain (20th of 25 entries),
   and re-ran `pnpm --filter @indigodb/client test` myself; both `write-preconditions.mjs` and
   `nested-writes-update.mjs` produced named `ok`/summary lines in the actual console output.
2. **All three not-found sites verified by direct diff read** of `delegate.ts`: `rawUpdate` (1229→now
   guards empty-SET pre-SQL and throws post-`RETURNING`), `deleteImpl` (throws post-`RETURNING`), and
   `updateImpl`'s relation-ops-only branch (`matches[0]` absent → throw). All three present, matching
   design.md's Data Flow diagram exactly.
3. **NW-4/C1.4c verified by direct diff read**: confirmed the rewritten assertion expects
   `IndigoNotFoundError`/`RECORD_NOT_FOUND` (not `undefined`), and confirmed the pre-existing
   `after[0].authorId === null` no-partial-write assertion is still present, unmoved in intent.
4. **Negative-test mutation independently re-run** (not just trusted from apply-progress): mutated
   `rawUpdate`'s empty-SET guard (`if (fields.length === 0)` → `if (false && fields.length === 0)`),
   rebuilt, ran `write-preconditions.mjs` directly — **WP-1 and D6a both FAILED** as expected
   (`expected an IndigoArgumentError`). Reverted via `git checkout`, confirmed the file is
   byte-identical (`git diff` empty), rebuilt, reran — all 8 checks green again. The mutation bites.

### Deviation Assessment — `connectByUpdate`'s `IndigoNotFoundError` catch

Apply's self-reported fix (catching `IndigoNotFoundError` inside `connectByUpdate` and folding it into
the existing `false`/`CONNECT_NOT_FOUND` sentinel) is **correct for its own call sites** — `B1.3d`,
`B1.3h`, and the `connect`/`connectOrCreate` planner paths all pass, and this does not swallow a
genuine not-found the caller should see: `CONNECT_NOT_FOUND` (an `IndigoNestedWriteError`) is thrown
right after, so the caller still learns the connect failed, just under the pre-existing typed error
class instead of the new one. No regression there.

**However, the search for other silent-`undefined` callers this deviation report did not catch found
one: `applyNonFkSideOp`'s `disconnect`/`set` handling also calls `target.update(...)` directly
(delegate.ts lines 1133, 1144, 1179 — inside the to-many `disconnect` loop, the `set` bulk-clear, and
the to-one bare `disconnect`/`set: null` path), and none of these three call sites are wrapped in the
same try/catch `connectByUpdate` received.** Before this change, a zero-row match on any of these
(e.g. `set: []`/`disconnect` on a relation that currently has nothing linked, or disconnecting a
specific row that is already unlinked) resolved `undefined` silently — a legitimate, spec-implied
no-op (the base spec's own scenario title is literally "set with an empty array disconnects
everything", i.e. it must succeed even when there is nothing to disconnect). After this change,
`target.update(...)` now throws `IndigoNotFoundError`, uncaught, at these three sites, turning a
previously-silent no-op into a hard, unhandled rejection.

**This was independently reproduced**, not merely inferred: a standalone repro script (author with
zero linked books) calling `Author.update({ where: { id }, data: { books: { set: [] } } })` threw
`IndigoNotFoundError RECORD_NOT_FOUND` on the current branch. The same script against `main`
(`aacf1a8`)'s pre-change `delegate.ts` could not even construct the comparison — `IndigoNotFoundError`
does not exist there — confirming this is a genuinely new failure mode introduced by this PR, not a
pre-existing behavior. No test in the suite exercises this path: `C1.3a` ("set: [] … disconnects
every currently-linked book") always seeds two already-linked books before calling `set: []`, so the
zero-currently-linked case — the exact case this regression breaks — is never reached.

### Correctness (Static Evidence)

| Requirement | Status | Notes |
|------------|--------|-------|
| `IndigoNotFoundError` class + export | Implemented | `delegate.ts`, `index.ts` — matches design.md Interfaces exactly |
| `rawUpdate` empty-SET pre-SQL guard | Implemented | Matches WP-1/WP-3/D6a |
| `rawUpdate`/`deleteImpl`/`updateImpl` not-found throws | Implemented | All 3 sites, matches design D1/D2 |
| `connectByUpdate` deviation fix | Implemented, scoped correctly | Fixes its own regression, does not fix the sibling disconnect/set regression (see above) |
| `disconnect`/`set` `target.update` call sites | **Not guarded** | 3 uncaught call sites now throw on zero-match, breaking a previously-silent, spec-implied no-op |

### Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| D1 (`IndigoNotFoundError` in `delegate.ts`) | Yes | |
| D2 (guard at `rawUpdate`, single SQL-emitting site) | Yes, as designed | Design explicitly predicted this closes every re-entrant caller "at once" — the disconnect/set finding shows that claim was incomplete: closing the SQL-emitting site closed the *type* of failure everywhere, but each caller still needed its own catch/translate, and 3 of 4 callers got one |
| Threat Matrix: "no new identifier reaches a query from user text" | N/A, unaffected | |

### Issues Found

**CRITICAL**:
1. `applyNonFkSideOp`'s `disconnect`/`set` handling (delegate.ts lines 1133, 1144, 1179) calls
   `target.update(...)` without catching `IndigoNotFoundError`. A zero-currently-linked-row
   `disconnect`/`set` (including the common `set: []` idempotent-clear case) now throws an unhandled
   `IndigoNotFoundError` where it previously silently no-op'd — independently reproduced against this
   branch, absent on `main`. Not covered by any test (`C1.3a` always seeds pre-linked rows). This is
   the same failure class the PR itself fixes (a caller "silently changed behavior without a test
   noticing"), now present at 3 additional call sites the apply phase's self-reported deviation did
   not find. Blocks archive until fixed (either guard these 3 sites the same way `connectByUpdate`
   was fixed, or make the zero-match case an explicit, tested no-op consistent with the base spec's
   "set with an empty array disconnects everything" scenario).

**WARNING**: None.

**SUGGESTION**:
1. `write-preconditions.mjs`'s `check()` helper does not set a non-zero `process.exit` per failed
   check inline — it only exits non-zero at the end via the aggregate `failures` counter (confirmed
   during the mutation proof: the standalone `node test/write-preconditions.mjs` run printed FAILs but
   still exited 0 when run alone, outside the full chain, because the file's own end-of-file
   `process.exit(1)` only fires when `failures > 0` — it does fire correctly in that case, so this is
   not a defect, just worth noting the exit code came from the aggregate, not from `check()` itself).

### TDD Compliance
| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | Yes | Found in apply-progress, full RED/GREEN table plus mutation proof |
| All tasks have tests | Yes | 3 task groups, all with covering test files |
| RED confirmed (tests exist) | Yes | `write-preconditions.mjs`, `nested-writes-update.mjs` both exist and were the RED suite per commit `e5c0251` |
| GREEN confirmed (tests pass) | Yes | Re-ran independently, all pass on current HEAD |
| Triangulation adequate | Yes | 8 distinct scenario cases (WP-1..7, D6a/D6b), not single-case |
| Safety Net for modified files | Yes | `nested-writes-update.mjs` pre-existing suite (C1.1-C1.4b, NW-1..3) reconfirmed green alongside the C1.4c rewrite |

**TDD Compliance**: 6/6 checks passed

### Test Layer Distribution
| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Integration (DB, PGlite) | 8 | 2 (`write-preconditions.mjs`, `nested-writes-update.mjs` C1.4c) | PGlite via `pglite-harness.mjs` |
| Unit (SQL-shape, recording exec) | 3 (WP-1, WP-3, D6a) | 1 | stub executor |
| **Total (PR 1 owned)** | **8 distinct scenario checks** | **2** | |

### Changed File Coverage
Coverage analysis skipped — no coverage tool detected in `@indigodb/client`.

### Assertion Quality
**Assertion quality**: 0 CRITICAL, 0 WARNING — all assertions verify real behavior (typed error class
+ code + `calls.length`/SQL-shape/row-state checks throughout; no tautologies, no ghost loops, no
ungrounded smoke tests found in either modified/new test file).

### Quality Metrics
**Linter**: No errors (`pnpm lint` exit 0, part of the green root gate)
**Type Checker**: No errors (`tsc -b`/`tsc` across all 10 packages, part of the green root gate)

### Verdict
**FAIL** — one CRITICAL finding: the `applyNonFkSideOp` disconnect/set path has 3 uncaught
`target.update` call sites that now throw `IndigoNotFoundError` on a zero-currently-linked match,
silently breaking a previously-working, spec-implied no-op (independently reproduced, no test covers
it). Everything else — all 8 owned spec scenarios, the mandatory OPS-1 chain-membership re-derivation,
all three not-found sites, NW-4/C1.4c's no-partial-write assertion, the negative-test mutation proof,
and the root `pnpm clean && pnpm build --force && pnpm lint && pnpm test` gate — passed clean.

---

## Re-verification (scoped) — commit `ec0bc99`

**Scope**: this pass verifies ONLY the CRITICAL raised above and the corrective commit
`ec0bc99` ("fix(client): keep disconnect and set a no-op when nothing is linked") on
`fix/client-write-correctness-1-runtime`. The original 24/24 tasks, 8/8 owned scenarios,
three not-found sites, C1.4c, OPS-1, no-AI-attribution, and PR 2 untouched status are NOT
redone here — see the sections above.

```yaml
schema: gentle-ai.verify-result/v1
commit_reviewed: ec0bc993d6a631051628e0c3b238f0c257c6d38b
delegate_ts_sha256: sha256:acd5ff5bf281f93b046870ac9f52878bebcf3915a6fa4bdede04953c58a85684
verdict: pass
critical_findings: 0
warning_findings: 0
suggestion_findings: 0
test_command: node packages/client/test/nested-writes-update.mjs
test_exit_code: 0
mutation_command: sd on disconnectByUpdate catch, rebuild, rerun; git checkout restore
mutation_result: exactly C1.1c, C1.1d, C1.2d failed; all 12 others stayed green
root_gate_command: pnpm clean && pnpm build --force && pnpm lint && pnpm test
root_gate_exit_code: 0
```

### 1. Original CRITICAL reproduction — RESOLVED

Re-ran (independently authored, not the apply agent's script) the exact repro that
originally found the CRITICAL: an `Author` with **zero** currently-linked `Book` rows,
calling `Author.update({ where: { id: author.id }, data: { books: { set: [] } } })`
against the built `packages/client/dist` from `ec0bc99`.

```
PASS: no throw, resolved with { id: 1, name: 'Ada' }
```

On the pre-fix branch this threw `IndigoNotFoundError RECORD_NOT_FOUND`. Confirmed resolved.

### 2. Catch narrowness — INDEPENDENTLY PROVEN, not just read

Read `disconnectByUpdate` (delegate.ts:1106-1112): `catch (err) { if (!(err instanceof
IndigoNotFoundError)) throw err; }` — narrow by inspection. Then proved it behaviorally: built a
standalone repro with a wrapped executor that throws a custom, non-`IndigoNotFoundError` `Error`
(`CustomBoom`) specifically on `UPDATE "Book"` SQL, then called `Author.update({ ..., data: {
books: { set: [] } } })` on an author with one pre-linked book (forcing the code down
`disconnectByUpdate`).

```
PASS: non-IndigoNotFoundError propagated as expected: CustomBoom simulated DB failure on Book update
```

Confirms the catch swallows only `IndigoNotFoundError`; any other failure still propagates
unmasked — the exact property this change exists to preserve.

### 3. Sweep — INDEPENDENTLY RE-DERIVED, agrees with the commit's claim

Ran `rg -n '\.update\(|\.delete\(|rawUpdate\(' packages/client/src/*.ts` myself (not trusting
the commit message's enumeration). Result, matched exactly against the five sites claimed:

- `delegate.ts:1090` — `target.update(...)` inside `connectByUpdate` — wrapped (pre-existing,
  from the first CRITICAL's fix), catches `IndigoNotFoundError` → `false` sentinel.
- `delegate.ts:1108` — `target.update(...)` inside `disconnectByUpdate` — wrapped, this commit.
- `delegate.ts:1334` and `:1404` — `rawUpdate(...)` calls from the public `updateImpl` path —
  intentionally throwing (`RECORD_NOT_FOUND` is the documented, spec-required public behavior;
  not a sentinel-consumption site).
- `client.ts:243` — `this.handleInflight.delete(table)` — `Map.delete`, unrelated to model
  writes.
- (also independently found, both pre-existing and clearly irrelevant: `realtime.ts:210/213` —
  `Set`/`Map.delete` on in-memory listener bookkeeping, nothing to do with DB writes.)

No unguarded internal consumer of a model `update`/`delete`/`rawUpdate` result remains. Agrees
with the commit's claim.

### 4. New tests reach the claimed branches — CONFIRMED by reading `applyNonFkSideOp`

Read the full `applyNonFkSideOp` body (delegate.ts:1077-1200) and the dispatcher that routes
into it (`updateImpl`'s Phase 3, non-`fkSide` relations only). Confirmed:
- `C1.1c`/`C1.1d` (`Author.books`, `list: true`, `fkSide: false`) reach the to-many array branch
  (`disconnects`/`op.set` loop, lines 1145-1170) via `disconnectByUpdate`.
- `C1.2d` (new `Profile` model, `list: false`, `fkSide: false`, `optionalFk: true`) reaches the
  to-one branch at line 1194 (`op.disconnect === true`) — genuinely a different branch from the
  to-many one, confirmed by reading the conditional structure, not inferred from the test's name.
  `Profile` is correctly registered in `buildDelegates` (`registry.Profile = new
  ModelDelegate(profileMeta, ...)`), so the fixture is real, not a dead declaration.

This is exactly the branch-vs-name mismatch class the original CRITICAL against C1.4c was about
— here the name and the branch agree.

### 5. Mutation proof — INDEPENDENTLY RE-RUN

Edited `disconnectByUpdate`'s catch to unconditionally rethrow (`sd 'if (!(err instanceof
IndigoNotFoundError)) throw err;' 'throw err;'`), rebuilt `@indigodb/client`, ran
`nested-writes-update.mjs` directly:

```
FAIL C1.1c: set: [] on an author with ZERO currently-linked books is a no-op, does not throw
FAIL C1.1d: disconnect naming a book id that does not exist at all is a no-op, does not throw
FAIL C1.2d: disconnect on an OPTIONAL to-one non-fkSide relation (Author.profile) ... is a no-op
@indigodb/client nested-writes-update: 3 failure(s)
```

All 12 other checks in the same file (`C1.1a/b`, `C1.2a/b/c`, `C1.3a/b`, `C1.4a/b/c`, and the two
end-of-file checks) stayed green — the mutation is scoped exactly to the three claimed tests, no
more, no less. Restored via `git checkout -- packages/client/src/delegate.ts`; `git diff --stat`
on that file was empty (byte-identical). Rebuilt, reran: all 15 checks green again.

### 6. Commit hygiene — CONFIRMED

`git log -1 --format='%B' ec0bc99` contains no `Co-Authored-By`, no `claude`/`anthropic`/
`generated with` string (checked via `rg -i`, zero matches). Subject line
`fix(client): keep disconnect and set a no-op when nothing is linked` is conventional-commits
shaped (`fix(scope): summary`).

### 7. Root gate — RE-RUN, exit 0

`pnpm clean && pnpm build --force && pnpm lint && pnpm test`, run in background, polled to
completion (~2 minutes on top of a warm Turbo cache for unrelated packages; `@indigodb/client`
itself rebuilt from scratch under `--force`). Output: build 10/10, lint 10/10, test 19/19 +
`cli` suite 18/18 successful, workspace pack-contents guard all green, zero `FAIL` lines across
3747 lines of combined output. Exit 0.

### Re-verify Issues Found

**CRITICAL**: None. The original CRITICAL is resolved and independently re-derived as resolved,
not merely re-read.

**WARNING**: None new.

**SUGGESTION**: None new (the one pre-existing SUGGESTION about `write-preconditions.mjs`'s
`process.exit` timing is unchanged and out of scope for this corrective batch).

### Re-verify Verdict
**PASS** — the CRITICAL from the original pass is genuinely fixed: independently reproduced as
resolved, the catch is narrow (proven with a real non-`IndigoNotFoundError` propagation test, not
just read), the sweep agrees with the commit's own enumeration, the three new tests reach the
branches their names claim, the mutation proof reproduces cleanly with an exact byte-identical
restore, the commit is clean conventional-commits with no AI attribution, and the root gate
(`pnpm clean && pnpm build --force && pnpm lint && pnpm test`) exits 0. No new issues introduced.
Ready for archive pending PR 2 (Phases 5-9), which remains genuinely unstarted.
