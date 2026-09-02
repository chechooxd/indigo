/**
 * @indigodb/cli — Studio schema source read path (PR #1a).
 *
 * Covers `splitDatasource`'s split/reconstruct property (SW-17), per-request
 * `GET /api/schema/source` freshness (SW-2), the `X-Indigo-Schema-Version`
 * header (SW-3), and the "no datasource block" GET case (SW-18, read half).
 *
 * Mirrors `studio-server.mjs`'s style: plain Node, no test framework, a real
 * `startStudio` HTTP server over real `fetch()` calls.
 */

import { strictEqual } from "node:assert";
import { writeFile } from "node:fs/promises";
import { parse, resolve } from "@indigodb/core";
import { withDatabase, withStudio, withSchemaFile } from "./studio-harness.mjs";
import { splitDatasource, redactSource } from "../dist/studio-server.js";

let ran = 0;
let failures = 0;

async function check(name, fn) {
  ran++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.stack || err.message).split("\n").slice(0, 30).join("\n"));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ─── Fixtures for the split/reconstruct property (SW-17) ──────────────────

const FIXTURE_SINGLE_LINE = [
  'datasource db { provider = "postgresql" url = "postgres://user:pass@host/db" }',
  "",
  "Table User {",
  "  id Int @id",
  "}",
].join("\n");

const FIXTURE_MULTILINE = [
  "datasource db {",
  '  provider = "postgresql"',
  '  url = env("DATABASE_URL")',
  "}",
  "",
  "Table User {",
  "  id        Int      @id @default(autoincrement())",
  "  email     String   @unique",
  "}",
].join("\n");

const FIXTURE_NESTED_BRACES = [
  "datasource db {",
  '  provider = "postgresql"',
  '  url = env("DATABASE_URL")',
  "  extra {",
  "    nested = true",
  "  }",
  "}",
  "",
  "Table User {",
  "  id Int @id",
  "}",
].join("\n");

const FIXTURE_CRLF = [
  "datasource db {",
  '  provider = "postgresql"',
  '  url = env("DATABASE_URL")',
  "}",
  "",
  "Table User {",
  "  id Int @id",
  "}",
].join("\r\n");

/**
 * Reconstructs the original source from a `splitDatasource` result: replaces
 * the single sentinel line in `redacted` with `block`'s own lines.
 */
function reconstruct(redacted, block) {
  const lines = redacted.split("\n");
  const sentinelIdx = lines.findIndex((l) => l === "// datasource redacted by Studio");
  assert(sentinelIdx !== -1, "expected exactly one sentinel line in the redacted text");
  const before = lines.slice(0, sentinelIdx);
  const after = lines.slice(sentinelIdx + 1);
  return [...before, block, ...after].join("\n");
}

await check(
  "splitDatasource: split/reconstruct property holds over 4 fixtures (SW-17)",
  () => {
    const fixtures = [
      ["single-line block", FIXTURE_SINGLE_LINE],
      ["multi-line block", FIXTURE_MULTILINE],
      ["nested braces", FIXTURE_NESTED_BRACES],
      ["CRLF", FIXTURE_CRLF],
    ];
    for (const [label, source] of fixtures) {
      const split = splitDatasource(source);
      assert(
        split.redacted === redactSource(source),
        `[${label}] split(s).redacted must equal redactSource(s)`,
      );
      assert(split.block !== null, `[${label}] expected a non-null block`);
      const rebuilt = reconstruct(split.redacted, split.block);
      assert(rebuilt === source, `[${label}] reconstruction must equal the original source byte-for-byte`);
    }
  },
);

// ─── Schema fixture for server-driven tests ────────────────────────────────

const SCHEMA_SOURCE = `
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

Table User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  createdAt DateTime @default(now()) @map("created_at")
}
`;

const SCHEMA_NO_DATASOURCE = `
Table User {
  id    Int    @id @default(autoincrement())
  email String @unique
}
`;

function loadFixture(source) {
  const ast = parse(source);
  const resolved = resolve(ast);
  return { resolved, source };
}

await check("GET /api/schema/source is per-request: an external edit is visible on the next GET (SW-2)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_SOURCE, async ({ schemaPath, dir }) => {
      const fixture = loadFixture(SCHEMA_SOURCE);
      await withStudio(db, fixture, async ({ baseUrl }) => {
        const first = await fetch(`${baseUrl}/api/schema/source`);
        assert(first.status === 200, `expected 200, got ${first.status}`);
        const firstText = await first.text();
        assert(firstText.includes("Table User"), "first GET should include the original model");

        const mutated = SCHEMA_SOURCE.replace("Table User", "Table Widget");
        await writeFile(schemaPath, mutated, "utf-8");

        const second = await fetch(`${baseUrl}/api/schema/source`);
        assert(second.status === 200, `expected 200, got ${second.status}`);
        const secondText = await second.text();
        assert(
          secondText.includes("Table Widget"),
          `expected the second GET to reflect the on-disk mutation; got: ${secondText}`,
        );
        void dir;
      }, { schemaPath });
    });
  });
});

await check(
  "GET /api/schema/source publishes X-Indigo-Schema-Version, which changes with content (SW-3)",
  async () => {
    await withDatabase(async (db) => {
      await withSchemaFile(SCHEMA_SOURCE, async ({ schemaPath }) => {
        const fixture = loadFixture(SCHEMA_SOURCE);
        await withStudio(db, fixture, async ({ baseUrl }) => {
          const first = await fetch(`${baseUrl}/api/schema/source`);
          const firstVersion = first.headers.get("x-indigo-schema-version");
          assert(typeof firstVersion === "string", "expected an X-Indigo-Schema-Version header");
          assert(/^[0-9a-f]{16}$/.test(firstVersion), `expected a 16-hex string, got: ${firstVersion}`);

          await writeFile(schemaPath, SCHEMA_SOURCE.replace("Table User", "Table Widget"), "utf-8");

          const second = await fetch(`${baseUrl}/api/schema/source`);
          const secondVersion = second.headers.get("x-indigo-schema-version");
          assert(typeof secondVersion === "string", "expected an X-Indigo-Schema-Version header on the second GET");
          assert(
            secondVersion !== firstVersion,
            "expected the version header to change after an on-disk mutation",
          );
        }, { schemaPath });
      });
    });
  },
);

await check(
  "GET /api/schema/source: a schema with no datasource block round-trips unchanged, no sentinel (SW-18, read half)",
  async () => {
    await withDatabase(async (db) => {
      await withSchemaFile(SCHEMA_NO_DATASOURCE, async ({ schemaPath }) => {
        const fixture = loadFixture(SCHEMA_NO_DATASOURCE);
        await withStudio(db, fixture, async ({ baseUrl }) => {
          const res = await fetch(`${baseUrl}/api/schema/source`);
          assert(res.status === 200, `expected 200, got ${res.status}`);
          const text = await res.text();
          assert(text === SCHEMA_NO_DATASOURCE, "expected the source to be returned byte-for-byte unchanged");
          assert(!text.includes("// datasource redacted"), "expected no sentinel line to be fabricated");
        }, { schemaPath });
      });
    });
  },
);

strictEqual(ran, 4, "expected exactly 4 check() cases in studio-schema-source.mjs");

if (failures > 0) {
  console.error(`\n@indigodb/cli studio-schema-source: ${failures} failing`);
  process.exit(1);
}
console.log("\n@indigodb/cli studio-schema-source: all green");
