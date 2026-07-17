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
import { renderPushSql } from "@indigodb/migrator";
import {
  loadEnv,
  loadSchema,
  resolveConnectionString,
  resolveOutputPath,
} from "./util.js";
import { SCHEMA_TEMPLATE, ENV_TEMPLATE } from "./template.js";
import { startStudio } from "./studio-server.js";
import { migrateDev, migrateDeploy, migrateStatus } from "./migrate-runner.js";

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
    const sql = renderPushSql(resolved);

    if (options.print) {
      console.log(sql);
      return;
    }

    const connectionString = resolveConnectionString(resolved);
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
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

// ─── migrate ─────────────────────────────────────────────────────────────────
// Versioned migrations with history (like `prisma migrate`), vs. the historyless
// `db push`. `dev` creates+applies; `deploy` applies pending files; `status` lists.
const migrate = program.command("migrate").description("Versioned schema migrations (with history).");
migrate
  .command("dev")
  .description("Create and apply a new migration from schema changes.")
  .requiredOption("-n, --name <name>", "Migration name")
  .option("-s, --schema <path>", "Schema file path", "schema.indigo")
  .action(async (options: { name: string; schema: string }) => {
    loadEnv();
    const { resolved } = loadSchema(options.schema);
    const connectionString = resolveConnectionString(resolved);
    await migrateDev({ resolved, name: options.name, connectionString });
  });
migrate
  .command("deploy")
  .description("Apply all pending migrations (CI/production).")
  .option("-s, --schema <path>", "Schema file path", "schema.indigo")
  .action(async (options: { schema: string }) => {
    loadEnv();
    const { resolved } = loadSchema(options.schema);
    await migrateDeploy(resolveConnectionString(resolved));
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

// ─── studio ──────────────────────────────────────────────────────────────────
// The Studio is the single home for everything visual: the ER diagram + editor,
// the data/table browser, the SQL query console, and the documentation view.
program
  .command("studio")
  .description("Launch the IndigoDB Studio (ER diagram, data browser, docs, queries).")
  .option("-s, --schema <path>", "Schema file path", "schema.indigo")
  .option("-p, --port <port>", "Port", "5555")
  .option("--no-open", "Do not open the browser automatically")
  .action(async (options: { schema: string; port: string; open: boolean }) => {
    loadEnv();
    const { resolved, path: schemaPath } = loadSchema(options.schema);
    const connectionString = resolveConnectionString(resolved);
    await startStudio({
      resolved,
      source: readFileSync(schemaPath, "utf-8"),
      connectionString,
      port: Number(options.port),
      open: options.open,
    });
  });

program.parseAsync();
