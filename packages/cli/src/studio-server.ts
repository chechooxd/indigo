/**
 * @indigodb/cli — Studio server
 *
 * Serves the compiled IndigoDB Studio SPA plus a small JSON API backed by the
 * user's PostgreSQL database. This is what wires the visual tool to the real
 * schema and data (replacing the SPA's former mock data).
 *
 * API:
 *   GET  /api/schema          → the ResolvedSchema as JSON
 *   GET  /api/tables/:name    → up to 100 rows from a table
 *   POST /api/query { sql }   → runs a single read-only SELECT
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import pg from "pg";
import type { ResolvedSchema } from "@indigodb/core";
import { RealtimeEngine, REALTIME_PATH, REALTIME_LOG_PATH } from "@indigodb/realtime";

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
  /** Runs `sql` on the shared (non-read-only) connection — used for metadata reads. */
  query(sql: string): Promise<StudioQueryResult>;
  /**
   * Runs `fn` inside a dedicated, read-only transaction: `BEGIN; SET
   * TRANSACTION READ ONLY; ...; ROLLBACK` (always rolled back, never
   * committed — nothing this path runs is meant to persist). Postgres
   * itself rejects any write, including one disguised inside a CTE, so
   * this is the actual enforcement boundary — not a string heuristic.
   */
  readOnly<T>(fn: (query: StudioDb["query"]) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Production `StudioDb`: `pg.Pool` for metadata reads, plus a small dedicated
 * pool (`max: 4`) for read-only work. Kept separate from the shared pool so a
 * hung read-only query never starves `/api/schema` or `/api/tables/:name`. */
function createPgDb(connectionString: string): StudioDb {
  const pool = new pg.Pool({ connectionString });
  const readOnlyPool = new pg.Pool({ connectionString, max: 4 });

  function toResult(result: { rows: unknown[]; fields: { name: string }[] }): StudioQueryResult {
    return { rows: result.rows, fields: result.fields.map((f) => ({ name: f.name })) };
  }

  return {
    async query(sql) {
      return toResult(await pool.query(sql));
    },
    async readOnly(fn) {
      const client = await readOnlyPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET TRANSACTION READ ONLY");
        return await fn(async (sql) => toResult(await client.query(sql)));
      } finally {
        // Always ROLLBACK, never COMMIT: this path exists to run read-only
        // work, and a failed ROLLBACK here must not surface as the route's
        // error (the query's own result/error already reflects the outcome).
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    },
    async close() {
      await pool.end();
      await readOnlyPool.end();
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

export async function startStudio(
  options: StudioOptions,
): Promise<{ port: number; host: string; close(): Promise<void> }> {
  const { resolved, source, connectionString, port, open = true } = options;
  const host = options.host ?? "127.0.0.1";
  const db = options.db ?? createPgDb(connectionString);
  const distDir = resolveStudioDist();
  const publicSchema = redactSchema(resolved);
  const publicSource = redactSource(source);

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

    try {
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
        const table = resolved.tables.find((t) => t.name === name || t.dbName === name);
        if (!table) {
          sendJson(res, 404, { error: `Unknown table: ${name}` });
          return;
        }
        // Alias physical columns back to schema field names (e.g. created_at → createdAt)
        // so the rows match the column metadata the UI renders.
        const selectList = table.columns
          .map((c) => `"${c.dbName}" AS "${c.name}"`)
          .join(", ");
        const result = await db.readOnly((query) =>
          query(`SELECT ${selectList} FROM "${table.dbName}" LIMIT 100`),
        );
        sendJson(res, 200, { columns: table.columns.map((c) => c.name), rows: result.rows });
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
          const result = await db.readOnly((query) => query(sql));
          sendJson(res, 200, { columns: result.fields.map((f) => f.name), rows: result.rows });
        } catch (error) {
          sendJson(res, 400, { error: (error as Error).message });
        }
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
