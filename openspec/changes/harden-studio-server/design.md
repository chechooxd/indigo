# Design: Harden the Studio server

## Technical Approach

All four fixes land inside `packages/cli/src/studio-server.ts`, plus a `--host` flag in
`index.ts` and the package's first test suite. `startStudio` gains a narrow DB port
(`StudioDb`) so a PGlite-backed adapter can drive the *real* HTTP server in tests while
production still builds `pg.Pool`. Redaction is computed once at startup; header validation
runs before routing; SQL runs inside `BEGIN; SET TRANSACTION READ ONLY;` on a dedicated
connection.

## Architecture Decisions

### Decision: inject a `StudioDb` port instead of a wire-protocol PGlite

| Option | Tradeoff |
|---|---|
| `@electric-sql/pglite-socket` + unchanged `pg.Pool` | New dep (0.5.4 ships no `./socket` subpath — verified); the socket server serves one client connection at a time, and this design needs two concurrent (metadata + read-only). Rejected. |
| Pool shim faking `pg.Pool` | Must emulate `connect()`/`release()`/`fields` faithfully; the fake becomes the contract. Rejected. |
| **`StudioDb` seam, default `createPgDb(connectionString)`** | **Chosen.** ~15 lines of production code, no new production dep, honest test double at the same boundary as the `Executor` seam planned for `packages/client`. |

`RealtimeEngine` keeps taking `connectionString` and stays off in tests (fixture has no
`@@realtime`).

### Decision: a separate small read-only pool, not a per-request `pg.Client`

| Option | Tradeoff |
|---|---|
| Check out from the shared pool | One hung console query starves `/api/schema`/`/api/tables`. Rejected (this is the stated defect). |
| `new pg.Client()` per request | Full TCP+auth handshake per keystroke-driven query; unbounded concurrent connections. Rejected. |
| **Second `pg.Pool({ max: 4 })` dedicated to read-only work** | **Chosen.** Bounds blast radius, amortizes handshakes, caps connection count. |

Every read-only unit ends in `ROLLBACK` (never `COMMIT`) in a `finally`, then `release()`.

### Decision: startup-time redaction of two different artifacts

- JSON: `redactSchema(resolved)` = shallow copy minus `datasource`, computed once into
  `publicSchema`. `/api/schema` serves only that; the raw `resolved` never reaches `sendJson`.
- Text: `/api/schema/source` cannot delete a key, so `redactSource(source)` scans lines for
  `/^\s*datasource\b/`, tracks brace depth, and replaces the whole block with
  `// datasource redacted by Studio`. Brace counting, not a regex — a regex cannot match
  nested/multi-line blocks reliably. Computed once into `publicSource`.

### Decision: Host always, Origin when present

Allowlist = `{localhost, 127.0.0.1, ::1, <configured host>}` × server port. `Host` is checked
on every request (including static assets, so DNS rebinding cannot reach the SPA either);
`Origin`, when present, must parse and match the same allowlist. Mismatch → `403`
`{"error":"Forbidden origin"}` before body read or routing. When the operator opts into a
non-loopback bind (e.g. `0.0.0.0`), Host validation relaxes to port-match only — the browsing
address is unknowable — and startup prints the risk line. Same-origin SPA requests always pass.

### Decision: demote, do not delete, the pre-filter

`isReadOnlyQuery` loses its `^(select|with)` prefix test (the part that gave false assurance,
and which wrongly rejects `TABLE t`, `VALUES (1)`, `EXPLAIN SELECT`). It keeps: non-empty and
no interior `;`. That avoids a pointless connection checkout for junk and preserves the existing
400 message. The transaction is the authority.

## Data Flow

    request ─→ validateHeaders ──403──→ done
                    │ ok
                    ├→ /api/schema        → publicSchema (redacted at startup)
                    ├→ /api/schema/source → publicSource  (redacted at startup)
                    ├→ /api/tables/:name ─┐
                    └→ /api/query ────────┴→ db.readOnly(q)
                                              └ dedicated client:
                                                BEGIN; SET TRANSACTION READ ONLY;
                                                <sql> … ROLLBACK; release()

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/cli/src/studio-server.ts` | Modify | `StudioDb` port + `createPgDb`; `host` option and `listen(port, host)`; `validateHeaders`; `redactSchema`/`redactSource`; both query paths through `db.readOnly`; return `{ port, close() }` instead of `void` |
| `packages/cli/src/index.ts` | Modify | `--host <host>` (default `127.0.0.1`, env `INDIGODB_STUDIO_HOST`, flag wins); pass through |
| `packages/cli/test/studio-harness.mjs` | Create | PGlite lifecycle, `StudioDb` adapter, `withStudio(fixture, fn)` on port 0 |
| `packages/cli/test/studio-server.mjs` | Create | The four blocker scenarios + aliasing regression |
| `packages/cli/package.json` | Modify | `test` script; devDeps `@electric-sql/pglite` |

## Interfaces / Contracts

```ts
export interface StudioDb {
  query(sql: string): Promise<{ rows: unknown[]; fields: { name: string }[] }>;
  readOnly<T>(fn: (q: StudioDb["query"]) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface StudioOptions { /* …existing… */ host?: string; db?: StudioDb }
export function startStudio(o: StudioOptions): Promise<{ port: number; close(): Promise<void> }>;
```

The PGlite adapter implements `readOnly` via `db.transaction(tx => tx.query("SET TRANSACTION
READ ONLY").then(…))` — proven to raise `25P02` for the CTE-DELETE payload.

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | `redactSource` brace scan, `isReadOnlyQuery` | Direct calls in the same `.mjs` suite |
| Integration | Bind address, 403 on bad Origin/Host, redaction of both endpoints, CTE-DELETE rejected with unchanged row count, `/api/tables` aliasing | Real `startStudio` + real `fetch()` over PGlite |

Strict TDD sequence: (1) harness + a failing bind assertion → seam + `listen(host)`;
(2) RED CTE-DELETE + row-count assertion → read-only transaction; (3) RED redaction pair →
`redactSchema`/`redactSource`; (4) RED 403 → `validateHeaders`. Aliasing test is written first
as a green regression guard.

## Threat Matrix

Routing boundary (HTTP + SQL) is applicable; shell/subprocess (`openBrowser`), VCS/PR
automation, and executable-file classification are `N/A — untouched by this change`.

| Row | Status | Safe behavior | RED test |
|---|---|---|---|
| Untrusted input reaching an interpreter | Applicable | Postgres refuses writes in a read-only txn | CTE-DELETE |
| Cross-origin / confused deputy | Applicable | 403 before routing | mismatched Origin |
| Secret exposure in output | Applicable | No `datasource` in JSON or text | both endpoints |
| Unintended network exposure | Applicable | Loopback default, explicit opt-in + warning | bind assertion |
| Path traversal (static) | N/A | Existing `normalize` guard unchanged | — |

## Migration / Rollout

No data migration. Behavioral break: remote users must now pass `--host`. Rollback is a revert
plus `pnpm build --filter @indigodb/cli`.

## Sizing

~330–420 authored lines (server +130, index +6, harness ~120, suite ~180). Against the
800-line budget with `auto-chain` / `stacked-to-main` on `e69fad8`, chain two slices:
**S1** seam + harness + read-only transaction (~230); **S2** bind + Origin/Host + redaction
(~160). S1 is independently deliverable; S2 stacks on S1.

## Open Questions

- [ ] Non-loopback reachability cannot be asserted deterministically in CI (no guaranteed LAN
      interface); the bind test asserts `server.address().address` plus the explicit-host path.
- [ ] `/api/schema/source` feeds the editor; redacting the block means a future save-back
      endpoint must not round-trip the redacted text. No write endpoint exists today.
