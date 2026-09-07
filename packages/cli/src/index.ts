#!/usr/bin/env node

/**
 * @indigodb/cli
 *
 * Command-line interface for IndigoDB: scaffold a schema, sync the database
 * (`db push`), generate the typed client, generate documentation, and launch
 * the visual Studio.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { Command } from "commander";
import pg from "pg";
import { generateClient } from "@indigodb/generator";
import { renderPushSql, renderReplicationPreSql, introspectResolvedSchema } from "@indigodb/migrator";
import {
  loadEnv,
  loadSchema,
  resolveConnectionString,
  resolveBareConnectionString,
  resolveOutputPath,
  writePulledSchema,
  assertLogicalReplication,
  assertRealtimeSecretPresent,
  assertStudioAuthForHost,
  resolveStudioReadOnly,
  resolveQueryTimeoutMs,
  resolveQueryRowCap,
  resolveStudioEnvironment,
  resolveStudioAuditLog,
  resolveAllowedOrigins,
} from "./util.js";
import { SCHEMA_TEMPLATE, ENV_TEMPLATE } from "./template.js";
import { startStudio } from "./studio-server.js";
import { migrateDev, migrateDeploy, migrateStatus, migrateResolve } from "./migrate-runner.js";
import { createServer } from "node:http";
import { RealtimeEngine, REALTIME_PATH, REALTIME_LOG_PATH } from "@indigodb/realtime";

const program = new Command();

program
  .name("indigodb")
  .description(
    "IndigoDB — schema-first ORM with ER diagrams and docs, all from one .indigo language.",
  )
  .version("0.0.1");

// ─── init ──────────────────────────────────────────────────────────────────
program
  .command("init")
  .description("Scaffold a schema.indigo and .env in the current directory.")
  .option("-s, --schema <path>", "Schema file path", "schema.indigo")
  .action((options: { schema: string }) => {
    const schemaPath = resolvePath(options.schema);
    if (existsSync(schemaPath)) {
      console.error(`❌ ${schemaPath} already exists. Aborting.`);
      process.exit(1);
    }
    writeFileSync(schemaPath, SCHEMA_TEMPLATE);
    const envPath = resolvePath(".env");
    const createdEnv = !existsSync(envPath);
    if (createdEnv) writeFileSync(envPath, ENV_TEMPLATE);

    console.log("✅ IndigoDB initialized.");
    console.log(`   Created ${schemaPath}`);
    if (createdEnv) console.log(`   Created .env (set your DATABASE_URL)`);
    console.log();
    console.log("   Next: edit schema.indigo, then run `indigodb db push`.");
  });

// ─── generate ──────────────────────────────────────────────────────────────
program
  .command("generate")
  .description("Generate the typed TypeScript client from your schema.")
  .option("-s, --schema <path>", "Schema file path", "schema.indigo")
  .option("-o, --output <path>", "Output file for the generated client")
  .action((options: { schema: string; output?: string }) => {
    const { ast, resolved } = loadSchema(options.schema);
    const outPath = resolveOutputPath(ast, options.output);
    const code = generateClient(resolved);

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, code);

    console.log("✅ Client generated.");
    console.log(`   ${outPath}`);
    console.log(`   ${resolved.tables.length} models, ${resolved.enums.length} enums.`);
  });

// ─── db push ─────────────────────────────────────────────────────────────────
const db = program.command("db").description("Database commands.");
db
  .command("push")
  .description("Sync the database to your schema (idempotent, no migration history).")
  .option("-s, --schema <path>", "Schema file path", "schema.indigo")
  .option("--print", "Print the SQL instead of executing it")
  .action(async (options: { schema: string; print?: boolean }) => {
    loadEnv();
    const { resolved } = loadSchema(options.schema);
    const hasRealtime = resolved.tables.some((t) => t.realtime);
    // Two-phase: the pre-transaction slot block runs BEFORE the main script
    // (design decision 2) — Postgres refuses to create a replication slot
    // inside a transaction that already performed writes, and `db push`
    // sends `sql` as one implicit transaction.
    const preSql = hasRealtime ? renderReplicationPreSql(resolved) : [];
    const sql = renderPushSql(resolved);

    if (options.print) {
      // `--print` stays a faithful transcript of what would execute: the
      // slot block first, then the main script — never folded together.
      for (const stmt of preSql) console.log(stmt + "\n");
      console.log(sql);
      return;
    }

    const connectionString = resolveConnectionString(resolved);
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      if (hasRealtime) await assertLogicalReplication(client);
      for (const stmt of preSql) await client.query(stmt);
      await client.query(sql);
      console.log("✅ Database synced.");
      console.log(`   ${resolved.tables.length} tables, ${resolved.enums.length} enums.`);
    } catch (error) {
      console.error("❌ db push failed:", (error as Error).message);
      process.exitCode = 1;
    } finally {
      await client.end();
    }
  });

// ─── db pull ─────────────────────────────────────────────────────────────────
db
  .command("pull")
  .description("Introspect the database and write/print an .indigo schema.")
  .option("-s, --schema <path>", "Schema file path", "./schema.indigo")
  .option("--url <connectionString>", "Database connection string (overrides DATABASE_URL)")
  .option("--db-schema <name>", "Catalog schema to introspect", "public")
  .option("--print", "Print the schema to stdout instead of writing it")
  .action(
    async (options: { schema: string; url?: string; dbSchema: string; print?: boolean }) => {
      loadEnv();
      const connectionString = resolveBareConnectionString({ url: options.url });
      const client = new pg.Client({ connectionString });
      try {
        await client.connect();
        const resolved = await introspectResolvedSchema(
          (sql, params) => client.query(sql, params),
          { schema: options.dbSchema },
        );
        writePulledSchema(resolved, { schema: options.schema, print: options.print });
      } catch (error) {
        console.error("❌ db pull failed:", (error as Error).message);
        process.exitCode = 1;
      } finally {
        await client.end();
      }
    },
  );

// ─── migrate ─────────────────────────────────────────────────────────────────
// Versioned migrations with history (like `prisma migrate`), vs. the historyless
// `db push`. `dev` creates+applies; `deploy` applies pending files; `status` lists.
const migrate = program.command("migrate").description("Versioned schema migrations (with history).");
migrate
  .command("dev")
  .description("Create and apply a new migration from schema changes.")
  .requiredOption("-n, --name <name>", "Migration name")
  .option("-s, --schema <path>", "Schema file path", "schema.indigo")
  .option("--force", "Apply destructive (requires-force) statements without refusing")
  .option("--create-only", "Write the migration file without applying it")
  .action(async (options: { name: string; schema: string; force?: boolean; createOnly?: boolean }) => {
    loadEnv();
    const { resolved } = loadSchema(options.schema);
    const connectionString = resolveConnectionString(resolved);
    await migrateDev({
      resolved,
      name: options.name,
      connectionString,
      force: options.force,
      createOnly: options.createOnly,
    });
  });
migrate
  .command("deploy")
  .description("Apply all pending migrations (CI/production).")
  .option("-s, --schema <path>", "Schema file path", "schema.indigo")
  .option("--force", "Apply destructive (requires-force) statements without refusing")
  .action(async (options: { schema: string; force?: boolean }) => {
    loadEnv();
    const { resolved } = loadSchema(options.schema);
    const connectionString = resolveConnectionString(resolved);
    if (resolved.tables.some((t) => t.realtime)) {
      const client = new pg.Client({ connectionString });
      try {
        await client.connect();
        await assertLogicalReplication(client);
      } finally {
        await client.end();
      }
    }
    await migrateDeploy(connectionString, { force: options.force });
  });
migrate
  .command("status")
  .description("Show applied and pending migrations.")
  .option("-s, --schema <path>", "Schema file path", "schema.indigo")
  .action(async (options: { schema: string }) => {
    loadEnv();
    const { resolved } = loadSchema(options.schema);
    await migrateStatus(resolveConnectionString(resolved));
  });
migrate
  .command("resolve")
  .description("Reconcile migration history without running SQL.")
  .option("-s, --schema <path>", "Schema file path", "schema.indigo")
  .option("--applied <id>", "Record <id> as applied without executing its SQL")
  .option("--rolled-back <id>", "Remove <id>'s recorded row from history")
  .action(async (options: { schema: string; applied?: string; rolledBack?: string }) => {
    loadEnv();
    const { resolved } = loadSchema(options.schema);
    await migrateResolve({
      connectionString: resolveConnectionString(resolved),
      applied: options.applied,
      rolledBack: options.rolledBack,
    });
  });

// ─── realtime ────────────────────────────────────────────────────────────────
// Standalone realtime daemon: LISTEN on the notify channel and fan events out
// to SSE subscribers. The same engine is embedded in `indigodb studio`.
program
  .command("realtime")
  .description("Serve realtime change events (SSE) for @@realtime tables.")
  .option("-s, --schema <path>", "Schema file path", "schema.indigo")
  .option("-p, --port <port>", "Port", "4477")
  .option(
    "--allow-origin <origin>",
    "Allowed CORS origin for the SSE and log routes (repeatable). Merges with " +
      "INDIGODB_REALTIME_ALLOWED_ORIGINS (comma-separated). Omitted/empty ⇒ closed: no " +
      "cross-origin browser access at all — a request with no Origin header (curl, an " +
      "operator proxy) is always allowed regardless.",
    (value: string, previous: string[]) => previous.concat([value]),
    [] as string[],
  )
  .action(async (options: { schema: string; port: string; allowOrigin: string[] }) => {
    loadEnv();
    const { resolved } = loadSchema(options.schema);
    if (!resolved.tables.some((t) => t.realtime)) {
      console.error("❌ No @@realtime tables in the schema. Mark a Table with @@realtime first.");
      process.exit(1);
    }
    // Startup preflight (PR B, narrowed from PR A's unconditional check per
    // spec): the daemon now serves the signed-handle log endpoint
    // (REALTIME_LOG_PATH), but a schema with no @@realtime+@@allow model
    // never mints or verifies a handle at all — the secret is only required
    // when it will actually be used.
    assertRealtimeSecretPresent(resolved, process.env.INDIGODB_REALTIME_SECRET);
    const connectionString = resolveConnectionString(resolved);
    const allowedOrigins = resolveAllowedOrigins(options.allowOrigin, process.env.INDIGODB_REALTIME_ALLOWED_ORIGINS);
    const engine = new RealtimeEngine({ connectionString, schema: resolved, allowedOrigins });
    const port = Number(options.port);

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname === REALTIME_PATH) {
        engine.handleRequest(req, res);
        return;
      }
      if (url.pathname === REALTIME_LOG_PATH) {
        void engine.handleLogRequest(req, res);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    try {
      await engine.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`❌ Realtime failed to start: ${message}`);
      process.exit(1);
    }
    await new Promise<void>((resolve) => server.listen(port, resolve));

    console.log();
    console.log("  ⚡ IndigoDB Realtime");
    console.log("  ─────────────────────────────");
    console.log(`  Tables: ${engine.models.join(", ")}`);
    console.log(`  SSE:    http://localhost:${port}${REALTIME_PATH}?tables=${engine.models[0]}`);
    console.log();
    console.log("  Press Ctrl+C to stop.");

    process.on("SIGINT", () => {
      void engine.stop().then(() => {
        server.close();
        process.exit(0);
      });
    });
  });

// ─── studio ──────────────────────────────────────────────────────────────────
// The Studio is the single home for everything visual: the ER diagram + editor,
// the data/table browser, the SQL query console, and the documentation view.
program
  .command("studio")
  .description("Launch the IndigoDB Studio (ER diagram, data browser, docs, queries).")
  .option("-s, --schema <path>", "Schema file path", "schema.indigo")
  .option("-p, --port <port>", "Port", "5555")
  .option(
    "--host <host>",
    "Bind host. SECURITY: defaults to 127.0.0.1 (loopback only); passing anything " +
      "else (e.g. 0.0.0.0) makes the server — including the SQL query console — " +
      "reachable from other hosts on the network, and relaxes Host-header " +
      "validation to a port-only match. Only do this on a trusted network.",
    process.env.INDIGODB_STUDIO_HOST ?? "127.0.0.1",
  )
  .option("--no-open", "Do not open the browser automatically")
  .option(
    "--read-only",
    "Refuse every write to the Studio API (INSERT/UPDATE/DELETE), regardless of session auth. " +
      "Defaults to INDIGODB_STUDIO_READONLY (exact match \"1\", \"0\", \"true\", or \"false\"; " +
      "any other value is rejected and the process exits 1 before binding). This flag only " +
      "ever adds read-only mode — it never suppresses a malformed env value.",
  )
  .option(
    "--query-timeout <ms>",
    "Statement timeout (ms) applied to /api/query and /api/tables/:name. " +
      "0 disables it. Defaults to INDIGODB_STUDIO_QUERY_TIMEOUT_MS, or 30000.",
  )
  .option(
    "--query-row-cap <n>",
    "Row cap applied to /api/query's result set. 0 disables it. " +
      "Defaults to INDIGODB_STUDIO_QUERY_ROW_CAP, or 1000.",
  )
  .option(
    "--env <name>",
    "Informational environment label (e.g. development/staging/production, or any custom " +
      "name) shown in the Studio badge and status probe. Purely informational — gates " +
      "nothing. Defaults to INDIGODB_ENV, or unset.",
  )
  .option(
    "--allow-origin <origin>",
    "Allowed CORS origin for the embedded realtime SSE/log routes (repeatable). Merges " +
      "with INDIGODB_REALTIME_ALLOWED_ORIGINS (comma-separated). Only relevant when the " +
      "schema has @@realtime tables. Omitted/empty ⇒ closed: no cross-origin browser " +
      "access at all — a request with no Origin header is always allowed regardless, " +
      "which is why the Studio's own embedded engine needs no configuration here.",
    (value: string, previous: string[]) => previous.concat([value]),
    [] as string[],
  )
  // Declared in THIS order — `--audit-log` before `--no-audit-log` —
  // deliberately: declaring the negated flag first would make commander
  // force a `true` default, which collapses the flag>env>default tri-state
  // `resolveStudioAuditLog` needs (its option arg must be able to observe
  // "neither flag was passed" as `undefined`). Reordering these silently
  // breaks that precedence — see design.md's "env throws on anything
  // ambiguous, default on" decision.
  .option(
    "--audit-log",
    "Log each attempted row write to stdout (column names, never values; a session " +
      "correlator, never an identity). Enabled by default.",
  )
  .option("--no-audit-log", "Disable the stdout audit log.")
  .action(
    async (options: {
      schema: string;
      port: string;
      host: string;
      open: boolean;
      readOnly?: boolean;
      queryTimeout?: string;
      queryRowCap?: string;
      env?: string;
      auditLog?: boolean;
      allowOrigin: string[];
    }) => {
      loadEnv();
      const password = process.env.INDIGODB_STUDIO_PASSWORD;
      assertStudioAuthForHost(options.host, password);
      // Resolved here, after `loadEnv()`, deliberately NOT as a commander
      // option default like `--host` above: `--host`'s default is evaluated
      // at module load, before `loadEnv()` runs, so a `.env` value never
      // reaches it — acceptable for a bind address that fails loudly, but not
      // for a guardrail that would otherwise fail open and silently.
      //
      // `resolveStudioReadOnly` (packages/cli/src/util.ts) now THROWS on a
      // malformed `INDIGODB_STUDIO_READONLY` (never `process.exit`), so it
      // is resolved inside the same try/catch as the guardrail resolvers
      // below rather than before it — a typo in the env var must exit 1
      // before binding, exactly like a malformed query-timeout/row-cap
      // value, instead of crashing uncaught or silently resolving to `false`.
      //
      // `resolveQueryTimeoutMs`/`resolveQueryRowCap` THROW (never
      // `process.exit`) on a present-but-malformed value — caught here so
      // the process exits 1 before binding, per the spec's "startup
      // resolution" requirement.
      // `resolveStudioEnvironment` (util.ts) is the same "pure, throws" shape
      // as the guardrail resolvers above — resolved here, after `loadEnv()`,
      // never as a commander option default (design.md: the `--read-only`
      // pattern, not `--host`'s module-load default).
      let readOnly: boolean;
      let queryTimeoutMs: number;
      let queryRowCap: number;
      let environment: string | undefined;
      let auditLog: boolean;
      try {
        readOnly = resolveStudioReadOnly(options.readOnly, process.env.INDIGODB_STUDIO_READONLY);
        queryTimeoutMs = resolveQueryTimeoutMs(options.queryTimeout, process.env.INDIGODB_STUDIO_QUERY_TIMEOUT_MS);
        queryRowCap = resolveQueryRowCap(options.queryRowCap, process.env.INDIGODB_STUDIO_QUERY_ROW_CAP);
        environment = resolveStudioEnvironment(options.env, process.env.INDIGODB_ENV);
        auditLog = resolveStudioAuditLog(options.auditLog, process.env.INDIGODB_STUDIO_AUDIT_LOG);
      } catch (error) {
        console.error(`❌ ${(error as Error).message}`);
        process.exit(1);
      }

      // D7: pure, never throws — resolved outside the try/catch above,
      // unlike the guardrail resolvers, which all validate and can fail.
      const allowedOrigins = resolveAllowedOrigins(
        options.allowOrigin,
        process.env.INDIGODB_REALTIME_ALLOWED_ORIGINS,
      );

      const { resolved, path: schemaPath } = loadSchema(options.schema);
      const connectionString = resolveConnectionString(resolved);
      await startStudio({
        resolved,
        source: readFileSync(schemaPath, "utf-8"),
        schemaPath,
        connectionString,
        port: Number(options.port),
        host: options.host,
        open: options.open,
        password,
        readOnly,
        queryTimeoutMs,
        queryRowCap,
        environment,
        auditLog,
        allowedOrigins,
      });
    },
  );

program.parseAsync();
