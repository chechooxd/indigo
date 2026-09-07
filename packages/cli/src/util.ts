/**
 * @indigodb/cli — Shared helpers
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { createHmac } from "node:crypto";
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
 * `indigodb studio`'s read-only resolution: the `--read-only` flag OR
 * `INDIGODB_STUDIO_READONLY` enables read-only mode. The env branch mirrors
 * `resolveStudioAuditLog`'s accepted-set shape — exact match `"1"`/`"true"`
 * enables, exact match `"0"`/`"false"` disables, and any other value
 * THROWS (never `process.exit`), naming the variable and the four accepted
 * values. `--read-only` is enable-only (no `--no-read-only`), so it
 * expresses no intent to override the env var: the env branch is resolved
 * into a local FIRST, and the flag is OR'd in afterward — a malformed env
 * value is rejected even when `--read-only` is also passed, rather than
 * being silently suppressed by it (design.md "a malformed env var fails
 * even when `--read-only` was passed" decision — deliberately unlike
 * `resolveStudioAuditLog`, whose flag IS authoritative in both directions).
 * Pure and throws so `index.ts`'s `studio` action — the only caller that
 * needs to exit the process — can catch, print, and exit 1 itself before
 * anything binds.
 */
export function resolveStudioReadOnly(optionReadOnly: boolean | undefined, envValue: string | undefined): boolean {
  let envReadOnly = false;
  if (envValue !== undefined) {
    if (envValue === "1" || envValue === "true") {
      envReadOnly = true;
    } else if (envValue === "0" || envValue === "false") {
      envReadOnly = false;
    } else {
      throw new Error(
        `INDIGODB_STUDIO_READONLY must be "1", "0", "true", or "false", got: ${JSON.stringify(envValue)}`,
      );
    }
  }
  return optionReadOnly === true || envReadOnly;
}

/**
 * Exact-match integer parser shared by both query-guardrail resolvers below:
 * `/^\d+$/` only — no leading/trailing whitespace, no sign, no decimal
 * point, no scientific notation, no `Infinity`. Returns `null` for
 * `undefined` (absent) or anything that fails the exact match, never `NaN`.
 */
export function parseGuardrailInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/**
 * Precedence resolver shared by `resolveQueryTimeoutMs`/`resolveQueryRowCap`:
 * CLI flag > environment variable > built-in default. A present-but-malformed
 * flag or env value THROWS (never `process.exit`), naming the offending
 * input, so `index.ts`'s `studio` action — the only caller that needs to
 * exit the process — can catch, print, and exit 1 itself
 * (design.md "resolvers are pure and throw" decision).
 */
function resolveGuardrailValue(
  option: string | undefined,
  env: string | undefined,
  defaultValue: number,
  flagName: string,
  envName: string,
): number {
  if (option !== undefined) {
    const parsed = parseGuardrailInt(option);
    if (parsed === null) {
      throw new Error(`${flagName} must be a non-negative integer, got: ${JSON.stringify(option)}`);
    }
    return parsed;
  }
  if (env !== undefined) {
    const parsed = parseGuardrailInt(env);
    if (parsed === null) {
      throw new Error(`${envName} must be a non-negative integer, got: ${JSON.stringify(env)}`);
    }
    return parsed;
  }
  return defaultValue;
}

/**
 * `indigodb studio`'s statement-timeout resolution: `--query-timeout` pairs
 * with `INDIGODB_STUDIO_QUERY_TIMEOUT_MS`. Default `30000` (30s). `0`
 * disables the guardrail entirely — Postgres already spells "no statement
 * timeout" as `statement_timeout = 0`.
 */
export function resolveQueryTimeoutMs(option: string | undefined, env: string | undefined): number {
  return resolveGuardrailValue(option, env, 30000, "--query-timeout", "INDIGODB_STUDIO_QUERY_TIMEOUT_MS");
}

/**
 * `indigodb studio`'s `/api/query` row-cap resolution: `--query-row-cap`
 * pairs with `INDIGODB_STUDIO_QUERY_ROW_CAP`. Default `1000`. `0` disables
 * the guardrail entirely (uncapped, matching pre-change behavior).
 */
export function resolveQueryRowCap(option: string | undefined, env: string | undefined): number {
  return resolveGuardrailValue(option, env, 1000, "--query-row-cap", "INDIGODB_STUDIO_QUERY_ROW_CAP");
}

/**
 * `indigodb studio`'s environment-label resolution: `--env` pairs with
 * `INDIGODB_ENV`, `--env` taking precedence. Pure and THROWS (never
 * `process.exit`) on a structurally invalid value, naming the offending
 * source (`--env` or `INDIGODB_ENV`) so `index.ts`'s `studio` action can
 * catch, print, and exit 1 itself — mirrors `resolveGuardrailValue`'s
 * message shape and the "resolvers are pure and throw" design decision.
 *
 * The label set is deliberately OPEN: `development`/`staging`/`production`
 * get distinct badge treatment downstream, but any other structurally valid
 * string is accepted and returned verbatim — this function never rejects a
 * value for being *unrecognised*, only for being *structurally invalid*
 * (empty after trim, over 32 UTF-16 code units, or containing an interior
 * C0/DEL control character). Trimmed before both the length/control-char
 * check and the returned value, but NOT case-folded — the operator's own
 * casing is preserved verbatim; only the UI's recognition matching does
 * `.toLowerCase()`.
 *
 * Returns `undefined` when both `option` and `env` are absent — never a
 * default label such as `"development"`.
 */
export function resolveStudioEnvironment(
  option: string | undefined,
  env: string | undefined,
): string | undefined {
  if (option !== undefined) return validateEnvironmentLabel(option, "--env");
  if (env !== undefined) return validateEnvironmentLabel(env, "INDIGODB_ENV");
  return undefined;
}

function validateEnvironmentLabel(raw: string, sourceName: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`${sourceName} must not be empty, got: ${JSON.stringify(raw)}`);
  }
  if (trimmed.length > 32) {
    throw new Error(
      `${sourceName} must be at most 32 characters after trimming, got ${trimmed.length}: ${JSON.stringify(raw)}`,
    );
  }
  for (const ch of trimmed) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      throw new Error(`${sourceName} must not contain control characters, got: ${JSON.stringify(raw)}`);
    }
  }
  return trimmed;
}

/**
 * `indigodb studio`'s audit-log resolution: `--audit-log`/`--no-audit-log`
 * pairs with `INDIGODB_STUDIO_AUDIT_LOG`. Precedence is flag > env > default
 * `true` — deliberately NOT the `resolveStudioReadOnly` OR-shape, because
 * this switch has a *disable* direction (design.md "env throws on anything
 * ambiguous, default on" decision). Only an exact-match `"0"`/`"false"`
 * disables and only an exact-match `"1"`/`"true"` (redundantly) confirms
 * enabled; any other non-empty env value THROWS (never `process.exit`),
 * naming `INDIGODB_STUDIO_AUDIT_LOG` — silently tolerating a malformed value
 * would leave logging on while the operator believes they turned it off,
 * which is the dangerous direction for a log that may carry table/column
 * names. `index.ts`'s `studio` action is the only caller that exits the
 * process, mirroring `resolveGuardrailValue`/`resolveStudioEnvironment`.
 */
export function resolveStudioAuditLog(option: boolean | undefined, env: string | undefined): boolean {
  if (option === true) return true;
  if (option === false) return false;
  if (env !== undefined) {
    if (env === "1" || env === "true") return true;
    if (env === "0" || env === "false") return false;
    throw new Error(
      `INDIGODB_STUDIO_AUDIT_LOG must be "1", "0", "true", or "false", got: ${JSON.stringify(env)}`,
    );
  }
  return true;
}

/**
 * D7 origin allowlist resolution (`realtime-origin-allowlist`, task 1.8):
 * `--allow-origin` (repeatable) MERGES with the comma-separated
 * `INDIGODB_REALTIME_ALLOWED_ORIGINS` into ONE array — neither source
 * overwrites the other, unlike every other resolver in this file (flag >
 * env precedence). Both `indigodb realtime` and `indigodb studio` share
 * this resolver, so an operator can combine a persistent env-configured
 * allowlist with a one-off flag addition. Flag entries come first, then env
 * entries (each trimmed, empty segments dropped), de-duplicated overall.
 * Both absent ⇒ `[]`, which `RealtimeEngine` treats as closed by default.
 */
export function resolveAllowedOrigins(flagValues: string[] | undefined, env: string | undefined): string[] {
  const fromFlag = flagValues ?? [];
  const fromEnv = env ? env.split(",").map((o) => o.trim()).filter(Boolean) : [];
  return [...new Set([...fromFlag, ...fromEnv])];
}

/**
 * Op/outcome/reason closed sets for `StudioAuditEntry` — see below.
 *
 * `"schema-write"` (added for `PUT /api/schema/source`, PR #1b) and
 * `"layout-write"` (added for `PUT /api/schema/layout`, studio-layout-
 * persistence) are the two `AuditOp` values never paired with a `table` —
 * see `StudioAuditEntry.table` below and `buildSchemaAuditEntry`/
 * `buildLayoutAuditEntry` in `studio-server.ts`, which are SEPARATE builders
 * from `buildAuditEntry` for exactly that reason: making `table` optional on
 * the shared row-write builder would let a row write silently forget its
 * table and still typecheck.
 */
export type AuditOp = "insert" | "update" | "delete" | "schema-write" | "layout-write";
export type AuditOutcome = "ok" | "denied" | "error";
/**
 * `"stale"`, `"redaction-conflict"`, `"schema-invalid"`, and `"io-error"` are
 * schema-write-only reasons, added for PR #1b's `PUT /api/schema/source`.
 */
export type AuditReason =
  | "read-only"
  | "invalid-request"
  | "not-found"
  | "db-error"
  | "stale"
  | "redaction-conflict"
  | "schema-invalid"
  | "io-error";

/**
 * `indigodb studio`'s audit log entry — one stdout JSON line per attempted
 * write (design.md "row values are unreachable by type" decision).
 *
 * `pk` is `Record<string, string>` — ALREADY stringified through
 * `formatPkValue`, never a raw row value — and `columns` is `string[]` of
 * column NAMES only. `patchInput`/`valuesInput` in `studio-server.ts` are
 * `Record<string, unknown>`; under `strict` mode neither assigns to
 * `Record<string, string>` nor `string[]`, so passing a request body or a
 * `RETURNING` row into an entry is a `tsc` compile error, not a review miss
 * (Testing Strategy row 17 — verified by `pnpm lint`, not a runtime test).
 *
 * `reason` never carries a database error message — see `formatAuditLine`'s
 * callers in `studio-server.ts`, which map every DB failure to the coarse
 * `"db-error"` plus SQLSTATE `code` only.
 */
export interface StudioAuditEntry {
  ts: string;
  kind: "studio.audit.write";
  op: AuditOp;
  /**
   * Optional (PR #1b, extended for layout persistence): a schema-write
   * entry (`op:"schema-write"`) or a layout-write entry
   * (`op:"layout-write"`) never carries a `table` — there is no table
   * involved, and the schema/sidecar file PATH is deliberately never logged
   * either (see `bytes` below). Every row-write entry
   * (`insert`/`update`/`delete`) still always supplies one; only
   * `buildSchemaAuditEntry`/`buildLayoutAuditEntry`'s call sites omit it.
   */
  table?: string;
  /** Primary-key value(s), stringified column-by-column. Never other columns. */
  pk?: Record<string, string>;
  /** Column NAMES only, from `ResolvedColumn.name`. Never a value. */
  columns?: string[];
  count: number;
  outcome: AuditOutcome;
  reason?: AuditReason;
  /** SQLSTATE only, `/^[0-9A-Z]{5}$/` — never the driver's message text. */
  code?: string;
  /** 12 hex chars from `deriveSessionCorrelator`. Absent when auth is off. */
  session?: string;
  /**
   * Written byte length on a successful schema write (`op:"schema-write"`,
   * `outcome:"ok"`). Never the file path or content — see design.md's "audit
   * content" decision.
   */
  bytes?: number;
}

/**
 * Formats one `StudioAuditEntry` as a single JSON line. `JSON.stringify`
 * both escapes control characters (`\n`, `\r`, etc.) inside string values —
 * the log-injection defence for the read-only gate's unvalidated table name
 * (design.md "denial line" decision) — and omits any key whose value is
 * `undefined`, which is what makes `session` disappear entirely rather than
 * serializing as `null` when auth is off (Testing Strategy row 15).
 */
export function formatAuditLine(entry: StudioAuditEntry): string {
  return JSON.stringify(entry);
}

/**
 * Stringifies one primary-key value for `StudioAuditEntry.pk`, capped at 128
 * characters — long enough for any realistic PK, short enough to keep one
 * audit line readable on a terminal. `null`/`undefined` render as the
 * literal strings `"null"`/`"undefined"` (distinct from an absent `pk` key,
 * which means "no PK returned", not "PK is null"); `Date` renders as its ISO
 * string, matching `ts`'s own format.
 */
export function formatPkValue(value: unknown): string {
  let text: string;
  if (value === null) text = "null";
  else if (value === undefined) text = "undefined";
  else if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "string") text = value;
  else text = String(value);
  return text.length > 128 ? text.slice(0, 128) : text;
}

/**
 * Fixed context string, domain-separating this HMAC from every other keyed
 * HMAC in this codebase (`studio-auth.ts`'s `SESSION_SECRET_CONTEXT`,
 * `@indigodb/realtime`'s `handle.ts`) — mirrors `SESSION_SECRET_CONTEXT`'s
 * convention. The NUL byte after the label is a literal domain-separator
 * byte (an actual `\0` character in this string, not the two-character
 * sequence backslash-zero) — design.md documents it as the `\0` escape
 * because a literal NUL made `design.md` register as binary to `rg`.
 */
const AUDIT_CORRELATOR_LABEL = "indigodb-studio-audit-correlator-v1\0";

/**
 * Derives the `session` audit correlator from a raw session cookie token and
 * a per-process random key: `hex(HMAC-SHA256(key, LABEL + token))`, first 12
 * characters (48 bits). `token === null` (auth off, or no cookie) returns
 * `undefined` — never `"anonymous"`/`null` — so `formatAuditLine` omits the
 * `session` key entirely (design.md "session key is absent, never null"
 * decision).
 *
 * `key` MUST be a per-process `randomBytes(32)` generated inside
 * `startStudio`, NEVER derived from the shared password or any secret
 * derived from it (`deriveSessionSecret` in `studio-auth.ts`) — this is the
 * security property that keeps the audit log from becoming an offline
 * password-guessing oracle against the predictable session-cookie payload
 * (design.md "the correlator is HMAC-SHA256 under a per-process random key"
 * decision). This function stays pure and never imports `studio-auth.ts`;
 * the caller in `studio-server.ts` is responsible for generating `key` once
 * per server instance, not at module load, so a restart rotates it.
 */
export function deriveSessionCorrelator(token: string | null, key: Buffer): string | undefined {
  if (token === null) return undefined;
  return createHmac("sha256", key)
    .update(AUDIT_CORRELATOR_LABEL + token)
    .digest("hex")
    .slice(0, 12);
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
