/**
 * @indigodb/generator — Client generator
 *
 * Emits a self-contained, typed `indigo.ts` client from a `ResolvedSchema`.
 * The generated file declares enums, row interfaces and per-model input types,
 * then wires one `ModelDelegate` per model onto an `IndigoClient` that extends
 * the runtime `IndigoClientBase` from `@indigodb/client`.
 */

import type {
  ResolvedSchema,
  ResolvedTable,
  ResolvedColumn,
  ResolvedRelation,
  ResolvedEnum,
  ResolvedEnumMember,
} from "@indigodb/core";
import { ScalarType } from "@indigodb/ast";

/** A member's schema name plus the PostgreSQL label it must round-trip as;
 * falls back to `values` (name === dbName) for `.snapshot.json` files
 * written before `members` existed. */
function enumMembers(e: ResolvedEnum): ResolvedEnumMember[] {
  return e.members ?? e.values.map((v) => ({ name: v, dbName: v }));
}

const SCALAR_TO_TS: Record<string, string> = {
  [ScalarType.String]: "string",
  [ScalarType.Int]: "number",
  [ScalarType.Float]: "number",
  [ScalarType.Boolean]: "boolean",
  [ScalarType.DateTime]: "Date",
  [ScalarType.Json]: "unknown",
  [ScalarType.BigInt]: "bigint",
  [ScalarType.Bytes]: "Buffer",
  [ScalarType.Decimal]: "string",
};

/** camelCase delegate name for a model (User → user, BlogPost → blogPost). */
function delegateName(modelName: string): string {
  return modelName.charAt(0).toLowerCase() + modelName.slice(1);
}

/** Base TS type for a column (scalar mapping or enum name). */
function baseType(col: ResolvedColumn): string {
  if (col.isEnum) return col.type;
  return SCALAR_TO_TS[col.type] ?? "unknown";
}

/** Whether a create input may omit this column. */
function optionalOnCreate(col: ResolvedColumn): boolean {
  return col.nullable || col.autoincrement || col.default !== undefined;
}

// ─── Relation metadata ───────────────────────────────────────────────────────
//
// `ResolvedRelation.fkColumns`/`refColumns` are PHYSICAL column names, and
// swap sides between the FK holder and its paired inverse (see core's
// ir.ts). Direction is collapsed HERE, once, at codegen time, into a
// symmetric `{ from, to }` pair of FIELD names so the client runtime has a
// single direction-agnostic rule: `target WHERE to IN (parent.from values)`
// (design.md, Decision #1).

/** One relation, translated to field names with the composite-key check applied. */
interface RelationInfo {
  name: string;
  target: string;
  list: boolean;
  optional: boolean;
  from: string;
  to: string;
  /**
   * `true` when THIS table physically holds the FK column for the pair
   * (`!rel.inverse`). Write-planner ordering rule (design.md, Decision
   * "`list` is insufficient to order writes"): `fkSide` relations must be
   * written BEFORE the parent row (the parent needs the FK value);
   * non-`fkSide` relations must be written AFTER (the child needs the
   * parent's key). `list` alone mis-orders a 1-1 inverse side, which has
   * `list: false` but the FK lives on the OTHER table.
   */
  fkSide: boolean;
  /**
   * Nullability of the PHYSICAL FK column backing this pair, wherever it
   * physically lives (this table when `fkSide`, the target table when
   * not). Gates whether `disconnect`/`set` can clear the FK to NULL instead
   * of throwing `REQUIRED_RELATION_DISCONNECT` (design.md Decision #1;
   * spec Requirement 4).
   */
  optionalFk: boolean;
  /** More than one fk/ref column — rejected at codegen time, see below. */
  composite: boolean;
}

function columnMapByDb(table: ResolvedTable): Map<string, ResolvedColumn> {
  const m = new Map<string, ResolvedColumn>();
  for (const c of table.columns) m.set(c.dbName, c);
  return m;
}

function resolveRelationInfo(
  table: ResolvedTable,
  rel: ResolvedRelation,
  tablesByName: Map<string, ResolvedTable>,
): RelationInfo {
  const targetTable = tablesByName.get(rel.targetModel);
  const localCols = columnMapByDb(table);
  const targetCols = targetTable ? columnMapByDb(targetTable) : new Map<string, ResolvedColumn>();

  // Holder side: fkColumns are physical columns on THIS table, refColumns on
  // the target. Inverse side: fkColumns/refColumns are mirrored from the
  // paired holder, so they live on the OTHER table — refColumns are physical
  // columns on THIS table instead (see ir.ts's `inverse` doc comment).
  const localPhysical = rel.inverse ? rel.refColumns : rel.fkColumns;
  const targetPhysical = rel.inverse ? rel.fkColumns : rel.refColumns;

  const from = localPhysical.map((c) => localCols.get(c)?.name ?? c);
  const to = targetPhysical.map((c) => targetCols.get(c)?.name ?? c);

  // `rel.fkColumns` are always the PHYSICAL FK column names, but the table
  // that physically owns them flips with `inverse` (ir.ts's `fkColumns` doc
  // comment): the local table when this side holds the FK, the target
  // table when this side is the mirrored inverse.
  const fkOwnerCols = rel.inverse ? targetCols : localCols;
  const fkColumn = rel.fkColumns.length === 1 ? fkOwnerCols.get(rel.fkColumns[0]!) : undefined;

  return {
    name: rel.name,
    target: rel.targetModel,
    list: rel.list,
    optional: rel.optional,
    fkSide: !rel.inverse,
    // Conservative default (nullable) when the FK column can't be resolved
    // (composite relations, or an unexpectedly missing column) — never
    // silently treats an unresolvable FK as required.
    optionalFk: fkColumn?.nullable ?? true,
    from: from[0] ?? "",
    to: to[0] ?? "",
    // Slice-1 only supports single-column relation keys (design.md,
    // Decision #5) — `{a:{in:[]},b:{in:[]}}` is a cross-product and would
    // need new SQL, exactly the query-builder growth the proposal rejects.
    composite: from.length !== 1 || to.length !== 1,
  };
}

/**
 * Composite-key rejection (tasks.md 1.4 decision, resolved here):
 *
 * A relation whose stitch key spans more than one column is rejected in
 * TWO layers, not one:
 *
 *  1. COMPILE-TIME OMISSION — it is left out of `<Model>Relations` (and
 *     therefore out of `<Model>IncludeInput`, since that's keyed off
 *     `keyof <Model>Relations`). A TypeScript caller cannot even write
 *     `include: { relName: true }` for it — the strongest guarantee this
 *     slice can offer.
 *  2. RUNTIME MARKER — it is still recorded in `__meta.<Model>.relations`
 *     as `{ target, composite: true }` (no `from`/`to`/`list`), so the
 *     client runtime (PR 2, `loadRelations`) can detect an attempted
 *     `include` on it — e.g. via `as any`, a plain-JS caller, or a stale
 *     compiled client — and throw ONE precise, typed error naming the
 *     relation and explaining single-column keys only, instead of a
 *     generic/misleading "unknown relation" failure.
 *
 * This keeps codegen-time and runtime rejection consistent (tasks.md 5.3):
 * both agree a composite-key relation is unusable via `include()`, they
 * just enforce it at different layers for different caller shapes.
 */
function relationMetaEntry(r: RelationInfo): string {
  if (r.composite) {
    return `${JSON.stringify(r.name)}: { target: ${JSON.stringify(r.target)}, composite: true }`;
  }
  return (
    `${JSON.stringify(r.name)}: { target: ${JSON.stringify(r.target)}, ` +
    `from: ${JSON.stringify(r.from)}, to: ${JSON.stringify(r.to)}, list: ${r.list}, ` +
    `fkSide: ${r.fkSide}, optional: ${r.optional}, optionalFk: ${r.optionalFk} }`
  );
}

/** `export interface <Model>Relations { ... }` — composite-key relations omitted (see `relationMetaEntry`). */
function generateRelationsInterface(table: ResolvedTable, relations: RelationInfo[]): string[] {
  const lines = [`export interface ${table.name}Relations {`];
  for (const r of relations) {
    if (r.composite) continue;
    const memberType = r.list ? `${r.target}[]` : r.optional ? `${r.target} | null` : r.target;
    lines.push(`  ${r.name}: ${memberType};`);
  }
  lines.push("}", "");
  return lines;
}

export function generateClient(schema: ResolvedSchema): string {
  const out: string[] = [];
  const hasRealtime = schema.tables.some((t) => t.realtime);

  const runtimeImports = ["IndigoClientBase", "ModelDelegate"];
  if (hasRealtime) runtimeImports.push("RealtimeModelDelegate");
  out.push(
    "// ──────────────────────────────────────────────────────────────────────────────",
    "// Auto-generated by IndigoDB — DO NOT EDIT",
    "// Run `indigodb generate` to regenerate this file.",
    "// ──────────────────────────────────────────────────────────────────────────────",
    "",
    `import { ${runtimeImports.join(", ")} } from "@indigodb/client";`,
    'import type {',
    "  IndigoClientOptions,",
    "  Executor,",
    "  RealtimeConnectionManager,",
    "  IncludeInput,",
    "  WhereInput,",
    "  ToOneRelationInput,",
    "  ToOneRelationUpdateInput,",
    "  ToManyRelationInput,",
    "  ToManyRelationUpdateInput,",
    "  RunAtomic,",
    '} from "@indigodb/client";',
    "",
  );

  // Direction-agnostic relation metadata, computed once per table (see the
  // "Relation metadata" section above `generateClient`).
  const tablesByName = new Map(schema.tables.map((t) => [t.name, t]));
  const relationsByTable = new Map<string, RelationInfo[]>(
    schema.tables.map((t) => [t.name, t.relations.map((r) => resolveRelationInfo(t, r, tablesByName))]),
  );

  // ─── Enums ───────────────────────────────────────────────────────────────
  // The TS enum key is the LOGICAL member name; its value is the PHYSICAL
  // (`@map`) PostgreSQL label, so the runtime sends exactly what
  // `@indigodb/migrator` created the type with (Prisma models it the same
  // way). Sending the logical name for a `@map`'d member fails at the
  // database with `invalid input value for enum`.
  for (const e of schema.enums) {
    out.push(`export enum ${e.name} {`);
    for (const m of enumMembers(e)) out.push(`  ${m.name} = "${m.dbName}",`);
    out.push("}", "");
  }

  // ─── Row interfaces + input types ───────────────────────────────────────
  for (const table of schema.tables) {
    out.push(...generateRowInterface(table));
    out.push(...generateCreateInput(table, relationsByTable.get(table.name)!));
    out.push(...generateUpdateInput(table, relationsByTable.get(table.name)!));
    out.push(...generateRelationsInterface(table, relationsByTable.get(table.name)!));
    out.push(`export type ${table.name}IncludeInput = IncludeInput<${table.name}Relations>;`, "");
  }

  // ─── Model metadata ─────────────────────────────────────────────────────
  out.push("const __meta = {");
  for (const table of schema.tables) {
    const fields = table.columns
      .map((c) => `${JSON.stringify(c.name)}: { db: ${JSON.stringify(c.dbName)}${c.isPk ? ", pk: true" : ""} }`)
      .join(", ");
    const relations = relationsByTable
      .get(table.name)!
      .map(relationMetaEntry)
      .join(", ");
    out.push(
      `  ${JSON.stringify(table.name)}: { name: ${JSON.stringify(table.name)}, table: ${JSON.stringify(table.dbName)}, fields: { ${fields} }, relations: { ${relations} } },`,
    );
  }
  out.push("} as const;", "");

  // ─── TransactionClient interface ────────────────────────────────────────
  // Per-model delegates + $queryRaw, bound to whatever executor `__delegates`
  // is handed. Deliberately NOT `Omit<IndigoClient, "$transaction">` — that
  // would also leak `$disconnect` and the options surface onto `tx`, making
  // it look closeable when it is only valid for the callback's duration.
  out.push("export interface TransactionClient {");
  for (const table of schema.tables) {
    const d = delegateName(table.name);
    const generics = `<${table.name}, ${table.name}CreateInput, ${table.name}UpdateInput, ${table.name}Relations>`;
    const delegateType = table.realtime ? `RealtimeModelDelegate${generics}` : `ModelDelegate${generics}`;
    out.push(`  readonly ${d}: ${delegateType};`);
  }
  out.push("  $queryRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;");
  out.push("}", "");

  // ─── __delegates factory ────────────────────────────────────────────────
  // One construction site reused by the constructor (bound to `this.exec`)
  // and `$transaction` (bound to a session-scoped executor), so both paths
  // wire delegates identically. `reg`/`siblings` is a lazy registry thunk
  // (design.md Decision #3): every delegate is constructed with `siblings`
  // before any entry is filled in, avoiding a construction-order cycle,
  // then `include`'s follow-up query reaches a sibling model's own
  // `findMany` through `siblings()[relation.target]` at call time.
  //
  // `runAtomic` (design.md Decision "atomicity via `runAtomic`, a 4th
  // `__delegates` argument") is OPTIONAL and deliberately omitted by
  // `$transaction`'s own call below — each `ModelDelegate` then falls back
  // to its own identity default (calls `fn` with `siblings()`, opening no
  // new transaction), since a nested write issued via `tx.<model>.create`
  // is already inside one. The top-level constructor passes the real thunk.
  out.push(
    "function __delegates(",
    "  exec: Executor,",
    "  realtime: () => RealtimeConnectionManager,",
    "  runAtomic?: RunAtomic,",
    "): TransactionClient {",
    "  const reg: Record<string, ModelDelegate<any, any, any, any>> = {};",
    "  const siblings = () => reg;",
    "  const client: TransactionClient = {",
  );
  for (const table of schema.tables) {
    const d = delegateName(table.name);
    const generics = `<${table.name}, ${table.name}CreateInput, ${table.name}UpdateInput, ${table.name}Relations>`;
    if (table.realtime) {
      out.push(
        `    ${d}: new RealtimeModelDelegate${generics}(`,
        `      __meta[${JSON.stringify(table.name)}],`,
        `      exec,`,
        `      realtime,`,
        `      ${JSON.stringify(table.name)},`,
        `      siblings,`,
        `      runAtomic,`,
        `    ),`,
      );
    } else {
      out.push(
        `    ${d}: new ModelDelegate${generics}(`,
        `      __meta[${JSON.stringify(table.name)}],`,
        `      exec,`,
        `      siblings,`,
        `      runAtomic,`,
        `    ),`,
      );
    }
  }
  out.push(
    "    $queryRaw: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>",
    "      (await exec(sql, params)) as T[],",
    "  };",
  );
  for (const table of schema.tables) {
    const d = delegateName(table.name);
    out.push(`  reg[${JSON.stringify(table.name)}] = client.${d};`);
  }
  out.push("  return client;", "}", "");

  // ─── Client class ───────────────────────────────────────────────────────
  out.push("export class IndigoClient extends IndigoClientBase {");
  for (const table of schema.tables) {
    const d = delegateName(table.name);
    const generics = `<${table.name}, ${table.name}CreateInput, ${table.name}UpdateInput, ${table.name}Relations>`;
    const delegateType = table.realtime ? `RealtimeModelDelegate${generics}` : `ModelDelegate${generics}`;
    out.push(`  readonly ${d}: ${delegateType};`);
  }
  out.push(
    "  constructor(options?: IndigoClientOptions) {",
    "    super(options);",
    "    const d = __delegates(this.exec, this.$realtime, (fn) => this.$transaction(fn as never));",
  );
  for (const table of schema.tables) {
    const d = delegateName(table.name);
    out.push(`    this.${d} = d.${d};`);
  }
  out.push(
    "  }",
    "",
    "  $transaction<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {",
    "    return this.$withSession((exec) => fn(__delegates(exec, this.$realtime)));",
    "  }",
  );
  out.push("}", "");
  out.push("export type { IndigoClientOptions };", "");

  return out.join("\n");
}

function generateRowInterface(table: ResolvedTable): string[] {
  const lines = [`export interface ${table.name} {`];
  for (const col of table.columns) {
    const t = baseType(col);
    const type = col.nullable ? `${t} | null` : t;
    lines.push(`  ${col.name}: ${type};`);
  }
  lines.push("}", "");
  return lines;
}

/**
 * Nested-write relation member type for one relation (tasks.md A2.1/A2.2,
 * design.md Decision "relation input unions live in
 * packages/client/src/types.ts"). TYPE PLUMBING ONLY — no planner (PR B/C)
 * reads these yet; this PR only makes them compile.
 *
 *  - `fkSide` (this table holds the FK, always to-one from here): the
 *    child's own `CreateInput` is referenced unomitted — nothing about the
 *    child needs hiding.
 *  - non-`fkSide` (the CHILD holds the FK back to this row, to-one or
 *    to-many): `Omit<ChildCreateInput, "<to>">` — the planner supplies the
 *    child's FK field from the parent's own key, never the caller.
 *
 * `update` gains `disconnect`/`set` only when the FK can legally become
 * NULL: always for a to-many (`ToManyRelationUpdateInput`), and for a
 * to-one only when `optionalFk` (spec Requirement 4) — a required to-one
 * can be replaced but never disconnected.
 */
function relationInputType(r: RelationInfo, mode: "create" | "update"): string {
  const whereType = `WhereInput<${r.target}>`;
  if (r.fkSide) {
    const createType = `${r.target}CreateInput`;
    return mode === "update" && r.optionalFk
      ? `ToOneRelationUpdateInput<${createType}, ${whereType}>`
      : `ToOneRelationInput<${createType}, ${whereType}>`;
  }
  const childCreate = `Omit<${r.target}CreateInput, ${JSON.stringify(r.to)}>`;
  if (r.list) {
    return mode === "update"
      ? `ToManyRelationUpdateInput<${childCreate}, ${whereType}>`
      : `ToManyRelationInput<${childCreate}, ${whereType}>`;
  }
  // non-fkSide to-one (1-1 inverse side).
  return mode === "update" && r.optionalFk
    ? `ToOneRelationUpdateInput<${childCreate}, ${whereType}>`
    : `ToOneRelationInput<${childCreate}, ${whereType}>`;
}

function generateCreateInput(table: ResolvedTable, relations: RelationInfo[]): string[] {
  const lines = [`export interface ${table.name}CreateInput {`];
  for (const col of table.columns) {
    if (col.autoincrement) continue; // DB-generated identity
    const t = baseType(col);
    const type = col.nullable ? `${t} | null` : t;
    const opt = optionalOnCreate(col) ? "?" : "";
    lines.push(`  ${col.name}${opt}: ${type};`);
  }
  for (const r of relations) {
    if (r.composite) continue;
    lines.push(`  ${r.name}?: ${relationInputType(r, "create")};`);
  }
  lines.push("}", "");
  return lines;
}

function generateUpdateInput(table: ResolvedTable, relations: RelationInfo[]): string[] {
  const lines = [`export interface ${table.name}UpdateInput {`];
  for (const col of table.columns) {
    const t = baseType(col);
    const type = col.nullable ? `${t} | null` : t;
    lines.push(`  ${col.name}?: ${type};`);
  }
  for (const r of relations) {
    if (r.composite) continue;
    lines.push(`  ${r.name}?: ${relationInputType(r, "update")};`);
  }
  lines.push("}", "");
  return lines;
}
