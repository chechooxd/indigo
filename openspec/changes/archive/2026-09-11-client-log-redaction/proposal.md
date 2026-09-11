# Proposal: Redact bound parameter values from client statement logging

## Intent

`packages/client/src/client.ts:252` (`wrapLog`) runs `console.log("[indigodb]", sql, params)`,
dumping every bound parameter value — password hashes, tokens, PII — to stdout whenever
`log: true`. It is opt-in, but the contexts that enable it (CI debugging, staging, support
calls) are exactly the contexts where stdout is captured and retained.

Worse, the defect is **canonically specified**. `openspec/specs/client-query-extensions/spec.md:36-38`
requires `wrapLog` to log "the exact SQL/params actually sent, with zero behavior change from
today", and the "Absent extensions" scenario (`:54-59`) locks `log` behaviour as identical to
before that capability existed. This is not a spec gap — it is a spec that ratifies a defect,
the same family as the golden snapshot that froze the `onDelete` bug. Goal: **no log statement
can emit a bound parameter value.**

## Scope

### In Scope
- Redact parameter values in `wrapLog` (`client.ts:249-254`), unconditionally, on both the
  `this.exec` path and the `$withSession`/`$transaction` path (`client.ts:304` — they compose
  identically; there is no asymmetry).
- A MODIFIED delta on `client-query-extensions` landing with the code.
- Update the `log?: boolean` doc comment (`client.ts:56-57`). NOTE: earlier drafts cited `types.ts:56-57`; that declaration does not exist there.
- Extend `packages/client/test/extensions.mjs:98-115` — it does not ratify the leak (empty
  params array), but its assertion on `console.log`'s argument shape is load-bearing.

### Out of Scope
- The PGlite adapter's missing rollback diagnostic (`pglite.ts` logs nothing where `pg.ts:88`
  logs errors). A real asymmetry, but a *missing* log, not a leaking one.
- Structured logging, tracing, metrics, compiler benchmarks — the broader observability epic.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `client-query-extensions`: the requirement titled **"Extension composition order and wrapLog
  placement"** must stop requiring raw params and must require redacted placeholders. Reuse that
  exact title (see Risks).

## Approach

`wrapLog` emits redacted positional placeholders — `$1=<redacted>`, `$2=<redacted>` — instead of
values. Position and arity survive, which is what makes `log: true` worth having for bind-order
and arity bugs; no value escapes. This mirrors the in-repo `studio-audit-log` convention already
specified at `openspec/specs/studio-audit-log/spec.md:54-65`: log structure (column names), never
content.

**Settled; rejected alternatives:**

| Rejected | Why |
|---|---|
| Configurable opt-out / raw mode | Reproduces the hazard: CI and staging are precisely where an unsafe knob is left enabled. |
| Drop params entirely | Too weak to debug with; users replace it with an uncontrolled raw `console.log`, which is worse than today. |
| Log arity only (`3 params`) | Misses bind-order bugs; same weakness. |
| Log value types | `typeof null === "object"`, Dates and arrays need special-casing — more surface to get subtly wrong. |

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/client/src/client.ts:249-254` | Modified | `wrapLog` emits redacted placeholders |
| `openspec/specs/client-query-extensions/spec.md:32-59` | Modified | Delta removes the requirement to log raw params |
| `packages/client/test/extensions.mjs:98-115` | Modified | Argument-shape assertion tracks the new signature |
| `packages/client/src/client.ts:56-57` | Modified | `log?: boolean` doc comment (NOT `types.ts` — no such declaration there) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| **Spec merge matches requirements by TITLE.** When `migration-history-forensics` expressed a MODIFIED requirement under a *new* title, the merge read it as an addition and the predecessor survived beside it, leaving the canonical spec self-contradictory. | High | The delta MUST reuse the exact title **"Extension composition order and wrapLog placement"**. Verify at archive that the canonical spec holds one such requirement, not two. |
| Code lands without the spec delta, leaving canonical text demanding behaviour the code no longer has | Med | Spec delta and code land in the same change; verify reads both. |
| Consumers parse `[indigodb]` stdout | Low | `log` is a debugging aid, documented as unstable output; no parsing contract exists. |
| Redaction weakens a real debugging workflow | Low | Positions and arity preserved; no confirmed workflow depends on values. |

## Rollback Plan

Single-commit revert. The change is one function body, one test, one spec delta, and doc
comments — no schema, migration, generated artifact, or persisted state. Reverting restores
the previous `console.log("[indigodb]", sql, params)` and the previous canonical requirement
text together.

## Dependencies

None. No new packages, no cross-package type changes.

## Success Criteria

- [ ] A test constructs a client with `log: true` and a **non-empty** params array containing a
      recognisable sentinel secret, captures stdout, and asserts the sentinel never appears in
      any captured line.
- [ ] The same test asserts the emitted line still carries the SQL and one placeholder per
      parameter, in order — proving redaction did not degrade to dropping params.
- [ ] Redaction holds on both `$queryRaw`/default path and inside `$transaction`.
- [ ] `extensions.mjs:98-115` still passes: the logged SQL is the post-extension rewrite.
- [ ] `openspec/specs/client-query-extensions/spec.md` no longer contains "with zero behavior
      change from today" for params, and after archive holds exactly one requirement titled
      "Extension composition order and wrapLog placement".
- [ ] `pnpm build && pnpm lint && pnpm test` green.
