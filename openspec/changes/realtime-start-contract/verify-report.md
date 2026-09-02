# Verify Report — `realtime-start-contract`

## PR 1 / Phase 1 — the seam contract

**Branch**: `fix/realtime-start-contract-1-seam` (off `main`@`ab6e888`), commit `cb86fb9`.
765 insertions / 22 deletions across 7 files. Nothing under `packages/cli` or `apps/studio`
touched; `packages/realtime/src/engine.ts` unchanged (empty `git diff --stat`).

> **Persistence note.** The verify agent completed the review but could not write this file: the
> native `gentle-ai sdd-verify-validate` gate denied admission on `evidence_revision`. Earlier
> verify passes in this same session persisted successfully through that gate, so this is an
> agent-side error deriving the digest, **not** a tooling defect — recorded here rather than
> escalated. The content below is the agent's report verbatim in substance; the orchestrator
> performed the write.

### Verdict: PASS WITH WARNINGS — 0 CRITICAL, 1 WARNING, 1 SUGGESTION

### Verification gate (repo root)

| Command | Result |
|---|---|
| `pnpm clean && pnpm build --force` | exit 0 (10/10 Turbo tasks) |
| `pnpm lint` | exit 0 |
| `pnpm test` | exit 0 (18/18 Turbo tasks, pack-contents guard green) |
| `packages/realtime/test/wal-source.mjs` | 38/38 checks, ends in `strictEqual(passed, 38, …)` |
| `packages/realtime/test/source-contract.mjs` | 4/4, run manually — chaining into `package.json` is task 3.5 (Phase 3) |

`INDIGODB_TEST_DATABASE_URL` was never set.

### Independent mutation re-run

Reproduced apply's mutation (b) independently: removed the `attempt.then(...)` backstop
(`wal-source.ts:246-249`), rebuilt, ran `timeout 25 node packages/realtime/test/wal-source.mjs`
with the exit code captured **directly to a file, not through a pipe** — **exit 13**, Node's
unsettled-top-level-await detector firing at
`RSC-9/RWS-7: stop() before the stream goes live rejects the pending start() and tears down
resources` (`wal-source.mjs:1006`). Restored via `git checkout`; `git diff --stat` empty
(byte-identical); rebuilt; 38/38 green.

**The backstop is genuinely load-bearing**, not defensive decoration.

### The five scrutiny points — all clean

1. **The `scheduleReconnect` stubs do not hollow out their tests.** Five sites in the
   readiness-contract region (`wal-source.mjs:780, 812, 838, 918, 971`); a sixth at `:390` is
   pre-existing and unrelated. At `:780`, `:812`, `:838` the stub is pure cleanup — those tests
   never touch reconnect, and the stub only stops a real timer leaking past their assertions. At
   `:918` and `:971`, the two genuine reconnect-scoping tests, the stub suppresses only a
   **third**-attempt timer: each test drives a real second `connect()` itself and asserts on its
   outcome. No stub neutralises the mechanism under test.
2. **RSC-11 deviations judged sound.** TypeScript `private` being compile-time only was verified
   independently against `dist/wal-source.js` — private helpers are ordinary own methods at
   runtime, so design's literal frozen-method-list check was unimplementable as written. The
   substitute (arity + getter + no-new-public-member) covers the two concrete widenings design's
   own "Alternatives rejected" section named. The comment-only-diff substitute is
   mutation-proven RED-sensitive.
3. **`stop()` during a pending `start()` cannot hang.** All five `connect()` exit paths traced in
   source (`wal-source.ts:281-401`): early `stopped` return, both supersession returns, the
   catch-superseded branch, the catch-real-failure branch, and normal stream-end completion. Every
   one settles the deferred explicitly or is caught by the `attempt.then()` backstop.
4. **Unhandled-rejection ordering correct.** `attempt.then(...)` attaches before
   `attempt.catch(() => {})` on the same promise (`wal-source.ts:246-255`), so the rejection
   handler forwards the real error to `settleReady` first. Design row RWS-4's
   `process.on("unhandledRejection")` recorder is implemented and passing
   (`wal-source.mjs:960-1004`).
5. **The suite can no longer lie about its own size.** `wal-source.mjs:1074` is
   `strictEqual(passed, 38, …)`, and 38 `check()` call sites were counted to match. `rg` confirms
   zero `INDIGODB_TEST_DATABASE_URL` references in the new files; the automated guard *script* is
   task 3.4 (Phase 3), correctly not in this PR.

### Also confirmed

RSC-5's `subscribeCalled === false` assertion is present (`wal-source.mjs:847`) — that is what
makes the auth-failure path distinct from the missing-slot path rather than a relabelled
duplicate. The dead `else throw err;` is removed and the false doc comment at `:178-180` rewritten
to the real contract. `connect()`'s supersession checks, orphaned-socket guard and
`scheduleReconnect()` are structurally unmodified. `protocol.ts`'s diff is comment-only.
`PgNotifySource` has no code change. All 10 Phase 1 tasks are `[x]`. Commit `cb86fb9` is
conventional with no AI-attribution trailer.

### Issues

**WARNING** — RSC-11a's substitute does not catch a *differently named* new public member the way
a literal frozen list would. Narrow, acknowledged; the concrete risks design named are covered.

**SUGGESTION** — `source-contract.mjs` is green but not yet in `pnpm test` (intentional, Phase 3),
so a contributor running the default command today will not see RSC-6/RSC-11a/RSC-11b execute
until PR 3 lands.

### Scope

PR 2 (engine/CLI/Studio wiring, 503 gating) and PR 3 (badge, test wiring, DB-gated discovery leg)
are deliberately absent and were not counted as gaps.
