# Proposal: Studio Audit Log

## Context

Change **5 of 5** splitting the roadmap epic "Auth and production guardrails" (Road to 1.0, Phase 5),
and the change that **closes the epic**. All four siblings shipped and are archived:
`studio-session-auth`, `studio-readonly-mode`, `studio-query-guardrails`, `studio-environment-badge`.
Exploration (Engram `sdd/explore/auth-production-guardrails`) rated this the smallest slice and warned
it is a local dev tool, not a compliance product. No `roadmap.md` exists in this repository; the epic
wording lives in Engram and prior proposals only.

## Intent

Studio's three write routes (`handleInsertRow`, `handleUpdateRow`, `handleDeleteRow` in
`packages/cli/src/studio-server.ts`) emit **nothing**. A row edited from Studio leaves no trace on
stdout, in a file, or anywhere else — the only evidence is the row itself. An operator who finds an
unexpected value cannot tell whether Studio changed it, when, or how many times. Every other posture
in this epic is already disclosed at startup (`Auth:`, `Read-only:`, `Environment:`); what those
guardrails actually *let through* is invisible.

## The honesty constraint — read this before the scope

**`studio-session-auth` is a shared password** (`openspec/specs/studio-session-auth/spec.md`: "a login
route that accepts the shared password"). No user table, no per-user credentials, no RBAC.
`SessionPayload` is `{ v, iat, exp }` — no subject, no session id. **This log therefore cannot answer
"who", and MUST NOT imply that it can.** Exploration's note about sequencing after auth "to attribute"
predates that shape being settled.

Decision: record a short **session correlator** — a truncated hash of the presented session cookie —
present only when auth is enabled. It groups writes plausibly made from one browser session. It proves
nothing about a person: everyone holds the same secret, and two logins in the same second mint an
identical cookie and therefore collide. The field is named `session` (never `user`, `actor`, or `by`),
and "this identifies no one" is a **normative** requirement of the new capability, restated in the log
schema, the startup line, and the docs — not left to prose.

## Scope

### In Scope
- One JSON line on **stdout** per attempted write, via a pure formatter in
  `packages/cli/src/util.ts`, following the sibling resolver convention.
- Fields: ISO timestamp, `op` (`insert|update|delete`), table (schema name), primary-key values,
  changed **column names**, affected row count, outcome (`ok | denied | error`), and the optional
  `session` correlator.
- **Denied writes are logged.** The read-only 403 gate (`studio-server.ts` ~line 763) emits an entry
  with `outcome: "denied"`, `reason: "read-only"`, and no column detail — an attempted mutation against
  a read-only instance is the most interesting line in the log.
- `StudioOptions.auditLog`, resolved **once at startup** by a pure, throwing (never `process.exit`)
  `resolveStudioAuditLog(option, env)` in `util.ts`, joining `resolveStudioReadOnly` /
  `resolveQueryTimeoutMs` / `resolveQueryRowCap` / `resolveStudioEnvironment`. Default **on**.
- CLI `--audit-log` / `--no-audit-log` with `INDIGODB_STUDIO_AUDIT_LOG`, resolved **after `loadEnv()`**
  inside the `studio` action (the `--read-only` precedent, not `--host`'s module-load default).
- A startup disclosure line consistent with the existing `Auth:` / `Read-only:` / `Environment:` block.

### Out of Scope — deliberate non-goals
- **Row values are never logged.** Non-PK column *values* are row data and may be PII, credentials, or
  tokens. This repo already redacts the datasource string (`redactSchema`, `redactSource`); writing row
  values to stdout would contradict its own posture. Column **names** only — a `MUST NOT` in the spec,
  not advice. Primary keys are the deliberate, narrow exception: without them the log cannot say *which
  row*, and a log that cannot be reconciled against a row is not worth writing.
- **No JSONL file, no `.indigo/` directory, no persistence.** Files bring path resolution, directory
  creation, permissions, rotation, retention, and gitignore — lifecycle this tool does not own, and the
  first step of a compliance story this change refuses. Operators who need durability redirect stdout.
- **No fourth `/api/auth/status` widening.** The probe has been widened three times and its name already
  lags what it reports. This posture has no UI affordance and no client decision depends on it; the
  startup line already discloses it to the operator who owns the terminal. Deliberately declined.
- **No identity, no per-user auth, no RBAC, no log shipping, no retention or rotation policy, no
  compliance claim** — all belong to a future epic, not to the last change of this one.
- **Reads are out of scope.** `/api/query` and `/api/tables/:name` are bounded by
  `studio-query-guardrails` and log nothing here.
- Unauthenticated `401`s are not logged: the auth gate covers all of `/api/*`, so a scanner would flood
  the log with entries that establish no write intent.
- Auth, read-only resolution, query guardrails, environment badge, pagination, write guards: behavior
  otherwise untouched.

## Capabilities

### New Capabilities
- `studio-audit-log`: startup resolution, the write-log line and its exact field set, the never-log-values
  rule, denial logging, and the non-identity guarantee.

### Modified Capabilities
- `studio-readonly-mode`: the 403 denial path gains a required audit entry — today it returns and does
  nothing else.
- `studio-row-writes`: the three write routes gain a required log side effect on success and error.
- `studio-session-auth`: **not modified.** The status probe and `SessionPayload` are untouched.

## Approach

One line, written where the outcome is already known. Success and error entries are emitted inside the
three handlers; the denial entry is emitted at the read-only gate in the dispatcher, before routing.

**Seam note:** `SessionPayload` is a named contract and this change **does not widen it**. The
correlator is derived from the raw cookie value already on the request, so no cookie format change, no
version bump, and no invalidation of live sessions. Adding a real `sid` would be a genuine identity
change and is refused here. No `crates/` change, so no `build:wasm` rerun. No `ResolvedSchema` field —
this is process behavior, not schema.

**Rejected alternative: no correlator at all.** Tempting, since it proves no identity. But correlating
"these six deletes came from one session" is real forensic value that costs nothing, provided the field
never claims more than it is. The overclaim risk is handled by naming and normative language, not by
withholding the field.

**Rejected alternative: JSONL under `.indigo/`.** See non-goals. Cross-restart persistence is a real
want; it is a separate change with its own lifecycle questions, not a parenthetical here.

**Rejected alternative: default off.** A log nobody enables is not a log — the same reasoning
`studio-query-guardrails` applied to its defaults.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/cli/src/util.ts` | Modified | `resolveStudioAuditLog` + pure entry formatter |
| `packages/cli/src/studio-server.ts` | Modified | Option, denial-gate entry, three handler entries, startup line |
| `packages/cli/src/index.ts` | Modified | `--audit-log` / `--no-audit-log`, resolved after `loadEnv()` |
| `packages/cli/src/studio-auth.ts` | Untouched | `SessionPayload` unchanged; correlator reads the raw cookie |
| `apps/studio/*` | Untouched | No UI, no probe field |
| `/api/query`, `/api/tables/:name` | Untouched | Reads are out of scope |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| The log is read as accountability it cannot provide | **High** | Normative non-identity requirement; field named `session`, never `user`; restated in log schema, startup line, and docs |
| Correlator collision (two logins in the same second) | Low | Accepted and documented; it is a correlator, not an identifier |
| A PK value is itself sensitive (e.g. an email PK) | Med | Accepted trade, stated: PKs are the one value class logged, because a log that cannot name the row is useless. Disable with `--no-audit-log` |
| A future contributor adds a `value` field "for debugging" | Med | `MUST NOT log non-PK column values` as a spec requirement with its own scenario, not a comment |
| Log volume noise in normal dev use | Low | One line per write; writes are deliberate and rare in Studio |
| Denial entries let a probe map table names | Low | Denial entries reach stdout only, never a response; the 403 body is unchanged |
| Scope creep toward retention/shipping | Med | Named non-goals above; this repo's most common review defect |

## Rollback Plan

Revert the change commits. Short of revert, `--no-audit-log` (or
`INDIGODB_STUDIO_AUDIT_LOG=false`) restores today's behavior exactly — every path becomes a structural
no-op, and no file, table, or wire format was created to clean up.

## Dependencies

None. No new packages. All four siblings are shipped and archived; none are modified beyond the two
delta capabilities named above.

## Success Criteria

- [ ] A successful insert/update/delete emits exactly one stdout JSON line with op, table, PK values,
      changed column names, row count, and `outcome: "ok"`.
- [ ] **No non-PK column value appears in any log line**, verified by a test that writes a distinctive
      sentinel value and asserts it is absent from captured stdout.
- [ ] A write refused by read-only mode emits `outcome: "denied"`, `reason: "read-only"`; the HTTP 403
      response body is byte-identical to today.
- [ ] A failing write emits `outcome: "error"` without leaking the submitted values.
- [ ] With auth disabled, no `session` field is present; with auth enabled, it is present and no log
      line, message, or doc string uses "user", "actor", or "who".
- [ ] `--no-audit-log` produces byte-identical stdout to today's Studio on the write path.
- [ ] `GET /api/auth/status` response is byte-identical to today — no fourth widening in the diff.
- [ ] No file is created anywhere on disk by this change at runtime.
- [ ] `pnpm build && pnpm lint && pnpm test` green from the repo root.

## Proposal question round (execution_mode: auto — assumptions recorded, not asked)

1. **Identity**: settled by source, not assumption — a shared password cannot attribute. The correlator
   ships with an explicit non-identity guarantee. Most consequential call here.
2. **Sink**: assumed stdout only. JSONL persistence is deferred to its own change, not hinted at.
3. **Payload**: assumed PK values in, all other column values permanently out. If PKs are also
   considered too sensitive, the log degrades to "a write happened to table X" — reversible by
   re-proposing, but it loses reconcilability.
4. **Denials**: assumed logged; reads and 401s assumed not.
5. **Default**: assumed on, with an explicit off switch.
6. **Probe**: assumed NOT widened — the first change in this epic to decline.
