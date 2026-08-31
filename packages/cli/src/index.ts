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
  .action(async (options: { schema: string; port: string }) => {
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
    const engine = new RealtimeEngine({ connectionString, schema: resolved });
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

    await engine.start();
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
      "Defaults to INDIGODB_STUDIO_READONLY (exact match \"1\" or \"true\").",
  )
  .action(async (options: { schema: string; port: string; host: string; open: boolean; readOnly?: boolean }) => {
    loadEnv();
    const password = process.env.INDIGODB_STUDIO_PASSWORD;
    assertStudioAuthForHost(options.host, password);
    // Resolved here, after `loadEnv()`, deliberately NOT as a commander
    // option default like `--host` above: `--host`'s default is evaluated
    // at module load, before `loadEnv()` runs, so a `.env` value never
    // reaches it — acceptable for a bind address that fails loudly, but not
    // for a guardrail that would otherwise fail open and silently.
    // `resolveStudioReadOnly` (packages/cli/src/util.ts) is extracted so
    // this exact resolution — `--read-only` OR exact-match
    // `INDIGODB_STUDIO_READONLY` — is unit testable independent of
    // commander's parsed options.
    const readOnly = resolveStudioReadOnly(options.readOnly, process.env.INDIGODB_STUDIO_READONLY);
    const { resolved, path: schemaPath } = loadSchema(options.schema);
    const connectionString = resolveConnectionString(resolved);
    await startStudio({
      resolved,
      source: readFileSync(schemaPath, "utf-8"),
      connectionString,
      port: Number(options.port),
      host: options.host,
      open: options.open,
      password,
      readOnly,
    });
  });

program.parseAsync();
