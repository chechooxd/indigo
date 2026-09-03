/**
 * @indigodb/cli — Studio layout persistence (`studio-layout-persistence`).
 *
 * Covers `GET`/`PUT /api/schema/layout`: sidecar path derivation, the
 * version/staleness contract (D6), payload validation, atomic write, the
 * read-only gate's extension to the new route (studio-readonly-mode delta),
 * and the `layoutWritable` probe on `/api/auth/status`.
 *
 * Mirrors `studio-schema-write.mjs`'s style: plain Node, no test framework,
 * a real `startStudio` HTTP server over real `fetch()` calls, with a real
 * file on disk via `withSchemaFile`.
 */

import { strictEqual } from "node:assert";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, resolve } from "@indigodb/core";
import { withDatabase, withStudio, withSchemaFile } from "./studio-harness.mjs";

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

const SCHEMA_SOURCE = [
  "Table User {",
  "  id Int @id @default(autoincrement())",
  "}",
  "",
].join("\n");

function loadFixture() {
  const ast = parse(SCHEMA_SOURCE);
  const resolved = resolve(ast);
  return { resolved, source: SCHEMA_SOURCE };
}

function getLayout(baseUrl) {
  return fetch(`${baseUrl}/api/schema/layout`);
}

function putLayout(baseUrl, positions, version) {
  return fetch(`${baseUrl}/api/schema/layout`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ positions, version }),
  });
}

function sidecarPath(dir) {
  return join(dir, "schema.layout.json");
}

// ─── 2.4 — absent sidecar × GET → {positions:{}, version:null} ────────────

await check("GET on an absent sidecar returns {positions:{}, version:null}", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_SOURCE, async ({ schemaPath }) => {
      const fixture = loadFixture();
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const res = await getLayout(baseUrl);
          assert(res.status === 200, `expected 200, got ${res.status}`);
          const body = await res.json();
          assert(
            body.version === null && typeof body.positions === "object" && Object.keys(body.positions).length === 0,
            `expected {positions:{}, version:null}, got ${JSON.stringify(body)}`,
          );
        },
        { schemaPath },
      );
    });
  });
});

// ─── 2.4 — absent × PUT version:null → creates ─────────────────────────────

await check("PUT with version:null on an absent sidecar creates the file (D6)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_SOURCE, async ({ schemaPath, dir }) => {
      const fixture = loadFixture();
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const res = await putLayout(baseUrl, { User: { x: 10, y: 20 } }, null);
          assert(res.status === 200, `expected 200, got ${res.status}`);
          const body = await res.json();
          assert(typeof body.version === "string" && body.version.length > 0, `expected a string version, got ${JSON.stringify(body)}`);

          const onDisk = JSON.parse(await readFile(sidecarPath(dir), "utf-8"));
          assert(onDisk.User.x === 10 && onDisk.User.y === 20, `expected the sidecar to hold the submitted position, got ${JSON.stringify(onDisk)}`);

          const entries = await readdir(dir);
          const leftoverTmp = entries.filter((e) => e !== "schema.indigo" && e !== "schema.layout.json");
          assert(leftoverTmp.length === 0, `expected no leftover temp file, got: ${JSON.stringify(leftoverTmp)}`);
        },
        { schemaPath },
      );
    });
  });
});

// ─── 2.4 — existing × PUT version:null → 409 ───────────────────────────────

await check("PUT with version:null on an EXISTING sidecar is refused with 409, nothing written (D6)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_SOURCE, async ({ schemaPath, dir }) => {
      const fixture = loadFixture();
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const created = await putLayout(baseUrl, { User: { x: 1, y: 2 } }, null);
          assert(created.status === 200, `expected the first create to succeed, got ${created.status}`);

          const before = await readFile(sidecarPath(dir), "utf-8");
          const res = await putLayout(baseUrl, { User: { x: 99, y: 99 } }, null);
          assert(res.status === 409, `expected 409 for version:null against an existing sidecar, got ${res.status}`);
          const after = await readFile(sidecarPath(dir), "utf-8");
          assert(after === before, "expected the sidecar to be byte-unchanged after the refused write");
        },
        { schemaPath },
      );
    });
  });
});

// ─── Stale version mismatch (non-null) is also rejected, file unchanged ──

await check("PUT with a mismatched (non-null) version is refused with 409, file unchanged", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_SOURCE, async ({ schemaPath, dir }) => {
      const fixture = loadFixture();
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          await putLayout(baseUrl, { User: { x: 1, y: 2 } }, null);
          const before = await readFile(sidecarPath(dir), "utf-8");

          const res = await putLayout(baseUrl, { User: { x: 3, y: 4 } }, "not-the-real-version");
          assert(res.status === 409, `expected 409, got ${res.status}`);

          const after = await readFile(sidecarPath(dir), "utf-8");
          assert(after === before, "expected the sidecar to be byte-unchanged after the refused write");
        },
        { schemaPath },
      );
    });
  });
});

// ─── 2.6 — malformed payload: table-driven → 400, nothing written ────────

const MALFORMED_CASES = [
  ["a string x value", { User: { x: "1", y: 2 } }],
  ["a NaN y value", { User: { x: 1, y: Number.NaN } }],
  ["positions is not an object", "not-an-object"],
  ["positions is an array", [{ x: 1, y: 2 }]],
];

for (const [label, positions] of MALFORMED_CASES) {
  await check(`PUT with malformed payload (${label}) is refused with 400, sidecar untouched`, async () => {
    await withDatabase(async (db) => {
      await withSchemaFile(SCHEMA_SOURCE, async ({ schemaPath, dir }) => {
        const fixture = loadFixture();
        await withStudio(
          db,
          fixture,
          async ({ baseUrl }) => {
            const res = await putLayout(baseUrl, positions, null);
            assert(res.status === 400, `expected 400, got ${res.status}`);
            const entries = await readdir(dir);
            const extra = entries.filter((e) => e !== "schema.indigo");
            assert(extra.length === 0, `expected no sidecar or temp file to exist, got: ${JSON.stringify(extra)}`);
          },
          { schemaPath },
        );
      });
    });
  });
}

await check("PUT with over 5000 layout entries is refused with 400, nothing written", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_SOURCE, async ({ schemaPath, dir }) => {
      const fixture = loadFixture();
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const huge = {};
          for (let i = 0; i < 5001; i++) huge[`Table${i}`] = { x: i, y: i };
          const res = await putLayout(baseUrl, huge, null);
          assert(res.status === 400, `expected 400 for over-cap payload, got ${res.status}`);
          const entries = await readdir(dir);
          const extra = entries.filter((e) => e !== "schema.indigo");
          assert(extra.length === 0, `expected no sidecar or temp file, got: ${JSON.stringify(extra)}`);
        },
        { schemaPath },
      );
    });
  });
});

// ─── 2.7 — payload verbatim: unknown/stale keys are stored, never pruned ──

await check("A successful PUT stores keys verbatim, including a key for a table that does not exist in the schema", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_SOURCE, async ({ schemaPath, dir }) => {
      const fixture = loadFixture();
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const res = await putLayout(baseUrl, { User: { x: 1, y: 2 }, GhostTable: { x: 3, y: 4 } }, null);
          assert(res.status === 200, `expected 200, got ${res.status}`);
          const onDisk = JSON.parse(await readFile(sidecarPath(dir), "utf-8"));
          assert(onDisk.GhostTable.x === 3 && onDisk.GhostTable.y === 4, "expected the unknown-table key to be stored verbatim, not pruned");
        },
        { schemaPath },
      );
    });
  });
});

// ─── 2.8 — no leftover temp file after 200 and after 400/409 ─────────────

await check("A successful PUT leaves no leftover temp file", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_SOURCE, async ({ schemaPath, dir }) => {
      const fixture = loadFixture();
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const res = await putLayout(baseUrl, { User: { x: 1, y: 2 } }, null);
          assert(res.status === 200, `expected 200, got ${res.status}`);
          const entries = await readdir(dir);
          assert(
            entries.length === 2 &&
              entries.includes("schema.indigo") &&
              entries.includes("schema.layout.json"),
            `expected exactly the schema and sidecar files, got: ${JSON.stringify(entries)}`,
          );
        },
        { schemaPath },
      );
    });
  });
});

// ─── 2.9 — layoutWritable probe ────────────────────────────────────────────

await check("GET /api/auth/status reports layoutWritable:true with a real schemaPath", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_SOURCE, async ({ schemaPath }) => {
      const fixture = loadFixture();
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const res = await fetch(`${baseUrl}/api/auth/status`);
          const body = await res.json();
          assert(body.layoutWritable === true, `expected layoutWritable:true, got ${body.layoutWritable}`);
        },
        { schemaPath },
      );
    });
  });
});

await check("GET /api/auth/status reports layoutWritable:false with no schemaPath, and both layout routes answer accordingly (2.2 combination)", async () => {
  await withDatabase(async (db) => {
    const fixture = loadFixture();
    await withStudio(db, fixture, async ({ baseUrl }) => {
      const statusRes = await fetch(`${baseUrl}/api/auth/status`);
      const statusBody = await statusRes.json();
      assert(statusBody.layoutWritable === false, `expected layoutWritable:false, got ${statusBody.layoutWritable}`);

      const getRes = await getLayout(baseUrl);
      assert(getRes.status === 404, `expected GET 404 with no schemaPath, got ${getRes.status}`);

      const putRes = await putLayout(baseUrl, { User: { x: 1, y: 2 } }, null);
      assert(putRes.status === 404, `expected PUT 404 with no schemaPath, got ${putRes.status}`);
    });
  });
});

// ─── 2.10 — read-only × PUT → 403, one denied audit line, sidecar unchanged

await check(
  "PUT under readOnly:true is refused with 403, exactly one denied 'layout-write' audit line, sidecar byte-unchanged",
  async () => {
    await withDatabase(async (db) => {
      await withSchemaFile(SCHEMA_SOURCE, async ({ schemaPath, dir }) => {
        const fixture = loadFixture();
        // Seed a sidecar first, WITHOUT read-only, so we can prove the
        // refused write left it byte-unchanged.
        await withStudio(
          db,
          fixture,
          async ({ baseUrl }) => {
            const seeded = await putLayout(baseUrl, { User: { x: 5, y: 6 } }, null);
            assert(seeded.status === 200, `expected the seed write to succeed, got ${seeded.status}`);
          },
          { schemaPath },
        );

        const before = await readFile(sidecarPath(dir), "utf-8");

        await withStudio(
          db,
          fixture,
          async ({ baseUrl }) => {
            const raw = await captureLog(async () => {
              const res = await putLayout(baseUrl, { User: { x: 999, y: 999 } }, null);
              assert(res.status === 403, `expected 403, got ${res.status}`);
              const body = await res.json();
              assert(body.error === "Studio is running in read-only mode", `unexpected body ${JSON.stringify(body)}`);
            });

            const after = await readFile(sidecarPath(dir), "utf-8");
            assert(after === before, "expected the sidecar to be byte-unchanged after a denied read-only write");

            const audit = parseAuditLines(raw);
            assert(audit.length === 1, `expected exactly one audit line, got ${audit.length}`);
            assert(audit[0].op === "layout-write", `expected op:layout-write, got ${audit[0].op}`);
            assert(audit[0].outcome === "denied", `expected outcome:denied, got ${audit[0].outcome}`);
            assert(audit[0].reason === "read-only", `expected reason:read-only, got ${audit[0].reason}`);
            assert(!("table" in audit[0]), "expected no table key on a layout-write audit entry");
          },
          { readOnly: true, schemaPath },
        );
      });
    });
  },
);

// ─── 2.12 — read-only × GET → 200, reads unaffected ────────────────────────

await check("GET /api/schema/layout succeeds under readOnly:true (negative control)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_SOURCE, async ({ schemaPath }) => {
      const fixture = loadFixture();
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const res = await getLayout(baseUrl);
          assert(res.status === 200, `expected GET 200 under read-only, got ${res.status}`);
        },
        { readOnly: true, schemaPath },
      );
    });
  });
});

// ─── 2.13 — read-only + missing schemaPath: 403 from read-only gate, not 404

await check(
  "PUT with readOnly:true AND no schemaPath answers 403 from the read-only gate, never 404 (gate ordering)",
  async () => {
    await withDatabase(async (db) => {
      const fixture = loadFixture();
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const res = await putLayout(baseUrl, { User: { x: 1, y: 2 } }, null);
          assert(res.status === 403, `expected 403 (read-only gate runs first), got ${res.status}`);
        },
        { readOnly: true },
      );
    });
  },
);

// ─── read-only does not block a schema Save as a side effect ─────────────
// (schema Save independence is exercised in studio-schema-write.mjs; this
// suite stays scoped to the layout route itself.)

// ─── Unknown-key round trip: GET after PUT with an extra key is unaffected

await check("GET after a PUT with a stale key returns that key verbatim (server never prunes)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_SOURCE, async ({ schemaPath }) => {
      const fixture = loadFixture();
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          await putLayout(baseUrl, { User: { x: 1, y: 2 }, OldTable: { x: 9, y: 9 } }, null);
          const res = await getLayout(baseUrl);
          const body = await res.json();
          assert(body.positions.OldTable.x === 9, "expected the stale OldTable key to survive a read");
        },
        { schemaPath },
      );
    });
  });
});

// ─── Directory-listing: no leftover temp file after a 400 rejection ──────

await check("directory listing shows no leftover temp file after a 400-rejected PUT (2.8)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_SOURCE, async ({ schemaPath, dir }) => {
      const fixture = loadFixture();
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          const res = await putLayout(baseUrl, { User: { x: "bad", y: 1 } }, null);
          assert(res.status === 400, `expected 400, got ${res.status}`);
          const entries = await readdir(dir);
          assert(
            entries.length === 1 && entries[0] === "schema.indigo",
            `expected no sidecar or temp file after a 400, got: ${JSON.stringify(entries)}`,
          );
        },
        { schemaPath },
      );
    });
  });
});

await check("directory listing shows no leftover temp file after a 409-rejected PUT (2.8)", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_SOURCE, async ({ schemaPath, dir }) => {
      const fixture = loadFixture();
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          await putLayout(baseUrl, { User: { x: 1, y: 2 } }, null);
          const res = await putLayout(baseUrl, { User: { x: 3, y: 4 } }, null);
          assert(res.status === 409, `expected 409, got ${res.status}`);
          const entries = await readdir(dir);
          const tmp = entries.filter((e) => e !== "schema.indigo" && e !== "schema.layout.json");
          assert(tmp.length === 0, `expected no leftover temp file after a 409, got: ${JSON.stringify(tmp)}`);
        },
        { schemaPath },
      );
    });
  });
});

// ─── An externally-modified sidecar is respected as staleness ────────────

await check("PUT is refused with 409 when the sidecar was modified externally since GET", async () => {
  await withDatabase(async (db) => {
    await withSchemaFile(SCHEMA_SOURCE, async ({ schemaPath, dir }) => {
      const fixture = loadFixture();
      await withStudio(
        db,
        fixture,
        async ({ baseUrl }) => {
          await putLayout(baseUrl, { User: { x: 1, y: 2 } }, null);
          const got = await getLayout(baseUrl);
          const gotBody = await got.json();

          await writeFile(sidecarPath(dir), JSON.stringify({ User: { x: 100, y: 100 } }), "utf-8");

          const res = await putLayout(baseUrl, { User: { x: 5, y: 5 } }, gotBody.version);
          assert(res.status === 409, `expected 409, got ${res.status}`);

          const onDisk = JSON.parse(await readFile(sidecarPath(dir), "utf-8"));
          assert(onDisk.User.x === 100, "expected the sidecar to retain the externally-mutated position");
        },
        { schemaPath },
      );
    });
  });
});

strictEqual(ran, 16 + MALFORMED_CASES.length, `expected exactly ${16 + MALFORMED_CASES.length} check() cases in studio-layout.mjs`);

if (failures > 0) {
  console.error(`\n@indigodb/cli studio-layout: ${failures} failing`);
  process.exit(1);
}
console.log("\n@indigodb/cli studio-layout: all green");
