# Archive Report: Studio Audit Log

**Change**: `studio-audit-log`
**Archived to**: `openspec/changes/archive/2026-08-31-studio-audit-log/`
**Date**: 2026-08-31
**Position**: change **5 of 5** — the LAST change of the roadmap epic "Auth and production
guardrails" (Road to 1.0, Phase 5). **This change closes the epic.**

Archived siblings, in delivery order: `studio-session-auth`, `studio-readonly-mode`,
`studio-query-guardrails`, `studio-environment-badge`.

> There is no `roadmap.md` committed in this repository. The epic wording lives only in Engram
> (`sdd/explore/auth-production-guardrails`, obs #799) and in prior proposals.

## Executive Summary

Studio's write path had **zero** logging: `handleInsertRow` / `handleUpdateRow` /
`handleDeleteRow` caught errors and returned them in the HTTP response, and nothing else was
recorded anywhere. This change emits one structured JSON line on stdout per **attempted** write —
including writes denied by read-only mode — carrying the operation, table, primary key, affected
column *names*, and a session correlator.

Final verdict: **PASS WITH WARNINGS** — 0 CRITICAL, 1 WARNING (budget), 1 SUGGESTION.
22/22 spec scenarios COMPLIANT. All 41 testing rows (design's 40 + the spec-only restart
scenario) have a covering, runtime-executed test. `tasks.md`: **34/34 complete**.

## Delivery

Two chained PRs, `stacked-to-main`, both merged:

| PR | Scope | Commit | Merge |
|----|-------|--------|-------|
| 1 | Pure layer — resolver, correlator, formatter + unit suite | `d6773f5`, `5e8099d` | `04373b5` |
| 2 | Server + CLI wiring + integration suite | `d62a5fd`, `afebb6d` | `291ad1c` |

Base was `main` @ `8b0d0f0`. Both feature branches deleted.

PR 1 was merged **without its own verify pass** — deliberately. It is pure functions with nothing
wired, so most spec scenarios were not yet observable and a separate pass would have reported
little but "deferred to PR 2". It was verified as part of the full change instead. The
security-critical NUL-separator property was independently confirmed before merge (see below).

## The load-bearing decision: this log cannot say *who*

`studio-session-auth` is a **shared password**. `SessionPayload` is `{ v, iat, exp }` — no
subject, no session id. Every authenticated session presents the same secret.

Exploration had suggested sequencing this change after auth "to attribute", but that note predated
the shape auth actually took. So the honest position, taken explicitly:

- The field is named **`session`**, never `user`, `actor`, or `who` — enforced by a regex sweep
  over shipped source, not by review discipline.
- It is a **correlator**, not an identifier: it can group writes within one session; it can never
  identify a person. "This field identifies no one" is a **normative requirement** with its own
  scenario, not prose.
- Two logins minted in the same second produce a byte-identical cookie and therefore collide.
  Accepted and documented rather than hidden.
- When auth is disabled — the zero-config default, and the common case — the `session` key is
  **absent**, not `null` and not `"anonymous"`. Both of those read as "unknown user" when the
  honest answer is "auth is off".

An audit log that implies accountability it structurally cannot deliver is worse than no audit
log, because it will be trusted in exactly the moment it matters.

## The security decision: why the obvious correlator is a vulnerability

**Shipped**: `HMAC-SHA256(auditKey, LABEL + "\0" + rawCookieToken)`, hex, first 12 characters
(48 bits), where `auditKey = randomBytes(32)` generated **inside `startStudio`**, never derived
from the password, never logged, never persisted.

The rejected alternatives were not stylistic. The cookie's payload is **predictable**: `v` is
constant, `exp = iat + 86400`, and `iat` is recoverable from the log line's own ISO timestamp. So
the only unknown in the cookie is its signature — a deterministic function of the shared password.

Under a keyless `sha256(cookie)`, or one keyed by a *fixed public label*, or (worse) keyed by the
derived session secret itself, anyone holding the log could work offline: guess a password →
derive the secret → mint the candidate cookie for each plausible `iat` → digest → compare. That
turns the audit log into an **offline guessing oracle against a human-chosen shared password**,
strictly cheaper than attacking `POST /api/auth/login` over HTTP. Domain separation alone does not
fix it — a fixed non-secret label is reproducible by the attacker.

A per-instance random key leaves **no candidate value to compare against**. The consequence is
accepted rather than engineered away: the key rotates on restart, so correlators are comparable
only within one process lifetime. That property is normative, with its own scenario, precisely so
a future "improvement" cannot quietly derive the key from the password and reintroduce the hole.

Verify assessed 48-bit truncation as defensible for a correlator (not an identifier) and confirmed
truncation does not weaken key-recovery resistance.

Two implementation details that are easy to get wrong and were checked:

- The domain separator must be a **literal NUL byte** in code. In `design.md` it is written as the
  two-character escape `\0`, because embedding a literal NUL made that file register as *binary*
  to `rg` — silently hiding it from every future search, including verify's own gap analysis.
  Confirmed behaviourally by recomputing the HMAC both ways against the built output.
- `auditKey` is generated **inside `startStudio`**, not at module load. In production the two are
  identical (one server per process), but a module-level `const` would make the normative
  restart-rotation scenario impossible to test, since the harness proves rotation by calling
  `withStudio` twice in one Node process.

## Other decisions

1. **stdout only.** No JSONL file, no persisted audit table, no rotation, retention, or shipping.
   Files bring path resolution, permissions, gitignore and lifecycle this tool does not own, and
   they are the first step of the compliance story this change deliberately refuses. "No file is
   ever created" is a tested requirement.
2. **Column *names* are logged; row *values* never** — primary keys the deliberate exception,
   because a log that cannot name a row cannot be reconciled. This is consistent with the repo's
   existing posture: `redactSchema` / `redactSource` already keep the datasource string out of
   what Studio exposes. Enforced by **shape**, not discipline: `pk` arrives pre-stringified as
   `Record<string,string>`, and request bodies are typed so that passing one to the log path fails
   `tsc`. That last guarantee is compile-time, and is documented as such rather than counted as
   runtime coverage.
3. **DB error messages are never logged.** Postgres embeds row values in them. Errors carry a
   coarse `reason: "db-error"` plus SQLSTATE only. See the finding below — this one nearly slipped.
4. **Denied writes ARE logged.** An attempted mutation against a read-only instance is the most
   interesting line in the log. The denial is emitted at the read-only dispatcher gate, which
   returns before `readBody`, so it carries op/table/session/`count:0`/`denied`/`read-only` and
   cannot carry pk or columns. Unauthenticated 401s are *not* logged — the auth gate covers all of
   `/api/*` and a scanner would flood it. `GET /api/rows/` still 403s but logs nothing.
5. **`respondWrite(res, status, body, audit, entry)`** — one function that both sends the response
   and emits the line, so a branch physically cannot respond to a write without logging. The
   invariant is structural and tested, not a review rule.
6. **No fourth widening of `GET /api/auth/status`.** The first change in this epic to decline it:
   there is no UI affordance and no client decision that depends on this posture, and the startup
   line already tells the operator who owns the terminal. A byte-identical probe response is a
   normative success criterion with its own test.
7. **Malformed `INDIGODB_STUDIO_AUDIT_LOG` is REJECTED at startup**, exit non-zero, message naming
   the variable. Only exact `"0"` / `"false"` disable; default is on. This deliberately differs
   from `isReadOnlyEnv`'s silent tolerance: this switch has a *disable* direction, so silence fails
   dangerously — an operator writing `=no` to stop table names and PKs reaching stdout would keep
   emitting them while believing logging was off.
8. **Commander ordering is load-bearing**: `--audit-log` is declared **before** `--no-audit-log`,
   which leaves commander's default `undefined` and preserves the tri-state that flag-over-env
   precedence needs. A refactor that reorders them breaks it silently.

## Findings worth keeping

**The `.detail` vs `.message` leak.** Proving a negative test *bites* is not optional. The apply
phase wrote a mutation to confirm its "DB error messages are never logged" test would catch a leak
— using `error.message`. The test did **not** trip. The leaked value in a Postgres unique
violation lives in `error.detail`, not `error.message`. Had it stopped there, it would have
concluded the test worked, with a test that did not protect against the real hazard. It had to
mutate `.detail` to prove it. Verify independently confirmed the shipped error branch only ever
builds `{ reason: "db-error", code: extractSqlState(error) }`.

**A fixture named "User" tripped the wording sweep.** The `user`/`actor`/`who` regex sweep matched
the test fixture's own schema. The fix was a dedicated fixture, not a looser regex — loosening the
sweep would have kept it green while removing its power.

## Corrections made during the cycle

1. **Spec/design reconciled** (`5a1a564`), both in design's favour: malformed env now rejects
   rather than silently keeping the default; the per-process random key became normative with a
   new covering scenario.
2. **`design.md` de-binarised and the key scope pinned** (`8b0d0f0`): two literal NUL bytes
   replaced with the `\0` escape, and the key pinned to per-`startStudio`-instance.
3. **`tasks.md` gap analysis** found the restart-rotation scenario had no row in design's 40-row
   Testing Strategy table, and scheduled it as task 3.15 with a named mutation.
4. **PR 1's test suite was wired into the test chain before merge.** The apply phase had deferred
   it to PR 2. A test nothing runs is a test that does not exist.

## Verification

CI is disabled in this repository (`.github/workflows-disabled/`), so local is the gate:

| Command | Result |
|---------|--------|
| `pnpm build` | 10/10 Turbo tasks, exit 0 |
| `pnpm lint` | 19/19 Turbo tasks, exit 0 |
| `pnpm test` | 18/18 Turbo tasks, exit 0 |

## Spec changes merged into the source of truth

| Spec | Type |
|------|------|
| `openspec/specs/studio-audit-log/spec.md` | **NEW** capability |
| `openspec/specs/studio-readonly-mode/spec.md` | **MODIFIED** — the write gate also emits a denial line |
| `openspec/specs/studio-row-writes/spec.md` | **ADDED** — success and error audit entries |

`studio-session-auth` was deliberately **not** touched (decision 6).

## WARNING carried at close

**Review budget.** The cumulative change is **1435 changed lines** against an 800-line budget —
**79% over**. Production code is only 246 lines; the overrun is the 799-line integration suite.
It is a direct consequence of the brief demanding a mutation-verifiable negative test for every
absence requirement, in a change unusually dense with them. Accepted by the orchestrator rather
than splitting a test file from the code it covers.

Recorded honestly because the orchestrator's own first estimate said 37% — that figure counted
only PR 2 and included `tasks.md` churn. The verify phase recomputed it correctly.

## Follow-ups — NOT resolved

1. **SUGGESTION** — `tasks.md` and `design.md` mention a fourth forbidden identity word ("by")
   that the normative spec does not require and the shipped regex sweep does not cover.
   Non-blocking: the spec is authoritative and no shipped string contains it as a token.
2. `GET /api/auth/status`'s name now clearly lags what it reports (`readOnly`, `queryTimeoutMs`,
   `queryRowCap`, `environment`). Renaming it was declined by every change in this epic; it is
   now a standing item.
3. **Out of scope but found during this change, and worth its own change**: `isReadOnlyEnv`
   (`packages/cli/src/util.ts`) is exact-match, and `openspec/specs/studio-readonly-mode/spec.md`
   makes that normative — `INDIGODB_STUDIO_READONLY=yes` silently leaves read-only **off**, with
   no warning. An operator who believes they have protected a production database has not, and is
   not told. That fails in the dangerous direction, and it is inconsistent with the newer
   resolvers in the same file (`resolveQueryTimeoutMs`, `resolveStudioEnvironment`, and now
   `resolveStudioAuditLog`) which all reject invalid input loudly. Changing it means amending an
   archived normative spec, so it belongs in its own change rather than as creep here.

## Epic closed

With this change, "Auth and production guardrails" is complete. Studio now has: an optional shared
password with session cookies; a server-enforced global read-only mode; statement timeout and row
cap on the ad-hoc SQL console; an explicit environment badge; and a write audit log. Together they
answer *who may connect*, *what they may do*, *how much they may cost*, *where they are pointed*,
and *what they did*.
