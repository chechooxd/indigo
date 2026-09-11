# Exploration: client-log-redaction

**Change**: `client-log-redaction`
**Phase**: explore
**Date**: 2026-09-11
**Engram topic**: `sdd/client-log-redaction/explore`

> Written by the orchestrator from the Engram artifact: the `sdd-explore` agent's toolset carried
> no Write tool, so it persisted to Engram only. Content is the agent's; this file is the
> hybrid-store filesystem copy.

## Current State

`IndigoClientBase.wrapLog` (`packages/client/src/client.ts:249-254`) is the **only** site in the
entire workspace that logs bound query parameter *values*:

```ts
private readonly wrapLog =
  (run: Executor): Executor =>
  async (sql, params) => {
    if (this.log) console.log("[indigodb]", sql, params);
    return run(sql, params);
  };
```

It composes as the innermost wrapper on both `this.exec` and `$withSession`'s session executor
(`client.ts:304`), so `$transaction` gets identical — not asymmetric — logging behaviour. The
orchestrator speculated there might be a `createPgAdapter`/`createPGliteAdapter`-style asymmetry
here; **there is not**, and that speculation is corrected.

## The finding that reshapes this change

**The defect is canonically specified.** `openspec/specs/client-query-extensions/spec.md:36-38`:

> `wrapLog`'s `log: boolean` behavior MUST remain innermost — between the last extension and the
> base executor — **logging the exact SQL/params actually sent, with zero behavior change from
> today.**

Its "Absent extensions" scenario (`:54-59`) further locks `log` behaviour as byte-identical to
before that capability existed. So the canonical spec does not merely fail to forbid the leak — it
**requires** it. A code-only fix would leave the repository's own specification demanding the
behaviour the code no longer has, which is precisely the contradiction that had to be corrected
after `migration-history-forensics` archived.

**This change therefore needs a MODIFIED delta on `client-query-extensions`, landing with the code.**

## Affected Areas

- `packages/client/src/client.ts:252` — the defect.
- `openspec/specs/client-query-extensions/spec.md:36-38, 47-52` — canonical text ratifying raw
  param logging; needs a delta.
- `packages/client/test/extensions.mjs:98-115` — the only test constructing `log: true`. It asserts
  `console.log`'s SQL **argument position**, and calls with an empty params array — so it does
  **not** ratify the leak (unlike prior incidents in this repo where a green test locked in a bug),
  but its argument-shape assertion is load-bearing and must track the new call signature.
- `client.ts:56-57` — the `log?: boolean` declaration and its doc comment. (Corrected 2026-09-11: an earlier draft of this line cited `types.ts:56-57`; `rg "log\?:" packages/client/src/types.ts` returns nothing — the option is declared only in `client.ts`.)

## Verified absences — no other param-leaking site

- `packages/client/src/adapters/pg.ts:88` and `packages/realtime/src/engine.ts:158` log
  `Error`/`err.message` only, never params.
- `pglite.ts` has no logging at all. That is a real asymmetry against `pg.ts` — no rollback
  diagnostic — but it is a *missing* log, not a leaking one. **Out of scope; flagged as a separate
  follow-up.**
- `packages/cli/src/index.ts:112-113` (`db push --print`) logs DDL text with no bound params.
- `packages/cli/src/studio-server.ts`'s audit log (`:931, :1161, :1175, :1189`) is **already
  correctly redacted by spec** — `openspec/specs/studio-audit-log/spec.md` scopes it to column
  *names* and PK values, never other values. **This is the in-repo precedent to mirror.**
- `packages/migrator/src/**` has no `console.*` outside test scaffolding.
- `packages/realtime/test/log.mjs` is a name collision — it tests the WAL `_indigo_realtime_log`
  table, unrelated.

## Correction to the framing this exploration was given

The prompt cited a "Phase 6, Observability and benchmarks" roadmap section. **No such file exists
in the tracked tree** (full-tree grep for `Phase 6` and `bound parameter` found nothing). The
explorer is right that no proposal should cite a file path for it.

*Orchestrator note:* the roadmap is real but is a published **Artifact**, not a repository file —
https://claude.ai/code/artifact/3164cbdb-95c0-445b-af85-3f89da36dd72. Cite it as that, or cite the
verified defect and spec text directly. The exit criterion it states is worth carrying regardless:
**"No log statement can emit a bound parameter value."**

## Approaches

| # | Approach | Tradeoff | Effort |
|---|---|---|---|
| 1 | Drop params entirely | Simplest, but the log becomes near-useless for the exact debugging `log: true` exists for — likely replaced by an uncontrolled raw `console.log` in user code, which is worse | Low |
| 2 | Log arity only (`3 params`) | Cheap, zero leak. Weak signal; misses bind-order bugs | Low |
| 3 | **Redacted placeholders (`$1=<redacted>`)** | Preserves positional/arity diagnostic value, zero value leakage, mirrors the in-repo `studio-audit-log` "structure not content" convention | Low-Med |
| 4 | Log types not values | More diagnostic, but `typeof null === "object"`, Dates and arrays need special-casing — more surface to get subtly wrong | Medium |
| 5 | Configurable redaction, safe default | Lets a local debugger opt back into raw values — and reproduces the exact hazard motivating the change, since CI/staging is precisely where an unsafe knob gets left on | Medium |

**Recommendation: Approach 3, unconditional, with no new configuration knob.** It satisfies "no log
statement can emit a bound parameter value" without an escape hatch someone can leave enabled in
CI, and it mirrors a convention this repository already ships and specifies. Reject 5 for that
reason; reject 1 and 2 for insufficient diagnostic value.

## Risks

- **Spec and code must land together.** `client-query-extensions/spec.md` currently contradicts the
  fix; a code-only change leaves verify failing against stale canonical text.
- `extensions.mjs:98-115`'s assertion on `console.log`'s argument shape must track the new
  signature — not because it is wrong today, but because its positions are load-bearing.
- Do **not** fold in the PGlite missing-rollback-log gap, or any structured-logging / tracing /
  metrics / benchmark work. Separate, unrelated surface.

## Ready for Proposal

Yes. Single confirmed defect, single canonical spec needing a MODIFIED delta, one test needing
extension, no other logging sites in scope.
