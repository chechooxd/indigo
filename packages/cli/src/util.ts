/**
 * @indigodb/cli — Shared helpers
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { parse, resolve, IndigoParseError, validate, printSchema } from "@indigodb/core";
import type { Schema, ResolvedSchema } from "@indigodb/core";

/**
 * Minimal query surface `assertLogicalReplication` needs — satisfied by
 * `pg.Client`, so callers never construct a bespoke shape.
 */
export interface ReplicationPreflightClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** Minimal `.env` loader (no dependency). Does not override existing env vars. */
export function loadEnv(cwd = process.cwd()): void {
  const envPath = resolvePath(cwd, ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export interface LoadedSchema {
  ast: Schema;
  resolved: ResolvedSchema;
  path: string;
}

/** Reads, parses and resolves an `.indigo` schema file. Exits on error. */
export function loadSchema(schemaPath: string): LoadedSchema {
  const fullPath = resolvePath(schemaPath);
  if (!existsSync(fullPath)) {
    console.error(`❌ Schema file not found: ${fullPath}`);
    console.error(`   Run \`indigodb init\` to create one.`);
    process.exit(1);
  }

  let ast: Schema;
  try {
    ast = parse(readFileSync(fullPath, "utf-8"));
  } catch (error) {
    if (error instanceof IndigoParseError) {
      console.error(`❌ Failed to parse ${fullPath}:`);
      for (const e of error.errors) {
        console.error(`   ${e.line ? `(line ${e.line}) ` : ""}${e.message}`);
      }
    } else {
      console.error(`❌ Failed to parse ${fullPath}:`, error);
    }
    process.exit(1);
  }

  const errors = validate(ast);
  if (errors.length > 0) {
    console.error(`❌ Schema validation failed:`);
    for (const e of errors) {
      const loc = [e.model, e.field].filter(Boolean).join(".");
      console.error(`   ${loc ? `[${loc}] ` : ""}${e.message}`);
    }
    process.exit(1);
  }

  return { ast, resolved: resolve(ast), path: fullPath };
}

/** Resolves the datasource connection string (literal or `env("VAR")`). */
export function resolveConnectionString(resolved: ResolvedSchema): string {
  const url = resolved.datasource?.url;
  if (!url) {
    console.error(`❌ No datasource block with a url in the schema.`);
    process.exit(1);
  }
  if (url.kind === "string") return url.value;
  if (url.kind === "function" && url.name === "env") {
    const arg = url.args[0];
    const varName = arg && arg.kind === "string" ? arg.value : undefined;
    const value = varName ? process.env[varName] : undefined;
    if (!value) {
      console.error(`❌ Environment variable ${varName} is not set (needed for datasource url).`);
      console.error(`   Add it to your .env file.`);
      process.exit(1);
    }
    return value;
  }
  console.error(`❌ Unsupported datasource url form.`);
  process.exit(1);
}

/**
 * Resolves a database connection string for commands that do NOT depend on
 * a pre-existing schema file (e.g. `db pull`, whose output IS the schema
 * file). Unlike `resolveConnectionString`, this never reads
 * `resolved.datasource.url` — there is no resolved schema yet.
 *
 * Precedence: `--url` flag wins over `DATABASE_URL`. If neither resolves,
 * errors naming both missing inputs and exits 1.
 */
export function resolveBareConnectionString(options: { url?: string }): string {
  if (options.url) return options.url;
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;
  console.error(`❌ No connection string. Pass --url or set DATABASE_URL.`);
  process.exit(1);
}

/**
 * Preflight for `db push`/`migrate deploy` against a schema carrying at
 * least one `@@realtime` table — checked ONLY then, and BEFORE any
 * replication DDL is attempted (design's "Interfaces" section). Two checks,
 * both read-only (`SHOW`, `pg_roles` — never `ALTER SYSTEM`/`ALTER ROLE`,
 * threat matrix "privilege escalation via preflight"):
 *
 * 1. `wal_level = logical` — `pg_create_logical_replication_slot` refuses
 *    otherwise. Failure names the exact remediation (`ALTER SYSTEM SET
 *    wal_level = logical` + restart) and that IndigoDB cannot do it itself.
 * 2. The connecting role carries `REPLICATION` (or is a superuser, which
 *    implies it) — failure names the exact `ALTER ROLE ... REPLICATION`
 *    remediation.
 *
 * Exits the process (like `loadSchema`/`resolveConnectionString`) rather
 * than throwing: nothing is applied when either check fails.
 */
export async function assertLogicalReplication(client: ReplicationPreflightClient): Promise<void> {
  const walLevelResult = await client.query("SHOW wal_level;");
  const walLevel = (walLevelResult.rows[0] as { wal_level?: string } | undefined)?.wal_level;
  if (walLevel !== "logical") {
    console.error(`❌ Postgres is not configured for logical replication (wal_level = "${walLevel}").`);
    console.error(`   @@realtime needs \`wal_level = logical\`. IndigoDB cannot set this for you — run:`);
    console.error(`     ALTER SYSTEM SET wal_level = logical;`);
    console.error(`   then RESTART Postgres, and re-run this command. Nothing was applied.`);
    process.exit(1);
  }

  const roleResult = await client.query(
    "SELECT rolsuper OR rolreplication AS ok, current_user AS name FROM pg_roles WHERE rolname = current_user;",
  );
  const row = roleResult.rows[0] as { ok?: boolean; name?: string } | undefined;
  if (!row?.ok) {
    console.error(`❌ The connecting role${row?.name ? ` "${row.name}"` : ""} lacks the REPLICATION privilege @@realtime needs. Run:`);
    console.error(`     ALTER ROLE ${row?.name ?? "<user>"} REPLICATION;`);
    console.error(`   then re-run this command. Nothing was applied.`);
    process.exit(1);
  }
}

/**
 * `indigodb realtime` daemon startup preflight: the signing secret is only
 * required when it will actually be used. The daemon serves `REALTIME_LOG_PATH`
 * unconditionally, but that endpoint only exists to give an RLS-scoped read
 * path to `@@realtime`+`@@allow` models — a schema with no such model never
 * mints or verifies a handle, so an unset secret is harmless there
 * (spec: "Requirement: Daemon startup preflight requires the signing
 * secret"). SCHEMA-CONDITIONAL by design — narrower than "fail whenever the
 * env var happens to be unset" (that broader unconditional form was PR A's
 * intentional safe-direction deviation pending this narrowing).
 *
 * The predicate is "any `@@allow` block at all" (`table.allow !==
 * undefined`), matching the corrected SSE wake-up scoping predicate — not
 * "carries a `read` `AllowRule`" — since a create-only `@@allow` model still
 * needs the secret to serve its RLS-scoped log page.
 */
export function assertRealtimeSecretPresent(
  resolved: Pick<ResolvedSchema, "tables">,
  secret: string | undefined,
): void {
  const needsSecret = resolved.tables.some((t) => t.realtime && t.allow !== undefined);
  if (needsSecret && !secret) {
    console.error(
      `❌ INDIGODB_REALTIME_SECRET is not set. This schema has a model that is both ` +
        `@@realtime and @@allow, whose /api/realtime/log page requires it to mint/verify ` +
        `handles. Set it and retry.`,
    );
    process.exit(1);
  }
}

/**
 * `indigodb studio` startup preflight: a non-loopback `--host` bind exposes
 * the schema, data browser and SQL query console to the whole network, so it
 * requires `INDIGODB_STUDIO_PASSWORD` to be set — the loopback default
 * (`127.0.0.1`/`::1`/`localhost`) needs no password and is left untouched.
 *
 * Kept self-contained (its own loopback set) rather than importing
 * `studio-server.ts`'s private `isLoopbackHost`, mirroring
 * `assertRealtimeSecretPresent`'s pattern of a small standalone preflight
 * function in this file; the loopback host list (`127.0.0.1`, `::1`,
 * `localhost`) matches `studio-server.ts`'s exactly and must stay in sync if
 * that ever changes.
 */
const STUDIO_LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Exact-match parser for `INDIGODB_STUDIO_READONLY`: only the literal
 * strings `"1"` and `"true"` enable read-only mode — no trimming, no case
 * folding, no other truthy coercion (`"TRUE"`, `"yes"`, `"1.0"` etc. are
 * all rejected). Extracted from `packages/cli/src/index.ts`'s `studio`
 * action so it — and the flag/env resolution it feeds — is directly unit
 * testable rather than only reachable through commander's parsed options.
 */
export function isReadOnlyEnv(v?: string): boolean {
  return v === "1" || v === "true";
}

/**
 * `indigodb studio`'s read-only resolution: the `--read-only` flag OR an
 * exact-match `INDIGODB_STUDIO_READONLY` enables read-only mode. Mirrors
 * exactly what the `studio` command's action runs after `loadEnv()`
 * (design.md "`--read-only` resolved after `loadEnv()`" decision) — kept as
 * a small pure function purely so it can be unit tested without spawning
 * the built CLI.
 */
export function resolveStudioReadOnly(optionReadOnly: boolean | undefined, envValue: string | undefined): boolean {
  return optionReadOnly === true || isReadOnlyEnv(envValue);
}

export function assertStudioAuthForHost(host: string, password: string | undefined): void {
  const loopback = STUDIO_LOOPBACK_HOSTS.has(host);
  if (!loopback && !password) {
    console.error(
      `❌ --host ${host} binds the Studio beyond loopback, but INDIGODB_STUDIO_PASSWORD is not set.`,
    );
    console.error(
      `   That would publish the schema, data browser and SQL console with no authentication.`,
    );
    console.error(
      `   Set INDIGODB_STUDIO_PASSWORD and retry, or drop --host to stay on 127.0.0.1.`,
    );
    process.exit(1);
  }
}

/** Determines the client output path (generator block > flag > default). */
export function resolveOutputPath(ast: Schema, flag?: string): string {
  const fromGenerator = ast.generators[0]?.output;
  return resolvePath(flag ?? fromGenerator ?? "src/generated/indigo.ts");
}

/**
 * `db pull` NEVER writes credentials into the schema file — even when
 * `--url` was the actual connection source — because the printed datasource
 * always points at `DATABASE_URL`. `introspectResolvedSchema` never
 * populates `schema.datasource` itself, so the CLI synthesizes it here
 * before printing.
 */
export function synthesizePullDatasource(): NonNullable<ResolvedSchema["datasource"]> {
  return {
    name: "db",
    provider: "postgresql",
    url: { kind: "function", name: "env", args: [{ kind: "string", value: "DATABASE_URL" }] },
  };
}

export interface WritePulledSchemaOptions {
  /** Target schema file path. Ignored when `print` is true. */
  schema: string;
  /** Write nothing to disk — print the schema text to stdout only. */
  print?: boolean;
}

export interface WritePulledSchemaResult {
  text: string;
  /** Absolute path written to, or `undefined` when `print` was used. */
  path?: string;
  /** Whether a file already existed at `path` and was overwritten. */
  overwrote: boolean;
}

/**
 * Prints `resolved` (with the datasource synthesized to `env("DATABASE_URL")`,
 * never a literal credential) and either writes it to `options.schema`
 * (overwriting unconditionally, no confirmation/`--force`) or, with
 * `options.print`, writes only to stdout and touches no file. Always logs a
 * visible success line; logs `⚠️  Overwrote <path>` when a file existed, and
 * — for a non-`--print` write — the FK-comments-not-regenerated-by-migrate-dev
 * warning banner, since a pulled schema's foreign keys survive only as
 * structured comments and `migrate dev` would otherwise plan to drop them.
 */
export function writePulledSchema(
  resolved: ResolvedSchema,
  options: WritePulledSchemaOptions,
): WritePulledSchemaResult {
  resolved.datasource = synthesizePullDatasource();
  const text = printSchema(resolved);

  if (options.print) {
    console.log(text);
    return { text, overwrote: false };
  }

  const schemaPath = resolvePath(options.schema);
  const overwrote = existsSync(schemaPath);
  mkdirSync(dirname(schemaPath), { recursive: true });
  writeFileSync(schemaPath, text);

  console.log("✅ Schema pulled.");
  console.log(`   ${schemaPath}`);
  console.log(`   ${resolved.tables.length} tables, ${resolved.enums.length} enums.`);
  if (overwrote) console.log(`⚠️  Overwrote ${schemaPath}`);
  console.log();
  console.log(
    "⚠️  Foreign keys survive only as structured comments in the pulled schema — " +
      "`migrate dev` will NOT regenerate them and will plan to DROP every FK constraint. " +
      "Re-add `@relation(...)` fields by hand before running `migrate dev` against this schema.",
  );

  return { text, path: schemaPath, overwrote };
}
