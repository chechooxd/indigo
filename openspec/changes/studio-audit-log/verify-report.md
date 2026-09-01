```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:924f851dadca08f31596758a6280a2c6cd4473d86848885f137e8330379b2026
verdict: pass_with_warnings
blockers: 0
critical_findings: 0
requirements: 10/10
scenarios: 22/22
test_command: pnpm test --force
test_exit_code: 0
test_output_hash: sha256:1c56a0c8713c3619bd34c554f988de8a93abb008635d26064049c330eefc93e7
build_command: pnpm build --force
build_exit_code: 0
build_output_hash: sha256:125813f5c90274f7915a8ac508fc3949ea0a0af2c42c2e1d6d57336228661990
```

## Verification Report

**Change**: studio-audit-log (final change of the "Auth and production guardrails" epic — 5/5)
**Version**: N/A (no schema version bump; no `crates/` change)
**Mode**: Strict TDD
**Scope**: FULL change — PR 1 (`04373b5`, merged into `main`) + PR 2 (`feat/studio-audit-log-2-server` @ `d62a5fd`, off `main`)

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total | 34 |
| Tasks complete | 34 |
| Tasks incomplete | 0 |

Counted directly from `openspec/changes/studio-audit-log/tasks.md` via `rg -n "^\- \["` (34 total, 34 `[x]`, 0 `[ ]`).

### Build & Tests Execution

**Build**: ✅ Passed (fresh, `--force`, cache bypassed on all 10 tasks)
```text
pnpm build --force → Tasks: 10 successful, 10 total (0 cached)
```

**Lint**: ✅ Passed (fresh, `--force`, cache bypassed on all 19 tasks — confirms Testing Strategy row 17's compile-time-only guarantee: `pk: Record<string,string>` rejects `Record<string,unknown>`)
```text
pnpm lint --force → Tasks: 19 successful, 19 total (0 cached)
```

**Tests**: ✅ 18/18 package test tasks passed (fresh, `--force`), exit code 0
```text
pnpm test --force → Tasks: 18 successful, 18 total (0 cached), 12m40s
Relevant lines observed directly in the raw log:
  "cli studio-audit-log pure-layer: all green"      (studio-audit-resolution.mjs, PR 1)
  "@indigodb/cli studio-audit: all green"            (studio-audit.mjs, PR 2, 24/24 checks)
Full @indigodb/cli chain (18 files) ran and passed, unaffected by this change.
```
`INDIGODB_TEST_DATABASE_URL` was unset — `@indigodb/realtime`'s Postgres-gated suites (`wal-source.mjs`, `pg-harness.mjs`) printed SKIP and passed, per documented convention; unrelated to this change (which uses PGlite, not gated).

**Coverage**: Not available — no coverage tool configured in this repo (Node `test` chain, no `c8`/`nyc`). Not a failure.

### Line-count reality check (both PRs, measured, not estimated)
`git diff --numstat 8088361..d62a5fd -- packages/cli`:
| File | +/- |
|---|---|
| `util.ts` | +134/-0 |
| `test/studio-audit-resolution.mjs` | +252/-0 (new) |
| `studio-server.ts` | +202/-26 |
| `index.ts` | +18/-0 |
| `package.json` | +1/-1 |
| `test/studio-audit.mjs` | +799/-0 (new) |

PR 1 alone: 386 changed lines. PR 2 alone (excl. `tasks.md`): 1047 changed lines (matches apply-progress's own count). Full change excl. `tasks.md`: **1433 changed lines** against the 800-line budget — **79% over**, not the ~37% figure in the orchestrator's note (that figure reflects PR 2's raw `git diff --numstat` total of 1046+53=1099, which itself includes the 26/26 `tasks.md` doc lines and is scoped to PR 2 only, not the cumulative two-PR total). Per the orchestrator's explicit instruction this is **not treated as a blocking finding** — the overrun is concentrated entirely in the two test files (`studio-audit-resolution.mjs` unit suite, `studio-audit.mjs` integration suite), both proportionate to the mutation-verifiable negative-test brief for this change. Recorded as **WARNING**, not CRITICAL.

### TDD Compliance
| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | Full "TDD Cycle Evidence" table present in apply-progress #837, covering both PRs |
| All tasks have tests | ✅ | 34/34 — every GREEN phase task traces to a RED phase task |
| RED confirmed (tests exist) | ✅ | `studio-audit-resolution.mjs` (252 lines) and `studio-audit.mjs` (799 lines) both exist and were independently re-run this session |
| GREEN confirmed (tests pass) | ✅ | Both suites pass in this session's fresh `pnpm test --force` run |
| Triangulation adequate | ✅ | Every negative/two-option row in design's 40-row table has its own dedicated assertion; restart-rotation adds a 41st scenario not in the original table |
| Safety Net for modified files | ✅ | `studio-server.ts`/`index.ts` are modifications — pre-existing suites (`studio-server.mjs`, `studio-write.mjs`, `studio-readonly.mjs`, `studio-auth.mjs`, etc.) ran in the same `pnpm test` invocation and remained green, confirming no regression |

**TDD Compliance**: 6/6 checks passed

### Mutation-verified negatives (independently spot-checked, not just trusted from apply-progress)
1. **Sentinel leak** (`studio-audit.mjs:222-241`): writes `"ZZ-SENTINEL-9137"` into a non-PK column across INSERT and UPDATE, asserts absence from all captured stdout. Confirmed by direct code read that `patchInput`/`valuesInput` never reach `buildAuditEntry` — only `columns` (names) and `pk` (via `formatPkValue`) do.
2. **DB-error `.detail` leak** (`studio-audit.mjs:346-365`): asserts `!joined.includes("a@example.com")` after a real PGlite unique-violation. Verified in source (`studio-server.ts:1259-1266`) that the error branch only ever constructs `{reason:"db-error", code: extractSqlState(error)}` — `extractSqlState` reads only `error.code` matched against `/^[0-9A-Z]{5}$/`, never `.message` or `.detail`. The orchestrator's claim that a first `.message`-only mutation would NOT trip this specific test, but a `.detail` mutation would, is architecturally consistent: the assertion is on the full captured-stdout join, so **either** field leaking would fail it — the test is not narrowly coupled to one field, which is stronger than the minimum bar.
3. **Restart-key reuse** (`studio-audit.mjs:750-793`): two sequential `withStudio(...)` calls in one test process, same cookie, asserts `session1 !== session2`. Verified in source that `auditKey = randomBytes(32)` is declared **inside** `startStudio` (`studio-server.ts:802`), not module-scope — the only shape that makes this test meaningful rather than vacuously true.

### Spec Compliance Matrix

#### `studio-audit-log` (NEW, 7 requirements / 15 scenarios)
| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Resolved once at startup, default on | Default enabled | `studio-audit-resolution.mjs` (rows 1-4) | ✅ COMPLIANT |
| " | `--no-audit-log` beats env | same | ✅ COMPLIANT |
| " | Exact-match env disables | same | ✅ COMPLIANT |
| " | Malformed env rejected at startup | same (row 5, asserts `throws`); `index.ts:377-385` catch→exit(1) wired | ✅ COMPLIANT |
| Successful writes: names not values | Sentinel absent | `studio-audit.mjs` row 21 | ✅ COMPLIANT |
| " | PK present | `studio-audit.mjs` row 18 (INSERT `pk` from returned row) | ✅ COMPLIANT |
| session is correlator not identity | No session, auth off | `studio-audit.mjs` row 28 | ✅ COMPLIANT |
| " | Stable within a session | `studio-audit.mjs` row 29 | ✅ COMPLIANT |
| " | Differs across sessions | `studio-audit.mjs` row 29 (two logins ≥1.1s apart, avoiding the accepted same-second collision) | ✅ COMPLIANT |
| " | Not the raw cookie value | `studio-audit.mjs` row 30 | ✅ COMPLIANT |
| " | Correlators do not survive a restart | `studio-audit.mjs` 3.15 (two sequential `startStudio` instances) | ✅ COMPLIANT |
| Startup disclosure line | Reflects resolved state | `studio-audit.mjs` 3.12 | ✅ COMPLIANT |
| stdout is the only sink | No file created | `studio-audit.mjs` 3.11 (`mkdtempSync` + `readdirSync` before/after, asserts empty) | ✅ COMPLIANT |
| Reads never logged | Read produces no line | `studio-audit.mjs` 3.7/32 (`GET /api/tables/:name`, `POST /api/query`, `GET /api/schema`) | ✅ COMPLIANT |
| Status probe unaffected | Byte-identical response | `studio-audit.mjs` 3.10 (on/off comparison + exact 6-key set) | ✅ COMPLIANT |

#### `studio-readonly-mode` (MODIFIED, 1 requirement / 3 scenarios)
| Scenario | Test | Result |
|---|---|---|
| All three verbs rejected identically from one gate | `studio-readonly.mjs` (pre-existing, unaffected — re-ran green this session) + `studio-audit.mjs` 3.3/22 | ✅ COMPLIANT |
| Denied write emits `outcome:"denied"`, `reason:"read-only"` | `studio-audit.mjs` 3.3, row 22-23 | ✅ COMPLIANT |
| 403 body unaffected by audit logging | `studio-audit.mjs` 3.9, row 35 (`{auditLog:false, readOnly:true}` → byte-identical 403) | ✅ COMPLIANT |

#### `studio-row-writes` (ADDED, 2 requirements / 4 scenarios)
| Scenario | Test | Result |
|---|---|---|
| Successful INSERT emits one ok line | `studio-audit.mjs` row 18 | ✅ COMPLIANT |
| Successful UPDATE emits one ok line | `studio-audit.mjs` row 19 | ✅ COMPLIANT |
| Successful DELETE emits one ok line | `studio-audit.mjs` row 20 | ✅ COMPLIANT |
| Failing write logs error without leaking values | `studio-audit.mjs` rows 25-27 (`db-error`/`invalid-request`/`not-found`) | ✅ COMPLIANT |

**Compliance summary**: 22/22 scenarios compliant (all COMPLIANT, 0 UNTESTED, 0 FAILING, 0 PARTIAL)

### Correctness (Static Evidence)
| Requirement | Status | Notes |
|---|---|---|
| `AuditOp`/`AuditOutcome`/`AuditReason` closed sets | ✅ Implemented | `util.ts:374-376`, exactly as design specifies |
| `respondWrite` structural invariant | ✅ Implemented | `grep -n "sendJson" studio-server.ts` confirms zero direct `sendJson` calls inside `handleInsertRow`/`handleUpdateRow`/`handleDeleteRow` — every terminal branch routes through `respondWrite(res, status, body, audit, entry)` (`studio-server.ts:703-712`), so a branch cannot physically respond without also emitting. Enforced structurally, not by convention, and covered by the invariant-sweep test (row 24) which would fail if any branch skipped `respondWrite` |
| `deriveSessionCorrelator`/HMAC key handling | ✅ Implemented | Literal NUL byte confirmed present in the code string (not the `\0` two-char escape used only in `design.md`'s prose, per the orchestrator's flagged distinction) |
| `--audit-log` before `--no-audit-log` ordering | ✅ Implemented | `index.ts:333-338`, with an explicit code comment documenting why reordering would silently break the tri-state |
| Row values unreachable by type | ✅ Implemented (compile-time only) | `StudioAuditEntry.pk: Record<string,string>` / `columns: string[]` — confirmed honestly documented in `util.ts:378-393`'s doc comment AND in `tasks.md`/design as "a `tsc` compile-time guarantee, not a runtime test." Correctly NOT counted as runtime coverage in the compliance matrix above |

### Coherence (Design)
| Decision | Followed? | Notes |
|---|---|---|
| Correlator: HMAC-SHA256, per-instance random key, 12-hex/48-bit | ✅ Yes | See Security Judgment below |
| `session` absent, never `null`/`"anonymous"` | ✅ Yes | `deriveSessionCorrelator` returns `undefined` on `token === null`; `JSON.stringify` drops `undefined`-valued keys |
| Emit coupled to response via `respondWrite` | ✅ Yes | Structural, not discipline-based |
| Exactly one line per write attempt, incl. 400/404 | ✅ Yes | Every terminal branch in all three handlers calls `respondWrite` with a built entry |
| Denial line carries op/table/session, never pk/columns | ✅ Yes | `studio-server.ts:861-872` |
| `--audit-log`/`--no-audit-log`, env throws, default on | ✅ Yes | `util.ts:360-371`, `index.ts:377-385` |
| `console.log`, not `process.stdout.write` | ✅ Yes | `respondWrite:711`, matches design's testability rationale |
| Startup line wording: "enabled"/"disabled" (spec) vs design's earlier "on"/"off" draft | ✅ Yes — reconciled correctly | `studio-server.ts:1119` prints `Audit log: enabled|disabled`, matching the **amended, normative spec** text exactly. Design's own flagged Open Question (per-line disclaimer vs startup-only) was correctly resolved in favor of startup-line-only, no per-line `note` field added |

### Security Judgment — correlator scheme

**Assessed claim**: keying the correlator HMAC with a per-process `randomBytes(32)` (never derived from the password) closes an offline password-guessing oracle that a keyless or public-label digest would open, given the session cookie's predictable payload (`v` constant, `exp = iat+86400`, `iat` recoverable from the log's own timestamp).

**Verdict: the implementation achieves the stated goal.**
- `auditKey` is generated with `randomBytes(32)` — cryptographically random, 256 bits, far exceeding the 128-bit security level HMAC-SHA256 needs from its key.
- It is provably never derived from `deriveSessionSecret`/the shared password (`util.ts`'s `deriveSessionCorrelator` never imports `studio-auth.ts`; grep confirms `auditKey` has exactly one producer — `randomBytes(32)` — and one consumer — the HMAC call).
- It is never logged, never persisted, never returned in any response (grep confirms `auditKey` appears only in the closure that computes `session`, never in an emitted entry or response body).
- Given all three of the above, an attacker holding the audit log has **zero** candidate key material to reconstruct the correlator offline — the stated oracle is genuinely closed, not just made "harder."

**48-bit truncation (12 hex chars) — defensible for this purpose, with the caveat correctly stated in design/spec.** For a correlator (not an identifier, not a security boundary — its only claimed property is "groups writes plausibly from one session"), 48 bits of an HMAC output is far more entropy than the purpose requires; the real determining factor for practical collision risk in a single Studio dev-session process lifetime is small login counts (tens, not millions), making the birthday bound (`n²/2^49`) negligible as design states. Truncation does NOT weaken the security property above — the untruncated 256-bit HMAC output space is what protects against key-recovery, and cutting to 12 hex chars only affects collision probability between two different session cookies within one process's correlator space, which the proposal already explicitly accepts as an inherent (not truncation-introduced) property at the cookie-format level. No objection to 48 bits for this specific, narrow purpose.

One residual, non-blocking observation: because `auditKey` lives only in memory for the `startStudio` closure's lifetime, an attacker with process-memory access (not log access) could still recover it — but that threat model is explicitly out of scope for a "log confidentiality" mitigation and is not a regression versus any other in-memory secret in this codebase (e.g. `deriveSessionSecret`'s own derived key).

### Gap Analysis — design's 40-row Testing Strategy table + all spec scenarios

All 40 rows plus the spec-only restart-rotation scenario (41 total covering items) were walked. All 41 have a named, runtime-executed covering test in `studio-audit-resolution.mjs` (rows 1-17) or `studio-audit.mjs` (rows 18-40 + restart-rotation), confirmed present in the test files by direct read (not just apply-progress's claim). No gap found in:
- **Symmetric pairs** (1-3 flag/env precedence in both directions, 12-13 injection in table-name vs PK-value, 22-23 write-verb-denied vs GET-still-403-no-line, 27 pairing with 26): all present, each half independently asserted.
- **Negative/absence requirements** (4, 9, 10, 11, 15, 17, 19, 20, 21, 25, 26): each has its own dedicated assertion, and three (sentinel, db-error leak, restart-key-reuse) were independently mutation-verified this session by source inspection rather than trusting the apply report (see "Mutation-verified negatives" above).
- **Two-option combinations** (28-29 auth on/off × correlator presence, 33 auditLog on/off × response identity, 34-35 readOnly × auditLog): rows 34/35 confirmed present and asserting the compound condition, not each factor in isolation.

No untested spec scenario found. No design decision found unimplemented or contradicted by the shipped code.

### Wording sweep (task 3.14) — scope check
The shipped regex is `/\b(user|actor|who)\b/i`, matching the **spec's** exact forbidden-word list ("MUST NOT use `user`, `actor`, or `who`"). `tasks.md`/`design.md` additionally mention `by` in their own prose, but the spec — the normative artifact — does not list `by` as forbidden, and no startup/log string in the shipped code contains the word "by" as a standalone token to begin with (grep confirms). Not a gap against the authoritative spec; recorded as a SUGGESTION only, for awareness that `tasks.md` and the spec disagree on this one non-normative detail.

### Issues Found

**CRITICAL**: None

**WARNING**:
1. Full-change line count is 1433 (excl. `tasks.md`), 79% over the 800-line review budget when both PRs are counted cumulatively — larger than the ~37% figure implied by PR 2's raw `git diff --numstat` total alone. Per the orchestrator's explicit instruction this is **not blocking**; recorded here only so the true cumulative number is on record rather than the PR-2-only figure. Root cause (per orchestrator and independently confirmed): the 799-line integration test file, driven by mutation-verifiable coverage of a change unusually dense in negative/absence requirements.

**SUGGESTION**:
1. `tasks.md`/`design.md` mention `by` as a fourth forbidden identity word; the normative spec and the shipped regex sweep (`/\b(user|actor|who)\b/i`) only cover three. Non-blocking, since the spec is authoritative and no current log/startup string contains "by" as a token — but worth a one-line spec/design reconciliation if this capability is ever extended.

### Verdict
**PASS WITH WARNINGS**
34/34 tasks complete, 22/22 spec scenarios COMPLIANT with runtime-passing covering tests (fresh `pnpm build`/`pnpm lint`/`pnpm test` all green, exit 0), 0 CRITICAL findings. The single WARNING (cumulative review-budget overrun) is explicitly non-blocking per the orchestrator's brief and does not affect implementation correctness. Ready for archive.
