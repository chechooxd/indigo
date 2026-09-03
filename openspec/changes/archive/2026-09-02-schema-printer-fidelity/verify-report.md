# Verify Report — `schema-printer-fidelity`

**Change**: `schema-printer-fidelity` · **Phase**: `sdd-verify` · **Mode**: Strict TDD (active)
**Scope verified**: both stacked branches — `feat/schema-printer-fidelity-1` (`ab58f75`, PR 1) and
`feat/schema-printer-fidelity-2` (`dbbd7e3`, PR 2), both based on `main`@`968f8de`.

## Verdict

**PASS WITH WARNINGS** — 0 CRITICAL, 1 WARNING, 2 SUGGESTION.

The printer's central contract — `resolve(parse(print(ir))) == ir` with exactly one documented
exclusion (index re-bucketing) — is verified true by direct source inspection of
`normalizeForRoundTrip`'s final form, and its falsifiability is proven by two mutation tests I
reproduced myself (not merely re-read from `apply-progress`). All 17 spec scenarios have a
covering runtime-passing test. All 58 claimed `[x]` tasks landed in one of the two commits. The
one WARNING is a test-quality gap (a throw-confirmation loop asserts only the error class, not a
message substring, for the 3 unprintable fixtures — contradicting that file's own inline comment)
that does not currently mask a wrong-reason pass, verified by source-level reasoning about the
exact throw site for each of the 3 fixtures.

## 1. Tasks landed in commits

`git show --stat ab58f75 dbbd7e3` confirms every file `apply-progress.md` claims changed is
present in one of the two commits:

- `ab58f75`: `apply-progress.md`, `design.md`, `exploration.md`, `proposal.md`,
  `specs/schema-printing/spec.md`, `tasks.md`, `packages/core/src/print.ts`,
  `packages/core/test/print.mjs` — 8 files, 1680(+)/53(-).
- `dbbd7e3`: `apply-progress.md`, `proposal.md`, `tasks.md`, `packages/core/src/print.ts`,
  `packages/core/test/print.mjs` — 5 files, 627(+)/90(-).

`openspec/changes/schema-printer-fidelity/tasks.md` has 58/58 `[x]`, 0 `[ ]` in the working tree.
No task's test file was left out of a commit (the failure mode the task explicitly warned about
was not reproduced here).

## 2. Scenario-by-scenario coverage (17/17)

| # | Requirement / Scenario | Covering test | Runtime result |
|---|---|---|---|
| 1.1 | FK-holding relation field prints `@relation(...)` | `print.mjs`: "relation: a claimed FK emits no `// @fk(...)` comment", fixtures `07/08/12` round trip | PASS |
| 1.2 | Inverse relation field prints without `fields`/`references` | `print.mjs`: "relation: unpaired inverse ... prints bare type, no `@relation` clause"; `12-relation-naming` fixture (`author`/`authoredPosts` pair) | PASS |
| 1.3 | Relation-free FK metadata still prints `// @fk(...)` | `print.mjs`: "relation: relation-free FK metadata still prints `// @fk(...)` (db pull shape, T8 guard)"; `pull-roundtrip.mjs` | PASS |
| 1.4 | Ambiguous FK-to-relation cross-reference throws | `print.mjs`: "ambiguous claim ... throws, message pinned" + "FK claimed by two relations throws, message pinned to 'claimed by both'" | PASS, message-pinned |
| 2.1 | Realtime model without column allowlist | `print.mjs`: "`@@realtime` emitted only when resolved with realtime true" | PASS |
| 2.2 | Realtime model with non-empty allowlist | `print.mjs`: "`@@realtime(columns: [...])` emitted for a non-empty allowlist" | PASS |
| 2.3 | Realtime model with empty allowlist prints empty list, not bare | `print.mjs`: "`@@realtime(columns: [])` prints the empty list ... and round-trips as `[]`" | PASS |
| 3.1 | Round-trip equality holds over full IR | 18/21 fixture round-trip loop | PASS (18/18 in-scope fixtures) |
| 3.2 | The one permitted exclusion is index re-bucketing, documented | Direct read of `normalizeForRoundTrip` (see §3 below) | Confirmed by source inspection |
| 3.3 | A deleted normalization exclusion fails the suite | Reproduced myself: re-adding `relations: []` → 7 fixtures RED (see §4) | PASS, reproduced independently |
| 4.1 | Multiple allow rules print in IR order | `print.mjs`: "`@@allow`: multiple rules print as separate lines in IR order; claim operand prints `auth.<name>`" | PASS |
| 4.2 | Field operand prints schema field name, not mapped column name | `print.mjs`: "`@@allow`: field operand prints the schema field name, not the mapped dbName" (task 1.8 mutation proof) | PASS |
| 4.3 | Claim operand prints as `auth.<name>` | Same check as 4.1 (combined assertion) | PASS |
| 4.4 | `write`/`all` sugar never re-collapsed | `print.mjs`: "`@@allow`: write/all sugar prints expanded, never re-collapsed (`18-allow-rules.indigo`)" | PASS |
| 5.1 | TableGroup blocks print after model/enum blocks | `print.mjs` TableGroup-order check; `04-tablegroup-edge` fixture round trip | PASS |
| 5.2 | "Last group wins" overlap round-trips faithfully | `04-tablegroup-edge.indigo` fixture round trip | PASS |
| 5.3 | TableGroup source, not derived fields, drives printing | `print.mjs` TableGroup source-of-truth check | PASS |

All 17 scenarios have a runtime-passing covering test. I ran `node packages/core/test/print.mjs`
myself (not trusting `apply-progress`'s reported numbers) — 64 `ok` lines, 0 failures, exit 0.

## 3. The central requirement, verified literally

`normalizeForRoundTrip`'s final body (`packages/core/test/print.mjs:853-865`) was read directly:

```js
function normalizeForRoundTrip(resolved) {
  return {
    ...resolved,
    tables: resolved.tables.map((t) => ({
      ...t,
      // `indexes`: re-bucketed (unique first, then non-unique, each group's
      // relative order preserved) because the printer's fixed emission
      // order groups `@@unique` before `@@index` — a documented ordering
      // artifact, not a dropped field. The one permitted exclusion.
      indexes: [...t.indexes.filter((i) => i.unique), ...t.indexes.filter((i) => !i.unique)],
    })),
  };
}
```

**Exactly one exclusion**, `indexes` (re-bucketing, not deletion), with an inline comment naming
the field and the reason. **No additional exclusion exists beyond the one permitted by the spec.**
`foreignKeys`, `relations`, `tableGroups`, `color`, `group`, `allow`, and `realtimeColumns` are all
compared in full — confirmed by the absence of any other key manipulation in the function body,
and confirmed functionally by the mutation test in §4.

## 4. Mutations reproduced myself (not merely re-read from apply-progress)

### 2.3 — discriminator regression (`isRelationHolder`)

Mutated `packages/core/src/print.ts`: `return rel.inverse !== true && rel.fkColumns.length > 0;`
→ `return rel.fkColumns.length > 0;`. Rebuilt (`pnpm build --filter=@indigodb/core`), ran
`node packages/core/test/print.mjs`.

**Observed**: RED — 5 failures (broader than apply-progress's single-fixture claim):
`relation: holder vs. name-paired-inverse discriminator (12-relation-naming.indigo)` plus fixture
round-trip failures on `01-cli-template`, `02-studio-initial`, `12-relation-naming`,
`13-ambiguous-relations`, all throwing `IndigoPrintError: ... column with physical name "..." has
no matching field — cannot print`. Reverted; confirmed GREEN again (all checks pass, exit 0).

### 2.25 — final normalizer exclusion (re-adding `relations: []`)

Mutated `packages/core/test/print.mjs`'s `normalizeForRoundTrip` to add `relations: []` to the
per-table spread (test-file-only change, no rebuild needed). Ran
`node packages/core/test/print.mjs`.

**Observed**: RED — exactly 7 failures as apply-progress claims:
`01-cli-template`, `02-studio-initial`, `03-quirks-values`, `07-referential-actions`,
`08-self-relation`, `12-relation-naming`, `13-ambiguous-relations`. Reverted; confirmed GREEN again.

Both mutations demonstrate the round-trip guarantee is genuinely falsifiable, and `git status`
confirms no source changes remain after both reverts.

## 5. Throw assertion audit (item 4 of the brief)

`grep -n "throws("` over `print.mjs` finds 7 call sites. Classified:

| Line | Assertion | Message-pinned? |
|---|---|---|
| 277 | primaryKey subsequence violation | No (pre-existing, unrelated to this change) |
| 323 | index column has no matching field dbName | No (pre-existing, unrelated to this change) |
| 447 | FK refTable has no matching table | No (pre-existing, unrelated to this change) |
| 462 | FK column has no matching field dbName | No (pre-existing, unrelated to this change) |
| 635 | ambiguous claim (relation matches 2 FKs), **T9** | **Yes** — pinned to `"matches"` |
| 655 | FK claimed by two relations, **T9-variant** | **Yes** — pinned to `"claimed by both"` |
| 678 | claimed FK carrying a `name`, **T10** | **Yes** — pinned to `"constraint name"` |
| 889 (loop, 3 fixtures) | `05-relations`/`19-rejected-allow`/`21-rejected-realtime-columns` resolve but `printSchema` throws | **No** — bare `throws(fn, IndigoPrintError)` |

The three weak-RED items the design explicitly flagged (T9 ambiguity, T9-variant claimed-by-both,
T10 FK-name) **are** correctly message-pinned — confirmed by direct read of lines 616–683.

**Finding (WARNING)**: The `UNPRINTABLE_FIXTURES` throw-confirmation loop (line 886–891) is a bare
`throws(() => printSchema(resolved), IndigoPrintError)` — class-only, not message-pinned — despite
the file's own inline comment at line 819 stating "A dedicated test below pins each fixture's
exact throw." That promise is not fulfilled by the actual assertion. `grep` for each fixture name
(`05-relations`, `19-rejected-allow`, `21-rejected-realtime-columns`) confirms no other, more
specific test exists for these three fixtures beyond this one bare-class loop check.

This is a real, reproducible discrepancy between the code's own documentation and its behavior,
not merely a nitpick. It does **not** currently mask a wrong-reason pass — I confirmed by source
read that each of the three fixtures' throw sites (`fieldNameFor` inside `printRelationField` for
`05-relations`; `fieldNameFor` inside `printAllowOperand` for `19-rejected-allow`; `fieldNameFor`
inside the `@@realtime(columns:)` branch of `printTable` for `21-rejected-realtime-columns`) match
the fixtures' documented reasons. But a future regression that made `printSchema` throw for an
unrelated reason on any of these three fixtures would still pass this test silently, since no
message substring is checked. Downgraded from what could be CRITICAL under the strict-TDD
assertion-quality rubric because: (a) the three genuinely weak-RED items the design named (T9/T9-
variant/T10) **were** properly closed with message pins elsewhere in the same file; (b) this loop
is a distinct, lower-stakes guard (whole-fixture reachability, not the primary throw-path
coverage) that the design/tasks artifacts never explicitly enumerated as requiring message pins —
only the brief's item 6 in this verify pass asked for it directly.

## 6. `db pull` path untouched

- `git diff main -- packages/migrator/test/pull-roundtrip.mjs` → empty (byte-unmodified).
- `git diff main -- packages/cli/src/util.ts` → empty (byte-unmodified).
- `node packages/migrator/test/pull-roundtrip.mjs` → all green (3/3 checks), run standalone by me.
- Orphan-FK case: confirmed by `pull-roundtrip.mjs`'s "printed text has no synthesized `@relation`,
  has an `@fk` comment" check, green.
- Claimed-FK case suppresses the duplicate comment: confirmed by `print.mjs`'s "relation: a claimed
  FK emits no `// @fk(...)` comment (no double representation, T7)" unit test, green.

**Note**: `apply-progress.md`'s citation "`introspect.ts:350`" and "`packages/cli/src/util.ts`" is
slightly imprecise about the module path — the `relations: []` hardcode actually lives in
`packages/migrator/src/introspect.ts:350` (confirmed: `grep -n "relations: \[\]"` finds it there),
not under `packages/cli/src`. The *content* of the claim (the hardcode exists, is unchanged, drives
the documented gap) is correct; only the file path in the prose is abbreviated/wrong. SUGGESTION,
not a functional issue — `packages/cli/src/util.ts` genuinely is unmodified and was the file the
brief asked me to check, which I confirmed independently above.

## 7. The 3 unprintable fixtures

`05-relations.indigo`, `19-rejected-allow.indigo`, `21-rejected-realtime-columns.indigo` each carry
a written per-fixture reason (`print.mjs:795-817`, plus in-fixture header comments) and a pinned
class-level throw (see §5 — class-pinned but not message-pinned, the WARNING above). All three are
confirmed by direct execution to resolve successfully and have `printSchema` throw
`IndigoPrintError`, matching the documented reason in each case (verified by source-level tracing
of the exact throw site, not merely trusting the comment).

## 8. Arithmetic discrepancy (17/20 vs 18/21)

Confirmed: `ls fixtures/*.indigo | wc -l` → **21** files. `UNPRINTABLE_FIXTURES` has 3 entries.
21 − 3 = **18**. The runtime `console.log` line in `print.mjs` reports `18/21 fixtures in scope`
(confirmed via direct execution). `tasks.md` lines 350/352 (task 2.28's own prose) say "20/20" and
"17/20" — an off-by-one typo pre-existing in the task file, not introduced by any code change. **No
assertion depends on the wrong number** — the actual round-trip loop is driven by
`allFixtures.filter(...)` at runtime, not by any hardcoded "17" or "20" literal. This is
SUGGESTION-level (fix the task-file prose for future readers), not a functional defect.

## 9. Full test execution (run by me, this session)

```
node packages/core/test/print.mjs              → print: all green (64 ok lines, exit 0)
node packages/migrator/test/pull-roundtrip.mjs  → migrator pull-roundtrip: all green (exit 0)
node packages/compiler/test/parity.mjs          → regression: all green, 21 fixtures + 3 error fixtures (exit 0)

pnpm clean                                      → 10/10 tasks successful
pnpm build --force                              → 10/10 tasks successful (fresh, no stale dist)
pnpm lint                                       → 19/19 tasks successful (tsc --noEmit / tsc -b --noEmit)
pnpm test                                       → 18/18 tasks successful, exit 0
```

`pnpm test` reused Turbo's content-addressed cache for several sub-tasks after the fresh
`build --force`; this is legitimate (hash-matched, not a stale-dist resurrection — the concern
`clean && build --force` exists to prevent) and I additionally ran the three named focused test
commands directly and independently above, all fresh, all green.

## Strict TDD Compliance

| Check | Result | Details |
|---|---|---|
| TDD Evidence reported | Yes | Full RED/GREEN/TRIANGULATE/SAFETY NET/REFACTOR tables present for both PRs in `apply-progress` |
| All tasks have tests | Yes | 58/58 tasks; every code-bearing task cites `print.mjs` |
| RED confirmed (tests exist) | Yes | Confirmed via file read of `print.mjs`, matches claimed test names |
| GREEN confirmed (tests pass) | Yes | 64/64 checks pass on fresh execution |
| Triangulation adequate | Yes | Multiple fixtures/operand kinds per scenario where the spec has multiple scenarios |
| Safety Net for modified files | Yes | Baseline (36/36, then 55/55) confirmed before each batch per apply-progress; both PRs report pre-batch green baselines |
| Weak-RED closure (T9/T10) | Yes | Message-pinned at lines 635/655/678, confirmed by direct read |
| Mutation proofs | Reproduced (2/4) | I independently reproduced 2.3 and 2.25; 1.8 and 1.20 (PR 1) were read but not independently re-mutated (out of the brief's required scope, which asked for "at least two") |

**Assertion quality**: 1 WARNING (the UNPRINTABLE_FIXTURES loop, §5). No CRITICAL — no tautologies,
no assertions that skip production code calls, no ghost loops over possibly-empty collections (the
round-trip and throw-confirmation loops iterate fixed, non-empty, statically-known fixture sets).

## Issues

### WARNING
1. **`UNPRINTABLE_FIXTURES` throw-confirmation loop is class-only, not message-pinned**
   (`packages/core/test/print.mjs:886-891`), contradicting its own inline comment ("A dedicated
   test below pins each fixture's exact throw"). See §5. Does not currently mask a wrong-reason
   pass (verified by source tracing), but is a real gap relative to the weak-RED discipline applied
   correctly elsewhere in the same file (T9/T10). Recommend tightening to
   `err.message.includes(...)` per fixture before archive, or explicitly accepting this as
   out-of-scope reachability tooling rather than primary coverage.

### SUGGESTION
1. `apply-progress.md`'s file-path citation for the `relations: []` hardcode
   ("`introspect.ts:350`" near "`packages/cli/src/util.ts`") is ambiguous about the module —
   the actual file is `packages/migrator/src/introspect.ts:350`. Cosmetic; the claim's substance
   is correct and independently confirmed.
2. `tasks.md` lines 350/352 (task 2.28's own prose) undercount the fixture corpus by one
   ("17/20" instead of the correct "18/21"), a pre-existing typo also present in PR 1's task 1.22.
   No test or code depends on the wrong number. Recommend a cosmetic fix to `tasks.md` before
   archive, non-blocking.

## Command Evidence

| Command | Exit | Notes |
|---|---|---|
| `node packages/core/test/print.mjs` | 0 | 64 ok, 0 fail |
| `node packages/migrator/test/pull-roundtrip.mjs` | 0 | 3 ok, 0 fail |
| `node packages/compiler/test/parity.mjs` | 0 | all green, 21+3 fixtures |
| `pnpm clean && pnpm build --force` | 0 | 10/10 tasks, fresh (no cache) |
| `pnpm lint` | 0 | 19/19 tasks |
| `pnpm test` | 0 | 18/18 tasks |
| Mutation 2.3 (`isRelationHolder` discriminator) | n/a | RED reproduced (5 failures), reverted, GREEN confirmed |
| Mutation 2.25 (`relations: []` re-added) | n/a | RED reproduced (7 failures), reverted, GREEN confirmed |

## Recommendation

`next_recommended`: **sdd-archive**. No CRITICAL issues block archive. The one WARNING is a
test-quality gap in a secondary (reachability) guard, not a functional defect in the printer or a
gap in the primary weak-RED coverage the design explicitly required — the orchestrator/user may
accept it as-is or route a small follow-up before archiving.

---

## WARNING closed by the orchestrator (post-verify)

Verify's WARNING — the `UNPRINTABLE_FIXTURES` throw-confirmation loop asserted only
`throws(fn, IndigoPrintError)` while its own inline comment claimed each fixture's exact throw was
pinned — is now closed.

**The comment overclaimed, and that is the defect.** A class-only assertion passes whenever the
printer throws for *any* reason, including a reason that masks a regression in the very construct
the fixture exists to exercise. A fixture excluded from the round-trip corpus is only a legitimate
exclusion while the printer refuses it **for the documented cause**; the moment it refuses for some
other cause, the exclusion is hiding a different bug.

`UNPRINTABLE_FIXTURES` became a `Map` from fixture to the exact substring its failure must contain,
each entry carrying the reason inline:

| Fixture | Pinned cause |
|---|---|
| `05-relations.indigo` | `physical name "missingLocal" has no matching field` |
| `19-rejected-allow.indigo` | `physical name "owner" has no matching field` |
| `21-rejected-realtime-columns.indigo` | `physical name "ghostField" has no matching field` |

**Mutation-proved.** Changing the printer's message from `has no matching field — cannot print` to
`is unsupported — cannot print` — a throw of the same class, from the same site, for the same
underlying condition — fails all three:

```
FAIL 05-relations.indigo resolves but printSchema throws for its documented reason
AssertionError: expected the throw to name its documented cause
  (physical name "missingLocal" has no matching field),
  got: Table "Post": column with physical name "missingLocal" is unsupported — cannot print
```

Under the previous class-only assertion that mutation was invisible. Reverted; suite green.

Verify's two SUGGESTIONs (a citation imprecision in apply-progress, and `tasks.md`'s pre-existing
"17/20" typo where the runtime count is `18/21`) are recorded in the archive report as follow-ups.
Neither has a code or assertion dependency — confirmed by verify.
