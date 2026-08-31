/**
 * @indigodb/cli — Studio server
 *
 * Serves the compiled IndigoDB Studio SPA plus a small JSON API backed by the
 * user's PostgreSQL database. This is what wires the visual tool to the real
 * schema and data (replacing the SPA's former mock data).
 *
 * API:
 *   GET   /api/schema          → the ResolvedSchema as JSON
 *   GET   /api/tables/:name    → a page of rows from a table, PK-ordered and
 *                                cursor-paginated (see `resolveReadTarget`,
 *                                `parsePageParams` below); falls back to a
 *                                single unpaginated page for PK-less tables
 *   POST  /api/query { sql }   → runs a single read-only SELECT
 *   POST   /api/rows/:table    → inserts one row, returns it (incl. generated PK)
 *   PATCH  /api/rows/:table    → updates one row, identified by primary key
 *   DELETE /api/rows/:table    → deletes one row, identified by primary key
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import pg from "pg";
import type { ResolvedColumn, ResolvedSchema, ResolvedTable } from "@indigodb/core";
import { RealtimeEngine, REALTIME_PATH, REALTIME_LOG_PATH } from "@indigodb/realtime";
import { createStudioAuth, SESSION_COOKIE, SESSION_TTL_SECONDS, type StudioAuth } from "./studio-auth.js";

export interface StudioOptions {
  resolved: ResolvedSchema;
  /** Raw `.indigo` source text, served for the editor. */
  source: string;
  connectionString: string;
  port: number;
  /**
   * Bind address. Defaults to `127.0.0.1` (loopback only). Passing anything
   * else is an explicit opt-in to non-loopback exposure — see the startup
   * warning printed in that case and `validateHeaders`'s relaxed Host check.
   */
  host?: string;
  /** Open the browser automatically once the server is listening. */
  open?: boolean;
  /** Injectable database port. Defaults to `createPgDb(connectionString)`. Tests inject a PGlite-backed adapter. */
  db?: StudioDb;
  /**
   * Optional shared password gating every `/api/*` route behind a signed
   * session cookie (see `studio-auth.ts`). `undefined` (the default) is a
   * structural no-op: `auth` below resolves to `null` once at startup and
   * every request short-circuits past auth entirely — no cookie parse, no
   * HMAC, not even a conditional branch body. The static SPA shell is never
   * gated, regardless of this option.
   */
  password?: string;
  /**
   * Global, server-side read-only mode: rejects every write to `/api/rows/`
   * with `403` regardless of session auth. `undefined`/`false` (the default)
   * is a structural no-op — the gate below never triggers.
   *
   * Naming note: unrelated to `StudioDb.readOnly()` above (a transaction
   * helper on the database port). Same word, different type, different
   * object — this is a top-level server posture, not a query mode.
   */
  readOnly?: boolean;
  /**
   * Statement-timeout guardrail (ms), applied via `readOnlyPreamble` to both
   * `/api/query` and `/api/tables/:name`. `undefined` falls back to `30000`
   * — the same built-in default `resolveQueryTimeoutMs` (util.ts) applies at
   * the CLI layer, kept independently here so `startStudio` remains directly
   * testable/usable without going through the CLI's option resolution.
   * `0` disables the guardrail (see `readOnlyPreamble`).
   */
  queryTimeoutMs?: number;
  /**
   * Row cap applied only to `POST /api/query`'s cursor-eligible statements
   * (see `isCursorEligible`). `undefined` falls back to `1000`, mirroring
   * `resolveQueryRowCap`'s default. `0` disables the cursor path entirely —
   * `/api/query` then runs exactly as it did before this change.
   */
  queryRowCap?: number;
  /**
   * Purely informational environment label (e.g. `"production"`), resolved
   * once by `resolveStudioEnvironment` (util.ts) and threaded through
   * unchanged. `undefined` (the default) is a structural no-op: the probe
   * reports `environment: null` and the Studio badge renders nothing. This
   * value is NEVER read by any auth/read-only/guardrail decision — it gates
   * nothing.
   */
  environment?: string;
}

/**
 * A minimal query result shape, satisfied by both `pg` and PGlite (test
 * adapter). Only what the API routes actually consume.
 */
export interface StudioQueryResult {
  rows: unknown[];
  fields: { name: string }[];
}

/**
 * Narrow database port `startStudio` depends on, instead of `pg.Pool`
 * directly. Production uses `createPgDb`; tests inject a PGlite-backed
 * adapter so the REAL HTTP server can be driven end to end without a real
 * PostgreSQL connection.
 */
export interface StudioDb {
  /**
   * Runs `sql` on the shared (non-read-only) connection — used for metadata
   * reads. `params`, when given, are bound (never string-interpolated).
   */
  query(sql: string, params?: unknown[]): Promise<StudioQueryResult>;
  /**
   * Runs `fn` inside a dedicated, read-only transaction: `BEGIN; SET
   * TRANSACTION READ ONLY; ...; ROLLBACK` (always rolled back, never
   * committed — nothing this path runs is meant to persist). Postgres
   * itself rejects any write, including one disguised inside a CTE, so
   * this is the actual enforcement boundary — not a string heuristic.
   *
   * This function's body contains no `COMMIT` statement, full stop — a
   * writable variant is a *separate* function (`writable`, below), never a
   * flag on this one.
   */
  readOnly<T>(fn: (query: StudioDb["query"]) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` inside a dedicated, writable transaction: literal `BEGIN`
   * … `COMMIT`, with `ROLLBACK` on throw. Sibling of `readOnly`, never
   * reachable from a GET handler. Every value `fn`'s query function is
   * given MUST be bound as a parameter, never interpolated into the SQL
   * text — only already-resolved identifiers (via `resolveWriteTarget`)
   * may be interpolated.
   */
  writable<T>(fn: (query: StudioDb["query"]) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Ordered statements issued at the top of every `db.readOnly` transaction,
 * on both `createPgDb` (production) and `studio-harness.mjs`'s PGlite
 * adapter (design.md "shared exported preamble builder" decision — without
 * this export the production statement-timeout line would have zero runtime
 * test coverage, since the harness injects its own `StudioDb`).
 *
 * `timeoutMs` is always a resolver-validated integer (`resolveQueryTimeoutMs`
 * in util.ts, or `StudioOptions.queryTimeoutMs`'s own fallback) — never raw
 * request input — so string-interpolating it here is safe. `0` is not
 * special-cased: `SET LOCAL statement_timeout = 0` is itself how Postgres
 * spells "no statement timeout", so this still emits that exact line.
 */
export function readOnlyPreamble(timeoutMs: number): string[] {
  return ["SET TRANSACTION READ ONLY", `SET LOCAL statement_timeout = ${timeoutMs}`];
}

/**
 * Capability classifier for the `/api/query` row-cap cursor path: after
 * stripping leading whitespace, SQL line comments, block comments and
 * leading `(`, does
 * the remaining text start with `select`/`with`/`table`/`values`?
 *
 * `isReadOnlyQuery` deliberately admits `EXPLAIN`/`SHOW`/`TABLE`/`VALUES` (it
 * dropped its old `^(select|with)` prefix test — see that function's
 * comment), and `DECLARE CURSOR FOR <sql>` only accepts a genuine *query*.
 * This classifier exists so a cursor is attempted only for statements that
 * accept one. It is a CAPABILITY test, never a safety boundary: a false
 * negative just degrades to today's uncapped-but-timeout-bounded behavior
 * (`/api/query` runs `sql` directly), never a rejection of a valid
 * statement — see the threat matrix in design.md.
 */
export function isCursorEligible(sql: string): boolean {
  let rest = sql;
  for (;;) {
    const trimmed = rest.replace(/^\s+/, "");
    if (trimmed.startsWith("--")) {
      const newline = trimmed.indexOf("\n");
      rest = newline === -1 ? "" : trimmed.slice(newline + 1);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const close = trimmed.indexOf("*/");
      rest = close === -1 ? "" : trimmed.slice(close + 2);
      continue;
    }
    if (trimmed.startsWith("(")) {
      rest = trimmed.slice(1);
      continue;
    }
    rest = trimmed;
    break;
  }
  return /^(select|with|table|values)\b/i.test(rest);
}

/** Production `StudioDb`: `pg.Pool` for metadata reads, plus a small dedicated
 * pool (`max: 4`) for read-only work, and a third small dedicated pool
 * (`max: 4`) for writable work. Three separate pools so a hung read-only
 * query never starves `/api/schema` or `/api/tables/:name`, and so a write
 * can never run on a connection that ever issued `SET TRANSACTION READ
 * ONLY`. */
function createPgDb(connectionString: string, queryTimeoutMs: number): StudioDb {
  const pool = new pg.Pool({ connectionString });
  const readOnlyPool = new pg.Pool({ connectionString, max: 4 });
  const writePool = new pg.Pool({ connectionString, max: 4 });

  function toResult(result: { rows: unknown[]; fields: { name: string }[] }): StudioQueryResult {
    return { rows: result.rows, fields: result.fields.map((f) => ({ name: f.name })) };
  }

  return {
    async query(sql, params) {
      return toResult(await pool.query(sql, params));
    },
    async readOnly(fn) {
      const client = await readOnlyPool.connect();
      try {
        await client.query("BEGIN");
        for (const stmt of readOnlyPreamble(queryTimeoutMs)) {
          await client.query(stmt);
        }
        return await fn(async (sql, params) => toResult(await client.query(sql, params)));
      } finally {
        // Always ROLLBACK, never COMMIT: this path exists to run read-only
        // work, and a failed ROLLBACK here must not surface as the route's
        // error (the query's own result/error already reflects the outcome).
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    },
    async writable(fn) {
      const client = await writePool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(async (sql, params) => toResult(await client.query(sql, params)));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
      await readOnlyPool.end();
      await writePool.end();
    },
  };
}

/** Opens a URL in the default browser (like `prisma studio`). Best-effort. */
function openBrowser(url: string): void {
  const cmd =
    platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: platform() === "win32" }).unref();
  } catch {
    /* non-fatal */
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

/** Locates the built Studio SPA directory (`apps/studio/dist`). */
function resolveStudioDist(): string | null {
  if (process.env.INDIGODB_STUDIO_DIST) return process.env.INDIGODB_STUDIO_DIST;
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@indigodb/studio/package.json");
    return join(pkgPath, "..", "dist");
  } catch {
    return null;
  }
}

/**
 * Cheap pre-filter, advisory only: rejects empty input and multi-statement
 * bodies before opening a connection. This is NOT the enforcement boundary —
 * `db.readOnly` running inside `SET TRANSACTION READ ONLY` is. A previous
 * `^(select|with)` prefix test was removed here: it wrongly rejected
 * legitimate read-only forms (`TABLE t`, `VALUES (1)`, `EXPLAIN SELECT`)
 * while giving false assurance about queries it did let through.
 */
function isReadOnlyQuery(sql: string): boolean {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (trimmed.length === 0) return false;
  if (trimmed.includes(";")) return false; // no multiple statements
  return true;
}

/**
 * Strips the `datasource` block from a resolved schema before it is served
 * over `/api/schema`. Shallow copy: the rest of the JSON is served as-is.
 */
function redactSchema(resolved: ResolvedSchema): ResolvedSchema {
  const copy: ResolvedSchema & { datasource?: unknown } = { ...resolved };
  delete copy.datasource;
  return copy;
}

/**
 * Strips the raw `datasource { ... }` block from `.indigo` source text
 * before it is served over `/api/schema/source`, replacing it with a short
 * placeholder comment. A connection string (literal or `env()`) can only
 * ever appear inside this block, and the block can span multiple lines and
 * nest braces (e.g. a future `env(...)` call with its own parens/braces), so
 * this is a brace-depth line scan rather than a regex — a regex cannot
 * reliably match a nested, multi-line block.
 *
 * Forward-looking constraint: this redaction is safe only because no
 * save-back/schema-editor-write endpoint exists yet in this server. If one
 * is ever added (Studio schema write-back is on the roadmap), it MUST NOT
 * round-trip this redacted text back into the real schema file — it must
 * read the original, unredacted source instead.
 */
export function redactSource(source: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let depth = 0;
  let inBlock = false;

  for (const line of lines) {
    if (!inBlock) {
      if (/^\s*datasource\b/.test(line)) {
        inBlock = true;
        depth = 0;
        for (const ch of line) {
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
        }
        out.push("// datasource redacted by Studio");
        if (depth <= 0) inBlock = false;
        continue;
      }
      out.push(line);
      continue;
    }

    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth <= 0) inBlock = false;
    // Lines inside the datasource block are dropped entirely.
  }

  return out.join("\n");
}

/**
 * Thrown by `resolveWriteTarget` on any identifier or shape problem with a
 * write request. Every route that calls it maps this to HTTP 400 and runs
 * no SQL — see the individual checks below.
 */
export class WriteTargetError extends Error {}

/**
 * A validated, ready-to-quote write target: the resolved table, its
 * already-quoted physical name, the resolved columns requested for the
 * write, and the table's primary-key columns (in `ResolvedTable.primaryKey`
 * order, composite-safe). Every quoted identifier here is derived from the
 * `ResolvedSchema` object itself — never from request text — which is what
 * makes it safe to interpolate into SQL alongside bound value parameters.
 */
export interface WriteTarget {
  table: ResolvedTable;
  quotedTable: string;
  columns: ResolvedColumn[];
  pk: ResolvedColumn[];
}

/**
 * Single shared identifier resolver for every row-write route (POST, PATCH,
 * DELETE). Re-validates the requested table
 * name against `resolved.tables` and every requested column name against
 * that table's columns — the one place this injection-adjacent surface is
 * checked, so every write route shares the exact same guarantees.
 *
 * Throws `WriteTargetError` (→ HTTP 400 at the call site) when:
 *  - the table name is not in `resolved.tables`;
 *  - any requested column name is not one of that table's columns;
 *  - the table has no primary key (writes require row identity);
 *  - a requested column is a generated/autoincrement column (its value is
 *    owned by the database, not the client) — this is what makes it safe to
 *    reuse unchanged for POST/INSERT: a generated primary key column must
 *    never appear among the requested columns there either, whether or not
 *    the client supplied a value for it.
 */
export function resolveWriteTarget(
  resolved: ResolvedSchema,
  tableName: string,
  columnNames: string[],
): WriteTarget {
  const table = resolved.tables.find((t) => t.name === tableName || t.dbName === tableName);
  if (!table) {
    throw new WriteTargetError(`Unknown table: ${tableName}`);
  }

  if (table.primaryKey.length === 0) {
    throw new WriteTargetError(
      `Table "${table.name}" has no primary key; row writes require one.`,
    );
  }
  const pk = table.primaryKey.map((dbName) => {
    const col = table.columns.find((c) => c.dbName === dbName);
    if (!col) {
      throw new WriteTargetError(
        `Primary key column "${dbName}" not found among "${table.name}"'s columns.`,
      );
    }
    return col;
  });

  const columns = columnNames.map((name) => {
    const col = table.columns.find((c) => c.name === name || c.dbName === name);
    if (!col) {
      throw new WriteTargetError(`Unknown column "${name}" on table "${table.name}"`);
    }
    if (col.autoincrement) {
      throw new WriteTargetError(
        `Column "${col.name}" is auto-generated and cannot be written directly.`,
      );
    }
    return col;
  });

  return { table, quotedTable: `"${table.dbName}"`, columns, pk };
}

/**
 * Thrown by `resolveReadTarget` when a table name doesn't resolve. Every
 * route that calls it maps this to HTTP 404 and runs no SQL.
 */
export class ReadTargetError extends Error {}

/**
 * A validated read target: the resolved table, its already-quoted physical
 * name, and its primary-key columns (possibly empty — a legal case for
 * reads, unlike `resolveWriteTarget`'s `WriteTarget`).
 *
 * Deliberately NOT `resolveWriteTarget` reused: that function throws on an
 * empty primary key (writes require row identity) and on autoincrement
 * columns (their value is database-owned) — both of those rejections are
 * wrong here. Reads must tolerate a PK-less table (short-circuit to a single
 * unpaginated page) and must be able to order by an autoincrement column,
 * since autoincrement primary keys are exactly what most tables page on.
 */
export interface ReadTarget {
  table: ResolvedTable;
  quotedTable: string;
  pk: ResolvedColumn[];
}

/**
 * Sibling of `resolveWriteTarget` for the read path. Validates only that the
 * table exists; an empty or autoincrement-bearing primary key is left to the
 * caller to handle (PK-less tables short-circuit to a single legacy page,
 * see `/api/tables/:name`).
 */
export function resolveReadTarget(resolved: ResolvedSchema, tableName: string): ReadTarget {
  const table = resolved.tables.find((t) => t.name === tableName || t.dbName === tableName);
  if (!table) {
    throw new ReadTargetError(`Unknown table: ${tableName}`);
  }

  const pk = table.primaryKey.map((dbName) => {
    const col = table.columns.find((c) => c.dbName === dbName);
    if (!col) {
      throw new ReadTargetError(
        `Primary key column "${dbName}" not found among "${table.name}"'s columns.`,
      );
    }
    return col;
  });

  return { table, quotedTable: `"${table.dbName}"`, pk };
}

/**
 * Builds the keyset WHERE-clause fragment and matching ORDER BY for a page
 * of rows, composite-PK-safe via Postgres row-value comparison:
 *   single column: `"col" op $N`
 *   composite:     `("c1","c2") op ($N,$N+1)`
 * `ORDER BY` always mirrors the operator so the comparison and the row order
 * agree: ascending for `>` (forward paging), descending for `<` (backward —
 * the query is run in reverse and the caller re-reverses the trimmed rows
 * before returning, so the response is always ascending PK order).
 */
function buildKeysetSql(
  pk: ResolvedColumn[],
  op: ">" | "<",
  paramStart: number,
): { where: string; orderBy: string } {
  const cols = pk.map((c) => `"${c.dbName}"`);
  const placeholders = pk.map((_, i) => `$${paramStart + i}`);
  const where =
    pk.length === 1
      ? `${cols[0]} ${op} ${placeholders[0]}`
      : `(${cols.join(",")}) ${op} (${placeholders.join(",")})`;
  const direction = op === ">" ? "ASC" : "DESC";
  const orderBy = cols.map((c) => `${c} ${direction}`).join(", ");
  return { where, orderBy };
}

/** Encodes a primary-key value tuple (in `ResolvedTable.primaryKey` order) as
 * an opaque cursor string: `base64url(JSON.stringify(values))`. */
function encodeCursor(values: unknown[]): string {
  return Buffer.from(JSON.stringify(values)).toString("base64url");
}

/**
 * Thrown by `parsePageParams`/`decodeCursor` on any malformed pagination
 * input. Every route that calls them maps this to HTTP 400 and runs no SQL.
 */
export class PageParamError extends Error {}

/**
 * Decodes and arity-checks a cursor string against the table's actual
 * primary-key column count — a cursor for a 2-column composite PK can never
 * be silently accepted as a 1-column cursor or vice versa.
 */
function decodeCursor(raw: string, pkLength: number): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new PageParamError("Invalid cursor");
  }
  if (!Array.isArray(parsed) || parsed.length !== pkLength) {
    throw new PageParamError("Invalid cursor");
  }
  return parsed;
}

const ALLOWED_LIMITS = new Set([25, 50, 100, 200]);

export interface PageParams {
  limit: number;
  direction: "forward" | "backward";
  cursor: unknown[] | null;
}

/**
 * Validates and parses `limit`/`direction`/`cursor` query params.
 *
 * `limit`: absent → 100 (default). Present → must be an exact decimal-integer
 * string that is a member of `{25, 50, 100, 200}`; anything else (including
 * `0`, `1000`, `50.0`, or non-numeric text) is REJECTED with 400, never
 * clamped to the nearest valid value — an honest-looking pager over a page
 * size the caller never actually chose would be worse than an error.
 *
 * `direction`: absent → "forward"; otherwise must be exactly "forward" or
 * "backward".
 *
 * `cursor`: absent → `null`; otherwise decoded and arity-checked against
 * `pkLength` via `decodeCursor`.
 */
export function parsePageParams(searchParams: URLSearchParams, pkLength: number): PageParams {
  const limitRaw = searchParams.get("limit");
  let limit = 100;
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw) || !ALLOWED_LIMITS.has(Number(limitRaw))) {
      throw new PageParamError("limit must be one of 25, 50, 100, 200");
    }
    limit = Number(limitRaw);
  }

  const directionRaw = searchParams.get("direction");
  let direction: "forward" | "backward" = "forward";
  if (directionRaw !== null) {
    if (directionRaw !== "forward" && directionRaw !== "backward") {
      throw new PageParamError('direction must be "forward" or "backward"');
    }
    direction = directionRaw;
  }

  const cursorRaw = searchParams.get("cursor");
  const cursor = cursorRaw !== null ? decodeCursor(cursorRaw, pkLength) : null;

  return { limit, direction, cursor };
}

/** Extracts a row's primary-key value tuple, in `pk` order, keyed by the
 * schema field name (`c.name`) — the alias every SELECT here uses. */
function pkValuesOf(pk: ResolvedColumn[], row: Record<string, unknown>): unknown[] {
  return pk.map((c) => row[c.name]);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Rejects a request whose `Host` header (checked on EVERY request,
 * including static assets) or `Origin` header (checked only when present)
 * does not match this server's own bind address — defends the loopback
 * bind against DNS-rebinding and cross-origin page access. Runs before any
 * routing.
 *
 * Under an explicit non-loopback `--host` bind, `Host` validation is
 * deliberately relaxed to a port-only match: the actual hostname or IP a
 * client will use to reach a non-loopback bind is not knowable in advance
 * (LAN IP, DNS name, etc.), so a strict allowlist would either reject
 * legitimate traffic or require guessing every possible value. This is a
 * tradeoff the operator opts into by choosing a non-loopback host — the
 * same tradeoff is spelled out in the startup warning printed for that
 * case (see `startStudio`).
 */
function validateHeaders(
  req: import("node:http").IncomingMessage,
  port: number,
  host: string,
): { ok: true } | { ok: false; error: string } {
  const loopback = isLoopbackHost(host);
  const allowedHostValues = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    `${host}:${port}`,
  ]);

  function hostAllowed(value: string | undefined): boolean {
    if (!value) return false;
    if (loopback) return allowedHostValues.has(value);
    return value.endsWith(`:${port}`); // relaxed: port-match only, see doc comment above.
  }

  if (!hostAllowed(req.headers.host)) {
    return { ok: false, error: "Host not allowed" };
  }

  const originHeader = req.headers.origin;
  if (originHeader) {
    let originHost: string | undefined;
    try {
      originHost = new URL(originHeader).host;
    } catch {
      return { ok: false, error: "Origin not allowed" };
    }
    if (!hostAllowed(originHost)) {
      return { ok: false, error: "Origin not allowed" };
    }
  }

  return { ok: true };
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

/** True when `error` carries Postgres's `statement_timeout` SQLSTATE (`57014`). */
function isStatementTimeoutError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "57014";
}

/**
 * The exact guidance message both read-only routes surface on a
 * `statement_timeout` abort — no SQL, no connection details, no stack (see
 * design.md's "57014 is translated" decision and the spec's `Interfaces`
 * contract). Applied to BOTH `/api/query` and `/api/tables/:name`: the
 * spec's "statement_timeout is enforced on both read-only routes"
 * requirement names a 4xx on either path as a MUST, so both catch this
 * error identically rather than leaving `/api/tables/:name` to fall through
 * to the generic 500 handler.
 */
function statementTimeoutMessage(queryTimeoutMs: number): string {
  return (
    `Query exceeded the ${queryTimeoutMs}ms statement timeout. ` +
    `Raise it with --query-timeout or INDIGODB_STUDIO_QUERY_TIMEOUT_MS.`
  );
}

export async function startStudio(
  options: StudioOptions,
): Promise<{ port: number; host: string; close(): Promise<void> }> {
  const { resolved, source, connectionString, port, open = true } = options;
  const host = options.host ?? "127.0.0.1";
  // Mirrors `resolveQueryTimeoutMs`/`resolveQueryRowCap`'s own built-in
  // defaults (util.ts) so a caller of `startStudio` that skips the CLI's
  // option resolution entirely (tests, embedders) still gets guardrails on
  // by default, matching the spec's "guardrails on by default" requirement.
  const queryTimeoutMs = options.queryTimeoutMs ?? 30000;
  const queryRowCap = options.queryRowCap ?? 1000;
  const db = options.db ?? createPgDb(connectionString, queryTimeoutMs);
  const distDir = resolveStudioDist();
  const publicSchema = redactSchema(resolved);
  const publicSource = redactSource(source);

  // Resolved ONCE at startup, never per-request: with no password configured
  // this is `null` and every request path below short-circuits on `if
  // (auth)` before any cookie parsing or HMAC work happens — a structural
  // no-op for the zero-config default, not a conditional check inside auth
  // logic.
  const auth: StudioAuth | null = options.password ? createStudioAuth(options.password) : null;

  // Resolved ONCE at startup, exactly like `auth` above: `false` (the
  // default) is a structural no-op on every request path.
  const readOnly = options.readOnly === true;

  // Purely informational — `null` (the wire/store default) when unset.
  // Never read by any auth/read-only/guardrail decision below.
  const environment = options.environment ?? null;

  // `boundPort` starts as the requested port and is updated once `listen`
  // resolves the actual bound port — needed for `port: 0` (ephemeral, used
  // by tests). Captured by reference, so the request handler below always
  // sees the final value even though requests only arrive after `listen`'s
  // callback has already fired.
  let boundPort = port;

  // Embedded realtime engine: with @@realtime tables the Studio gets live
  // change events on the same port, no separate `indigodb realtime` needed.
  const engine = resolved.tables.some((t) => t.realtime)
    ? new RealtimeEngine({ connectionString, schema: resolved })
    : null;
  if (engine) await engine.start();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${boundPort}`);
    const path = url.pathname;

    const headerCheck = validateHeaders(req, boundPort, host);
    if (!headerCheck.ok) {
      sendJson(res, 403, { error: headerCheck.error });
      return;
    }

    // ─── Session auth gate ────────────────────────────────────────────────
    // Applies ONLY to /api/* routes — the static SPA shell always falls
    // through unauthenticated (see design.md's "Static SPA shell" decision).
    // `GET /api/auth/status` and `POST /api/auth/login` are themselves
    // ungated (a locked-out client must be able to reach them at all); every
    // other /api/* route requires a valid session whenever `auth` is set.
    if (auth && path.startsWith("/api/") && path !== "/api/auth/status" && path !== "/api/auth/login") {
      if (!auth.verify(req.headers.cookie)) {
        sendJson(res, 401, { error: "Authentication required" });
        return;
      }
    }

    // ─── Read-only gate ─────────────────────────────────────────────────
    // Method-agnostic: refuses every request under `/api/rows/` regardless
    // of verb, so a future write route added under this prefix inherits the
    // gate automatically instead of needing its own check. Runs strictly
    // after the auth gate above (design.md: an unauthenticated write must
    // answer 401, never 403 — the write route must not become an oracle for
    // server posture). No DB connection or validation work happens here.
    if (readOnly && path.startsWith("/api/rows/")) {
      sendJson(res, 403, { error: "Studio is running in read-only mode" });
      return;
    }

    try {
      // ─── Auth routes ───────────────────────────────────────────────────
      if (path === "/api/auth/status" && req.method === "GET") {
        const authRequired = auth !== null;
        const authenticated = auth !== null && auth.verify(req.headers.cookie);
        sendJson(res, 200, { authRequired, authenticated, readOnly, queryTimeoutMs, queryRowCap, environment });
        return;
      }

      if (path === "/api/auth/login" && req.method === "POST") {
        const body = await readBody(req);
        let submittedPassword = "";
        try {
          submittedPassword = (JSON.parse(body || "{}").password ?? "").toString();
        } catch {
          sendJson(res, 401, { error: "Invalid password" });
          return;
        }
        // Identical failure whether auth is unconfigured or the password is
        // simply wrong — a caller must never be able to distinguish the two.
        if (!auth || !auth.check(submittedPassword)) {
          sendJson(res, 401, { error: "Invalid password" });
          return;
        }
        res.setHeader("Set-Cookie", auth.cookieHeader(auth.mint(), SESSION_TTL_SECONDS));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path === "/api/auth/logout" && req.method === "POST") {
        // Stateless sessions by design: this clears the client-side cookie
        // only — no server-side session invalidation. A captured cookie
        // replayed elsewhere before its own natural expiry remains valid,
        // a spec'd limitation, not a bug.
        res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        sendJson(res, 200, { ok: true });
        return;
      }

      // ─── API ───────────────────────────────────────────────────────────
      if (path === "/api/schema") {
        sendJson(res, 200, publicSchema);
        return;
      }

      if (path === "/api/schema/source") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(publicSource);
        return;
      }

      if (path === REALTIME_PATH && engine) {
        engine.handleRequest(req, res);
        return;
      }

      if (path === REALTIME_LOG_PATH && engine) {
        await engine.handleLogRequest(req, res);
        return;
      }

      if (path.startsWith("/api/tables/")) {
        const name = decodeURIComponent(path.slice("/api/tables/".length));

        let target: ReadTarget;
        try {
          target = resolveReadTarget(resolved, name);
        } catch (error) {
          if (error instanceof ReadTargetError) {
            sendJson(res, 404, { error: error.message });
            return;
          }
          throw error;
        }

        let params: PageParams;
        try {
          params = parsePageParams(url.searchParams, target.pk.length);
        } catch (error) {
          if (error instanceof PageParamError) {
            sendJson(res, 400, { error: error.message });
            return;
          }
          throw error;
        }

        // Alias physical columns back to schema field names (e.g. created_at → createdAt)
        // so the rows match the column metadata the UI renders.
        const selectList = target.table.columns
          .map((c) => `"${c.dbName}" AS "${c.name}"`)
          .join(", ");
        const columns = target.table.columns.map((c) => c.name);

        let result;
        try {
          result = await db.readOnly(async (query) => {
          const countResult = await query(
            `SELECT count(*)::int AS n FROM ${target.quotedTable}`,
          );
          const total = (countResult.rows[0] as { n: number }).n;

          if (target.pk.length === 0) {
            // PK-less: no stable cursor key exists. Keep today's exact query
            // shape (no ORDER BY, LIMIT only) — cursor/direction/limit were
            // already validated above but are otherwise ignored here.
            const rowsResult = await query(
              `SELECT ${selectList} FROM ${target.quotedTable} LIMIT 100`,
            );
            return {
              columns,
              rows: rowsResult.rows,
              nextCursor: null,
              prevCursor: null,
              total,
              paginated: false,
            };
          }

          const op = params.direction === "forward" ? ">" : "<";
          const { where, orderBy } = buildKeysetSql(target.pk, op, 1);
          const whereClause = params.cursor ? `WHERE ${where}` : "";
          const sql = `SELECT ${selectList} FROM ${target.quotedTable} ${whereClause} ORDER BY ${orderBy} LIMIT ${params.limit + 1}`;
          const rowsResult = await query(sql, params.cursor ?? []);

          const hasExtra = rowsResult.rows.length > params.limit;
          let rows = rowsResult.rows.slice(0, params.limit) as Record<string, unknown>[];
          if (params.direction === "backward") rows = rows.reverse();

          let nextCursor: string | null = null;
          let prevCursor: string | null = null;
          if (rows.length > 0) {
            if (params.direction === "forward") {
              nextCursor = hasExtra ? encodeCursor(pkValuesOf(target.pk, rows[rows.length - 1])) : null;
              prevCursor = params.cursor ? encodeCursor(pkValuesOf(target.pk, rows[0])) : null;
            } else {
              prevCursor = hasExtra ? encodeCursor(pkValuesOf(target.pk, rows[0])) : null;
              nextCursor = encodeCursor(pkValuesOf(target.pk, rows[rows.length - 1]));
            }
          }

          return { columns, rows, nextCursor, prevCursor, total, paginated: true };
          });
        } catch (error) {
          if (isStatementTimeoutError(error)) {
            sendJson(res, 400, { error: statementTimeoutMessage(queryTimeoutMs) });
            return;
          }
          throw error;
        }

        sendJson(res, 200, result);
        return;
      }

      if (path === "/api/query" && req.method === "POST") {
        const body = await readBody(req);
        const sql = (JSON.parse(body || "{}").sql ?? "").toString();
        if (!isReadOnlyQuery(sql)) {
          sendJson(res, 400, { error: "Only a single read-only SELECT/WITH statement is allowed." });
          return;
        }
        try {
          if (queryRowCap > 0 && isCursorEligible(sql)) {
            // Row cap via cursor: fetch `cap + 1` so a single extra row
            // distinguishes "exactly cap rows" from "more than cap rows"
            // without a second round trip (design.md "row cap via DECLARE
            // cursor" decision). Never closed explicitly — `db.readOnly`
            // always rolls back its transaction.
            const fetched = await db.readOnly(async (query) => {
              await query(`DECLARE _indigo_query_cursor NO SCROLL CURSOR FOR ${sql}`);
              return query(`FETCH FORWARD ${queryRowCap + 1} FROM _indigo_query_cursor`);
            });
            const truncated = fetched.rows.length > queryRowCap;
            const rows = truncated ? fetched.rows.slice(0, queryRowCap) : fetched.rows;
            sendJson(res, 200, { columns: fetched.fields.map((f) => f.name), rows, truncated });
          } else {
            // queryRowCap: 0 (disabled) or a cursor-ineligible statement
            // (EXPLAIN/SHOW/etc.) — run exactly as before this change.
            const result = await db.readOnly((query) => query(sql));
            sendJson(res, 200, { columns: result.fields.map((f) => f.name), rows: result.rows, truncated: false });
          }
        } catch (error) {
          if (isStatementTimeoutError(error)) {
            sendJson(res, 400, { error: statementTimeoutMessage(queryTimeoutMs) });
            return;
          }
          sendJson(res, 400, { error: (error as Error).message });
        }
        return;
      }

      if (path.startsWith("/api/rows/") && req.method === "POST") {
        await handleInsertRow(path.slice("/api/rows/".length), req, res, resolved, db);
        return;
      }

      if (path.startsWith("/api/rows/") && req.method === "PATCH") {
        await handleUpdateRow(path.slice("/api/rows/".length), req, res, resolved, db);
        return;
      }

      if (path.startsWith("/api/rows/") && req.method === "DELETE") {
        await handleDeleteRow(path.slice("/api/rows/".length), req, res, resolved, db);
        return;
      }

      if (path.startsWith("/api/")) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      // ─── Static SPA ────────────────────────────────────────────────────
      if (!distDir) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(FALLBACK_PAGE);
        return;
      }
      await serveStatic(distDir, path, res);
    } catch (error) {
      sendJson(res, 500, { error: (error as Error).message });
    }
  });

  const actualHost = await new Promise<string>((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      boundPort = typeof addr === "object" && addr !== null ? addr.port : port;
      resolve(typeof addr === "object" && addr !== null ? addr.address : host);
    });
  });

  console.log();
  console.log("  🎨 IndigoDB Studio");
  console.log("  ─────────────────────────────");
  console.log(`  Tables: ${resolved.tables.length}`);
  console.log(`  URL:    http://${actualHost}:${boundPort}`);
  console.log(`  Auth:   ${auth ? "enabled (session password required)" : "disabled (no password configured)"}`);
  console.log(`  Read-only: ${readOnly ? "on" : "off"}`);
  console.log(`  Environment: ${environment ?? "(unset)"}`);
  if (!distDir) {
    console.log(`  ⚠  Studio UI build not found — serving API only.`);
  }
  if (!isLoopbackHost(host)) {
    console.log(
      `  ⚠  Binding to ${host}: the Studio server (including the SQL query console) is` +
        ` reachable from other hosts on the network. This also relaxes Host-header` +
        ` validation to a port-only match (see validateHeaders in studio-server.ts) —` +
        ` only do this on a trusted network you control.`,
    );
  }
  console.log();
  console.log("  Press Ctrl+C to stop.");

  if (open) openBrowser(`http://${actualHost}:${boundPort}`);

  return {
    port: boundPort,
    host: actualHost,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      if (engine) await engine.stop();
      await db.close();
    },
  };
}

/** Serves a static file from the dist dir, falling back to index.html (SPA). */
async function serveStatic(
  distDir: string,
  path: string,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const rel = path === "/" ? "index.html" : normalize(path).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(distDir, rel);

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    filePath = join(distDir, "index.html"); // SPA fallback
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

/**
 * `PATCH /api/rows/:table` — updates one row, identified by primary key.
 * Body shape: `{ pk: Record<columnName, value>, patch: Record<columnName, value> }`,
 * both keyed by the schema field name (not the physical `dbName`), matching
 * `/api/tables/:name`'s aliasing convention.
 *
 * All identifiers (table name, column names) go through `resolveWriteTarget`
 * before any SQL is built; every value is bound as a parameter, never
 * interpolated. Runs on `db.writable`, never `db.readOnly`.
 */
async function handleUpdateRow(
  encodedTableName: string,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  resolved: ResolvedSchema,
  db: StudioDb,
): Promise<void> {
  const tableName = decodeURIComponent(encodedTableName);

  let body: { pk?: Record<string, unknown>; patch?: Record<string, unknown> };
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }
  const pkInput = body.pk ?? {};
  const patchInput = body.patch ?? {};

  let target: WriteTarget;
  try {
    target = resolveWriteTarget(resolved, tableName, Object.keys(patchInput));
  } catch (error) {
    if (error instanceof WriteTargetError) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    throw error;
  }

  const missingPk = target.pk.filter((c) => !(c.name in pkInput));
  if (missingPk.length > 0) {
    sendJson(res, 400, {
      error: `Missing primary key value(s): ${missingPk.map((c) => c.name).join(", ")}`,
    });
    return;
  }
  if (target.columns.length === 0) {
    sendJson(res, 400, { error: "No columns to update" });
    return;
  }

  const setParams = target.columns.map((c) => patchInput[c.name] ?? null);
  const setClauses = target.columns.map((c, i) => `"${c.dbName}" = $${i + 1}`);
  const whereParams = target.pk.map((c) => pkInput[c.name]);
  const whereClauses = target.pk.map(
    (c, i) => `"${c.dbName}" = $${setParams.length + i + 1}`,
  );
  const selectList = target.table.columns.map((c) => `"${c.dbName}" AS "${c.name}"`).join(", ");
  const sql = `UPDATE ${target.quotedTable} SET ${setClauses.join(", ")} WHERE ${whereClauses.join(" AND ")} RETURNING ${selectList}`;

  try {
    const result = await db.writable((query) => query(sql, [...setParams, ...whereParams]));
    if (result.rows.length === 0) {
      sendJson(res, 404, { error: "No row matched the given primary key" });
      return;
    }
    sendJson(res, 200, { row: result.rows[0] });
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message });
  }
}

/**
 * `POST /api/rows/:table` — inserts one row, returning the persisted row
 * (including any database-generated primary key or default values). Body
 * shape: a flat `Record<columnName, value>` of the new row's column values,
 * keyed by the schema field name (not the physical `dbName`), matching
 * `/api/tables/:name`'s aliasing convention.
 *
 * `resolveWriteTarget` is reused unchanged from the UPDATE route: a
 * generated/autoincrement primary key column MUST be omitted from the
 * request body entirely — the database owns its value — so if the client
 * includes one anyway (any value, including `null`), the same
 * `WriteTargetError` that guards UPDATE's patch body rejects it here too,
 * before any SQL is built.
 *
 * Runs on `db.writable`, never `db.readOnly`.
 */
async function handleInsertRow(
  encodedTableName: string,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  resolved: ResolvedSchema,
  db: StudioDb,
): Promise<void> {
  const tableName = decodeURIComponent(encodedTableName);

  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    sendJson(res, 400, { error: "Request body must be a JSON object of column values" });
    return;
  }
  const valuesInput = body as Record<string, unknown>;

  let target: WriteTarget;
  try {
    target = resolveWriteTarget(resolved, tableName, Object.keys(valuesInput));
  } catch (error) {
    if (error instanceof WriteTargetError) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    throw error;
  }

  const params = target.columns.map((c) => valuesInput[c.name] ?? null);
  const selectList = target.table.columns.map((c) => `"${c.dbName}" AS "${c.name}"`).join(", ");
  const sql =
    target.columns.length > 0
      ? `INSERT INTO ${target.quotedTable} (${target.columns.map((c) => `"${c.dbName}"`).join(", ")}) ` +
        `VALUES (${target.columns.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${selectList}`
      : `INSERT INTO ${target.quotedTable} DEFAULT VALUES RETURNING ${selectList}`;

  try {
    const result = await db.writable((query) => query(sql, params));
    sendJson(res, 201, { row: result.rows[0] });
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message });
  }
}

/**
 * `DELETE /api/rows/:table` — deletes one row, identified by primary key.
 * Body shape: `{ pk: Record<columnName, value> }`, keyed by the schema field
 * name (not the physical `dbName`), matching PATCH's `pk` shape.
 *
 * `resolveWriteTarget` is called with an empty requested-column set (DELETE
 * has no column body of its own to validate) purely to re-validate the table
 * name and obtain its resolved primary-key columns — the exact same
 * table-lookup and "table has a primary key" guarantees PATCH/POST rely on.
 * Every primary-key value is bound as a parameter, never interpolated.
 * Runs on `db.writable`, never `db.readOnly`.
 *
 * This route is intentionally UI-guard-agnostic: the confirmation dialog and
 * the "Safe Updates" toggle are enforced client-side only (see
 * `useSettingsStore`/`DeleteRecordDialog`), per the studio-write-guards spec.
 * The server's job here is solely correct, injection-safe row identification.
 */
async function handleDeleteRow(
  encodedTableName: string,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  resolved: ResolvedSchema,
  db: StudioDb,
): Promise<void> {
  const tableName = decodeURIComponent(encodedTableName);

  let body: { pk?: Record<string, unknown> };
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }
  const pkInput = body.pk ?? {};

  let target: WriteTarget;
  try {
    target = resolveWriteTarget(resolved, tableName, []);
  } catch (error) {
    if (error instanceof WriteTargetError) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    throw error;
  }

  const missingPk = target.pk.filter((c) => !(c.name in pkInput));
  if (missingPk.length > 0) {
    sendJson(res, 400, {
      error: `Missing primary key value(s): ${missingPk.map((c) => c.name).join(", ")}`,
    });
    return;
  }

  const whereParams = target.pk.map((c) => pkInput[c.name]);
  const whereClauses = target.pk.map((c, i) => `"${c.dbName}" = $${i + 1}`);
  const sql = `DELETE FROM ${target.quotedTable} WHERE ${whereClauses.join(" AND ")}`;

  try {
    const result = await db.writable(async (query) => {
      const before = await query(
        `SELECT 1 FROM ${target.quotedTable} WHERE ${whereClauses.join(" AND ")}`,
        whereParams,
      );
      if (before.rows.length === 0) return { deleted: false };
      await query(sql, whereParams);
      return { deleted: true };
    });
    if (!result.deleted) {
      sendJson(res, 404, { error: "No row matched the given primary key" });
      return;
    }
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message });
  }
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const FALLBACK_PAGE = `<!doctype html><html><body style="font-family:sans-serif;background:#09090b;color:#e4e4e7;padding:40px">
<h1>IndigoDB Studio</h1><p>The Studio UI build was not found, but the API is running.</p>
<p>Try <code>GET /api/schema</code>.</p></body></html>`;
