/**
 * @indigodb/cli — Shared helpers
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parse, resolve, IndigoParseError, validate } from "@indigodb/core";
import type { Schema, ResolvedSchema } from "@indigodb/core";

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

/** Determines the client output path (generator block > flag > default). */
export function resolveOutputPath(ast: Schema, flag?: string): string {
  const fromGenerator = ast.generators[0]?.output;
  return resolvePath(flag ?? fromGenerator ?? "src/generated/indigo.ts");
}
