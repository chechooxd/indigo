/**
 * @indigodb/core — Schema printer
 *
 * `printSchema` is the inverse of `parse` + `resolve` for the subset of
 * `ResolvedSchema` that `.indigo` can express: a pure, I/O-free function
 * `(ResolvedSchema) -> string`. It throws `IndigoPrintError` — never emits
 * partial/best-guess text — on any IR construct it cannot represent
 * losslessly (unmappable physical names, ambiguous FK-to-relation
 * cross-references) and on genuine ambiguity (two relation fields claiming
 * the same foreign key). One shape is deliberate, documented dual behavior
 * rather than a guess: a foreign key with no matching relation metadata
 * (the `db pull` introspection shape, `relations: []`) prints as a plain
 * scalar column with its FK data in `// @fk(...)` comment form — this is
 * the correct and only representation for that path until a future
 * `db-pull-relation-synthesis` change adds relation-field-name synthesis.
 *
 * Deterministic emission order: header comment -> datasource -> enums ->
 * tables, with each collection's IR array order preserved verbatim
 * (ordering stability is the producer's job, not the printer's).
 */

import type { AttributeValue } from "@indigodb/ast";
import type {
  AllowOperand,
  AllowRule,
  ForeignKey,
  ResolvedColumn,
  ResolvedEnum,
  ResolvedIndex,
  ResolvedRelation,
  ResolvedSchema,
  ResolvedTable,
  ResolvedTableGroup,
} from "./ir.js";

export interface PrintOptions {
  /** Free text emitted as a leading `//` comment block (CLI passes the pull banner). */
  header?: string;
  /** Indent unit. Default two spaces. */
  indent?: string;
}

/** Thrown when the IR contains a construct `printSchema` cannot represent losslessly. */
export class IndigoPrintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndigoPrintError";
  }
}

/**
 * Schema spelling <-> SQL-ready text for `@relation(onDelete:/onUpdate:)`.
 * `resolve.rs` stores the SQL side (`"CASCADE"`, `"SET NULL"`, ...) on
 * `ForeignKey.onDelete`/`onUpdate`; printing inverts it back to the schema
 * identifier a `.indigo` author would write.
 */
const REFERENTIAL_ACTIONS: [schema: string, sql: string][] = [
  ["Cascade", "CASCADE"],
  ["Restrict", "RESTRICT"],
  ["SetNull", "SET NULL"],
  ["SetDefault", "SET DEFAULT"],
  ["NoAction", "NO ACTION"],
];

function schemaActionFromSql(sql: string): string {
  const found = REFERENTIAL_ACTIONS.find(([, s]) => s === sql);
  if (!found) {
    throw new IndigoPrintError(
      `Unknown referential action SQL text "${sql}" — not in the 5-entry REFERENTIAL_ACTIONS domain`,
    );
  }
  return found[0];
}

/** Quotes and escapes a string the same way `.indigo` string literals are written. */
function quoteString(value: string): string {
  return JSON.stringify(value);
}

function printAttributeValue(value: AttributeValue): string {
  switch (value.kind) {
    case "string":
      return quoteString(value.value);
    case "number":
      return String(value.value);
    case "boolean":
      return String(value.value);
    case "reference":
      return value.value;
    case "function":
      return `${value.name}(${value.args.map(printAttributeValue).join(", ")})`;
    case "array":
      return `[${value.values.map(printAttributeValue).join(", ")}]`;
    case "path":
    case "comparison":
      // `@@allow` values (realtime-rls-allow-rule PR A) never reach this
      // function today — printSchema only calls it for `datasource.url` and
      // its own recursive `function`/`array` args, neither of which can
      // carry a path/comparison. Throwing (not silently printing a guess)
      // matches this module's contract if that ever changes.
      throw new IndigoPrintError(
        `Cannot print an "@@allow" ${value.kind} value — printSchema does not support it yet.`,
      );
  }
}

function printDatasource(schema: ResolvedSchema, indent: string): string {
  const ds = schema.datasource!;
  const lines = [
    `${indent}provider = ${quoteString(ds.provider)}`,
    `${indent}url = ${printAttributeValue(ds.url)}`,
  ];
  return `datasource ${ds.name} {\n${lines.join("\n")}\n}`;
}

function printEnum(en: ResolvedEnum): string {
  const members = en.members ?? en.values.map((name) => ({ name, dbName: name }));
  const lines = members.map((m) => {
    const mapPart = m.dbName !== m.name ? ` @map(${quoteString(m.dbName)})` : "";
    return `  ${m.name}${mapPart}`;
  });
  return `enum ${en.name} {\n${lines.join("\n")}\n}`;
}

/** Finds the field (schema) name for a physical column name on a table, or throws. */
function fieldNameFor(table: ResolvedTable, dbName: string): string {
  const col = table.columns.find((c) => c.dbName === dbName);
  if (!col) {
    throw new IndigoPrintError(
      `Table "${table.name}": column with physical name "${dbName}" has no matching field — cannot print`,
    );
  }
  return col.name;
}

/**
 * Throws unless `table.primaryKey` (physical column names) appears, in
 * order, as a subsequence of `table.columns` declaration order — the
 * ordering `resolve.rs` relies on when deriving a composite PK from
 * repeated field-level `@id` attributes.
 */
function checkPrimaryKeySubsequence(table: ResolvedTable): void {
  if (table.primaryKey.length === 0) return;
  const declOrder = table.columns.map((c) => c.dbName);
  let cursor = -1;
  for (const pkCol of table.primaryKey) {
    const found = declOrder.indexOf(pkCol, cursor + 1);
    if (found === -1) {
      throw new IndigoPrintError(
        `Table "${table.name}": primary key column order [${table.primaryKey.join(", ")}] ` +
          `is not a subsequence of the table's column declaration order [${declOrder.join(", ")}]`,
      );
    }
    cursor = found;
  }
}

function printDefault(col: ResolvedColumn): string {
  const d = col.default;
  if (!d) return "";
  if (d.kind === "function") return `${d.name}()`;
  if (col.isEnum) return String(d.value);
  if (typeof d.value === "string") return quoteString(d.value);
  return String(d.value);
}

function fieldAttrs(col: ResolvedColumn): string[] {
  const attrs: string[] = [];
  if (col.isPk) attrs.push("@id");
  if (col.unique) attrs.push("@unique");
  if (col.default) attrs.push(`@default(${printDefault(col)})`);
  if (col.nativeType) {
    const argsPart = col.nativeType.args.length ? `(${col.nativeType.args.join(", ")})` : "";
    attrs.push(`@db.${col.nativeType.name}${argsPart}`);
  }
  if (col.dbName !== col.name) attrs.push(`@map(${quoteString(col.dbName)})`);
  if (col.note !== undefined) attrs.push(`@note(${quoteString(col.note)})`);
  return attrs;
}

function arrayEq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Whether `rel` is the FK-holding side. `pair_relations` (`resolve.rs:592-597`)
 * back-fills the holder's `fkColumns`/`refColumns` onto the paired inverse
 * side and sets `inverse: true` — so `fkColumns.length > 0` ALONE is not
 * sufficient (the inverse side carries them too). Design D1.
 */
function isRelationHolder(rel: ResolvedRelation): boolean {
  return rel.inverse !== true && rel.fkColumns.length > 0;
}

/**
 * Partitions `table.foreignKeys` into FKs claimed by a holder relation field
 * and orphan FKs (no matching relation — the `db pull` introspection shape).
 * Throws `IndigoPrintError` on any ambiguity (design D3): a relation
 * matching >=2 FKs, or an FK matched by >=2 relations. A claimed FK carrying
 * `name` also throws (design D4) — `.indigo`'s `@relation(...)` has no
 * `name:` argument to print it, and this branch is unreached by the corpus
 * (0/21 FKs carry a name).
 */
function claimForeignKeys(
  schema: ResolvedSchema,
  table: ResolvedTable,
): { fkFor: Map<ResolvedRelation, ForeignKey | undefined>; orphans: ForeignKey[] } {
  const fkFor = new Map<ResolvedRelation, ForeignKey | undefined>();
  const claimedBy = new Map<ForeignKey, ResolvedRelation>();

  for (const rel of table.relations) {
    if (!isRelationHolder(rel)) continue;

    const targetTable = schema.tables.find((t) => t.name === rel.targetModel);
    if (!targetTable) {
      throw new IndigoPrintError(
        `Table "${table.name}": relation field "${rel.name}" references unknown model "${rel.targetModel}"`,
      );
    }

    const matches = table.foreignKeys.filter(
      (fk) => arrayEq(fk.columns, rel.fkColumns) && fk.refTable === targetTable.dbName,
    );

    if (matches.length > 1) {
      throw new IndigoPrintError(
        `Table "${table.name}": relation field "${rel.name}" matches ${matches.length} foreign keys ` +
          `with identical column set [${rel.fkColumns.join(", ")}] targeting "${targetTable.dbName}" — ` +
          `cannot determine onDelete/onUpdate`,
      );
    }

    const fk = matches[0];
    if (fk !== undefined) {
      const claimant = claimedBy.get(fk);
      if (claimant !== undefined) {
        throw new IndigoPrintError(
          `Table "${table.name}": foreign key on [${fk.columns.join(", ")}] is claimed by both ` +
            `"${claimant.name}" and "${rel.name}"`,
        );
      }
      if (fk.name !== undefined) {
        throw new IndigoPrintError(
          `Table "${table.name}": relation field "${rel.name}" claims a foreign key carrying a ` +
            `constraint name ("${fk.name}") — .indigo's @relation(...) has no name: argument to print it`,
        );
      }
      claimedBy.set(fk, rel);
    }

    fkFor.set(rel, fk);
  }

  const orphans = table.foreignKeys.filter((fk) => !claimedBy.has(fk));
  return { fkFor, orphans };
}

/**
 * Prints one relation field. Non-holder sides (inverse/paired) emit the bare
 * type plus an optional `@relation("name")`; holder sides emit the full
 * `@relation(fields:, references:, onDelete:, onUpdate:)` clause. `fields:`/
 * `references:` are only emitted when their array is non-empty (design D9).
 */
function printRelationField(
  schema: ResolvedSchema,
  table: ResolvedTable,
  rel: ResolvedRelation,
  fk: ForeignKey | undefined,
): { name: string; type: string; attrs: string[] } {
  const type = `${rel.targetModel}${rel.list ? "[]" : rel.optional ? "?" : ""}`;

  if (!isRelationHolder(rel)) {
    const attrs = rel.relationName === undefined ? [] : [`@relation(${quoteString(rel.relationName)})`];
    return { name: rel.name, type, attrs };
  }

  const targetTable = schema.tables.find((t) => t.name === rel.targetModel);
  if (!targetTable) {
    throw new IndigoPrintError(
      `Table "${table.name}": relation field "${rel.name}" references unknown model "${rel.targetModel}"`,
    );
  }

  const args: string[] = [];
  if (rel.relationName !== undefined) args.push(quoteString(rel.relationName));
  if (rel.fkColumns.length > 0) {
    args.push(`fields: [${rel.fkColumns.map((c) => fieldNameFor(table, c)).join(", ")}]`);
  }
  if (rel.refColumns.length > 0) {
    args.push(`references: [${rel.refColumns.map((c) => fieldNameFor(targetTable, c)).join(", ")}]`);
  }
  if (fk?.onDelete !== undefined) args.push(`onDelete: ${schemaActionFromSql(fk.onDelete)}`);
  if (fk?.onUpdate !== undefined) args.push(`onUpdate: ${schemaActionFromSql(fk.onUpdate)}`);

  return { name: rel.name, type, attrs: [`@relation(${args.join(", ")})`] };
}

/**
 * Scalar columns and relation fields share one aligned block, relation rows
 * appended after all scalars in `table.relations` IR order (design D5) —
 * interleaving is unrecoverable from the IR, and joint padding keeps output
 * diff-stable.
 */
function printFieldLines(
  schema: ResolvedSchema,
  table: ResolvedTable,
  indent: string,
  fkFor: Map<ResolvedRelation, ForeignKey | undefined>,
): string[] {
  const columnRows = table.columns.map((col) => ({
    name: col.name,
    type: `${col.type}${col.list ? "[]" : col.nullable ? "?" : ""}`,
    attrs: fieldAttrs(col),
  }));
  const relationRows = table.relations.map((rel) => printRelationField(schema, table, rel, fkFor.get(rel)));
  const rows = [...columnRows, ...relationRows];
  const nameWidth = rows.reduce((max, r) => Math.max(max, r.name.length), 0);
  const typeWidth = rows.reduce((max, r) => Math.max(max, r.type.length), 0);
  return rows.map((r) => {
    const namePad = r.name.padEnd(nameWidth);
    const typePad = r.attrs.length > 0 ? r.type.padEnd(typeWidth) : r.type;
    return `${indent}${namePad} ${typePad} ${r.attrs.join(" ")}`.trimEnd();
  });
}

function printFkComment(schema: ResolvedSchema, table: ResolvedTable, fk: ForeignKey): string {
  const refTable = schema.tables.find((t) => t.dbName === fk.refTable);
  if (!refTable) {
    throw new IndigoPrintError(
      `Table "${table.name}": foreign key references unknown table (physical name "${fk.refTable}")`,
    );
  }
  const fields = fk.columns.map((c) => fieldNameFor(table, c));
  const references = fk.refColumns.map((c) => fieldNameFor(refTable, c));
  const parts = [
    `fields: [${fields.join(", ")}]`,
    `references: [${references.join(", ")}]`,
    `model: ${refTable.name}`,
  ];
  if (fk.onDelete !== undefined) parts.push(`onDelete: ${schemaActionFromSql(fk.onDelete)}`);
  if (fk.onUpdate !== undefined) parts.push(`onUpdate: ${schemaActionFromSql(fk.onUpdate)}`);
  if (fk.name !== undefined) parts.push(`name: ${quoteString(fk.name)}`);
  return `// @fk(${parts.join(", ")})`;
}

function printIndexAttr(table: ResolvedTable, idx: ResolvedIndex): string {
  const attrName = idx.unique ? "@@unique" : "@@index";
  const cols = idx.columns.map((c) => fieldNameFor(table, c));
  const args = [`[${cols.join(", ")}]`];
  if (idx.name !== undefined) args.push(`name: ${quoteString(idx.name)}`);
  if (idx.type !== undefined) args.push(`type: ${idx.type}`);
  if (idx.where !== undefined) args.push(`where: ${quoteString(idx.where)}`);
  if (idx.expression !== undefined) args.push(`expression: ${quoteString(idx.expression)}`);
  return `${attrName}(${args.join(", ")})`;
}

/**
 * Prints one side of a resolved `@@allow` equality condition. Deliberately
 * separate from `printAttributeValue` (design D6): that function's
 * `path`/`comparison` throw guard belongs to the unrelated `datasource.url`
 * path and must stay a dead branch.
 */
function printAllowOperand(table: ResolvedTable, op: AllowOperand): string {
  switch (op.kind) {
    case "field":
      return `this.${fieldNameFor(table, op.name)}`;
    case "claim":
      return `auth.${op.name}`;
    case "string":
      return quoteString(op.value);
    case "number":
    case "boolean":
      return String(op.value);
  }
}

function printAllowRule(table: ResolvedTable, rule: AllowRule): string {
  const left = printAllowOperand(table, rule.left);
  const right = printAllowOperand(table, rule.right);
  return `@@allow(${rule.action}, ${left} == ${right})`;
}

function printTable(schema: ResolvedSchema, table: ResolvedTable, indent: string): string {
  checkPrimaryKeySubsequence(table);

  const { fkFor, orphans } = claimForeignKeys(schema, table);
  const fieldLines = printFieldLines(schema, table, indent, fkFor);

  const fkLines = orphans.map((fk) => `${indent}${printFkComment(schema, table, fk)}`);

  const blockLines: string[] = [];
  if (table.dbName !== table.name) blockLines.push(`${indent}@@map(${quoteString(table.dbName)})`);
  for (const idx of table.indexes) {
    if (idx.unique) blockLines.push(`${indent}${printIndexAttr(table, idx)}`);
  }
  for (const idx of table.indexes) {
    if (!idx.unique) blockLines.push(`${indent}${printIndexAttr(table, idx)}`);
  }
  if (table.realtimeColumns !== undefined) {
    const cols = table.realtimeColumns.map((c) => fieldNameFor(table, c));
    blockLines.push(`${indent}@@realtime(columns: [${cols.join(", ")}])`);
  } else if (table.realtime) {
    blockLines.push(`${indent}@@realtime`);
  }
  if (table.allow) {
    for (const rule of table.allow) blockLines.push(`${indent}${printAllowRule(table, rule)}`);
  }
  if (table.note !== undefined) blockLines.push(`${indent}@@note(${quoteString(table.note)})`);

  const tail = [...fkLines, ...blockLines];
  let body = fieldLines.join("\n");
  if (tail.length > 0) body += `\n\n${tail.join("\n")}`;

  return `Table ${table.name} {\n${body}\n}`;
}

/**
 * Prints one `TableGroup` block verbatim from `ResolvedSchema.tableGroups`
 * (design D8) — never derived from `table.color`/`table.group`, so a
 * declared overlap ("last group wins") replays identically on re-resolve.
 */
function printTableGroup(group: ResolvedTableGroup, indent: string): string {
  const lines: string[] = [];
  if (group.color !== undefined) lines.push(`${indent}color = ${quoteString(group.color)}`);
  for (const t of group.tables) lines.push(`${indent}${t}`);
  return `TableGroup ${quoteString(group.name)} {\n${lines.join("\n")}\n}`;
}

function printHeader(header: string): string {
  return header
    .split("\n")
    .map((line) => (line.length > 0 ? `// ${line}` : "//"))
    .join("\n");
}

/**
 * Prints a `ResolvedSchema` as `.indigo` source text. Pure and I/O-free:
 * calling it twice on the same IR returns byte-identical output. Throws
 * `IndigoPrintError` (never emits partial output) for constructs it cannot
 * represent losslessly.
 */
export function printSchema(schema: ResolvedSchema, options: PrintOptions = {}): string {
  const indent = options.indent ?? "  ";
  const blocks: string[] = [];

  if (options.header) blocks.push(printHeader(options.header));
  if (schema.datasource) blocks.push(printDatasource(schema, indent));
  for (const en of schema.enums) blocks.push(printEnum(en));
  for (const table of schema.tables) blocks.push(printTable(schema, table, indent));
  for (const group of schema.tableGroups) blocks.push(printTableGroup(group, indent));

  const text = blocks.join("\n\n").replace(/\r\n/g, "\n");
  return `${text.replace(/\n+$/, "")}\n`;
}
