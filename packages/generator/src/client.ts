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
  // pg's default int8 result parser returns a JS `string` at runtime — no
  // `setTypeParser` override anywhere in the client (client-query-type-safety
  // spec "BigInt scalar columns are typed as string"). Do NOT touch
  // `packages/migrator/src/postgres.ts`'s `"bigint"` — that's the PostgreSQL
  // DDL type name, unrelated to this TS-facing mapping.
  [ScalarType.BigInt]: "string",
  [ScalarType.Bytes]: "Buffer",
  [ScalarType.Decimal]: "string",
};

/** camelCase delegate name for a model (User → user, BlogPost → blogPost). */
function delegateName(modelName: string): string {
  return modelName.charAt(0).toLowerCase() + modelName.slice(1);
}

/**
 * Whether `.live()` is emitted for this model (`client-live-queries` spec
 * Requirement "`.live()` is generated only for `@@realtime` + `@@allow`
 * models"): `@@realtime` AND a non-empty `@@allow` block. `@@realtime`-only
 * models (design decision 7) keep `RealtimeModelDelegate` and get no
 * `.live()` at all — a type-level omission, never a runtime throw.
 */
function hasLive(table: ResolvedTable): boolean {
  return Boolean(table.realtime) && Boolean(table.allow && table.allow.length > 0);
}

/** Delegate class name for a table: `LiveModelDelegate` for a qualifying
 * `@@realtime`+`@@allow` model, `RealtimeModelDelegate` for `@@realtime`-only,
 * `ModelDelegate` otherwise. */
function delegateClassName(table: ResolvedTable): string {
  if (hasLive(table)) return "LiveModelDelegate";
  return table.realtime ? "RealtimeModelDelegate" : "ModelDelegate";
}

/** Base TS type for a column (scalar mapping or enum name, with `[]` for list fields). */
function baseType(col: ResolvedColumn): string {
  const scalar = col.isEnum ? col.type : (SCALAR_TO_TS[col.type] ?? "unknown");
  return col.list ? `${scalar}[]` : scalar;
}

/** Whether a create input may omit this column. */
function optionalOnCreate(col: ResolvedColumn): boolean {
  return col.nullable || col.autoincrement || col.default !== undefined;
}

/**
 * Whether a column is a `Json`/`jsonb` column (client-where-composition PR
 * C, design.md Decision "JSON detection"). Drives both the `__meta`
 * `json: true` bit and `<Model>WhereInput`'s `JsonFilter` typing — never
 * inferred structurally from the presence of a `path` key at runtime.
 */
function isJsonColumn(col: ResolvedColumn): boolean {
  return !col.isEnum && !col.list && col.type === ScalarType.Json;
}

/** Numeric scalar types (client-aggregation PR C, design.md Decision #10):
 * `Int`/`Float`/`Decimal`/`BigInt`, never an enum — drives both `__meta`'s
 * `numeric: true` bit and `<Model>NumericFields`'s member set. */
const NUMERIC_SCALAR_TYPES: ReadonlySet<string> = new Set([
  ScalarType.Int,
  ScalarType.Float,
  ScalarType.Decimal,
  ScalarType.BigInt,
]);

function isNumericColumn(col: ResolvedColumn): boolean {
  return !col.isEnum && !col.list && NUMERIC_SCALAR_TYPES.has(col.type);
}

/**
 * Declared unique-constraint groups (client-upsert PR D, design.md Decision
 * #12): PK first, then `@unique` columns (each its own single-column
 * group), then unique `@@index`/`@@unique` groups — every entry an array of
 * FIELD names (schema names, not physical column names), mirroring the
 * direction-agnostic translation `resolveRelationInfo` already does for
 * relation columns. Drives both `__meta.uniqueGroups` and
 * `<Model>WhereUniqueInput`'s member shapes.
 */
function uniqueGroups(table: ResolvedTable): string[][] {
  const colsByDb = columnMapByDb(table);
  const groups: string[][] = [];

  if (table.primaryKey.length > 0) {
    groups.push(table.primaryKey.map((dbName) => colsByDb.get(dbName)?.name ?? dbName));
  }
  for (const col of table.columns) {
    if (col.unique) groups.push([col.name]);
  }
  for (const idx of table.indexes) {
    // Partial (`where`) and expression (`expression`) unique indexes cannot
    // back an unconditional `ON CONFLICT (cols)` upsert target in PostgreSQL
    // and do not guarantee full-table uniqueness for column-equality lookups.
    if (!idx.unique || idx.where !== undefined || idx.expression !== undefined) continue;
    groups.push(idx.columns.map((dbName) => colsByDb.get(dbName)?.name ?? dbName));
  }

  return groups;
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
  const anyLive = schema.tables.some(hasLive);

  const runtimeImports = ["IndigoClientBase", "ModelDelegate", "isIndigoPromise", "runDeferred", "IndigoTransactionError"];
  if (hasRealtime) runtimeImports.push("RealtimeModelDelegate");
  if (anyLive) runtimeImports.push("LiveModelDelegate");
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
    "  WhereValue,",
    "  RelationFilter,",
    "  ToOneRelationInput,",
    "  ToOneRelationUpdateInput,",
    "  ToManyRelationInput,",
    "  ToManyRelationUpdateInput,",
    "  JsonFilter,",
    "  RunAtomic,",
    "  CreateManyArgs,",
    "  UpdateManyArgs,",
    "  DeleteManyArgs,",
    "  BatchPayload,",
    "  AggregateArgs,",
    "  GroupByArgs,",
    "  AggregateResult,",
    "  GroupByResult,",
    "  UpsertArgs,",
    "  IndigoPromise,",
    "  DeferredResults,",
    ...(anyLive ? ["  ClientRunScoped,", "  GetHandleFn,"] : []),
    '} from "@indigodb/client";',
    "",
  );

  // Direction-agnostic relation metadata, computed once per table (see the
  // "Relation metadata" section above `generateClient`).
  const tablesByName = new Map(schema.tables.map((t) => [t.name, t]));
  const relationsByTable = new Map<string, RelationInfo[]>(
    schema.tables.map((t) => [t.name, t.relations.map((r) => resolveRelationInfo(t, r, tablesByName))]),
  );
  const requiredFkGroupsByTable = new Map<string, RequiredFkGroup[]>(
    schema.tables.map((t) => [t.name, requiredFkGroupsForTable(t, relationsByTable.get(t.name)!)]),
  );

  // ─── Enums ───────────────────────────────────────────────────────────────
  // The const-object key is the LOGICAL member name; its value is the
  // PHYSICAL (`@map`) PostgreSQL label, so the runtime sends exactly what
  // `@indigodb/migrator` created the type with (Prisma models it the same
  // way). Sending the logical name for a `@map`'d member fails at the
  // database with `invalid input value for enum`.
  //
  // Emitted as `export const X = {...} as const` + a paired
  // `export type X = typeof X[keyof typeof X]` (client-query-type-safety
  // spec "Generated enums emit as a const object with a paired type",
  // design.md Decision "const-object enums, parenthesized typeof") instead
  // of a nominal `export enum X {...}` — TS keeps value and type
  // declaration spaces separate, so `const X` and `type X` coexist legally
  // under the same identifier, and this form compiles under
  // `isolatedModules`/`erasableSyntaxOnly` consumers, unlike a nominal enum.
  // `baseType()` above returns the bare enum name for type position and
  // needs no change; `__meta` never emits enum members in value position.
  for (const e of schema.enums) {
    out.push(`export const ${e.name} = {`);
    for (const m of enumMembers(e)) out.push(`  ${m.name}: "${m.dbName}",`);
    out.push("} as const;");
    out.push(`export type ${e.name} = (typeof ${e.name})[keyof typeof ${e.name}];`, "");
  }

  // ─── Row interfaces + input types ───────────────────────────────────────
  for (const table of schema.tables) {
    out.push(...generateRowInterface(table));
    out.push(...generateCreateInput(table, relationsByTable.get(table.name)!, requiredFkGroupsByTable, relationsByTable));
    out.push(...generateCreateManyInput(table));
    out.push(...generateCursorInput(table));
    out.push(...generateNumericFields(table));
    out.push(...generateWhereUniqueInput(table));
    out.push(...generateUpdateInput(table, relationsByTable.get(table.name)!, requiredFkGroupsByTable, relationsByTable));
    out.push(...generateWhereInput(table, relationsByTable.get(table.name)!));
    out.push(...generateRelationsInterface(table, relationsByTable.get(table.name)!));
    out.push(`export type ${table.name}IncludeInput = IncludeInput<${table.name}Relations>;`, "");
    out.push(
      `export type ${table.name}CreateManyArgs = CreateManyArgs<${table.name}CreateManyInput>;`,
      `export type ${table.name}UpdateManyArgs = UpdateManyArgs<${table.name}, ${table.name}UpdateInput, ${table.name}WhereInput>;`,
      `export type ${table.name}DeleteManyArgs = DeleteManyArgs<${table.name}, ${table.name}WhereInput>;`,
      `export type ${table.name}AggregateArgs = AggregateArgs<${table.name}, ${table.name}WhereInput, ${table.name}NumericFields>;`,
      `export type ${table.name}GroupByArgs = GroupByArgs<${table.name}, ${table.name}WhereInput, ${table.name}NumericFields>;`,
      `export type ${table.name}UpsertArgs = UpsertArgs<${table.name}CreateInput, ${table.name}UpdateInput, ${table.name}WhereUniqueInput>;`,
      "",
    );
  }

  // ─── Model metadata ─────────────────────────────────────────────────────
  out.push("const __meta = {");
  for (const table of schema.tables) {
    const fields = table.columns
      .map(
        (c) =>
          `${JSON.stringify(c.name)}: { db: ${JSON.stringify(c.dbName)}${c.isPk ? ", pk: true" : ""}${isJsonColumn(c) ? ", json: true" : ""}${isNumericColumn(c) ? ", numeric: true" : ""} }`,
      )
      .join(", ");
    const relations = relationsByTable
      .get(table.name)!
      .map(relationMetaEntry)
      .join(", ");
    const colsByDb = columnMapByDb(table);
    const indexesLiteral = table.indexes
      .map((idx) => {
        const idxFields = idx.columns
          .map((dbName) => JSON.stringify(colsByDb.get(dbName)?.name ?? dbName))
          .join(", ");
        const parts = [`fields: [${idxFields}]`, `unique: ${idx.unique}`];
        if (idx.name !== undefined) parts.push(`name: ${JSON.stringify(idx.name)}`);
        if (idx.type !== undefined) parts.push(`type: ${JSON.stringify(idx.type)}`);
        if (idx.where !== undefined) parts.push(`where: ${JSON.stringify(idx.where)}`);
        if (idx.expression !== undefined) parts.push(`expression: ${JSON.stringify(idx.expression)}`);
        return `{ ${parts.join(", ")} }`;
      })
      .join(", ");
    const uniqueGroupsLiteral = uniqueGroups(table)
      .map((g) => `[${g.map((f) => JSON.stringify(f)).join(", ")}]`)
      .join(", ");
    out.push(
      `  ${JSON.stringify(table.name)}: { name: ${JSON.stringify(table.name)}, table: ${JSON.stringify(table.dbName)}, fields: { ${fields} }, relations: { ${relations} }, uniqueGroups: [${uniqueGroupsLiteral}], indexes: [${indexesLiteral}] },`,
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
    const generics = `<${table.name}, ${table.name}CreateInput, ${table.name}UpdateInput, ${table.name}Relations, ${table.name}WhereInput, ${table.name}CreateManyInput, ${cursorGenericArg(table)}, ${table.name}NumericFields, ${table.name}WhereUniqueInput>`;
    const delegateType = `${delegateClassName(table)}${generics}`;
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
    ...(anyLive
      ? [
          "  runScoped: ClientRunScoped,",
          "  handle: GetHandleFn,",
          "  requireHandle: () => void,",
        ]
      : []),
    "  runAtomic?: RunAtomic,",
    "): { tx: TransactionClient; byModel: Record<string, unknown> } {",
    // `Record<string, any>` when any model is `.live()`-qualifying: assigning
    // a `LiveModelDelegate<...>` instance (whose overridden `findMany` return
    // type is intersected with `{ live(...): ... }`) into a
    // `Record<string, ModelDelegate<any, any, any, any>>`-typed map forces a
    // FULL structural comparison TypeScript otherwise short-circuits for an
    // UN-overridden inherited method — surfacing an unrelated, pre-existing
    // `Payload<Model, Relations, A>` vs `Payload<any, any, A>` variance gap
    // for any model whose Cursor generic isn't `never` (verified in
    // isolation: identical failure with zero live-related code, once
    // `findMany` is overridden at all). `reg`/`siblings` are internal-only —
    // never surfaced through `TransactionClient`'s own strongly-typed
    // per-model fields — so widening this ONE internal map is a safe,
    // zero-behavior-change fix scoped to schemas that actually use `.live()`.
    anyLive
      ? "  const reg: Record<string, any> = {};"
      : "  const reg: Record<string, ModelDelegate<any, any, any, any>> = {};",
    "  const siblings = () => reg;",
    "  const client: TransactionClient = {",
  );
  for (const table of schema.tables) {
    const d = delegateName(table.name);
    const generics = `<${table.name}, ${table.name}CreateInput, ${table.name}UpdateInput, ${table.name}Relations, ${table.name}WhereInput, ${table.name}CreateManyInput, ${cursorGenericArg(table)}, ${table.name}NumericFields, ${table.name}WhereUniqueInput>`;
    if (hasLive(table)) {
      out.push(
        `    ${d}: new LiveModelDelegate${generics}(`,
        `      __meta[${JSON.stringify(table.name)}],`,
        `      exec,`,
        `      realtime,`,
        `      ${JSON.stringify(table.name)},`,
        `      runScoped,`,
        `      handle,`,
        `      requireHandle,`,
        `      siblings,`,
        `      runAtomic,`,
        `    ),`,
      );
    } else if (table.realtime) {
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
  out.push("  return { tx: client, byModel: reg };", "}", "");

  // ─── Client class ───────────────────────────────────────────────────────
  out.push("export class IndigoClient extends IndigoClientBase {");
  if (anyLive) {
    // Generator emission, design.md Interfaces section: bound ONCE per
    // instance (arrow-function class field, so `this` stays lexically
    // bound wherever it's later passed as a value — `__delegates` is a free
    // function, not a class method). Reused by the constructor AND every
    // session-scoped `__delegates(...)` call inside `$transaction`/`$auth`
    // below, so a `.live()` call made from a delegate handed to a
    // `$transaction`/`$auth` callback re-enters `this.$authSession` while
    // one is already open — surfacing the nesting guard through `.live()`'s
    // own onError path (tasks.md section 8) rather than a second, divergent
    // implementation.
    out.push(
      "  private readonly runScoped: ClientRunScoped = (userId, model, run) =>",
      "    this.$authSession({ userId }, (exec) => run(__delegates(exec, this.$realtime, this.runScoped, this.$handle, this.$requireGetHandle).byModel[model]));",
    );
  }
  out.push(
    anyLive
      ? "  private readonly runAtomic: RunAtomic = (fn) => this.$withSession((exec) => fn(__delegates(exec, this.$realtime, this.runScoped, this.$handle, this.$requireGetHandle).byModel as never));"
      : "  private readonly runAtomic: RunAtomic = (fn) => this.$withSession((exec) => fn(__delegates(exec, this.$realtime).byModel as never));",
  );
  for (const table of schema.tables) {
    const d = delegateName(table.name);
    const generics = `<${table.name}, ${table.name}CreateInput, ${table.name}UpdateInput, ${table.name}Relations, ${table.name}WhereInput, ${table.name}CreateManyInput, ${cursorGenericArg(table)}, ${table.name}NumericFields, ${table.name}WhereUniqueInput>`;
    const delegateType = `${delegateClassName(table)}${generics}`;
    out.push(`  readonly ${d}: ${delegateType};`);
  }
  out.push(
    "  constructor(options?: IndigoClientOptions) {",
    "    super(options);",
    anyLive
      ? "    const d = __delegates(this.exec, this.$realtime, this.runScoped, this.$handle, this.$requireGetHandle, this.runAtomic);"
      : "    const d = __delegates(this.exec, this.$realtime, this.runAtomic);",
  );
  for (const table of schema.tables) {
    const d = delegateName(table.name);
    out.push(`    this.${d} = d.tx.${d};`);
  }
  out.push(
    "  }",
    "",
    "  $transaction<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T>;",
    "  $transaction<const Ops extends readonly IndigoPromise<unknown>[]>(ops: Ops): Promise<DeferredResults<Ops>>;",
    "  $transaction(",
    "    fnOrOps: ((tx: TransactionClient) => Promise<unknown>) | readonly IndigoPromise<unknown>[],",
    "  ): Promise<unknown> {",
    "    if (Array.isArray(fnOrOps)) {",
    "      for (const op of fnOrOps) {",
    "        if (!isIndigoPromise(op)) {",
    "          throw new IndigoTransactionError(",
    '            "NOT_A_DEFERRED_OPERATION",',
    '            "$transaction array elements must be deferred operations returned by a model " +',
    "              `delegate method (e.g. db.user.create(...)), got ${typeof op}. If this value comes ` +",
    '              "from a generated client, regenerate it.",',
    "          );",
    "        }",
    "      }",
    "      if (fnOrOps.length === 0) {",
    "        return Promise.resolve([]);",
    "      }",
    anyLive
      ? "      return this.$withSession((exec) => runDeferred(fnOrOps, __delegates(exec, this.$realtime, this.runScoped, this.$handle, this.$requireGetHandle).byModel));"
      : "      return this.$withSession((exec) => runDeferred(fnOrOps, __delegates(exec, this.$realtime).byModel));",
    "    }",
    "    if (typeof fnOrOps === \"function\") {",
    anyLive
      ? "      return this.$withSession((exec) => fnOrOps(__delegates(exec, this.$realtime, this.runScoped, this.$handle, this.$requireGetHandle).tx));"
      : "      return this.$withSession((exec) => fnOrOps(__delegates(exec, this.$realtime).tx));",
    "    }",
    "    throw new IndigoTransactionError(",
    '      "NOT_A_DEFERRED_OPERATION",',
    '      "$transaction expects a callback function or an array of deferred operations.",',
    "    );",
    "  }",
    "",
    // `$auth` (design.md Decision #16, mirrors `$transaction` above).
    // Deliberately NOT declared with `override` and NOT overriding a
    // same-named base member: `IndigoClientBase` exposes the protected
    // `$authSession` (not `$auth`) for exactly this reason — a real
    // override with a narrower callback parameter (`(tx: TransactionClient)
    // => Promise<T>` instead of `(exec: Executor) => Promise<T>`) fails
    // TypeScript's strict class-override compatibility check (verified: no
    // bivariance escape for a plain method override). Calling the
    // differently-named protected helper here means `$auth` is simply a
    // new public method, so there is no override relationship to conflict.
    "  $auth<T>(ctx: { userId: string | number }, fn: (tx: TransactionClient) => Promise<T>): Promise<T> {",
    anyLive
      ? "    return this.$authSession(ctx, (exec) => fn(__delegates(exec, this.$realtime, this.runScoped, this.$handle, this.$requireGetHandle).tx));"
      : "    return this.$authSession(ctx, (exec) => fn(__delegates(exec, this.$realtime).tx));",
    "  }",
  );
  out.push("}", "");
  out.push("export type { IndigoClientOptions, BatchPayload, AggregateResult, GroupByResult };", "");

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
 * A required non-autoincrement FK scalar column paired with the non-composite
 * `fkSide` relation(s) that can populate it at runtime during phase 1 of a
 * nested write (`delegate.ts`'s `resolveToOneOp`). Callers must pass either
 * the FK scalar OR the nested relation operation, never neither.
 */
interface RequiredFkGroup {
  col: ResolvedColumn;
  rels: RelationInfo[];
}

function requiredFkGroupsForTable(table: ResolvedTable, relations: RelationInfo[]): RequiredFkGroup[] {
  const colsByName = new Map(table.columns.map((c) => [c.name, c]));
  const grouped = new Map<string, RelationInfo[]>();
  for (const r of relations) {
    if (r.composite || !r.fkSide) continue;
    const col = colsByName.get(r.from);
    if (!col || optionalOnCreate(col)) continue;
    const list = grouped.get(col.name);
    if (list) list.push(r);
    else grouped.set(col.name, [r]);
  }
  const out: RequiredFkGroup[] = [];
  for (const col of table.columns) {
    const rels = grouped.get(col.name);
    if (rels && rels.length > 0) out.push({ col, rels });
  }
  return out;
}

function columnCreateFieldType(col: ResolvedColumn): string {
  const t = baseType(col);
  return col.nullable ? `${t} | null` : t;
}

function fkGroupUnion(
  group: RequiredFkGroup,
  requiredFkGroupsByTable: Map<string, RequiredFkGroup[]>,
  relationsByTable: Map<string, RelationInfo[]>,
): string {
  const colType = columnCreateFieldType(group.col);
  const relMembers = group.rels.map((r) => ({
    name: r.name,
    type: relationInputType(r, "create", requiredFkGroupsByTable, relationsByTable),
  }));
  const scalarBranch = `{ ${group.col.name}: ${colType}; ${relMembers.map((m) => `${m.name}?: ${m.type}`).join("; ")} }`;
  const relBranches = relMembers.map((active) => {
    const others = relMembers
      .filter((m) => m.name !== active.name)
      .map((m) => `; ${m.name}?: ${m.type}`)
      .join("");
    return `{ ${group.col.name}?: undefined; ${active.name}: ${active.type}${others} }`;
  });
  return `(${[scalarBranch, ...relBranches].join(" | ")})`;
}

/**
 * Nested-write relation member type for one relation (tasks.md A2.1/A2.2,
 * design.md Decision "relation input unions live in
 * packages/client/src/types.ts").
 *
 *  - `fkSide` (this table holds the FK, always to-one from here): the
 *    child's own `CreateInput` is referenced unomitted — nothing about the
 *    child needs hiding.
 *  - non-`fkSide` (the CHILD holds the FK back to this row, to-one or
 *    to-many): excludes the child's own FK column AND its corresponding
 *    `fkSide` relation field(s) so neither can conflict with the key supplied
 *    by the parent planner, while keeping any other required FK groups on the
 *    child (`authorId` vs `author`) intact.
 *
 * `update` gains `disconnect`/`set` only when the FK can legally become
 * NULL: always for a to-many (`ToManyRelationUpdateInput`), and for a
 * to-one only when `optionalFk` (spec Requirement 4) — a required to-one
 * can be replaced but never disconnected.
 */
function relationInputType(
  r: RelationInfo,
  mode: "create" | "update",
  requiredFkGroupsByTable: Map<string, RequiredFkGroup[]>,
  relationsByTable: Map<string, RelationInfo[]>,
): string {
  const whereType = `WhereInput<${r.target}>`;
  if (r.fkSide) {
    const createType = `${r.target}CreateInput`;
    return mode === "update" && r.optionalFk
      ? `ToOneRelationUpdateInput<${createType}, ${whereType}>`
      : `ToOneRelationInput<${createType}, ${whereType}>`;
  }

  const targetFkGroups = requiredFkGroupsByTable.get(r.target) ?? [];
  const targetRels = relationsByTable.get(r.target) ?? [];
  const matchingFkRels = targetRels.filter((tr) => !tr.composite && tr.fkSide && tr.from === r.to).map((tr) => tr.name);
  const omitCandidates = Array.from(new Set([r.to, ...matchingFkRels]));

  let childCreate: string;
  if (targetFkGroups.length === 0) {
    const omitUnion = omitCandidates.map((f) => JSON.stringify(f)).join(" | ");
    childCreate = `Omit<${r.target}CreateInput, ${omitUnion}>`;
  } else {
    const excludedFromBase = new Set<string>();
    for (const g of targetFkGroups) {
      excludedFromBase.add(g.col.name);
      for (const rel of g.rels) excludedFromBase.add(rel.name);
    }
    const baseOmit = omitCandidates.filter((f) => !excludedFromBase.has(f));
    const baseExpr =
      baseOmit.length > 0
        ? `Omit<${r.target}CreateBase, ${baseOmit.map((f) => JSON.stringify(f)).join(" | ")}>`
        : `${r.target}CreateBase`;
    const remainingGroups = targetFkGroups
      .filter((g) => g.col.name !== r.to)
      .map((g) => fkGroupUnion(g, requiredFkGroupsByTable, relationsByTable));
    childCreate = [baseExpr, ...remainingGroups].join(" & ");
  }

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

function generateCreateInput(
  table: ResolvedTable,
  relations: RelationInfo[],
  requiredFkGroupsByTable: Map<string, RequiredFkGroup[]>,
  relationsByTable: Map<string, RelationInfo[]>,
): string[] {
  const fkGroups = requiredFkGroupsByTable.get(table.name) ?? [];
  const excludedCols = new Set(fkGroups.map((g) => g.col.name));
  const excludedRels = new Set(fkGroups.flatMap((g) => g.rels.map((r) => r.name)));

  const interfaceName = fkGroups.length === 0 ? `${table.name}CreateInput` : `${table.name}CreateBase`;
  const lines = [`export interface ${interfaceName} {`];
  for (const col of table.columns) {
    if (col.autoincrement || excludedCols.has(col.name)) continue;
    const type = columnCreateFieldType(col);
    const opt = optionalOnCreate(col) ? "?" : "";
    lines.push(`  ${col.name}${opt}: ${type};`);
  }
  for (const r of relations) {
    if (r.composite || excludedRels.has(r.name)) continue;
    lines.push(`  ${r.name}?: ${relationInputType(r, "create", requiredFkGroupsByTable, relationsByTable)};`);
  }
  lines.push("}", "");

  if (fkGroups.length > 0) {
    const unions = fkGroups.map((g) => fkGroupUnion(g, requiredFkGroupsByTable, relationsByTable));
    lines.push(`export type ${table.name}CreateInput = ${interfaceName} & ${unions.join(" & ")};`, "");
  }
  return lines;
}

/**
 * `export interface <Model>CreateManyInput { ... }` (client-batch-aggregate
 * PR A.7, spec "Nested relation writes are not accepted"): the exact scalar
 * subset of `<Model>CreateInput` — same column set and optionality rules,
 * autoincrement columns omitted — but with every relation key left out
 * entirely, so `{ author: { create: {...} } }` inside a `createMany` data
 * element fails TypeScript's excess-property check instead of compiling.
 * Passed as `ModelDelegate`'s 6th (`CreateManyInput`) generic, distinct from
 * the full `CreateInput` the single-row `create()` method still accepts.
 */
function generateCreateManyInput(table: ResolvedTable): string[] {
  const lines = [`export interface ${table.name}CreateManyInput {`];
  for (const col of table.columns) {
    if (col.autoincrement) continue; // DB-generated identity
    const t = baseType(col);
    const type = col.nullable ? `${t} | null` : t;
    const opt = optionalOnCreate(col) ? "?" : "";
    lines.push(`  ${col.name}${opt}: ${type};`);
  }
  lines.push("}", "");
  return lines;
}

/** The table's declared primary-key columns. Single-column-PK models get a
 * `<Model>CursorInput` type (see below); every other shape (composite PK,
 * no PK) does not. */
function pkColumns(table: ResolvedTable) {
  return table.columns.filter((c) => c.isPk);
}

/**
 * `export interface <Model>CursorInput { <pk>: <type>; }` (client-batch-
 * aggregate PR B, design.md Decision #7) — emitted ONLY for single-column-PK
 * models. Passed as `ModelDelegate`'s 7th (`Cursor`) generic; composite-PK
 * or PK-less models pass `never` directly instead (no interface emitted),
 * making `cursor` unwritable in TS for those (spec "Composite primary keys
 * reject cursor").
 */
function generateCursorInput(table: ResolvedTable): string[] {
  const pks = pkColumns(table);
  if (pks.length !== 1) return [];
  const pk = pks[0]!;
  const t = baseType(pk);
  const type = pk.nullable ? `${t} | null` : t;
  return [`export interface ${table.name}CursorInput {`, `  ${pk.name}: ${type};`, `}`, ""];
}

/** The type argument to pass as `ModelDelegate`'s 7th (`Cursor`) generic:
 * `<Model>CursorInput` for a single-column-PK model, `never` (unwritable)
 * otherwise. */
function cursorGenericArg(table: ResolvedTable): string {
  return pkColumns(table).length === 1 ? `${table.name}CursorInput` : "never";
}

/**
 * `export type <Model>NumericFields = "a" | "b" | never;` (client-aggregation
 * PR C, design.md Decision #10) — the string-literal union of every field
 * tagged `numeric: true` in `__meta` (`isNumericColumn`). Passed as
 * `ModelDelegate`'s 8th (`Numeric`) generic, restricting `_sum`/`_avg` to
 * these fields only; `never` when the model has none, making `_sum`/`_avg`
 * unwritable in TS for it.
 */
function generateNumericFields(table: ResolvedTable): string[] {
  const fields = table.columns.filter(isNumericColumn).map((c) => c.name);
  const union = fields.length > 0 ? fields.map((f) => JSON.stringify(f)).join(" | ") : "never";
  return [`export type ${table.name}NumericFields = ${union};`, ""];
}

/**
 * `export type <Model>WhereUniqueInput = { <group0 fields> } | { <group1
 * fields> } | ...;` (client-upsert PR D, design.md Decisions #12-13) — one
 * object shape per declared unique group (`uniqueGroups`: PK first, then
 * `@unique` columns, then unique indexes), each member typed exactly like
 * `<Model>CreateInput`'s own scalar members. Passed as `ModelDelegate`'s 9th
 * (`UniqueWhere`) generic; a model with no declared unique group at all
 * (e.g. no PK, no `@unique`, no unique index) gets `never`, making `upsert`
 * unwritable in TS for it.
 */
function generateWhereUniqueInput(table: ResolvedTable): string[] {
  const groups = uniqueGroups(table);
  if (groups.length === 0) {
    return [`export type ${table.name}WhereUniqueInput = never;`, ""];
  }
  const colsByName = new Map(table.columns.map((c) => [c.name, c]));
  const shapes = groups.map((g) => {
    const members = g.map((f) => {
      const col = colsByName.get(f);
      const t = col ? baseType(col) : "unknown";
      const type = col?.nullable ? `${t} | null` : t;
      return `${f}: ${type}`;
    });
    return `{ ${members.join("; ")} }`;
  });
  return [`export type ${table.name}WhereUniqueInput = ${shapes.join(" | ")};`, ""];
}

/**
 * `export interface <Model>WhereInput { ... }` (client-where-composition PR
 * A, design.md "Types stay per-model and generated, mirroring
 * CreateInput/UpdateInput"). Every scalar column gets a `WhereValue<T>`
 * predicate (direct equality or operator object, mirroring the flat
 * `WhereInput<Row>` this replaces as the concrete `Where` type argument),
 * plus self-referential `AND?`/`OR?`/`NOT?` — fully inlined per model rather
 * than composed from a shared generic, matching `CreateInput`/`UpdateInput`'s
 * own emission style.
 *
 * PR B adds one `RelationFilter<<Target>WhereInput>` key per TO-MANY
 * relation (`r.list`), reusing `resolveRelationInfo`'s existing metadata —
 * no new runtime metadata needed (design.md "Target metadata"). Composite-key
 * and to-one relations get no key here (design.md "To-one relation filters
 * stay out of scope"; composite relations already can't reach `include`
 * either). PR C types a `Json`/`jsonb` column as `JsonFilter` instead of
 * `WhereValue<T>` (design.md "JSON Filter (PR C)"), driven by the same
 * `isJsonColumn` check that sets `__meta`'s `json: true` bit.
 */
function generateWhereInput(table: ResolvedTable, relations: RelationInfo[]): string[] {
  const lines = [`export interface ${table.name}WhereInput {`];
  for (const col of table.columns) {
    if (isJsonColumn(col)) {
      lines.push(`  ${col.name}?: JsonFilter;`);
      continue;
    }
    const t = baseType(col);
    const type = col.nullable ? `${t} | null` : t;
    lines.push(`  ${col.name}?: WhereValue<${type}>;`);
  }
  for (const r of relations) {
    if (r.composite || !r.list) continue;
    lines.push(`  ${r.name}?: RelationFilter<${r.target}WhereInput>;`);
  }
  lines.push(`  AND?: ${table.name}WhereInput[];`);
  lines.push(`  OR?: ${table.name}WhereInput[];`);
  lines.push(`  NOT?: ${table.name}WhereInput;`);
  lines.push("}", "");
  return lines;
}

function generateUpdateInput(
  table: ResolvedTable,
  relations: RelationInfo[],
  requiredFkGroupsByTable: Map<string, RequiredFkGroup[]>,
  relationsByTable: Map<string, RelationInfo[]>,
): string[] {
  const lines = [`export interface ${table.name}UpdateInput {`];
  for (const col of table.columns) {
    const t = baseType(col);
    const type = col.nullable ? `${t} | null` : t;
    lines.push(`  ${col.name}?: ${type};`);
  }
  for (const r of relations) {
    if (r.composite) continue;
    lines.push(`  ${r.name}?: ${relationInputType(r, "update", requiredFkGroupsByTable, relationsByTable)};`);
  }
  lines.push("}", "");
  return lines;
}
