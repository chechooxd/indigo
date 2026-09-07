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
import { writeFileSync, renameSync, unlinkSync, statSync } from "node:fs";
import { join, extname, normalize, dirname, basename } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import type { ResolvedColumn, ResolvedSchema, ResolvedTable } from "@indigodb/core";
import { parse, validate, IndigoParseError } from "@indigodb/core";
import type { ParseErrorDetail } from "@indigodb/parser";
import { RealtimeEngine, REALTIME_PATH, REALTIME_LOG_PATH } from "@indigodb/realtime";
import { createStudioAuth, parseCookie, SESSION_COOKIE, SESSION_TTL_SECONDS, type StudioAuth } from "./studio-auth.js";
import {
  deriveSessionCorrelator,
  formatAuditLine,
  formatPkValue,
  type AuditOp,
  type StudioAuditEntry,
} from "./util.js";

export interface StudioOptions {
  resolved: ResolvedSchema;
  /** Raw `.indigo` source text, served for the editor. */
  source: string;
  /**
   * Absolute path to the schema file on disk. When present, `GET
   * /api/schema/source` re-reads and re-redacts this file on every request
   * (rather than serving the `source` string snapshotted at startup) and
   * publishes an `X-Indigo-Schema-Version` header derived from the file's
   * current bytes. `undefined` (the default) falls back to serving
   * `redactSource(source)` with no version header — see decision 13 in
   * design.md. Every existing call site (embedders, tests) omits this and
   * keeps working unchanged.
   */
  schemaPath?: string;
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
  /**
   * Stdout JSON audit line for every attempted row write (`studio-audit-log`).
   * `undefined`/`true` (the default, matching `resolveStudioAuditLog`'s own
   * default) enables it; `false` is a structural no-op — every emit path
   * becomes `if (auditLog)` false, never even building the correlator.
   */
  auditLog?: boolean;
  /**
   * D7 origin allowlist for the embedded realtime engine's SSE/log routes
   * (only constructed when the schema has `@@realtime` tables). `undefined`
   * or `[]` (the default, matching `resolveAllowedOrigins`'s own default)
   * keeps the engine closed by default — the Studio's own embedded browser
   * client is unaffected either way, since its same-origin SSE `GET` never
   * carries an `Origin` header, and D7 always admits an originless request.
   */
  allowedOrigins?: string[];
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
 * The literal placeholder line `splitDatasource`/`redactSource` substitute
 * for a `datasource { ... }` block. Hoisted to a named export so the write
 * path (`reattachDatasource`, PR #1b) and the read path share the exact same
 * literal instead of two copies drifting apart.
 */
export const DATASOURCE_SENTINEL = "// datasource redacted by Studio";

/**
 * The result of scanning `.indigo` source for its `datasource { ... }`
 * block: `redacted` is the source with that block replaced by exactly one
 * `DATASOURCE_SENTINEL` line (or the source unchanged when there is no
 * block); `block` is the original block text — including the `datasource`
 * header line and its closing brace, `"\n"`-joined — or `null` when no
 * block was found.
 *
 * The reconstruction property this shape guarantees: splicing `block` back
 * in place of the single sentinel line in `redacted` reproduces the
 * original source byte-for-byte, because splitting/joining on `"\n"` is
 * lossless and every line outside the block is carried through unchanged.
 */
export interface DatasourceSplit {
  redacted: string;
  block: string | null;
}

/**
 * Splits `.indigo` source text into its datasource-redacted form and the
 * original datasource block text, in a single brace-depth line scan. A
 * connection string (literal or `env()`) can only ever appear inside this
 * block, and the block can span multiple lines and nest braces (e.g. a
 * future `env(...)` call with its own parens/braces), so this is a
 * brace-depth scan rather than a regex — a regex cannot reliably match a
 * nested, multi-line block.
 *
 * One scanner producing both halves (rather than two scans kept in lockstep
 * by discipline) is what makes the reconstruction property a compile-time
 * invariant instead of a review-time one — see `DatasourceSplit`'s doc
 * comment and the `studio-schema-source.mjs` property test (SW-17).
 *
 * Forward-looking constraint carried over from the pre-refactor
 * `redactSource`: `redacted` must never be round-tripped back into the real
 * schema file — the write path reattaches the original `block` instead (see
 * `reattachDatasource`, PR #1b).
 */
export function splitDatasource(source: string): DatasourceSplit {
  const lines = source.split("\n");
  const out: string[] = [];
  const blockLines: string[] = [];
  let depth = 0;
  let inBlock = false;
  let sawBlock = false;

  for (const line of lines) {
    if (!inBlock) {
      if (/^\s*datasource\b/.test(line)) {
        inBlock = true;
        sawBlock = true;
        depth = 0;
        for (const ch of line) {
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
        }
        blockLines.push(line);
        out.push(DATASOURCE_SENTINEL);
        if (depth <= 0) inBlock = false;
        continue;
      }
      out.push(line);
      continue;
    }

    blockLines.push(line);
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth <= 0) inBlock = false;
    // Lines inside the datasource block are dropped entirely from `out`.
  }

  return { redacted: out.join("\n"), block: sawBlock ? blockLines.join("\n") : null };
}

/**
 * Strips the raw `datasource { ... }` block from `.indigo` source text
 * before it is served over `/api/schema/source`, replacing it with a short
 * placeholder comment. A one-line wrapper over `splitDatasource` — this
 * exported signature is unchanged from before the refactor.
 */
export function redactSource(source: string): string {
  return splitDatasource(source).redacted;
}

/**
 * Strips at most one trailing `\r` from a line before comparing it against
 * `DATASOURCE_SENTINEL` — decision 2. A CRLF-normalizing editor turns the
 * sentinel line's ending into `\r\n`, which `String.split("\n")` leaves as a
 * trailing `\r` on that one line; matching after stripping it keeps the
 * round-trip working without loosening the match to `trim()`/`includes()`,
 * either of which would accept a subtly mutated placeholder line.
 */
function stripTrailingCR(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Outcome of `reattachDatasource` on a submitted write buffer. `reason` is
 * always one of these three closed values regardless of which specific
 * mismatch triggered it (zero sentinels, an unrelated `block === null`
 * mismatch, or too many sentinels all map to `"no-sentinel"` /
 * `"multiple-sentinels"`) — every `ok:false` result maps to the same `400
 * redaction-conflict` audit reason at the call site, so the distinction only
 * matters for the human-readable message, not for control flow.
 */
export type ReattachResult =
  | { ok: true; text: string }
  | { ok: false; reason: "inbound-datasource" | "no-sentinel" | "multiple-sentinels" };

/**
 * Splices the real on-disk `block` back into a submitted write `buffer` in
 * place of its single `DATASOURCE_SENTINEL` line — decision 3. No second
 * brace-depth scan of the buffer exists here: the buffer's own `datasource`
 * region (if any) is never parsed, only refused (decision 4). Ordering is
 * load-bearing (non-negotiable #5 / decision 4): the inbound-credential
 * guard runs BEFORE the sentinel count, so a buffer carrying both a real
 * `datasource` block and the sentinel is always reported as
 * `"inbound-datasource"`, never allowed to pass the count check.
 */
export function reattachDatasource(buffer: string, block: string | null): ReattachResult {
  const lines = buffer.split("\n");

  if (lines.some((line) => /^\s*datasource\b/.test(line))) {
    return { ok: false, reason: "inbound-datasource" };
  }

  const sentinelIndexes: number[] = [];
  lines.forEach((line, i) => {
    if (stripTrailingCR(line) === DATASOURCE_SENTINEL) sentinelIndexes.push(i);
  });

  if (block === null) {
    // Correction 2 (design.md): unreachable via a running `indigodb studio`
    // (resolveConnectionString exits first), reachable only for embedders
    // and tests. A sentinel with nothing to reattach is still refused, never
    // silently dropped.
    if (sentinelIndexes.length > 0) {
      return { ok: false, reason: "no-sentinel" };
    }
    return { ok: true, text: buffer };
  }

  if (sentinelIndexes.length === 0) {
    return { ok: false, reason: "no-sentinel" };
  }
  if (sentinelIndexes.length >= 2) {
    return { ok: false, reason: "multiple-sentinels" };
  }

  const idx = sentinelIndexes[0];
  const blockLines = block.split("\n");
  const spliced = [...lines.slice(0, idx), ...blockLines, ...lines.slice(idx + 1)];
  return { ok: true, text: spliced.join("\n") };
}

/** Human-readable `400` message for a `reattachDatasource` refusal. Always
 * names the exact placeholder line (verbatim) so the user can restore it. */
function reattachErrorMessage(reason: "inbound-datasource" | "no-sentinel" | "multiple-sentinels"): string {
  switch (reason) {
    case "inbound-datasource":
      return (
        "The submitted schema contains a literal `datasource` block. Studio manages the " +
        "datasource block separately for you — remove it from your edit and keep the " +
        `placeholder line "${DATASOURCE_SENTINEL}" in its place.`
      );
    case "no-sentinel":
      return (
        `Expected exactly one placeholder line ("${DATASOURCE_SENTINEL}") marking the ` +
        "datasource block, but none was found. Reload the schema from the server to restore it."
      );
    case "multiple-sentinels":
      return (
        `Expected exactly one placeholder line ("${DATASOURCE_SENTINEL}") marking the ` +
        "datasource block, but found more than one. Reload the schema from the server to restore it."
      );
  }
}

/**
 * Translates a 1-based line number from the *reattached* text (what was
 * actually parsed/validated) back to the submitted buffer's own coordinates
 * — decision 7. `sentinelIdx` is the 0-based index of the sentinel line in
 * the ORIGINAL buffer; `blockLineCount` is the on-disk block's line count.
 * Returns `undefined` when `line` falls inside the reattached block itself
 * (not visible in the user's buffer at all) — an honest "no position",
 * never a position clamped to the sentinel line.
 */
function translateLine(
  line: number | undefined,
  sentinelIdx: number,
  blockLineCount: number,
): number | undefined {
  if (line === undefined) return undefined;
  if (line <= sentinelIdx) return line; // before the block: unaffected
  if (line <= sentinelIdx + blockLineCount) return undefined; // inside the block: no position
  return line - (blockLineCount - 1); // after the block: shift back
}

/** Applies `translateLine` to one parser diagnostic's `line`/`endLine`. A
 * diagnostic that translates to no position is stripped of every positional
 * field — a validation-class entry, since that line is not visible in the
 * user's buffer. */
function translateParseError(
  error: ParseErrorDetail,
  sentinelIdx: number,
  blockLineCount: number,
): ParseErrorDetail {
  const line = translateLine(error.line, sentinelIdx, blockLineCount);
  if (line === undefined) {
    return { message: error.message };
  }
  const endLine = translateLine(error.endLine, sentinelIdx, blockLineCount) ?? line;
  return { message: error.message, line, column: error.column, endLine, endColumn: error.endColumn };
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

/**
 * Generalized read-only-gate predicate (design.md decision 9): every
 * `/api/rows/` request stays method-agnostic exactly as before (narrowing it
 * would regress a shipped scenario), and `/api/schema/source` /
 * `/api/schema/layout` are method-scoped — `GET`/`HEAD` on either path must
 * remain readable in read-only mode, only a mutating verb on them is a
 * write. This is the EXPLICIT write-route set the studio-readonly-mode delta
 * requires: `/api/schema/layout` does not share the `/api/rows/` prefix, so
 * it is listed here by name rather than inferred from a shared prefix. A
 * future write route inherits this gate by being added HERE, not by adding
 * a second gate check next to its own handler.
 */
function isWriteRoute(path: string, method: string): boolean {
  const isMutatingVerb = method !== "GET" && method !== "HEAD";
  return (
    path.startsWith("/api/rows/") ||
    (path === "/api/schema/source" && isMutatingVerb) ||
    (path === "/api/schema/layout" && isMutatingVerb)
  );
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

/**
 * Per-request audit context, computed once by the dispatcher (which alone
 * holds `auth`/`auditKey`) and threaded into each write handler — the
 * handlers themselves never see the correlator key, only its already-derived
 * `session` value (design.md "session is derived in studio-server.ts, never
 * in util.ts" data-flow note).
 */
interface AuditContext {
  enabled: boolean;
  session: string | undefined;
}

/**
 * The ONE function that both sends a write route's HTTP response and emits
 * its audit line, so a terminal branch cannot physically respond without
 * logging (design.md "emit is coupled to the response" decision). `sendJson`
 * is never called directly from `handleInsertRow`/`handleUpdateRow`/
 * `handleDeleteRow` — this is what makes "no `sendJson` inside the three
 * write handlers" grep-checkable and the exactly-one-line-per-response
 * invariant (Testing Strategy row 24) hold structurally rather than by
 * discipline.
 */
function respondWrite(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  audit: AuditContext,
  entry: StudioAuditEntry,
): void {
  sendJson(res, status, body);
  if (audit.enabled) console.log(formatAuditLine(entry));
}

/** Builds one `StudioAuditEntry`, filling in `ts`/`kind`/`op`/`table`/`session` once. */
function buildAuditEntry(
  op: AuditOp,
  table: string,
  session: string | undefined,
  rest: Omit<StudioAuditEntry, "ts" | "kind" | "op" | "table" | "session">,
): StudioAuditEntry {
  return { ts: new Date().toISOString(), kind: "studio.audit.write", op, table, session, ...rest };
}

/**
 * `buildAuditEntry`'s SEPARATE sibling for `PUT /api/schema/source`
 * (design.md decision 10) — hardcodes `op:"schema-write"` and never takes a
 * `table`. Kept apart from `buildAuditEntry` (rather than making its
 * `table` parameter optional) so a row write can never typecheck while
 * silently forgetting its table.
 */
function buildSchemaAuditEntry(
  session: string | undefined,
  rest: Omit<StudioAuditEntry, "ts" | "kind" | "op" | "table" | "session">,
): StudioAuditEntry {
  return { ts: new Date().toISOString(), kind: "studio.audit.write", op: "schema-write", session, ...rest };
}

/**
 * `buildSchemaAuditEntry`'s sibling for `PUT /api/schema/layout`
 * (studio-layout-persistence design.md D6) — hardcodes `op:"layout-write"`
 * and never takes a `table`, for the same reason `buildSchemaAuditEntry` is
 * kept separate from `buildAuditEntry`.
 */
function buildLayoutAuditEntry(
  session: string | undefined,
  rest: Omit<StudioAuditEntry, "ts" | "kind" | "op" | "table" | "session">,
): StudioAuditEntry {
  return { ts: new Date().toISOString(), kind: "studio.audit.write", op: "layout-write", session, ...rest };
}

/**
 * `respondWrite`'s sibling for the schema-write route — same coupling of
 * response and audit line, so a terminal branch cannot physically respond
 * without logging. Delegates to `respondWrite` directly since the two are
 * mechanically identical; the distinct name documents intent at each call
 * site (design.md decision 10).
 */
function respondSchemaWrite(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  audit: AuditContext,
  entry: StudioAuditEntry,
): void {
  respondWrite(res, status, body, audit, entry);
}

/**
 * `respondSchemaWrite`'s sibling for the layout-write route — same coupling
 * of response and audit line.
 */
function respondLayoutWrite(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  audit: AuditContext,
  entry: StudioAuditEntry,
): void {
  respondWrite(res, status, body, audit, entry);
}

/**
 * Extracts a driver error's SQLSTATE, only when it matches the exact
 * five-character shape (`/^[0-9A-Z]{5}$/`) — never the driver's message text,
 * which embeds submitted values (design.md "`reason` never carries a
 * database message" decision).
 */
function extractSqlState(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
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
  const { resolved, source, schemaPath, connectionString, port, open = true } = options;
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

  // Resolved ONCE at startup, matching `resolveStudioAuditLog`'s own default
  // (util.ts) so a caller that skips CLI option resolution (tests, embedders)
  // still gets logging on by default.
  const auditLog = options.auditLog ?? true;

  // Per-PROCESS random correlator key — generated freshly on every
  // `startStudio` call, NEVER at module load and NEVER derived from
  // `options.password`. This is the security property that keeps the audit
  // log from becoming an offline password-guessing oracle against the
  // predictable session-cookie payload (design.md "the correlator is
  // HMAC-SHA256 under a per-process random key" decision) — and generating
  // it here, rather than as a module-level constant, is what makes the
  // "correlators do not survive a restart" scenario testable: two
  // `withStudio` calls in one test process must observe two different keys.
  const auditKey = randomBytes(32);

  /** Derives the `session` audit correlator for one request, or `undefined`
   * when auth is off — the one place `auditKey`/`auth` are both in scope. */
  function auditSessionFor(req: import("node:http").IncomingMessage): string | undefined {
    if (!auth) return undefined;
    return deriveSessionCorrelator(parseCookie(req.headers.cookie, SESSION_COOKIE), auditKey);
  }

  // `boundPort` starts as the requested port and is updated once `listen`
  // resolves the actual bound port — needed for `port: 0` (ephemeral, used
  // by tests). Captured by reference, so the request handler below always
  // sees the final value even though requests only arrive after `listen`'s
  // callback has already fired.
  let boundPort = port;

  // Embedded realtime engine: with @@realtime tables the Studio gets live
  // change events on the same port, no separate `indigodb realtime` needed.
  const engine = resolved.tables.some((t) => t.realtime)
    ? new RealtimeEngine({ connectionString, schema: resolved, allowedOrigins: options.allowedOrigins })
    : null;
  // A rejected start is NOT fatal here, unlike `indigodb realtime`: the
  // schema, table and query routes need no replication stream, so refusing
  // to boot would trade a defect for a regression. But the failure must be
  // visible rather than silent — `realtimeAvailable` latches false and the
  // realtime routes answer 503, because `engine.handleRequest` would
  // otherwise write 200 plus a `ready` frame without consulting the source,
  // and the Studio's live badge reads `live` from that response alone.
  let realtimeAvailable = engine !== null;
  if (engine) {
    try {
      await engine.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`⚠ Realtime unavailable: ${message} — Studio continues without live updates`);
      realtimeAvailable = false;
      // No `engine.stop()` here on purpose: `start()` already stopped the
      // source on its way out, and `stop()` is guarded on a `started` flag
      // that a rejected start has cleared — calling it would read like
      // cleanup while doing nothing.
    }
  }

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
    // Generalized predicate (design.md decision 9, `isWriteRoute` above):
    // `/api/rows/` stays method-agnostic exactly as before; the schema route
    // is method-scoped so `GET`/`HEAD` on it remain readable in read-only
    // mode. Runs strictly after the auth gate above (design.md: an
    // unauthenticated write must answer 401, never 403 — the write route
    // must not become an oracle for server posture). No DB connection or
    // validation work happens here.
    if (readOnly && isWriteRoute(path, req.method ?? "")) {
      if (path === "/api/schema/source") {
        // Every mutating verb reaching this branch is an attempted schema
        // write (GET/HEAD are excluded by `isWriteRoute` itself), so — unlike
        // `/api/rows/`'s deniedOp-null GET case below — this always emits a
        // denial line (studio-readonly-mode: "a denied write emits an audit
        // line marked as denied").
        if (auditLog) {
          console.log(
            formatAuditLine(
              buildSchemaAuditEntry(auditSessionFor(req), { count: 0, outcome: "denied", reason: "read-only" }),
            ),
          );
        }
      } else if (path === "/api/schema/layout") {
        // Sibling of the schema-write branch above — every mutating verb
        // reaching this branch is an attempted layout write, so it always
        // emits a denial line. Runs BEFORE this route's own `schemaPath`
        // presence check, so a missing `schemaPath` under read-only mode
        // still answers 403 here, never 404 (studio-layout-persistence
        // "Read-only mode combined with a missing schemaPath" scenario).
        if (auditLog) {
          console.log(
            formatAuditLine(
              buildLayoutAuditEntry(auditSessionFor(req), { count: 0, outcome: "denied", reason: "read-only" }),
            ),
          );
        }
      } else {
        const deniedOp: AuditOp | null =
          req.method === "POST" ? "insert" : req.method === "PATCH" ? "update" : req.method === "DELETE" ? "delete" : null;
        // Non-write verbs (e.g. GET) hit this same method-agnostic gate and
        // still get refused 403, but emit NOTHING — a GET is not an attempted
        // mutation (design.md "denial line" decision).
        if (auditLog && deniedOp) {
          const table = decodeURIComponent(path.slice("/api/rows/".length));
          console.log(
            formatAuditLine(
              buildAuditEntry(deniedOp, table, auditSessionFor(req), {
                count: 0,
                outcome: "denied",
                reason: "read-only",
              }),
            ),
          );
        }
      }
      sendJson(res, 403, { error: "Studio is running in read-only mode" });
      return;
    }

    try {
      // ─── Auth routes ───────────────────────────────────────────────────
      if (path === "/api/auth/status" && req.method === "GET") {
        const authRequired = auth !== null;
        const authenticated = auth !== null && auth.verify(req.headers.cookie);
        sendJson(res, 200, {
          authRequired,
          authenticated,
          readOnly,
          queryTimeoutMs,
          queryRowCap,
          environment,
          // Independent of readOnly (design.md decision 12): a read-only
          // Studio with a real schemaPath still reports true — writability
          // and the read-only refusal are two orthogonal, separately
          // user-visible reasons.
          schemaWritable: schemaPath !== undefined,
          // Layout's writability probe (studio-layout-persistence): true
          // only when `schemaPath` is present, since the sidecar path is
          // derived from it — same independence from `readOnly` as above.
          layoutWritable: schemaPath !== undefined,
        });
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

      if (path === "/api/schema/source" && req.method === "GET") {
        // Per-request read + redact when `schemaPath` is set, so an
        // external edit to the file is visible on the very next GET — no
        // startup snapshot is ever served here (design.md decision 5 / SW-2).
        // Falls back to the startup `source` string with no version header
        // when `schemaPath` is absent (decision 13), keeping every existing
        // `startStudio` call site that omits it working unchanged.
        if (schemaPath) {
          let fileBytes: Buffer;
          try {
            fileBytes = await readFile(schemaPath);
          } catch {
            sendJson(res, 404, { error: "Schema file not found" });
            return;
          }
          const { redacted } = splitDatasource(fileBytes.toString("utf-8"));
          const version = createHash("sha256").update(fileBytes).digest("hex").slice(0, 16);
          res.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "X-Indigo-Schema-Version": version,
          });
          res.end(redacted);
          return;
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(redactSource(source));
        return;
      }

      if (path === "/api/schema/source" && req.method === "PUT") {
        const audit: AuditContext = { enabled: auditLog, session: auditSessionFor(req) };
        await handleWriteSchemaSource(schemaPath, req, res, audit);
        return;
      }

      if (path === "/api/schema/layout" && req.method === "GET") {
        await handleReadSchemaLayout(schemaPath, res);
        return;
      }

      if (path === "/api/schema/layout" && req.method === "PUT") {
        const audit: AuditContext = { enabled: auditLog, session: auditSessionFor(req) };
        await handleWriteSchemaLayout(schemaPath, req, res, audit);
        return;
      }

      if ((path === REALTIME_PATH || path === REALTIME_LOG_PATH) && engine && !realtimeAvailable) {
        // 503 with no `event: ready` frame: the SSE client treats any 200 as
        // an open stream, so answering 200 here would make the Studio's live
        // badge report `live` over a stream that can never deliver an event.
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Realtime unavailable" }));
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
        const audit: AuditContext = { enabled: auditLog, session: auditSessionFor(req) };
        await handleInsertRow(path.slice("/api/rows/".length), req, res, resolved, db, audit);
        return;
      }

      if (path.startsWith("/api/rows/") && req.method === "PATCH") {
        const audit: AuditContext = { enabled: auditLog, session: auditSessionFor(req) };
        await handleUpdateRow(path.slice("/api/rows/".length), req, res, resolved, db, audit);
        return;
      }

      if (path.startsWith("/api/rows/") && req.method === "DELETE") {
        const audit: AuditContext = { enabled: auditLog, session: auditSessionFor(req) };
        await handleDeleteRow(path.slice("/api/rows/".length), req, res, resolved, db, audit);
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
  console.log(`  Audit log: ${auditLog ? "enabled" : "disabled"}`);
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
 * Atomic write: temp file + `rename(2)` in the SAME directory as `target`
 * (design.md decision 8 for schema writes; extracted for
 * studio-layout-persistence's D6 so both `PUT /api/schema/source` and
 * `PUT /api/schema/layout` share exactly one implementation — the same
 * "exactly one implementation" discipline as `splitDatasource`).
 * `rename(2)` is atomic only within one filesystem; `os.tmpdir()` routinely
 * crosses devices (EXDEV) on exactly the machines this is meant to protect,
 * so the temp file is created alongside `target` instead.
 *
 * `target`'s existing file mode is copied onto the temp file when a file
 * already exists at `target` (a restrictively-permissioned file must never
 * be widened to the process umask default); when no file exists yet at
 * `target` (the layout sidecar's create path), the temp file is written
 * with the process's default mode instead — there is nothing to copy from.
 *
 * On any failure, the temp file is best-effort unlinked before the error is
 * rethrown to the caller, which maps it to its own route's `500`/`io-error`
 * response.
 */
function atomicWriteFile(target: string, text: string): void {
  const dir = dirname(target);
  const tmpPath = join(dir, `.${basename(target)}.studio-${process.pid}-${randomBytes(3).toString("hex")}.tmp`);
  let mode: number | undefined;
  try {
    mode = statSync(target).mode;
  } catch {
    mode = undefined;
  }
  try {
    writeFileSync(tmpPath, text, mode !== undefined ? { mode } : undefined);
    renameSync(tmpPath, target);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup only */
    }
    throw error;
  }
}

/**
 * `PUT /api/schema/source` — writes a validated `.indigo` schema buffer back
 * to disk, reattaching the real datasource block in place of the buffer's
 * sentinel line. See design.md's route contract table for the full
 * status/reason mapping; this function is the single implementation of
 * every branch in that table, always terminating through
 * `respondSchemaWrite` so a response and its audit line can never separate.
 *
 * `schemaPath === undefined` (no CLI-supplied file, e.g. an embedder or test
 * harness constructed from a bare `source` string) is checked FIRST and
 * answers `404` regardless of buffer content (design.md decision 13 / SW-15)
 * — every other branch below assumes a real file.
 */
async function handleWriteSchemaSource(
  schemaPath: string | undefined,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  audit: AuditContext,
): Promise<void> {
  if (schemaPath === undefined) {
    respondSchemaWrite(
      res,
      404,
      { error: "No schema file is configured for this Studio session." },
      audit,
      buildSchemaAuditEntry(audit.session, { count: 0, outcome: "error", reason: "not-found" }),
    );
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    respondSchemaWrite(
      res,
      400,
      { error: "Invalid JSON body" },
      audit,
      buildSchemaAuditEntry(audit.session, { count: 0, outcome: "error", reason: "invalid-request" }),
    );
    return;
  }

  const submitted = (typeof body === "object" && body !== null ? body : {}) as {
    source?: unknown;
    version?: unknown;
  };
  // A missing or non-string `version` is 400, checked BEFORE the staleness
  // comparison below — never a bypass of it (design.md decision 5 / SW-5).
  if (typeof submitted.source !== "string" || typeof submitted.version !== "string") {
    respondSchemaWrite(
      res,
      400,
      { error: "Request body must be { source: string, version: string }" },
      audit,
      buildSchemaAuditEntry(audit.session, { count: 0, outcome: "error", reason: "invalid-request" }),
    );
    return;
  }
  const submittedSource = submitted.source;
  const submittedVersion = submitted.version;

  let fileBytes: Buffer;
  try {
    fileBytes = await readFile(schemaPath);
  } catch {
    // Also the ENOENT-at-PUT case per design.md's route contract table: the
    // file the client thought it was editing is gone, which is a staleness
    // condition, not a 404 — the route itself is still valid.
    respondSchemaWrite(
      res,
      409,
      { error: "The schema file no longer exists on disk." },
      audit,
      buildSchemaAuditEntry(audit.session, { count: 0, outcome: "error", reason: "stale" }),
    );
    return;
  }

  const currentVersion = createHash("sha256").update(fileBytes).digest("hex").slice(0, 16);
  if (currentVersion !== submittedVersion) {
    respondSchemaWrite(
      res,
      409,
      { error: "The schema file changed on disk since this buffer was fetched." },
      audit,
      buildSchemaAuditEntry(audit.session, { count: 0, outcome: "error", reason: "stale" }),
    );
    return;
  }

  const fileText = fileBytes.toString("utf-8");
  const { block } = splitDatasource(fileText);

  const reattached = reattachDatasource(submittedSource, block);
  if (!reattached.ok) {
    respondSchemaWrite(
      res,
      400,
      { error: reattachErrorMessage(reattached.reason) },
      audit,
      buildSchemaAuditEntry(audit.session, { count: 0, outcome: "error", reason: "redaction-conflict" }),
    );
    return;
  }

  // Diagnostic line translation (design.md decision 7 / SW-10) only applies
  // when a splice actually happened — `block === null` means `reattached.text
  // === submittedSource` verbatim, so reattached-relative and buffer-relative
  // coordinates are already identical.
  let sentinelIdx: number | null = null;
  let blockLineCount = 0;
  if (block !== null) {
    const bufferLines = submittedSource.split("\n");
    const found = bufferLines.findIndex((line) => stripTrailingCR(line) === DATASOURCE_SENTINEL);
    if (found !== -1) {
      sentinelIdx = found;
      blockLineCount = block.split("\n").length;
    }
  }

  let ast;
  try {
    ast = parse(reattached.text);
  } catch (error) {
    if (error instanceof IndigoParseError) {
      const parseErrors =
        sentinelIdx !== null
          ? error.errors.map((e) => translateParseError(e, sentinelIdx as number, blockLineCount))
          : error.errors;
      respondSchemaWrite(
        res,
        422,
        { error: "The submitted schema failed to parse.", parseErrors },
        audit,
        buildSchemaAuditEntry(audit.session, { count: 0, outcome: "error", reason: "schema-invalid" }),
      );
      return;
    }
    throw error;
  }

  const validationErrors = validate(ast);
  if (validationErrors.length > 0) {
    respondSchemaWrite(
      res,
      422,
      { error: "The submitted schema failed validation.", validationErrors },
      audit,
      buildSchemaAuditEntry(audit.session, { count: 0, outcome: "error", reason: "schema-invalid" }),
    );
    return;
  }

  // Atomic write via the shared `atomicWriteFile` helper (design.md decision
  // 8, extracted for D6 — see that function's doc comment).
  try {
    atomicWriteFile(schemaPath, reattached.text);
  } catch (error) {
    respondSchemaWrite(
      res,
      500,
      { error: (error as Error).message },
      audit,
      buildSchemaAuditEntry(audit.session, { count: 0, outcome: "error", reason: "io-error" }),
    );
    return;
  }

  const writtenBytes = Buffer.byteLength(reattached.text, "utf-8");
  const newVersion = createHash("sha256").update(Buffer.from(reattached.text, "utf-8")).digest("hex").slice(0, 16);
  respondSchemaWrite(
    res,
    200,
    { ok: true, version: newVersion },
    audit,
    buildSchemaAuditEntry(audit.session, { count: 1, outcome: "ok", bytes: writtenBytes }),
  );
}

/**
 * One dragged table's persisted position — a plain `{x, y}` pair, kept
 * deliberately minimal (no rotation/scale/etc.) since this is view layout,
 * not schema semantics (design.md D6).
 */
interface LayoutPosition {
  x: number;
  y: number;
}

/**
 * Entry-count cap for a layout payload — generous enough for any realistic
 * schema, small enough to bound a single JSON parse/validate pass.
 */
const MAX_LAYOUT_ENTRIES = 5000;

/**
 * Derives the layout sidecar's path from `schemaPath`, SERVER-SIDE only —
 * design.md D6's no-traversal-surface guarantee: the path is never built
 * from request data. Always `schema.layout.json` in the schema file's own
 * directory, regardless of the schema file's own basename.
 */
function layoutSidecarPath(schemaPath: string): string {
  return join(dirname(schemaPath), "schema.layout.json");
}

/**
 * Validates a submitted `positions` payload: a plain object (not an array,
 * not `null`) whose values are each `{x, y}` with finite numbers, capped at
 * `MAX_LAYOUT_ENTRIES` entries. Used both to accept a `PUT` body and to
 * (defensively) accept whatever is currently on disk before serving a `GET`
 * — corrupt sidecar bytes degrade to `positions: {}` rather than a 500 (see
 * design.md's "corrupt sidecar degrades to formula-seeded positions" note).
 */
function isValidLayoutPositions(value: unknown): value is Record<string, LayoutPosition> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_LAYOUT_ENTRIES) return false;
  for (const [, pos] of entries) {
    if (typeof pos !== "object" || pos === null || Array.isArray(pos)) return false;
    const { x, y } = pos as { x?: unknown; y?: unknown };
    if (typeof x !== "number" || !Number.isFinite(x)) return false;
    if (typeof y !== "number" || !Number.isFinite(y)) return false;
  }
  return true;
}

/**
 * `GET /api/schema/layout` — serves the current sidecar contents plus an
 * opaque `version` (content hash of the sidecar's bytes), or the D6
 * null-sentinel shape `{positions:{}, version:null}` when no sidecar exists
 * yet. `schemaPath === undefined` answers `404` first — there is no sidecar
 * location to read from (mirrors `handleWriteSchemaSource`'s same check).
 *
 * Never gated by read-only mode: `isWriteRoute` excludes `GET`/`HEAD` on
 * this path, so this function is reached directly from the dispatcher, with
 * no audit line — reads are not attempted writes.
 */
async function handleReadSchemaLayout(
  schemaPath: string | undefined,
  res: import("node:http").ServerResponse,
): Promise<void> {
  if (schemaPath === undefined) {
    sendJson(res, 404, { error: "No schema file is configured for this Studio session." });
    return;
  }

  const sidecarPath = layoutSidecarPath(schemaPath);
  let fileBytes: Buffer;
  try {
    fileBytes = await readFile(sidecarPath);
  } catch {
    sendJson(res, 200, { positions: {}, version: null });
    return;
  }

  let positions: Record<string, LayoutPosition> = {};
  try {
    const parsed: unknown = JSON.parse(fileBytes.toString("utf-8"));
    if (isValidLayoutPositions(parsed)) positions = parsed;
  } catch {
    /* corrupt sidecar: serve an empty layout rather than a 500 */
  }

  const version = createHash("sha256").update(fileBytes).digest("hex").slice(0, 16);
  sendJson(res, 200, { positions, version });
}

/**
 * `PUT /api/schema/layout` — writes the submitted `{positions, version}`
 * atomically to the sidecar file, mirroring `handleWriteSchemaSource`'s
 * version/staleness contract (design.md D6), but WITHOUT any parse/validate
 * step — layout is opaque view data, not `.indigo` source.
 *
 * `schemaPath === undefined` is checked FIRST, same as the schema-write
 * route: every other branch below assumes a real sidecar location. Payload
 * shape is validated BEFORE the version comparison (a malformed body is
 * always `400`, never a bypass of staleness checking). `version: null`
 * matches only the "sidecar does not exist yet" sentinel — an EXISTING
 * sidecar always rejects `version: null` with `409`, per D6.
 */
async function handleWriteSchemaLayout(
  schemaPath: string | undefined,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  audit: AuditContext,
): Promise<void> {
  if (schemaPath === undefined) {
    respondLayoutWrite(
      res,
      404,
      { error: "No schema file is configured for this Studio session." },
      audit,
      buildLayoutAuditEntry(audit.session, { count: 0, outcome: "error", reason: "not-found" }),
    );
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    respondLayoutWrite(
      res,
      400,
      { error: "Invalid JSON body" },
      audit,
      buildLayoutAuditEntry(audit.session, { count: 0, outcome: "error", reason: "invalid-request" }),
    );
    return;
  }

  const submitted = (typeof body === "object" && body !== null ? body : {}) as {
    positions?: unknown;
    version?: unknown;
  };
  const versionIsValid = submitted.version === null || typeof submitted.version === "string";
  if (!isValidLayoutPositions(submitted.positions) || !versionIsValid) {
    respondLayoutWrite(
      res,
      400,
      { error: "Request body must be { positions: Record<string, {x:number, y:number}>, version: string | null }" },
      audit,
      buildLayoutAuditEntry(audit.session, { count: 0, outcome: "error", reason: "invalid-request" }),
    );
    return;
  }
  const positions = submitted.positions;
  const submittedVersion = submitted.version as string | null;

  const sidecarPath = layoutSidecarPath(schemaPath);
  let currentVersion: string | null = null;
  try {
    const fileBytes = await readFile(sidecarPath);
    currentVersion = createHash("sha256").update(fileBytes).digest("hex").slice(0, 16);
  } catch {
    // No sidecar on disk yet: the only version that matches is the `null`
    // sentinel (D6) — currentVersion stays `null`.
  }

  if (currentVersion !== submittedVersion) {
    respondLayoutWrite(
      res,
      409,
      { error: "The layout file changed on disk since this buffer was fetched." },
      audit,
      buildLayoutAuditEntry(audit.session, { count: 0, outcome: "error", reason: "stale" }),
    );
    return;
  }

  const text = JSON.stringify(positions);
  try {
    atomicWriteFile(sidecarPath, text);
  } catch (error) {
    respondLayoutWrite(
      res,
      500,
      { error: (error as Error).message },
      audit,
      buildLayoutAuditEntry(audit.session, { count: 0, outcome: "error", reason: "io-error" }),
    );
    return;
  }

  const newVersion = createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex").slice(0, 16);
  respondLayoutWrite(
    res,
    200,
    { version: newVersion },
    audit,
    buildLayoutAuditEntry(audit.session, { count: 1, outcome: "ok" }),
  );
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
  audit: AuditContext,
): Promise<void> {
  const tableName = decodeURIComponent(encodedTableName);
  const entryFor = (rest: Omit<StudioAuditEntry, "ts" | "kind" | "op" | "table" | "session">) =>
    buildAuditEntry("update", tableName, audit.session, rest);

  let body: { pk?: Record<string, unknown>; patch?: Record<string, unknown> };
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    respondWrite(res, 400, { error: "Invalid JSON body" }, audit, entryFor({ count: 0, outcome: "error", reason: "invalid-request" }));
    return;
  }
  const pkInput = body.pk ?? {};
  const patchInput = body.patch ?? {};

  let target: WriteTarget;
  try {
    target = resolveWriteTarget(resolved, tableName, Object.keys(patchInput));
  } catch (error) {
    if (error instanceof WriteTargetError) {
      respondWrite(res, 400, { error: error.message }, audit, entryFor({ count: 0, outcome: "error", reason: "invalid-request" }));
      return;
    }
    throw error;
  }

  const missingPk = target.pk.filter((c) => !(c.name in pkInput));
  if (missingPk.length > 0) {
    respondWrite(
      res,
      400,
      { error: `Missing primary key value(s): ${missingPk.map((c) => c.name).join(", ")}` },
      audit,
      entryFor({ count: 0, outcome: "error", reason: "invalid-request" }),
    );
    return;
  }
  if (target.columns.length === 0) {
    respondWrite(res, 400, { error: "No columns to update" }, audit, entryFor({ count: 0, outcome: "error", reason: "invalid-request" }));
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

  const pk = Object.fromEntries(target.pk.map((c) => [c.name, formatPkValue(pkInput[c.name])]));
  const columns = target.columns.map((c) => c.name);

  try {
    const result = await db.writable((query) => query(sql, [...setParams, ...whereParams]));
    if (result.rows.length === 0) {
      respondWrite(
        res,
        404,
        { error: "No row matched the given primary key" },
        audit,
        entryFor({ count: 0, outcome: "error", reason: "not-found", pk }),
      );
      return;
    }
    respondWrite(res, 200, { row: result.rows[0] }, audit, entryFor({ count: 1, outcome: "ok", pk, columns }));
  } catch (error) {
    respondWrite(
      res,
      400,
      { error: (error as Error).message },
      audit,
      entryFor({ count: 0, outcome: "error", reason: "db-error", ...(extractSqlState(error) ? { code: extractSqlState(error) } : {}) }),
    );
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
  audit: AuditContext,
): Promise<void> {
  const tableName = decodeURIComponent(encodedTableName);
  const entryFor = (rest: Omit<StudioAuditEntry, "ts" | "kind" | "op" | "table" | "session">) =>
    buildAuditEntry("insert", tableName, audit.session, rest);

  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    respondWrite(res, 400, { error: "Invalid JSON body" }, audit, entryFor({ count: 0, outcome: "error", reason: "invalid-request" }));
    return;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    respondWrite(
      res,
      400,
      { error: "Request body must be a JSON object of column values" },
      audit,
      entryFor({ count: 0, outcome: "error", reason: "invalid-request" }),
    );
    return;
  }
  const valuesInput = body as Record<string, unknown>;

  let target: WriteTarget;
  try {
    target = resolveWriteTarget(resolved, tableName, Object.keys(valuesInput));
  } catch (error) {
    if (error instanceof WriteTargetError) {
      respondWrite(res, 400, { error: error.message }, audit, entryFor({ count: 0, outcome: "error", reason: "invalid-request" }));
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

  const columns = target.columns.map((c) => c.name);

  try {
    const result = await db.writable((query) => query(sql, params));
    // The primary key is server-generated on INSERT — the request cannot
    // supply it — so it is read back from the returned row, never the body.
    const row = result.rows[0] as Record<string, unknown>;
    const pk = Object.fromEntries(target.pk.map((c) => [c.name, formatPkValue(row[c.name])]));
    respondWrite(res, 201, { row }, audit, entryFor({ count: 1, outcome: "ok", pk, columns }));
  } catch (error) {
    respondWrite(
      res,
      400,
      { error: (error as Error).message },
      audit,
      entryFor({ count: 0, outcome: "error", reason: "db-error", ...(extractSqlState(error) ? { code: extractSqlState(error) } : {}) }),
    );
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
  audit: AuditContext,
): Promise<void> {
  const tableName = decodeURIComponent(encodedTableName);
  const entryFor = (rest: Omit<StudioAuditEntry, "ts" | "kind" | "op" | "table" | "session">) =>
    buildAuditEntry("delete", tableName, audit.session, rest);

  let body: { pk?: Record<string, unknown> };
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    respondWrite(res, 400, { error: "Invalid JSON body" }, audit, entryFor({ count: 0, outcome: "error", reason: "invalid-request" }));
    return;
  }
  const pkInput = body.pk ?? {};

  let target: WriteTarget;
  try {
    target = resolveWriteTarget(resolved, tableName, []);
  } catch (error) {
    if (error instanceof WriteTargetError) {
      respondWrite(res, 400, { error: error.message }, audit, entryFor({ count: 0, outcome: "error", reason: "invalid-request" }));
      return;
    }
    throw error;
  }

  const missingPk = target.pk.filter((c) => !(c.name in pkInput));
  if (missingPk.length > 0) {
    respondWrite(
      res,
      400,
      { error: `Missing primary key value(s): ${missingPk.map((c) => c.name).join(", ")}` },
      audit,
      entryFor({ count: 0, outcome: "error", reason: "invalid-request" }),
    );
    return;
  }

  const whereParams = target.pk.map((c) => pkInput[c.name]);
  const whereClauses = target.pk.map((c, i) => `"${c.dbName}" = $${i + 1}`);
  const sql = `DELETE FROM ${target.quotedTable} WHERE ${whereClauses.join(" AND ")}`;
  const pk = Object.fromEntries(target.pk.map((c) => [c.name, formatPkValue(pkInput[c.name])]));

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
      respondWrite(
        res,
        404,
        { error: "No row matched the given primary key" },
        audit,
        entryFor({ count: 0, outcome: "error", reason: "not-found", pk }),
      );
      return;
    }
    respondWrite(res, 200, { ok: true }, audit, entryFor({ count: 1, outcome: "ok", pk }));
  } catch (error) {
    respondWrite(
      res,
      400,
      { error: (error as Error).message },
      audit,
      entryFor({ count: 0, outcome: "error", reason: "db-error", ...(extractSqlState(error) ? { code: extractSqlState(error) } : {}) }),
    );
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
