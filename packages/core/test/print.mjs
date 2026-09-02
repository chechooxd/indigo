/**
 * @indigodb/core — printer regression suite.
 *
 * Plain Node, no test framework (repo convention: `parity.mjs`). Two parts:
 *
 * 1. Unit tests over hand-built `ResolvedSchema` fragments — every field/
 *    block-attribute shape and every throw path.
 * 2. A pure fixture round trip over the shared `fixtures/*.indigo` corpus:
 *    `resolve(parse(printSchema(resolved))) == normalizeForRoundTrip(resolved)`.
 *    No DB, no introspection — everything goes through `resolve.rs` on both
 *    sides. See `normalizeForRoundTrip` below for the documented, empirically
 *    verified divergences this comparison must account for.
 */

import { readdirSync, readFileSync } from "node:fs";
import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { parse, resolve, printSchema, IndigoPrintError } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../../../fixtures");

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.stack ?? err.message).split("\n").slice(0, 20).join("\n"));
  }
}

// ─── Minimal ResolvedSchema builders ────────────────────────────────────────

function schema(overrides = {}) {
  return { tables: [], enums: [], tableGroups: [], ...overrides };
}

function table(overrides = {}) {
  return {
    name: "T",
    dbName: "T",
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    indexes: [],
    relations: [],
    ...overrides,
  };
}

function col(overrides = {}) {
  return {
    name: "id",
    dbName: "id",
    type: "Int",
    isEnum: false,
    nullable: false,
    isPk: false,
    unique: false,
    autoincrement: false,
    ...overrides,
  };
}

// ─── 1. Field / column emission ─────────────────────────────────────────────

check("scalar type + ? nullability suffix", () => {
  const s = schema({
    tables: [
      table({
        columns: [
          col({ name: "id", isPk: true }),
          col({ name: "name", dbName: "name", type: "String", nullable: true }),
        ],
        primaryKey: ["id"],
      }),
    ],
  });
  const out = printSchema(s);
  strictEqual(out.includes("name String?"), true, out);
  strictEqual(out.includes("id   Int     @id"), true, out);
});

check("@default per kind: function", () => {
  const s = schema({
    tables: [
      table({
        columns: [col({ isPk: true, autoincrement: true, default: { kind: "function", name: "autoincrement" } })],
        primaryKey: ["id"],
      }),
    ],
  });
  strictEqual(printSchema(s).includes("@default(autoincrement())"), true);
});

check("@default per kind: string value quoted+escaped", () => {
  const s = schema({
    tables: [
      table({
        columns: [col({ name: "label", type: "String", default: { kind: "value", value: 'say "hi"' } })],
      }),
    ],
  });
  strictEqual(printSchema(s).includes('@default("say \\"hi\\"")'), true);
});

check("@default per kind: raw number", () => {
  const s = schema({
    tables: [
      table({ columns: [col({ name: "count", type: "Int", default: { kind: "value", value: -3.5 } })] }),
    ],
  });
  strictEqual(printSchema(s).includes("@default(-3.5)"), true);
});

check("@default per kind: boolean", () => {
  const s = schema({
    tables: [
      table({ columns: [col({ name: "enabled", type: "Boolean", default: { kind: "value", value: true } })] }),
    ],
  });
  strictEqual(printSchema(s).includes("@default(true)"), true);
});

check("@default per kind: enum emits bare identifier, not a string", () => {
  const s = schema({
    tables: [
      table({
        columns: [
          col({ name: "role", type: "Role", isEnum: true, default: { kind: "value", value: "ADMIN" } }),
        ],
      }),
    ],
  });
  const out = printSchema(s);
  strictEqual(out.includes("@default(ADMIN)"), true, out);
  strictEqual(out.includes('@default("ADMIN")'), false, out);
});

check("@db.X native type override, with and without args", () => {
  const s = schema({
    tables: [
      table({
        columns: [
          col({ name: "id", type: "String", nativeType: { name: "Uuid", args: [] } }),
          col({ name: "price", type: "Float", nativeType: { name: "Numeric", args: ["10", "2"] } }),
        ],
      }),
    ],
  });
  const out = printSchema(s);
  strictEqual(out.includes("@db.Uuid"), true, out);
  strictEqual(out.includes("@db.Numeric(10, 2)"), true, out);
});

check("field-attribute fixed order: @id @unique @default @db.X @map @note", () => {
  const s = schema({
    tables: [
      table({
        columns: [
          col({
            name: "sku",
            dbName: "sku_code",
            type: "String",
            isPk: true,
            unique: true,
            default: { kind: "value", value: "X" },
            nativeType: { name: "VarChar", args: ["10"] },
            note: "hi",
          }),
        ],
        primaryKey: ["sku_code"],
      }),
    ],
  });
  const out = printSchema(s);
  const idx = {
    id: out.indexOf("@id"),
    unique: out.indexOf("@unique"),
    def: out.indexOf("@default"),
    db: out.indexOf("@db."),
    map: out.indexOf("@map"),
    note: out.indexOf("@note"),
  };
  strictEqual(idx.id < idx.unique, true, out);
  strictEqual(idx.unique < idx.def, true, out);
  strictEqual(idx.def < idx.db, true, out);
  strictEqual(idx.db < idx.map, true, out);
  strictEqual(idx.map < idx.note, true, out);
});

// ─── 3. @map conditional emission ───────────────────────────────────────────

check("@map emitted only when dbName diverges (field)", () => {
  const s = schema({
    tables: [
      table({
        columns: [
          col({ name: "createdAt", dbName: "created_at", type: "DateTime" }),
          col({ name: "id", dbName: "id" }),
        ],
      }),
    ],
  });
  const out = printSchema(s);
  strictEqual(out.includes('@map("created_at")'), true, out);
  strictEqual(/\bid\s+Int\s+@map/.test(out), false, out);
});

check("@@map emitted only when table dbName diverges", () => {
  const mapped = printSchema(schema({ tables: [table({ name: "Widget", dbName: "widgets", columns: [col()] })] }));
  strictEqual(mapped.includes('@@map("widgets")'), true, mapped);
  const unmapped = printSchema(schema({ tables: [table({ name: "Widget", dbName: "Widget", columns: [col()] })] }));
  strictEqual(unmapped.includes("@@map"), false, unmapped);
});

check("enum member @map only when db value diverges from identifier", () => {
  const s = schema({
    enums: [
      {
        name: "Status",
        values: ["ACTIVE", "INACTIVE"],
        members: [
          { name: "ACTIVE", dbName: "active" },
          { name: "INACTIVE", dbName: "INACTIVE" },
        ],
      },
    ],
  });
  const out = printSchema(s);
  strictEqual(out.includes('ACTIVE @map("active")'), true, out);
  strictEqual(/INACTIVE\s+@map/.test(out), false, out);
});

// ─── 5. / 7. Primary keys ────────────────────────────────────────────────────

check("single-column PK emits field-level @id", () => {
  const s = schema({ tables: [table({ columns: [col({ isPk: true })], primaryKey: ["id"] })] });
  strictEqual(printSchema(s).includes("@id"), true);
});

check("composite PK emits repeated field-level @id, no @@id([...])", () => {
  const s = schema({
    tables: [
      table({
        columns: [
          col({ name: "a", dbName: "a", isPk: true }),
          col({ name: "b", dbName: "b", type: "Int", isPk: true }),
        ],
        primaryKey: ["a", "b"],
      }),
    ],
  });
  const out = printSchema(s);
  strictEqual((out.match(/@id/g) ?? []).length, 2, out);
  strictEqual(out.includes("@@id("), false, out);
});

check("throws when primaryKey order is not a subsequence of column declaration order", () => {
  const s = schema({
    tables: [
      table({
        columns: [
          col({ name: "a", dbName: "a", isPk: true }),
          col({ name: "b", dbName: "b", isPk: true }),
        ],
        // declared b, a — reversed relative to column order
        primaryKey: ["b", "a"],
      }),
    ],
  });
  throws(() => printSchema(s), IndigoPrintError);
});

// ─── 9./10. Enum blocks ──────────────────────────────────────────────────────

check("enum block uses `members` when present, else falls back to `values`", () => {
  const withMembers = printSchema(schema({ enums: [{ name: "E", values: ["A"], members: [{ name: "A", dbName: "a" }] }] }));
  strictEqual(withMembers.includes('A @map("a")'), true, withMembers);
  const valuesOnly = printSchema(schema({ enums: [{ name: "E", values: ["A", "B"] }] }));
  strictEqual(valuesOnly.includes("A\n") || valuesOnly.includes("A}"), true, valuesOnly);
  strictEqual(valuesOnly.includes("@map"), false, valuesOnly);
});

// ─── 11./12. Index / unique blocks ──────────────────────────────────────────

check("@@index / @@unique: name:/type: args + fixed block order incl. @@realtime/@@note", () => {
  const s = schema({
    tables: [
      table({
        name: "User",
        dbName: "users",
        columns: [col({ name: "email", dbName: "email", type: "String" }), col({ name: "tags", dbName: "tags", type: "String" })],
        indexes: [
          { columns: ["email"], unique: false, name: "user_email_idx" },
          { columns: ["tags"], unique: false, type: "gin" },
          { columns: ["email", "tags"], unique: true, name: "user_email_tags_key" },
        ],
        realtime: true,
        note: "A user",
      }),
    ],
  });
  const out = printSchema(s);
  strictEqual(out.includes('@@index([email], name: "user_email_idx")'), true, out);
  strictEqual(out.includes("@@index([tags], type: gin)"), true, out);
  strictEqual(out.includes('@@unique([email, tags], name: "user_email_tags_key")'), true, out);
  const order = ["@@map", "@@unique(", "@@index(", "@@realtime", "@@note"].map((tok) => out.indexOf(tok));
  const present = order.filter((i) => i !== -1);
  const sorted = [...present].sort((a, b) => a - b);
  deepStrictEqual(present, sorted, out);
});

check("throws when an index column has no matching field dbName", () => {
  const s = schema({
    tables: [table({ columns: [col()], indexes: [{ columns: ["ghost"], unique: false }] })],
  });
  throws(() => printSchema(s), IndigoPrintError);
});

// ─── 15./16. @@realtime ─────────────────────────────────────────────────────

check("@@realtime emitted only when resolved with realtime true", () => {
  const on = printSchema(schema({ tables: [table({ columns: [col()], realtime: true })] }));
  strictEqual(on.includes("@@realtime"), true, on);
  const off = printSchema(schema({ tables: [table({ columns: [col()] })] }));
  strictEqual(off.includes("@@realtime"), false, off);
});

check("@@realtime(columns: [...]) emitted for a non-empty allowlist", () => {
  const s = schema({
    tables: [
      table({
        columns: [col({ name: "id" }), col({ name: "status", dbName: "status", type: "String" })],
        realtimeColumns: ["id", "status"],
      }),
    ],
  });
  const out = printSchema(s);
  strictEqual(out.includes("@@realtime(columns: [id, status])"), true, out);
  strictEqual(/@@realtime\s*$/m.test(out), false, out);
});

check("@@realtime(columns: []) prints the empty list, not bare @@realtime, and round-trips as []", () => {
  const s = schema({
    tables: [table({ name: "T", dbName: "T", columns: [col({ name: "id" })], realtimeColumns: [] })],
  });
  const out = printSchema(s);
  strictEqual(out.includes("@@realtime(columns: [])"), true, out);
  const reresolved = resolve(parse(out));
  deepStrictEqual(reresolved.tables[0].realtimeColumns, []);
});

// ─── 17./18./19./20. Raw FK comments ───────────────────────────────────────

check("raw FK prints as structured comment, no @relation(...) synthesis", () => {
  const s = schema({
    tables: [
      table({
        name: "Post",
        dbName: "Post",
        columns: [col({ name: "id", isPk: true }), col({ name: "authorId", dbName: "authorId", type: "Int" })],
        primaryKey: ["id"],
        foreignKeys: [
          {
            columns: ["authorId"],
            refTable: "User",
            refColumns: ["id"],
            onDelete: "CASCADE",
            name: "post_author_fkey",
          },
        ],
      }),
      table({ name: "User", dbName: "User", columns: [col({ name: "id", isPk: true })], primaryKey: ["id"] }),
    ],
  });
  const out = printSchema(s);
  strictEqual(
    out.includes(
      '// @fk(fields: [authorId], references: [id], model: User, onDelete: Cascade, name: "post_author_fkey")',
    ),
    true,
    out,
  );
  strictEqual(out.includes("@relation("), false, out);
});

check("REFERENTIAL_ACTIONS maps every SQL action back to schema spelling", () => {
  const pairs = [
    ["CASCADE", "Cascade"],
    ["RESTRICT", "Restrict"],
    ["SET NULL", "SetNull"],
    ["SET DEFAULT", "SetDefault"],
    ["NO ACTION", "NoAction"],
  ];
  for (const [sql, schemaWord] of pairs) {
    const s = schema({
      tables: [
        table({
          name: "A",
          dbName: "A",
          columns: [col({ name: "id", isPk: true }), col({ name: "bId", dbName: "bId", type: "Int" })],
          primaryKey: ["id"],
          foreignKeys: [{ columns: ["bId"], refTable: "B", refColumns: ["id"], onDelete: sql }],
        }),
        table({ name: "B", dbName: "B", columns: [col({ name: "id", isPk: true })], primaryKey: ["id"] }),
      ],
    });
    strictEqual(printSchema(s).includes(`onDelete: ${schemaWord}`), true, sql);
  }
});

check("optional FK args (name, onDelete, onUpdate) appear only when present", () => {
  const s = schema({
    tables: [
      table({
        name: "A",
        dbName: "A",
        columns: [col({ name: "id", isPk: true }), col({ name: "bId", dbName: "bId", type: "Int" })],
        primaryKey: ["id"],
        foreignKeys: [{ columns: ["bId"], refTable: "B", refColumns: ["id"] }],
      }),
      table({ name: "B", dbName: "B", columns: [col({ name: "id", isPk: true })], primaryKey: ["id"] }),
    ],
  });
  const out = printSchema(s);
  strictEqual(out.includes("// @fk(fields: [bId], references: [id], model: B)"), true, out);
});

check("throws when FK refTable has no matching table", () => {
  const s = schema({
    tables: [
      table({
        name: "A",
        dbName: "A",
        columns: [col({ name: "id", isPk: true }), col({ name: "bId", dbName: "bId", type: "Int" })],
        primaryKey: ["id"],
        foreignKeys: [{ columns: ["bId"], refTable: "Missing", refColumns: ["id"] }],
      }),
    ],
  });
  throws(() => printSchema(s), IndigoPrintError);
});

check("throws when an FK column has no matching field dbName", () => {
  const s = schema({
    tables: [
      table({
        name: "A",
        dbName: "A",
        columns: [col({ name: "id", isPk: true })],
        primaryKey: ["id"],
        foreignKeys: [{ columns: ["ghost"], refTable: "A", refColumns: ["id"] }],
      }),
    ],
  });
  throws(() => printSchema(s), IndigoPrintError);
});

// ─── @@allow ─────────────────────────────────────────────────────────────

check("@@allow: multiple rules print as separate lines in IR order; claim operand prints auth.<name>", () => {
  const s = schema({
    tables: [
      table({
        columns: [col({ name: "id" }), col({ name: "ownerId", dbName: "ownerId", type: "Int" })],
        allow: [
          { action: "read", left: { kind: "claim", name: "userId" }, right: { kind: "field", name: "ownerId" } },
          { action: "read", left: { kind: "field", name: "ownerId" }, right: { kind: "claim", name: "userId" } },
        ],
      }),
    ],
  });
  const out = printSchema(s);
  const first = out.indexOf("@@allow(read, auth.userId == this.ownerId)");
  const second = out.indexOf("@@allow(read, this.ownerId == auth.userId)");
  strictEqual(first !== -1, true, out);
  strictEqual(second !== -1, true, out);
  strictEqual(first < second, true, out);
});

check("@@allow: field operand prints the schema field name, not the mapped dbName", () => {
  const s = schema({
    tables: [
      table({
        columns: [
          col({ name: "id" }),
          col({ name: "ownerId", dbName: "owner_id", type: "Int" }),
        ],
        allow: [
          { action: "read", left: { kind: "claim", name: "userId" }, right: { kind: "field", name: "owner_id" } },
        ],
      }),
    ],
  });
  const out = printSchema(s);
  strictEqual(out.includes("this.ownerId"), true, out);
  strictEqual(out.includes("this.owner_id"), false, out);
});

check("@@allow: write/all sugar prints expanded, never re-collapsed (18-allow-rules.indigo)", () => {
  const source = readFileSync(join(fixturesDir, "18-allow-rules.indigo"), "utf8");
  const resolved = resolve(parse(source));
  const out = printSchema(resolved);
  strictEqual(out.includes("@@allow(create, auth.userId == this.ownerId)"), true, out);
  strictEqual(out.includes("@@allow(update, auth.userId == this.ownerId)"), true, out);
  strictEqual(out.includes("@@allow(delete, auth.userId == this.ownerId)"), true, out);
  strictEqual(out.includes("@@allow(write,"), false, out);
  strictEqual(out.includes("@@allow(all,"), false, out);
});

// ─── TableGroup ──────────────────────────────────────────────────────────

check("TableGroup blocks print after all model/enum blocks", () => {
  const s = schema({
    tables: [table({ name: "A", dbName: "A", columns: [col()] })],
    enums: [{ name: "E", values: ["X"] }],
    tableGroups: [{ name: "G1", color: "#ff0000", tables: ["A"] }],
  });
  const out = printSchema(s);
  const groupIdx = out.indexOf('TableGroup "G1"');
  strictEqual(groupIdx !== -1, true, out);
  const tableEnd = out.indexOf("Table A {") + out.slice(out.indexOf("Table A {")).indexOf("}");
  const enumEnd = out.indexOf("enum E {") + out.slice(out.indexOf("enum E {")).indexOf("}");
  strictEqual(groupIdx > tableEnd, true, out);
  strictEqual(groupIdx > enumEnd, true, out);
});

check("TableGroup 'last group wins' overlap round-trips faithfully (04-tablegroup-edge.indigo)", () => {
  const source = readFileSync(join(fixturesDir, "04-tablegroup-edge.indigo"), "utf8");
  const original = resolve(parse(source));
  const printed = printSchema(original);
  const reresolved = resolve(parse(printed));
  deepStrictEqual(reresolved.tableGroups, original.tableGroups);
  const reA = reresolved.tables.find((t) => t.name === "A");
  strictEqual(reA.group, "NoColor");
  strictEqual(reA.color, undefined);
});

check("TableGroup printing reads schema.tableGroups, not the inconsistent derived table.color/table.group", () => {
  const s = schema({
    tables: [
      table({
        name: "A",
        dbName: "A",
        columns: [col()],
        color: "bogus",
        group: "NotReal",
      }),
    ],
    tableGroups: [{ name: "Real", tables: ["A"] }],
  });
  const out = printSchema(s);
  strictEqual(out.includes('TableGroup "Real"'), true, out);
  strictEqual(out.includes('TableGroup "NotReal"'), false, out);
  strictEqual(out.includes("bogus"), false, out);
});

// ─── 21./22. Determinism, LF-only, single trailing newline ─────────────────

check("printSchema is pure: identical IR prints byte-identical text twice", () => {
  const s = schema({ tables: [table({ columns: [col({ isPk: true })], primaryKey: ["id"] })] });
  strictEqual(printSchema(s), printSchema(s));
});

check("output is LF-only with exactly one trailing newline", () => {
  const s = schema({ tables: [table({ columns: [col({ isPk: true })], primaryKey: ["id"] })] });
  const out = printSchema(s);
  strictEqual(out.includes("\r"), false);
  strictEqual(out.endsWith("\n"), true);
  strictEqual(out.endsWith("\n\n"), false);
});

check("IndigoPrintError is a real Error subclass", () => {
  const err = new IndigoPrintError("x");
  strictEqual(err instanceof Error, true);
  strictEqual(err.name, "IndigoPrintError");
});

// ─── 23./24. Pure fixture round trip ────────────────────────────────────────

/**
 * EMPIRICAL FINDING (this test suite verified it directly, rather than
 * trusting the "never resolve successfully" framing suggested by the
 * fixture filenames / design doc prose): every `NN-rejected-*.indigo`
 * fixture in this corpus PARSES and RESOLVES successfully. "Rejected"
 * describes `validate()` diagnostics (unknown attribute, unknown native
 * type, bad index args, ...), not a parse/resolve failure — `resolve()`
 * only reads recognized attributes and silently drops the rest (e.g.
 * `@@id([...])`, `@updatedAt`, `@@ignore` never reach the IR at all), so
 * there is nothing structurally unrepresentable for the printer here for
 * most of these fixtures — they round-trip cleanly and are INCLUDED below.
 *
 * Three fixtures genuinely cannot round-trip. Each is a case where the
 * printer PROVABLY THROWS — a different category from a normalizer field
 * exclusion (which would silently drop data instead):
 *
 * - `05-relations.indigo`: its `ghost` relation deliberately references
 *   unresolved local/target columns (`missingLocal`/`missingTarget`) to
 *   exercise validate.rs's unknown-reference diagnostics. `resolve.rs`
 *   still structurally records this as a `ForeignKey` carrying those
 *   dangling physical column names. The printer's "throw, never guess"
 *   invariant (spec: Loud Failure on Unmappable Constructs) means it
 *   correctly THROWS `IndigoPrintError` trying to map
 *   `missingLocal`/`missingTarget` back to field names that do not exist on
 *   the referenced table (currently inside `printFkComment`; PR 2 moves this
 *   to `printRelationField` once relation claiming lands).
 * - `19-rejected-allow.indigo`: `UnknownField`'s `@@allow(read, auth.userId
 *   == this.owner)` resolves to `{kind:"field", name:"owner"}`, but no
 *   column on that table carries the physical `dbName` "owner" — `owner` is
 *   an unresolved reference `resolve.rs` records verbatim. `fieldNameFor`
 *   throws inside `printAllowOperand`.
 * - `21-rejected-realtime-columns.indigo`: `UnknownColumn`'s
 *   `@@realtime(columns: [id, ghostField])` resolves to `realtimeColumns:
 *   ["id", "ghostField"]`, but no column carries the physical `dbName`
 *   "ghostField". `fieldNameFor` throws inside the `@@realtime(columns:)`
 *   branch of `printTable`.
 *
 * A dedicated test below pins each fixture's exact throw.
 */
const UNPRINTABLE_FIXTURES = new Set([
  "05-relations.indigo",
  "19-rejected-allow.indigo",
  "21-rejected-realtime-columns.indigo",
]);

/**
 * Normalizes a `ResolvedSchema` for round-trip comparison. Two categories of
 * documented, real divergence remain — verified empirically against this
 * corpus, not assumed:
 *
 * 1. Relations/foreign keys (PR 2's job, still excluded here): `.indigo` has
 *    no bare-FK syntax — FKs only exist via `@relation(fields:,
 *    references:)` on a relation field, and this PR deliberately does NOT
 *    yet synthesize `@relation(...)` (raw FKs print as lexer-invisible
 *    comments instead, spec: Raw Foreign Key Output). So re-resolving
 *    printed text always yields empty `foreignKeys`/`relations` for tables
 *    that had them. Dropped on both sides for comparison. PR 2 deletes this
 *    exclusion once `claimForeignKeys`/`printRelationField` land.
 * 2. Index/unique ordering (permanent): the spec's fixed block-attribute
 *    order (`@@map` -> `@@unique` -> `@@index` -> `@@realtime` -> `@@allow`
 *    -> `@@note`) means the printer always emits every `@@unique` before
 *    every `@@index`, regardless of how the original schema interleaved
 *    them (see fixture 16, which interleaves unique/non-unique indexes).
 *    Re-resolving the printed text therefore yields `indexes` re-bucketed
 *    (all `unique: true` first, in original relative order, then all
 *    `unique: false`, in original relative order) rather than in the
 *    original array order. This is the printer's fixed emission order
 *    working as designed, not a bug, so the "expected" side is re-bucketed
 *    identically for comparison.
 *
 * Everything else — `tableGroups`, `color`, `group`, `allow`,
 * `realtimeColumns` — is now printed and compared in full as of this PR.
 * Adding an exclusion beyond these two re-opens the exact blind spot this
 * change closes: any new entry MUST name the IR field and why it is
 * unrepresentable, and MUST be called out in the verify report.
 *
 * NOTE on the design doc's identity-column caveat ("introspect.ts emits
 * `{autoincrement:true}` with no `default`, while resolve.rs emits
 * `{autoincrement:true, default:{...}}`"): that asymmetry is specific to
 * the DB-introspection producer (`introspect.ts`), which never runs in
 * this pure fixture round trip — both the original and the reprinted side
 * go through `resolve.rs` exclusively. Empirically, no such divergence was
 * observed here, so this normalizer does NOT special-case identity
 * defaults.
 */
function normalizeForRoundTrip(resolved) {
  return {
    ...resolved,
    tables: resolved.tables.map((t) => {
      // `indexes`: re-bucketed (unique first, then non-unique, each group's
      // relative order preserved) because the printer's fixed emission
      // order groups `@@unique` before `@@index` — a documented ordering
      // artifact, not a dropped field. The one permitted exclusion.
      const indexes = [...t.indexes.filter((i) => i.unique), ...t.indexes.filter((i) => !i.unique)];
      return { ...t, indexes, foreignKeys: [], relations: [] };
    }),
  };
}

const allFixtures = readdirSync(fixturesDir).filter((f) => f.endsWith(".indigo")).sort();
const roundTripFixtures = allFixtures.filter((f) => !UNPRINTABLE_FIXTURES.has(f));

console.log(`round trip: ${roundTripFixtures.length}/${allFixtures.length} fixtures in scope`);

for (const file of roundTripFixtures) {
  check(`round trip: ${file}`, () => {
    const source = readFileSync(join(fixturesDir, file), "utf8");
    const original = resolve(parse(source));
    const printed = printSchema(original);
    const reresolved = resolve(parse(printed));
    deepStrictEqual(JSON.parse(JSON.stringify(reresolved)), JSON.parse(JSON.stringify(normalizeForRoundTrip(original))));
  });
}

// Confirm each excluded fixture behaves exactly as documented, and that
// "rejected" fixtures in general are NOT excluded merely because their name
// says "rejected" — only these three, because they resolve successfully but
// printSchema throws.
for (const file of UNPRINTABLE_FIXTURES) {
  check(`${file} resolves but printSchema throws (confirms exclusion reason)`, () => {
    const resolved = resolve(parse(readFileSync(join(fixturesDir, file), "utf8")));
    throws(() => printSchema(resolved), IndigoPrintError);
  });
}

if (failures > 0) {
  console.error(`\nprint: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nprint: all green");
