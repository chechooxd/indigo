# Tasks: Studio Audit Log

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~740–800 (util.ts ~90, studio-server.ts ~130, index.ts ~20, studio-audit-resolution.mjs ~150, studio-audit.mjs ~400, package.json ~2) |
| 800-line budget risk | Medium-High (near budget as one PR) |
| Chained PRs recommended | Yes |
| Suggested split | PR 1: pure layer (util.ts + unit suite) → PR 2: server wiring + integration suite + CLI |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
800-line budget risk: Medium-High

Backend-only change — no `apps/studio/*` diff in any unit; single-package (`@indigodb/cli`) split, not a frontend/backend split.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Pure resolver/formatter/correlator (`util.ts`) + unit suite, RED→GREEN | PR 1 | `node packages/cli/test/studio-audit-resolution.mjs` | N/A — pure functions, no server | Revert PR 1 alone; nothing else depends on it yet |
| 2 | Server/CLI wiring (`studio-server.ts`, `index.ts`) + integration suite, RED→GREEN | PR 2 | `node packages/cli/test/studio-audit.mjs` | PGlite-backed `withStudio` harness (real HTTP + `console.log` capture) | `--no-audit-log` makes every emit path a structural no-op; revert PR 2 or flip the flag |

## Phase 1: RED — Unit tests (pure layer)

- [ ] 1.1 `test/studio-audit-resolution.mjs`: resolver precedence + default (design rows 1–6; spec "resolved once at startup") — flag beats env both directions, exact-match env, default-on, malformed env throws naming `INDIGODB_STUDIO_AUDIT_LOG`, never `process.exit`
- [ ] 1.2 Same file: correlator determinism/security (rows 7–11; spec "session field is correlator") — 12 lowercase hex, same key+token stable, **different keys → different correlator** (proves keying, row 9), token not a substring, `null` token → `undefined`
- [ ] 1.3 Same file: log-injection + cap (rows 12–14) — `formatAuditLine` escapes `\n`/`\r`/spaces in table name and PK value; `formatPkValue` caps at 128 chars for number/null/undefined/Date/500-char string
- [ ] 1.4 Same file: entry shape (rows 15–16) — `session: undefined` omits the key (`!("session" in parsed)`, mutation: emit `null` instead); exact key set per `outcome`, no extras
- [ ] 1.5 Run the suite; confirm every case fails (no `util.ts` implementation yet)

## Phase 2: GREEN — `packages/cli/src/util.ts`

- [ ] 2.1 Add `AuditOp`/`AuditOutcome`/`AuditReason`/`StudioAuditEntry` types and `resolveStudioAuditLog(option, env)` — precedence flag > env > default `true`, exact-match `"0"|"false"`/`"1"|"true"`, throw (never exit) naming the var on anything else — closes 1.1
- [ ] 2.2 Add `formatAuditLine`, `formatPkValue`, `deriveSessionCorrelator(token, key)` — HMAC-SHA256 over `"indigodb-studio-audit-correlator-v1 " + token` keyed by a caller-supplied `Buffer`, hex, first 12 chars — closes 1.2–1.4
- [ ] 2.3 Run Phase-1 suite to GREEN; verify row 17 (`pk: Record<string,string>` rejects a `Record<string,unknown>` body) via `pnpm lint` — this is a `tsc` strict-mode guarantee, not a runtime test; document that in a code comment on `StudioAuditEntry`

## Phase 3: RED — Integration tests (`test/studio-audit.mjs`, PGlite + `console.log` capture)

- [ ] 3.1 Successful INSERT/UPDATE/DELETE each emit exactly one `ok` line with correct `op`/pk/columns/count (rows 18–20; spec `studio-row-writes` ADDED reqs)
- [ ] 3.2 Sentinel: write `"ZZ-SENTINEL-9137"` into a non-PK column; assert absent from all captured stdout (row 21; mutation: log `patchInput` → fails) — the proposal's headline negative
- [ ] 3.3 Read-only denial emits `{outcome:"denied", reason:"read-only"}` with no pk/columns; `GET` under read-only still 403s but emits nothing (rows 22–23; `studio-readonly-mode` MODIFIED scenario)
- [ ] 3.4 Invariant sweep: table of ok/400/404/db-error/denied requests, each response matched by exactly one line (row 24; mutation: remove one `respondWrite` call → fails)
- [ ] 3.5 DB unique-violation → `outcome:"error"`, `reason:"db-error"`, `code:"23505"`, conflicting value absent (row 25; mutation: log `(error as Error).message` → fails); 400 invalid-column → `reason:"invalid-request"` (row 26); 404 no-row-matched → `reason:"not-found"` (row 27) — closes `studio-row-writes` "failing write" requirement
- [ ] 3.6 Auth off → no line has a `session` key (row 28); auth on → `session` present, 12 hex, stable across two writes same cookie, differs across two logins a second apart (row 29); raw cookie value never appears in captured stdout (row 30)
- [ ] 3.7 Unauthenticated 401 → no line (row 31); reads (`GET /api/tables/:name`, `POST /api/query`, `GET /api/schema`) → no line (row 32)
- [ ] 3.8 `auditLog: false` → zero lines for a successful write, HTTP response byte-identical to the `auditLog: true` run (row 33)
- [ ] 3.9 Two-option combinations: `{readOnly, password}` denial line carries `session` and `reason:"read-only"` (row 34); `{auditLog:false, readOnly:true}` → 403 still returned, no line, body byte-identical to audit-on run (row 35)
- [ ] 3.10 `GET /api/auth/status` byte-identical across `--audit-log`/`--no-audit-log` instances and to pre-change response; exact six keys, no seventh (row 36)
- [ ] 3.11 No file/directory created anywhere under cwd or `.indigo/` across several writes (row 37)
- [ ] 3.12 Startup block prints `Audit log: enabled`/`Audit log: disabled` (row 38)
- [ ] 3.13 Control: `auditLog: true` alone leaves writes succeeding and `readOnly`/guardrails at defaults — not an enforcement input (row 39)
- [ ] 3.14 Regex sweep: no captured line, message, or startup string contains `user`/`actor`/`by`/`who` (row 40)
- [ ] 3.15 **Restart rotation (new — not in design's 40-row table, spec scenario "Correlators do not survive a restart")**: same client, same still-valid cookie, write against two successive `startStudio` instances; the second instance's `session` value differs from the first's — proves the key is regenerated, not password-derived. Mutation that must break it: hardcode/persist `auditKey` across instances → test passes when it must fail
- [ ] 3.16 Run the suite; confirm every case fails (server not wired yet)

## Phase 4: GREEN — Server + CLI wiring

- [ ] 4.1 `studio-server.ts`: add `auditLog: boolean` to `StudioOptions`; `const auditKey = randomBytes(32)` at startup (per-process, never persisted/logged); add `Audit log: enabled|disabled` startup line
- [ ] 4.2 Add `respondWrite(res, status, body, audit, entry)` — the one function that calls `sendJson` **and** `console.log(formatAuditLine(entry))`; remove direct `sendJson` calls from the three write handlers so a branch cannot respond without logging
- [ ] 4.3 Rewire `handleInsertRow`/`handleUpdateRow`/`handleDeleteRow` to build a `StudioAuditEntry` per terminal branch (ok/invalid-request/not-found/db-error) and call `respondWrite`; error branches map to `reason:"db-error"` + SQLSTATE only, never the driver message
- [ ] 4.4 Read-only 403 gate: call the emitter directly with `{op, table, count:0, outcome:"denied", reason:"read-only"}` (+ `session` when auth on) before returning; non-write verbs stay 403 with no emit
- [ ] 4.5 `index.ts`: declare `--audit-log` **before** `--no-audit-log` (preserves commander's `undefined` default); call `resolveStudioAuditLog` after `loadEnv()`; catch → print message naming the var → `exit(1)` before binding; thread `auditLog` into `startStudio`
- [ ] 4.6 Run Phase-3 suite to GREEN

## Phase 5: Verification & cleanup

- [ ] 5.1 Append both new suites to `packages/cli/package.json`'s `test` chain
- [ ] 5.2 `pnpm test --filter=@indigodb/cli` green
- [ ] 5.3 `pnpm build && pnpm lint` green from repo root (confirms row 17's compile-time guarantee)
- [ ] 5.4 Grep sweep confirms `apps/studio/*` and `studio-auth.ts` are untouched — no probe widening
