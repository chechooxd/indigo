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
import { RealtimeEngine, REALTIME_PATH } from "@indigodb/realtime";

export interface StudioOptions {
  resolved: ResolvedSchema;
  /** Raw `.indigo` source text, served for the editor. */
  source: string;
  connectionString: string;
  port: number;
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

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

export async function startStudio(
  options: StudioOptions,
): Promise<{ port: number; close(): Promise<void> }> {
  const { resolved, source, connectionString, port, open = true } = options;
  const db = options.db ?? createPgDb(connectionString);
  const distDir = resolveStudioDist();

  // Embedded realtime engine: with @@realtime tables the Studio gets live
  // change events on the same port, no separate `indigodb realtime` needed.
  const engine = resolved.tables.some((t) => t.realtime)
    ? new RealtimeEngine({ connectionString, schema: resolved })
    : null;
  if (engine) await engine.start();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;

    try {
      // ─── API ───────────────────────────────────────────────────────────
      if (path === "/api/schema") {
        sendJson(res, 200, resolved);
        return;
      }

      if (path === "/api/schema/source") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(source);
        return;
      }

      if (path === REALTIME_PATH && engine) {
        engine.handleRequest(req, res);
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

  const actualPort = await new Promise<number>((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : port);
    });
  });

  console.log();
  console.log("  🎨 IndigoDB Studio");
  console.log("  ─────────────────────────────");
  console.log(`  Tables: ${resolved.tables.length}`);
  console.log(`  URL:    http://localhost:${actualPort}`);
  if (!distDir) {
    console.log(`  ⚠  Studio UI build not found — serving API only.`);
  }
  console.log();
  console.log("  Press Ctrl+C to stop.");

  if (open) openBrowser(`http://localhost:${actualPort}`);

  return {
    port: actualPort,
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
