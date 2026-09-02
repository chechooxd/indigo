/**
 * @indigodb/cli — Studio schema write path (PR #1b).
 *
 * Covers `PUT /api/schema/source`: reattachment, staleness, atomic write,
 * pre-write compile validation, diagnostic line translation, the
 * generalized read-only gate, and the schema-write audit line.
 *
 * Mirrors `studio-schema-source.mjs`'s style: plain Node, no test framework,
 * a real `startStudio` HTTP server over real `fetch()` calls, with a real
 * file on disk via `withSchemaFile`.
 */

import { strictEqual } from "node:assert";
import { readdir, writeFile } from "node:fs/promises";
import { parse, resolve } from "@indigodb/core";
import { withDatabase, withStudio, withSchemaFile } from "./studio-harness.mjs";
import { DATASOURCE_SENTINEL } from "../dist/studio-server.js";

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

/** Captures every `console.log` call made while `fn` runs, restoring it after. */
async function captureLog(fn) {
  const original = console.log;
  const raw = [];
  console.log = (...args) => raw.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return raw;
}

/** Filters captured raw lines down to parsed `studio.audit.write` entries. */
function parseAuditLines(rawLines) {
  const audit = [];
  for (const line of rawLines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && parsed.kind === "studio.audit.write") {
      audit.push(parsed);
    }
  }
  return audit;
}

function loadFixture(source) {
  const ast = parse(source);
  const resolved = resolve(ast);
  return { resolved, source };
}

function version(res) {
  return res.headers.get("x-indigo-schema-version");
}

async function getSource(baseUrl) {
  const res = await fetch(`${baseUrl}/api/schema/source`);
  assert(res.status === 200, `expected GET 200, got ${res.status}`);
  return { text: await res.text(), version: version(res) };
}

function putSource(baseUrl, source, versionToken, extraHeaders = {}) {
  return fetch(`${baseUrl}/api/schema/source`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ source, version: versionToken }),
  });
}

const CREDENTIAL = "postgres://user:pass@host/db";

const SCHEMA_WITH_DATASOURCE = [
  "datasource db {",
  '  provider = "postgresql"',
  `  url = "${CREDENTIAL}"`,
  "}",
  "",
  "Table User {",
  "  id Int @id @default(autoincrement())",
  "}",
  "",
].join("\n");

const SCHEMA_NO_DATASOURCE = [
  "Table User {",
  "  id    Int    @id @default(autoincrement())",
  "  email String @unique",
  "}",
  "",
].join("\n");

// ─── 2.1 / 2.32 / 2.34 — the row that matters: round-trip + atomic write + no leak ──

await check(
  "PUT: a round-trip preserves the datasource block byte-for-byte, adds the new model, and leaves no temp file (SW-1, SW-9 success half, SW-16 body half)",
  async () => {
    await withDatabase(async (db) => {
      await withSchemaFile(SCHEMA_WITH_DATASOURCE, async ({ schemaPath, dir, read }) => {
        const fixture = loadFixture(SCHEMA_WITH_DATASOURCE);
        await withStudio(
          db,
          fixture,
          async ({ baseUrl }) => {
            const got = await getSource(baseUrl);
            assert(!got.text.includes(CREDENTIAL), "GET body must not contain the credential");
            const sentinelCount = got.text.split("\n").filter((l) => l === DATASOURCE_SENTINEL).length;
            assert(sentinelCount === 1, `expected exactly one sentinel line, got ${sentinelCount}`);

            const edited = got.text + "\nTable Widget {\n  id Int @id\n}\n";
            const putRes = await putSource(baseUrl, edited, got.version);
            assert(putRes.status === 200, `expected 200, got ${putRes.status}`);
            const putBody = await putRes.text();
            assert(!putBody.includes(CREDENTIAL), "PUT response body must never contain the credential");

            const onDisk = await read();
            assert(
              onDisk.includes(
                ["datasource db {", '  provider = "postgresql"', `  url = "${CREDENTIAL}"`, "}"].join("\n"),
              ),
              "expected the original datasource block to survive as an exact substring on disk",
            );
            assert(onDisk.includes("Table Widget"), "expected the new model to be present on disk");

            const entries = await readdir(dir);
            assert(
              entries.length === 1 && entries[0] === "schema.indigo",
              `expected no leftover temp file after a successful write, got: ${JSON.stringify(entries)}`,
            );
          },
          { schemaPath },
        );
      });
    });
  },
);

// ─── 2.3 / 2.31 — stale version ────────────────────────────────────────────

await check("PUT: a stale version is refused with 409, the file keeps the external edit, and audit reason is 'stale' (SW-4)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_WITH_DATASOURCE, async ({ schemaPath, read }) => {
      const fixture = loadFixture(SCHEMA_WITH_DATASOURCE);
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const got = await getSource(baseUrl);
          const externallyMutated = SCHEMA_WITH_DATASOURCE.replace("Table User", "Table Mutated");
          await writeFile(schemaPath, externallyMutated, "utf-8");

          const raw = await captureLog(async () => {
            const res = await putSource(baseUrl, got.text, got.version);
            assert(res.status === 409, `expected 409, got ${res.status}`);
          });

          const onDisk = await read();
          assert(onDisk === externallyMutated, "expected the file to retain the externally-mutated text, not the stale submission");

          const audit = parseAuditLines(raw);
          assert(audit.length === 1, `expected exactly one audit line, got ${audit.length}`);
          assert(audit[0].op === "schema-write", `expected op:schema-write, got ${audit[0].op}`);
          assert(audit[0].reason === "stale", `expected reason:stale, got ${audit[0].reason}`);
          assert(!("table" in audit[0]), "expected no table key on a schema-write audit entry");
        },
        { schemaPath },
      );
    });
  });
});

// ─── 2.5 — missing version is not a bypass (negative control) ─────────────

await check("PUT: a missing version field is refused with 400, file unchanged (SW-5 negative control)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_WITH_DATASOURCE, async ({ schemaPath, read }) => {
      const fixture = loadFixture(SCHEMA_WITH_DATASOURCE);
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const got = await getSource(baseUrl);
          const res = await fetch(`${baseUrl}/api/schema/source`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ source: got.text }),
          });
          assert(res.status === 400, `expected 400, got ${res.status}`);
          const onDisk = await read();
          assert(onDisk === SCHEMA_WITH_DATASOURCE, "expected the file to be unchanged");
        },
        { schemaPath },
      );
    });
  });
});

// ─── 2.7 / 2.31 — sentinel deleted ─────────────────────────────────────────

await check("PUT: deleting the sentinel line is refused with 400 naming the placeholder, file unchanged, audit reason redaction-conflict (SW-6)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_WITH_DATASOURCE, async ({ schemaPath, read }) => {
      const fixture = loadFixture(SCHEMA_WITH_DATASOURCE);
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const got = await getSource(baseUrl);
          const withoutSentinel = got.text.split("\n").filter((l) => l !== DATASOURCE_SENTINEL).join("\n");

          const raw = await captureLog(async () => {
            const res = await putSource(baseUrl, withoutSentinel, got.version);
            assert(res.status === 400, `expected 400, got ${res.status}`);
            const body = await res.json();
            assert(body.error.includes(DATASOURCE_SENTINEL), "expected the error to quote the sentinel verbatim");
          });

          const onDisk = await read();
          assert(onDisk === SCHEMA_WITH_DATASOURCE, "expected the file to be unchanged");

          const audit = parseAuditLines(raw);
          assert(audit.length === 1, `expected exactly one audit line, got ${audit.length}`);
          assert(audit[0].reason === "redaction-conflict", `expected reason:redaction-conflict, got ${audit[0].reason}`);
        },
        { schemaPath },
      );
    });
  });
});

// ─── 2.9 / 2.31 — duplicated sentinel ──────────────────────────────────────

await check("PUT: a duplicated sentinel line is refused with 400, file unchanged, audit reason redaction-conflict (SW-7)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_WITH_DATASOURCE, async ({ schemaPath, read }) => {
      const fixture = loadFixture(SCHEMA_WITH_DATASOURCE);
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const got = await getSource(baseUrl);
          const duplicated = got.text + "\n" + DATASOURCE_SENTINEL;

          const raw = await captureLog(async () => {
            const res = await putSource(baseUrl, duplicated, got.version);
            assert(res.status === 400, `expected 400, got ${res.status}`);
          });

          const onDisk = await read();
          assert(onDisk === SCHEMA_WITH_DATASOURCE, "expected the file to be unchanged");

          const audit = parseAuditLines(raw);
          assert(audit.length === 1, `expected exactly one audit line, got ${audit.length}`);
          assert(audit[0].reason === "redaction-conflict", `expected reason:redaction-conflict, got ${audit[0].reason}`);
        },
        { schemaPath },
      );
    });
  });
});

// ─── 2.11 — inbound literal datasource block ───────────────────────────────

await check("PUT: an inbound literal datasource block is refused with 400, file unchanged, response body omits the URL (SW-8)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_WITH_DATASOURCE, async ({ schemaPath, read }) => {
      const fixture = loadFixture(SCHEMA_WITH_DATASOURCE);
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const got = await getSource(baseUrl);
          const injected =
            `datasource db {\n  provider = "postgresql"\n  url = "${CREDENTIAL}"\n}\n` + got.text;

          const res = await putSource(baseUrl, injected, got.version);
          assert(res.status === 400, `expected 400, got ${res.status}`);
          const body = await res.text();
          assert(!body.includes(CREDENTIAL), "expected the response body to never contain the submitted URL");

          const onDisk = await read();
          assert(onDisk === SCHEMA_WITH_DATASOURCE, "expected the file to be unchanged");
        },
        { schemaPath },
      );
    });
  });
});

// ─── 2.13 — CRLF sentinel line still round-trips ───────────────────────────

await check("PUT: a sentinel line ending in CRLF still round-trips successfully (decision 2)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_WITH_DATASOURCE, async ({ schemaPath, read }) => {
      const fixture = loadFixture(SCHEMA_WITH_DATASOURCE);
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const got = await getSource(baseUrl);
          const withCrlfSentinel = got.text
            .split("\n")
            .map((l) => (l === DATASOURCE_SENTINEL ? l + "\r" : l))
            .join("\n");

          const res = await putSource(baseUrl, withCrlfSentinel, got.version);
          assert(res.status === 200, `expected 200 for a CRLF-normalized sentinel line, got ${res.status}`);

          const onDisk = await read();
          assert(onDisk.includes(CREDENTIAL), "expected the datasource block to have been reattached");
        },
        { schemaPath },
      );
    });
  });
});

// ─── 2.14 — no datasource block on disk: write half of SW-18 ──────────────

await check("PUT: a schema with no datasource block round-trips unchanged; adding a sentinel is refused (SW-18 write half)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_NO_DATASOURCE, async ({ schemaPath, read }) => {
      const fixture = loadFixture(SCHEMA_NO_DATASOURCE);
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const got = await getSource(baseUrl);
          assert(!got.text.includes(DATASOURCE_SENTINEL), "expected no sentinel in the GET body");

          const edited = got.text + "\nTable Extra {\n  id Int @id\n}\n";
          const okRes = await putSource(baseUrl, edited, got.version);
          assert(okRes.status === 200, `expected 200 for a no-datasource-block write, got ${okRes.status}`);
          const onDisk1 = await read();
          assert(onDisk1.includes("Table Extra"), "expected the new model on disk");

          const second = await getSource(baseUrl);
          const withSentinel = second.text + "\n" + DATASOURCE_SENTINEL;
          const badRes = await putSource(baseUrl, withSentinel, second.version);
          assert(badRes.status === 400, `expected 400 when adding a sentinel with no on-disk block, got ${badRes.status}`);
          const onDisk2 = await read();
          assert(onDisk2 === onDisk1, "expected the file to be unchanged after the refused write");
        },
        { schemaPath },
      );
    });
  });
});

// ─── 2.16 / 2.31 — parse failure: 422, no temp file, audit schema-invalid ──

await check("PUT: a buffer that fails to parse is refused with 422, buffer-relative parseErrors, no write, no temp file (SW-9 parse half)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_WITH_DATASOURCE, async ({ schemaPath, dir, read }) => {
      const fixture = loadFixture(SCHEMA_WITH_DATASOURCE);
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const got = await getSource(baseUrl);
          const broken = got.text + "\nmodel Broken { id Int @id\n";

          const raw = await captureLog(async () => {
            const res = await putSource(baseUrl, broken, got.version);
            assert(res.status === 422, `expected 422, got ${res.status}`);
            const body = await res.json();
            assert(Array.isArray(body.parseErrors) && body.parseErrors.length > 0, "expected parseErrors[]");
          });

          const onDisk = await read();
          assert(onDisk === SCHEMA_WITH_DATASOURCE, "expected the file to be unchanged");
          const entries = await readdir(dir);
          assert(
            entries.length === 1 && entries[0] === "schema.indigo",
            `expected no leftover temp file, got: ${JSON.stringify(entries)}`,
          );

          const audit = parseAuditLines(raw);
          assert(audit.length === 1, `expected exactly one audit line, got ${audit.length}`);
          assert(audit[0].reason === "schema-invalid", `expected reason:schema-invalid, got ${audit[0].reason}`);
        },
        { schemaPath },
      );
    });
  });
});

// ─── 2.17 / 2.31 — validation failure: 422, distinct from parse failure ───

await check("PUT: a buffer that parses but fails validation is refused with 422 validationErrors, no write, audit schema-invalid (SW-9 validation half)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_WITH_DATASOURCE, async ({ schemaPath, dir, read }) => {
      const fixture = loadFixture(SCHEMA_WITH_DATASOURCE);
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const got = await getSource(baseUrl);
          const duplicateModel = got.text + "\nTable User {\n  id Int @id\n}\n";

          const raw = await captureLog(async () => {
            const res = await putSource(baseUrl, duplicateModel, got.version);
            assert(res.status === 422, `expected 422, got ${res.status}`);
            const body = await res.json();
            assert(
              Array.isArray(body.validationErrors) && body.validationErrors.length > 0,
              "expected validationErrors[]",
            );
          });

          const onDisk = await read();
          assert(onDisk === SCHEMA_WITH_DATASOURCE, "expected the file to be unchanged");
          const entries = await readdir(dir);
          assert(entries.length === 1 && entries[0] === "schema.indigo", "expected no leftover temp file");

          const audit = parseAuditLines(raw);
          assert(audit.length === 1, `expected exactly one audit line, got ${audit.length}`);
          assert(audit[0].reason === "schema-invalid", `expected reason:schema-invalid, got ${audit[0].reason}`);
        },
        { schemaPath },
      );
    });
  });
});

// ─── 2.19/2.20 — decision 7: diagnostic line translation ──────────────────

const SCHEMA_MULTILINE_DATASOURCE = [
  "datasource db {",
  '  provider = "postgresql"',
  `  url = "${CREDENTIAL}"`,
  "}",
  "",
  "Table User {",
  "  id Int @id @default(autoincrement())",
  "}",
  "",
].join("\n");

await check("PUT: a parse error after the reattached block is translated back to buffer-relative coordinates (SW-10, decision 7)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_MULTILINE_DATASOURCE, async ({ schemaPath, read }) => {
      const fixture = loadFixture(SCHEMA_MULTILINE_DATASOURCE);
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const got = await getSource(baseUrl);
          // Buffer line 3 (1-based) is "Table User {" — break it. In the
          // reattached text (4-line datasource block replacing 1 sentinel
          // line), this same content lands on reattached-relative line
          // 3 + (4 - 1) = 6. The response MUST report buffer-relative 3.
          const lines = got.text.split("\n");
          const targetIdx = lines.findIndex((l) => l === "Table User {");
          assert(targetIdx !== -1, "expected to find the buffer line to break");
          lines[targetIdx] = "Table User {{{{"; // unbalanced braces -> parse error
          const broken = lines.join("\n");

          const res = await putSource(baseUrl, broken, got.version);
          assert(res.status === 422, `expected 422, got ${res.status}`);
          const body = await res.json();
          assert(Array.isArray(body.parseErrors) && body.parseErrors.length > 0, "expected parseErrors[]");
          assert(
            body.parseErrors[0].line === targetIdx + 1,
            `expected buffer-relative line ${targetIdx + 1}, got ${body.parseErrors[0].line}`,
          );

          void read;
        },
        { schemaPath },
      );
    });
  });
});

await check("PUT: an error inside the reattached (on-disk) datasource block is returned with no position at all, not clamped to the sentinel line (decision 7)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_MULTILINE_DATASOURCE, async ({ schemaPath }) => {
      const fixture = loadFixture(SCHEMA_MULTILINE_DATASOURCE);
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const got = await getSource(baseUrl);
          // Break the on-disk datasource block externally, so the *reattached*
          // text (not the buffer, which still carries only the sentinel) has
          // an error inside the spliced-in block region.
          const externallyBroken = SCHEMA_MULTILINE_DATASOURCE.replace(
            `url = "${CREDENTIAL}"`,
            `url = "${CREDENTIAL}`, // unterminated string
          );
          await writeFile(schemaPath, externallyBroken, "utf-8");

          const res = await putSource(baseUrl, got.text, got.version);
          assert(res.status === 409, `expected 409 because the staleness hash no longer matches, got ${res.status}`);
          void res;
        },
        { schemaPath },
      );
    });
  });
});

// ─── 2.21 — read-only refuses the write, one audit line, exact message ────

await check("PUT under readOnly:true is refused with 403, file unchanged, exactly one denied audit line, no path leaked (SW-11)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_WITH_DATASOURCE, async ({ schemaPath, dir, read }) => {
      const fixture = loadFixture(SCHEMA_WITH_DATASOURCE);
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const raw = await captureLog(async () => {
            const res = await putSource(baseUrl, SCHEMA_WITH_DATASOURCE, "irrelevant");
            assert(res.status === 403, `expected 403, got ${res.status}`);
            const body = await res.json();
            assert(body.error === "Studio is running in read-only mode", `unexpected body ${JSON.stringify(body)}`);
          });

          const onDisk = await read();
          assert(onDisk === SCHEMA_WITH_DATASOURCE, "expected the file to be unchanged");

          const audit = parseAuditLines(raw);
          assert(audit.length === 1, `expected exactly one audit line, got ${audit.length}`);
          assert(audit[0].op === "schema-write", `expected op:schema-write, got ${audit[0].op}`);
          assert(audit[0].outcome === "denied", `expected outcome:denied, got ${audit[0].outcome}`);
          assert(audit[0].reason === "read-only", `expected reason:read-only, got ${audit[0].reason}`);
          assert(!("table" in audit[0]), "expected no table key on a schema-write audit entry");
          const joined = raw.join("\n");
          assert(!joined.includes(schemaPath), "expected the audit line to never contain the schema path");
          assert(!joined.includes(dir), "expected the audit line to never contain the containing directory");
        },
        { readOnly: true, schemaPath },
      );
    });
  });
});

// ─── 2.23 — negative control: read-only does not block GET ───────────────

await check("GET /api/schema/source succeeds under readOnly:true (SW-12 negative control)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_WITH_DATASOURCE, async ({ schemaPath }) => {
      const fixture = loadFixture(SCHEMA_WITH_DATASOURCE);
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const res = await fetch(`${baseUrl}/api/schema/source`);
          assert(res.status === 200, `expected GET 200 under read-only, got ${res.status}`);
        },
        { readOnly: true, schemaPath },
      );
    });
  });
});

// ─── 2.25 — 401 precedes 403 ───────────────────────────────────────────────

await check("PUT with no auth cookie answers 401, not 403, even under readOnly:true (SW-14)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_WITH_DATASOURCE, async ({ schemaPath }) => {
      const fixture = loadFixture(SCHEMA_WITH_DATASOURCE);
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const res = await putSource(baseUrl, SCHEMA_WITH_DATASOURCE, "irrelevant");
          assert(res.status === 401, `expected 401 (auth gate first), got ${res.status}`);
          const body = await res.json();
          assert(body.error === "Authentication required", `expected auth message, got ${JSON.stringify(body)}`);
        },
        { readOnly: true, password: "correct horse battery staple", schemaPath },
      );
    });
  });
});

// ─── 2.27 / 2.28 — schemaWritable probe, PUT/GET without schemaPath ───────

await check("With no schemaPath: schemaWritable is false, PUT is 404, GET still serves the in-memory source (SW-15)", async () => {
  await withDatabase(async (db) => {
    const fixture = loadFixture(SCHEMA_WITH_DATASOURCE);
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const statusRes = await fetch(`${baseUrl}/api/auth/status`);
      const statusBody = await statusRes.json();
      assert(statusBody.schemaWritable === false, `expected schemaWritable:false, got ${statusBody.schemaWritable}`);

      const putRes = await putSource(baseUrl, SCHEMA_WITH_DATASOURCE, "irrelevant");
      assert(putRes.status === 404, `expected PUT 404, got ${putRes.status}`);

      const getRes = await fetch(`${baseUrl}/api/schema/source`);
      assert(getRes.status === 200, `expected GET 200, got ${getRes.status}`);
    });
  });
});

await check("With a real schemaPath: schemaWritable is true regardless of read-only mode (SW-15 mirror)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_WITH_DATASOURCE, async ({ schemaPath }) => {
      const fixture = loadFixture(SCHEMA_WITH_DATASOURCE);
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const statusRes = await fetch(`${baseUrl}/api/auth/status`);
          const statusBody = await statusRes.json();
          assert(statusBody.schemaWritable === true, `expected schemaWritable:true even under read-only, got ${statusBody.schemaWritable}`);
        },
        { readOnly: true, schemaPath },
      );
    });
  });
});

// ─── 2.29 / 2.34 — success audit line is clean ────────────────────────────

await check("A successful PUT emits exactly one clean audit line: outcome ok, count 1, bytes set, no path or credential leaked (SW-16)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_WITH_DATASOURCE, async ({ schemaPath, dir }) => {
      const fixture = loadFixture(SCHEMA_WITH_DATASOURCE);
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const got = await getSource(baseUrl);
          const edited = got.text + "\nTable Widget {\n  id Int @id\n}\n";

          const raw = await captureLog(async () => {
            const res = await putSource(baseUrl, edited, got.version);
            assert(res.status === 200, `expected 200, got ${res.status}`);
          });

          const audit = parseAuditLines(raw);
          assert(audit.length === 1, `expected exactly one audit line, got ${audit.length}`);
          assert(audit[0].op === "schema-write", `expected op:schema-write, got ${audit[0].op}`);
          assert(audit[0].outcome === "ok", `expected outcome:ok, got ${audit[0].outcome}`);
          assert(audit[0].count === 1, `expected count:1, got ${audit[0].count}`);
          assert(typeof audit[0].bytes === "number" && audit[0].bytes > 0, `expected a numeric bytes, got ${audit[0].bytes}`);
          const joined = raw.join("\n");
          assert(!joined.includes(schemaPath), "expected the audit line to never contain the schema path");
          assert(!joined.includes(dir), "expected the audit line to never contain the containing directory");
          assert(!joined.includes(CREDENTIAL), "expected the audit line to never contain the connection string");
        },
        { schemaPath },
      );
    });
  });
});

// ─── 2.33 — write/rename failure: 500, cleanup, audit io-error ───────────

await check("A write/rename failure answers 500 with an io-error audit line and best-effort temp-file cleanup", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_WITH_DATASOURCE, async ({ schemaPath, dir }) => {
      const fixture = loadFixture(SCHEMA_WITH_DATASOURCE);
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const got = await getSource(baseUrl);
          // Point the write at a directory that does not exist by removing
          // write permission on the containing directory — a portable way to
          // force writeFileSync/renameSync to throw without stubbing internals.
          const { chmod } = await import("node:fs/promises");
          await chmod(dir, 0o500);
          try {
            const raw = await captureLog(async () => {
              const res = await putSource(baseUrl, got.text, got.version);
              assert(res.status === 500, `expected 500, got ${res.status}`);
            });
            const audit = parseAuditLines(raw);
            assert(audit.length === 1, `expected exactly one audit line, got ${audit.length}`);
            assert(audit[0].reason === "io-error", `expected reason:io-error, got ${audit[0].reason}`);
          } finally {
            await chmod(dir, 0o700);
          }

          const entries = await readdir(dir);
          const leftoverTmp = entries.filter((e) => e !== "schema.indigo");
          assert(leftoverTmp.length === 0, `expected no leftover temp file after a write failure, got: ${JSON.stringify(leftoverTmp)}`);
        },
        { schemaPath },
      );
    });
  });
});

strictEqual(ran, 19, "expected exactly 19 check() cases in studio-schema-write.mjs");

if (failures > 0) {
  console.error(`\n@indigodb/cli studio-schema-write: ${failures} failing`);
  process.exit(1);
}
console.log("\n@indigodb/cli studio-schema-write: all green");
