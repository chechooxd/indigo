/**
 * @indigodb/cli — Generated client strict-TypeScript compilation + runtime E2E check.
 *
 * Verifies that `generateClient()` output (with enums, list columns, Json,
 * relations, `@@realtime(columns)` with an enum field, and `@@allow`) compiles
 * cleanly under strict `tsc` and executes top-level nested writes, JSON arrays,
 * list columns, and `$transaction` against PGlite.
 */

import { strictEqual, ok } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { parse, resolve, validate } from "@indigodb/core";
import { generateClient } from "@indigodb/generator";
import { renderPushSql } from "@indigodb/migrator";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(here, "../../..");
const tscBin = resolvePath(here, "../node_modules/.bin/tsc");

const SCHEMA = `
enum Status {
  OPEN
  CLOSED
}

Table Post {
  id       Int      @id @default(autoincrement())
  ownerId  Int
  title    String
  status   Status   @default(OPEN)
  tags     String[]
  meta     Json?
  comments Comment[]

  @@realtime(columns: [id, title, status])
  @@allow(read, auth.userId == this.ownerId)
}

Table Comment {
  id     Int    @id @default(autoincrement())
  postId Int
  post   Post   @relation(fields: [postId], references: [id], onDelete: Cascade)
  body   String
}
`;

const ast = parse(SCHEMA);
const errors = validate(ast);
strictEqual(errors.length, 0, `unexpected validation errors: ${JSON.stringify(errors)}`);
const schema = resolve(ast);
const generatedTs = generateClient(schema);

const workDir = mkdtempSync(join(tmpdir(), "indigo-gen-e2e-"));
try {
  mkdirSync(join(workDir, "src", "generated"), { recursive: true });
  mkdirSync(join(workDir, "node_modules", "@indigodb"), { recursive: true });
  symlinkSync(join(repoRoot, "packages", "client"), join(workDir, "node_modules", "@indigodb", "client"), "dir");
  symlinkSync(join(repoRoot, "packages", "realtime"), join(workDir, "node_modules", "@indigodb", "realtime"), "dir");
  symlinkSync(
    join(repoRoot, "packages", "client", "node_modules", "@electric-sql"),
    join(workDir, "node_modules", "@electric-sql"),
    "dir",
  );
  symlinkSync(
    join(repoRoot, "packages", "client", "node_modules", "pg"),
    join(workDir, "node_modules", "pg"),
    "dir",
  );

  writeFileSync(
    join(workDir, "package.json"),
    JSON.stringify({ name: "gen-e2e", type: "module", private: true }),
  );
  writeFileSync(
    join(workDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022"],
        outDir: "dist",
        rootDir: "src",
        strict: true,
        skipLibCheck: true,
      },
      include: ["src/**/*.ts"],
    }),
  );
  writeFileSync(join(workDir, "src", "generated", "indigo.ts"), generatedTs);
  writeFileSync(
    join(workDir, "src", "app.ts"),
    `
import { createPGliteAdapter } from "@indigodb/client";
import { IndigoClient, Status } from "./generated/indigo.js";

export async function run(pglite: unknown) {
  const db = new IndigoClient({ db: createPGliteAdapter(pglite as never) });
  const post = await db.post.create({
    data: {
      ownerId: 7,
      title: "Nested + JSON + Array",
      status: Status.OPEN,
      tags: ["ts", "pg"],
      meta: ["json-array", 1],
      comments: {
        create: [{ body: "first comment" }],
      },
    },
  });
  const loaded = await db.post.findUnique({
    where: { id: post.id },
    include: { comments: true },
  });
  const toOneCreated = await db.comment.create({
    data: {
      body: "child with nested parent create",
      post: {
        create: {
          ownerId: 9,
          title: "Created via to-one",
          tags: ["to-one"],
        },
      },
    },
  });
  const toOneConnected = await db.comment.create({
    data: {
      body: "child with connect",
      post: { connect: { id: post.id } },
    },
  });
  const count = await db.$transaction([db.comment.count({ where: { postId: post.id } })]);
  const viaCb = await db.$transaction(async (tx) => tx.post.findMany({ where: { id: post.id } }));
  await db.$disconnect();
  return { post, loaded, toOneCreated, toOneConnected, count: count[0], viaCb };
}
`,
  );

  execFileSync(tscBin, ["-p", join(workDir, "tsconfig.json")], { stdio: "pipe" });
  console.log("  ok   generated client compiles cleanly under strict tsc");

  // Push non-WAL DDL to PGlite (strip logical replication slot statement which requires wal_level=logical)
  const ddl = renderPushSql(schema);
  const pglite = new PGlite();
  await pglite.exec(ddl);

  const { run } = await import(join(workDir, "dist", "app.js"));
  const res = await run(pglite);
  await pglite.close();

  strictEqual(res.post.title, "Nested + JSON + Array");
  ok(Array.isArray(res.post.tags) && res.post.tags[0] === "ts" && res.post.tags[1] === "pg");
  ok(Array.isArray(res.post.meta) && res.post.meta[0] === "json-array");
  strictEqual(res.loaded?.comments.length, 1);
  strictEqual(res.loaded?.comments[0].body, "first comment");
  ok(res.toOneCreated.postId > res.post.id);
  strictEqual(res.toOneConnected.postId, res.post.id);
  strictEqual(res.count, 2);
  strictEqual(res.viaCb.length, 1);
  console.log("  ok   generated client top-level nested write, String[], Json array, and $transaction work end to end");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
