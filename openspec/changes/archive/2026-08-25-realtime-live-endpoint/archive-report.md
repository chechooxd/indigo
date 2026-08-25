# Archive Report: Cacheable `GET ?handle&offset` shape-log endpoint

**Change**: `realtime-live-endpoint`  
**Slice**: 4 of 4 (Phase 4 realtime epic)  
**Archived**: 2026-08-25  
**Status**: ARCHIVED — ready for production  

## Artifact Observation IDs (Engram Traceability)

| Artifact | Observation ID | Retrieved | Content |
|----------|---|---|---|
| proposal | #733 | 2026-08-25 08:18:05 | Proposal finalized, zero open questions |
| spec | #734 | 2026-08-25 08:23:26 | Spec corrected for SSE wake-up predicate; `id` as public cursor |
| design | #735 | 2026-08-25 08:26:00 | 11 design decisions verified against codebase; 5 proposal/spec claims corrected |
| tasks | #736 | 2026-08-25 08:29:42 | TDD RED→GREEN checklist (PR A: 40/40, PR B: 56/56 tasks complete) |
| verify-report-pr-a | #738 | 2026-08-25 09:41:43 | **PASS WITH WARNINGS** (0 CRITICAL, 2 WARNING, 1 SUGGESTION) |
| verify-report-pr-b | #740 | 2026-08-25 10:35:36 | **PASS** (0 CRITICAL, 0 WARNING substantive, 1 informational) |

## Execution Summary

### Specs Merged into OpenSpec

| Domain | Action | Details |
|--------|--------|---------|
| `realtime-live-endpoint` | **Created** | New spec (fully specified, no delta) with 11 requirements covering `GET ?handle&offset` endpoint, handle signing, caching, RLS binding, SSE scoping |
| `model-allow-rules` | **Modified** | Removed 1 requirement (mutual-exclusion rejection of `@@realtime`+`@@allow` combo); 1 requirement + 1 scenario deleted with reason/migration notes |
| `realtime-shape-log` | **Modified** | Updated 1 requirement (added `id` as public cursor contract, removed `lsn` as addressing key); added 1 new requirement (`id` ordering guarantees) |

All deltas applied correctly. No destructive edits; all other requirements preserved.

### Archive Contents

- `proposal.md` ✅ (finalized, zero open questions at proposal time)
- `design.md` ✅ (11 decisions, code-verified)
- `specs/realtime-live-endpoint/spec.md` ✅ (11 requirements)
- `specs/model-allow-rules/spec.md` ✅ (delta applied — 1 requirement removed)
- `specs/realtime-shape-log/spec.md` ✅ (delta applied — `id` contract added, new requirement added)
- `tasks.md` ✅ (56 implementation tasks complete: PR A 40/40 ✓, PR B 56/56 ✓)
- `archive-report.md` ✅ (this file)

Post-slice cleanup tasks (C1–C5) are correctly unchecked; they are archive-phase (spec merge in C2) and post-archive follow-ups (C3–C5 non-blocking deferred work).

## Verification Status

### PR A (`feature/realtime-live-endpoint-pr-a`)
- **Verdict**: **PASS WITH WARNINGS**
- **Critical Issues**: 0
- **Warnings**: 2 (non-blocking)
  1. Slow teardown in `endpoint.mjs`'s real-Postgres suite (~2.5 minutes after last assertion); related to replication-slot/connection cleanup in shared `pg-harness.mjs` fixture. Same slow-teardown family as pre-existing `resume.mjs` hang. **Non-blocking follow-up**: profile and improve `pg-harness.mjs` fixture teardown for faster local dev loop.
  2. `spec.md` requirement text still says endpoint is "published on both hosts via `attach()`" but design decision 4 corrected this to "both hosts route manually" (neither calls `attach()`). Implementation correctly follows design (route IS exposed on both hosts). **Non-blocking follow-up during spec-merge archive step**: tighten spec wording to remove stale mechanism hint.
- **Suggestion**: 1 informational (TDD-ordering deviation claimed but substance-verified; all RED/GREEN cases reproduced independently).
- **Tasks Complete**: 40/40 ✓
- **Verification Method**: Maximal scrutiny (6 independent reproduction runs by verifier; crypto, cache-control, RLS, offset handling, route wiring, threat suite all verified via hand-crafted scripts, not just re-run of shipped tests).

### PR B (`feature/realtime-live-endpoint-pr-b`)
- **Verdict**: **PASS**
- **Critical Issues**: 0
- **Warnings**: 0 (substantive)
- **Informational Note**: Post-slice cleanup tasks (C1–C5) correctly unchecked; they are archive/post-archive scope and do not block the PASS verdict.
- **Tasks Complete**: 56/56 ✓
- **Verification Method**: Maximal scrutiny; SSE wake-up predicate verification emphasized per user request (independent reproduction of all 3 scoping cases; composite-PK dropping structurally verified; guard removal and WASM rebuild confirmed; daemon preflight narrowing verified).

**Overall**: 2 PRs verified, 2/2 PASS (PR A with 2 non-blocking follow-ups, PR B clean).

## Deviations from Design

### Daemon Secret Preflight (Intentional Incremental Delivery)

**What Happened**: PR A implemented an unconditional secret requirement (`INDIGODB_REALTIME_SECRET` required at all daemon startup). PR B correctly narrowed it to conditional (required only when any model is `@@realtime`+`@@allow`), matching the spec requirement.

**Why**: PR A was released before PR B to stay within the 400-line review budget. Both PRs were merged into `main` locally before archive (user provided both PR branch tips). The unconditional-then-conditional progression is **documented as intentional incremental delivery**, not a bug.

**How It's Recorded**: Archive reflects the final state: the daemon preflight is correctly conditional (per spec + PR B's implementation). Intermediate snapshots (`apply-progress` from PR A) are lower-authority and noted for reference only; the actual committed code is the source of truth.

**Authority Ranking**: Native code state in merged PRs (`main` post-merge) > intermediate snapshots.

## Known Follow-ups

All non-blocking, deferred to future slices per design and PR verification reports:

1. **Slow test teardown** (PR A warning, `pg-harness.mjs` fixture cleanup). Action: profile and improve in a future test-infra slice.

2. **Spec wording refresh** (PR A warning, remove stale `attach()` mechanism hint from requirement text). Action: included in C2 (spec-merge step) — minor clarification, no semantic change.

3. **`.live()` client API** (originally proposed in `realtime-live-endpoint` proposal, decision 4). Status: deferred; its future shape is now clear from PR B: SSE-wakes-then-GET-fetches hybrid. `RealtimeWakeEvent` type is additive (`event: wake` frames are silently ignored by today's client), so the API is not foreseeable.

4. **Log retention / pruning** (inherited from slice 3, no path yet). Status: still unaddressed; this slice makes it more operationally urgent. No client impact; infrastructure concern.

5. **Last-Event-ID hint for `.live()` resume** (design question noted in design.md). Status: deferred pending `.live()` API design.

None of these items block archive or deployment.

## What Shipped

### Endpoint and Signing
- `GET /api/realtime/log?handle=<token>&offset=<id>` route on both `indigodb realtime` daemon and embedded studio server
- Opaque signed handles (`base64url(payload).base64url(HMAC-SHA256)`, `{v:1, t:table, u:claim, exp}`)
- `timingSafeEqual` verification with length-check BEFORE comparison (prevents timing leaks and 500 errors on truncated signatures)
- Mandatory `exp` (~1h default), no non-expiring capabilities
- All signature failures return uniform `401` (no detail distinction)

### Identity and RLS
- `app.user_id` set from verified handle claim inside a read-only transaction with the log query
- RLS isolation on `_indigo_realtime_log` reuses existing `buckets`-based policy (slices 1–3)
- Uniform handle requirement for all models, including public ones (no special code path)
- Table-scoped handles only (v1 limitation); clients narrow client-side
- Two identities on same table receive different row sets, enforced by RLS policy

### Caching
- Sealed pages (filled `LIMIT`) → `public, max-age=31536000, immutable` (byte-identical re-requests, CDN-safe)
- Head pages (short/empty) → `no-store` (never cacheable, including zero-row case — inverted-TTL regression guard)
- One predicate (`rows.length === PAGE_SIZE`) drives BOTH `hasMore` and cache-header (no disagreement possible)

### Guard Lifting
- Compiler guard removed: `validate.rs` no longer rejects `@@realtime`+`@@allow` combination
- New joint-safety invariant in code comments: endpoint's RLS-enforced read path + SSE wake-up scoping together make it safe
- Guard removal and SSE scoping ship in same commit (PR B)

### SSE Scoping
- For `@@allow`-protected models: `{table, op, lsn}` wake-up frame only (no `pk`, `new`, `old`)
- Predicate: `ResolvedTable.allow !== undefined` (ANY `@@allow` block, not just those with `read` rule)
- Includes create-only `@@allow` models: they get scoped SSE because RLS denies all reads despite no `read` rule
- Non-`@@allow` `@@realtime` models: unchanged full-payload SSE (byte-identical to before)
- `RealtimeWakeEvent` type distinct from `RealtimeEvent` (impossible to leak row data structurally)
- Today's client (ignores unknown event names) is forward-compatible with no code change

### Cursor and Offset
- `id` column (bigserial) replaces `lsn` as cursor (public contract now, not internal detail)
- Offset string validated with regex `/^\d{1,19}$/` before query construction
- Bound as text, cast `id > $2::bigint` (never coerced to JS `Number`, preserves precision)
- Supports pagination to exhaustion; `hasMore: false` signals end

### Daemon Configuration
- `INDIGODB_REALTIME_SECRET` preflight: daemon refuses to start when any model is `@@realtime`+`@@allow` and secret unset
- Starts normally when no model combines both (secret unset is OK)
- Preflight is conditional, not unconditional (narrowed in PR B after PR A's broader implementation)

## Why This Slice Matters

`realtime-live-endpoint` is the read-side of the realtime system. Slices 1–3 built:
- **Slice 1** (`realtime-rls-allow-rule`): RLS policy generation for `@@allow` rules
- **Slice 2** (`realtime-wal-source`): WAL capture and `_indigo_realtime_log` writes
- **Slice 3** (`realtime-shape-log`): Log schema with `buckets` pre-computation

This slice adds:
- **Slice 4** (`realtime-live-endpoint`): The HTTP read path that closes the loop

Together, they form the complete data flow: `.indigo` schema `@@allow` rules → Postgres RLS generation → WAL capture → `_indigo_realtime_log` shape log with pre-computed auth buckets → signed-handle HTTP endpoint with RLS-enforced reads → CDN-cacheable pages + scoped SSE wake-ups.

## Phase 4 Realtime Epic Completion

This archive closes **Phase 4's entire realtime epic** (4 slices, 4 changes, all now archived):

### Slice 1: `realtime-rls-allow-rule` (Archived 2026-08-24)
- **Focus**: RLS policy generation from `@@allow` rules
- **What Shipped**: `computeBuckets()` pre-computes auth buckets at log-write time; `renderPolicy()` generates RLS policy using `app.user_id` and `buckets`-matching
- **Outcome**: Row-level filtering available in the log and real table

### Slice 2: `realtime-wal-source` (Archived 2026-08-24)
- **Focus**: WAL capture via replication slot, log entry writing
- **What Shipped**: Logical replication listener; one-writer guarantee (exclusive replication slot); multi-row `INSERT` per transaction; log-write-before-ack ordering
- **Outcome**: Durable, ordered event capture without data loss

### Slice 3: `realtime-shape-log` (Archived 2026-08-25)
- **Focus**: `_indigo_realtime_log` schema and pre-computed bucket storage
- **What Shipped**: Shared single-writer log table; `buckets` nullable to distinguish public vs. protected; RLS policy that gates by `app.user_id`
- **Outcome**: Persistent, auth-scoped event record accessible only to authorized readers

### Slice 4: `realtime-live-endpoint` (Archived 2026-08-25)
- **Focus**: HTTP read path with signed handles, caching, SSE scoping
- **What Shipped**: `GET ?handle&offset` endpoint; HMAC-SHA256 signed handles; RLS-enforced reads; sealed-vs-head cache-control; guard lifting; SSE wake-up scoping
- **Outcome**: Firebase-like "read the changelog, get pushed when data changes" ergonomics (minus `.live()` API, which is deferred)

### Complete Data Flow (Now Implemented)

```
┌─ Schema Authoring ──────────────────────────────────┐
│  model User { ... @@allow(read, ...) @@realtime }    │
└────────────────────┬────────────────────────────────┘
                     │
     ┌───────────────┴────────────────────┐
     │ Slice 1: RLS Policy Generation      │
     │ (computeBuckets + renderPolicy)     │
     └───────────────┬────────────────────┘
                     │
     ┌───────────────┴────────────────────┐
     │ Slice 2: WAL Capture               │
     │ (LogicalReplication via slot)      │
     └───────────────┬────────────────────┘
                     │
     ┌───────────────┴──────────────────────────┐
     │ Slice 3: Shape Log (_indigo_realtime_log)│
     │ (buckets[] + RLS policy enforcement)    │
     └───────────────┬──────────────────────────┘
                     │
     ┌───────────────┴──────────────────────────────┐
     │ Slice 4: Read Path & Wake-up Signal         │
     │ (GET ?handle&offset + SSE scoping)          │
     └───────────────┬──────────────────────────────┘
                     │
    ┌────────────────┴─────────────────┐
    │  Client Layer (not shipped yet)   │
    │  (.live() API — future slice)     │
    └──────────────────────────────────┘
```

**What Remains for "Firebase Ergonomics"**

The main missing piece is the `.live()` client API (`packages/client/src/realtime.ts`, `realtime-delegate.ts`). Its future shape is now clear:

```typescript
const liveQuery = await client.user.live()
  .where({ ownerId: "u1" })
  .select({ id: true, name: true });

// When data changes:
// 1. SSE sends wake-up frame: {table: "User", op: "INSERT", lsn: "0/12345678"}
// 2. Client fetches new rows via GET ?handle&offset
// 3. User sees live updates without polling
```

The infrastructure is complete; the typed client wrapper is deferred. No architectural risk; the shape is locked in.

## Rollback Plan

All changes are code-only; no migrations or data schema changes after slices 1–3:

1. Revert the endpoint route and handle helpers
2. Restore `validate.rs` guard and test
3. Revert SSE `dispatch()` scoping
4. Commit; WASM rebuilds via normal `wasm-drift` on `main`

The log (`_indigo_realtime_log`) and RLS policies remain untouched; rollback leaves the log durable and defensible.

## Conformance Checklist

- [x] All proposal Success Criteria met (9/9: paginated cursor page, RLS row-set isolation, uniform 401, daemon secret preflight, sealed/head cache correctness, guard lifted cleanly, byte-identical SSE for non-`@@allow`, builds green, WASM artifact committed)
- [x] All implementation tasks complete (PR A: 40/40, PR B: 56/56)
- [x] All verification tasks complete (PR A: PASS WITH WARNINGS, PR B: PASS)
- [x] No CRITICAL issues (0/2)
- [x] All known deviations documented (daemon secret incremental narrowing)
- [x] Specs merged into `openspec/specs/` (realtime-live-endpoint created, model-allow-rules and realtime-shape-log updated)
- [x] Change folder archived to `openspec/changes/archive/2026-08-25-realtime-live-endpoint/`
- [x] Archive report written with observation IDs

---

**Archive Date**: 2026-08-25  
**Archived By**: sdd-archive executor  
**Project**: indigo (IndigoDB)  
**Scope**: Phase 4, slice 4 of realtime epic (4 changes, all now archived)
