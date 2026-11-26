/**
 * @indigodb/client — Model delegate
 *
 * Generic CRUD implementation shared by every model (`db.user`, `db.post`, …).
 * Builds parameterized SQL ($1, $2, …) from the Prisma-style argument objects
 * and maps between schema field names and physical column names in both
 * directions (SELECT aliases columns back to field names).
 */

import type {
  ModelMeta,
  IndexMeta,
  ExplainResult,
  RelationMeta,
  Executor,
  FindManyArgs,
  FindFirstArgs,
  FindUniqueArgs,
  CreateArgs,
  UpdateArgs,
  DeleteArgs,
  CountArgs,
  CreateManyArgs,
  UpdateManyArgs,
  DeleteManyArgs,
  BatchPayload,
  AggregateArgs,
  GroupByArgs,
  AggregateResult,
  GroupByResult,
  UpsertArgs,
  WhereInput,
  WhereFilter,
  OrderByInput,
  OrderDirection,
  SelectInput,
  IncludeInput,
  Payload,
} from "./types.js";
import { withQueryContext } from "./context.js";
import { defer, type IndigoPromise } from "./promise.js";

function quote(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

/**
 * Escape character declared on every `ILIKE` this file emits. PostgreSQL
 * already defaults to a backslash, but stating it makes the pattern's meaning
 * independent of server settings (`standard_conforming_strings`) instead of
 * inherited from them.
 */
const LIKE_ESCAPE_CLAUSE = ` ESCAPE '\\'`;

/**
 * Escapes the LIKE metacharacters in a `contains`/`startsWith`/`endsWith`
 * value so it matches as literal text.
 *
 * `types.ts` documents these three as substring/prefix/suffix matches, but
 * they compile to `ILIKE`, where `%` and `_` are wildcards and `\` escapes
 * them. Without this, a value carrying one silently widens the match:
 * `contains: "100%"` matched "1000 euros", `contains: "a_b"` matched "axb",
 * and a value mixing both (`"100\%"`) matched a row the caller never asked
 * for while missing the one it did.
 *
 * This was never an injection issue — the value has always travelled as a
 * bind parameter, so no SQL structure was reachable from it. The defect was
 * purely in pattern semantics. The backslash must be replaced first, or the
 * backslashes introduced for `%`/`_` would be escaped a second time.
 */
function escapeLikePattern(value: unknown): string {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Thrown by `loadRelations` when `include` targets an unusable relation —
 * unknown name, no sibling delegate registered, or a composite (multi-
 * column) key (see `types.ts`'s `CompositeRelationMeta`). */
export class IndigoRelationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndigoRelationError";
  }
}

/**
 * Error codes for `whereExpr` (client-where-composition spec/design.md
 * Decision "Unknown `where` key | Throw `IndigoWhereError` (PR A)").
 * `UNKNOWN_WHERE_KEY` is the exact defect the proposal opens with (an
 * unrecognized key like `OR` silently treated as a column, crashing at the
 * database instead of failing fast); `NOT_MUST_BE_OBJECT` guards the
 * runtime half of "NOT accepts a single object only, no array form"
 * (design.md Open Questions) for callers that bypass the type system.
 * `PATH_ON_NON_JSON_FIELD` (PR C) guards a `path` filter key used against a
 * field whose `FieldMeta.json` bit is unset — a typed error instead of
 * silently emitting `#>` on a non-JSON column (design.md Decision "JSON
 * detection"). `EMPTY_WHERE` (client-batch-aggregate PR A, design.md
 * Decision #4) guards `updateMany`/`deleteMany`'s required-`where` rule: an
 * absent or empty `where` would otherwise silently become a whole-table
 * mutation (`buildWhere` returns `""` for `{}`).
 */
export type WhereErrorCode =
  | "UNKNOWN_WHERE_KEY"
  | "NOT_MUST_BE_OBJECT"
  | "PATH_ON_NON_JSON_FIELD"
  | "EMPTY_WHERE";

/** Thrown by `whereExpr` when a `where` clause references an unrecognized
 * key or violates a structural-key shape rule. */
export class IndigoWhereError extends Error {
  readonly code: WhereErrorCode;
  constructor(code: WhereErrorCode, message: string) {
    super(message);
    this.name = "IndigoWhereError";
    this.code = code;
  }
}

/**
 * Error codes for argument-shape rejections that are not `where`-specific
 * (client-batch-aggregate design.md Decision #2: "One new
 * `IndigoArgumentError extends Error` with a `code` union, extended
 * additively per PR"). `EMPTY_BATCH` (PR A) guards `createMany([])` — an
 * empty `data` array carries no rows to build a `VALUES` list from.
 * `CURSOR_COMPOSITE_PK`/`CURSOR_NO_PK` (PR B) guard `findMany`'s `cursor`
 * option: it identifies a row by a SINGLE primary-key column (design.md
 * Decision #7), so a model whose primary key spans more than one column, or
 * has none at all, cannot use it — a runtime pk-count guard for `as any`/
 * stale-client bypasses of the compile-time `cursor?: never` the generator
 * emits for those models (client-cursor-pagination spec).
 * `NON_NUMERIC_AGGREGATE`/`UNKNOWN_AGGREGATE_FIELD`/`EMPTY_AGGREGATE` (PR C,
 * client-aggregation spec) guard `aggregate`/`groupBy`: `_sum`/`_avg` on a
 * field not tagged `FieldMeta.numeric` throws before any SQL is built (the
 * compile-time `Numeric`-restricted `_sum`/`_avg` keys are a TS-only guard;
 * this catches `as any`/stale-compiled-client bypasses), any aggregate op on
 * a field absent from `meta.fields` throws `UNKNOWN_AGGREGATE_FIELD`, and
 * requesting no aggregate at all (`aggregate({})`) throws `EMPTY_AGGREGATE`
 * — there would be nothing to `SELECT`.
 * `NO_MATCHING_UNIQUE_CONSTRAINT` (PR D, client-upsert spec) guards
 * `upsert`'s `where`: it must contain ONLY plain scalar equalities (no
 * operator objects, no `AND`/`OR`/`NOT` — `ON CONFLICT` cannot represent
 * arbitrary `WHERE` logic) and its key set must exactly match one declared
 * unique-constraint group in `__meta.uniqueGroups` (single-column or
 * composite; a partial composite match is rejected the same as a wholly
 * non-unique `where`) — the compile-time `UniqueWhere`-restricted `where`
 * shape is a TS-only guard; this catches `as any`/stale-compiled-client
 * bypasses.
 */
export type ArgumentErrorCode =
  | "EMPTY_BATCH"
  | "CURSOR_COMPOSITE_PK"
  | "CURSOR_NO_PK"
  | "NON_NUMERIC_AGGREGATE"
  | "UNKNOWN_AGGREGATE_FIELD"
  | "EMPTY_AGGREGATE"
  | "NO_MATCHING_UNIQUE_CONSTRAINT"
  | "EMPTY_UPDATE_DATA";

/** Thrown for a caller-supplied argument shape that is rejected before any
 * SQL is issued, for rejections that are not a `where`-clause defect (see
 * `IndigoWhereError` for those). */
export class IndigoArgumentError extends Error {
  readonly code: ArgumentErrorCode;
  constructor(code: ArgumentErrorCode, message: string) {
    super(message);
    this.name = "IndigoArgumentError";
    this.code = code;
  }
}

/**
 * Error codes for the nested-write planner (design.md Decision "reuse
 * `IndigoRelationError` as the base of a new subclass"; client-nested-writes
 * spec). `NO_ATOMIC_SEAM` is not in the spec's requirement list — it guards
 * an internal invariant (a delegate constructed without a sibling registry
 * cannot route a nested write) rather than a caller-input mistake.
 */
export type NestedWriteErrorCode =
  | "UNKNOWN_FIELD"
  | "COMPOSITE_RELATION"
  | "CONNECT_NOT_FOUND"
  | "REQUIRED_RELATION_DISCONNECT"
  | "UNKNOWN_RELATION_OP"
  | "AMBIGUOUS_UPDATE_TARGET"
  | "NO_ATOMIC_SEAM";

/** Thrown by the nested-write planner (`create`/`update`'s relation
 * sub-operation handling). Extends `IndigoRelationError` so existing callers
 * catching that base class keep working; `code` gives programmatic
 * branching the message string alone cannot (design.md). */
export class IndigoNestedWriteError extends IndigoRelationError {
  readonly code: NestedWriteErrorCode;
  constructor(code: NestedWriteErrorCode, message: string) {
    super(message);
    this.name = "IndigoNestedWriteError";
    this.code = code;
  }
}

/**
 * Thrown when `update`/`delete` matches zero rows (client-write-preconditions
 * spec, design.md Decision D1). Declared here — not in `errors.ts` — because
 * `IndigoDatabaseError`/`withDatabaseErrors` are spec-scoped to wrapping pg
 * SQLSTATE failures and forbid wrapping non-pg errors; a zero-row write never
 * reaches the driver as a failure. Thrown at all three write sites: the
 * direct scalar `rawUpdate` path, `deleteImpl`, and `updateImpl`'s
 * relation-ops-only branch. */
export class IndigoNotFoundError extends Error {
  readonly code = "RECORD_NOT_FOUND";
  constructor(
    readonly model: string,
    readonly operation: "update" | "delete",
  ) {
    super(`IndigoDB: \`${operation}\` on "${model}" matched zero rows.`);
    this.name = "IndigoNotFoundError";
  }
}

/** Lazy registry of every model's delegate, keyed by model name — passed as
 * the ctor's last argument so `__delegates` can construct all delegates
 * before any of them exist yet (design.md Decision #3). */
export type SiblingRegistry = Record<string, ModelDelegate<any, any, any, any>>;

/**
 * Atomicity seam for nested writes (design.md Decision "atomicity via
 * `runAtomic`, a 4th `__delegates` argument"; client-transactions spec).
 * `fn` receives the SAME sibling registry a nested write's per-op executors
 * reach through `siblings()` — either a brand-new transaction's registry
 * (top-level call) or the CURRENT transaction's registry, reused with no new
 * transaction opened (call issued via `tx.<model>.create/update` inside an
 * active `$transaction`).
 *
 * PR A (this file) only threads the seam through the constructor — no
 * planner reads it yet (that's PR B/C).
 */
export type RunAtomic = <T>(fn: (tx: SiblingRegistry) => Promise<T>) => Promise<T>;

/** Accumulates positional parameters for a statement. */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

const OPERATORS = new Set([
  "equals",
  "not",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "startsWith",
  "endsWith",
]);

function isFilterObject(value: unknown): value is WhereFilter<unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value as object).some((k) => OPERATORS.has(k));
}

/** `"col"` unqualified at depth 0 (`alias: null`), `"alias"."col"` inside a
 * correlated subquery (PR B). `alias: null` must reproduce the exact
 * unqualified column text every pre-existing statement already emits
 * (design.md Decision "Column qualification"). */
function qualifiedColumn(alias: string | null, dbName: string): string {
  return alias !== null ? `${quote(alias)}.${quote(dbName)}` : quote(dbName);
}

/** One field-level clause — the exact operator handling `buildWhere` used to
 * inline per entry, now shared by `whereExpr`'s field-key branch. Multiple
 * operators on the same field (e.g. `{ gt: 1, lt: 10 }`) join with `AND`,
 * matching the original flat join's ordering and text exactly. */
function fieldExpr(column: string, raw: unknown, params: Params): string {
  if (raw === null) return `${column} IS NULL`;

  if (isFilterObject(raw)) {
    const f = raw as WhereFilter<unknown>;
    const clauses: string[] = [];
    // NULL never compares equal to anything in SQL, so binding it as a
    // parameter makes the clause unsatisfiable rather than "match the NULL
    // rows". `equals: null` has to become IS NULL — the `raw === null`
    // shorthand above already did, and the two spellings disagreeing was the
    // same API contradicting itself.
    if ("equals" in f)
      clauses.push(f.equals === null ? `${column} IS NULL` : `${column} = ${params.add(f.equals)}`);
    // Negation is Prisma-compatible: NULL rows survive it. `not: null` is
    // IS NOT NULL (as `<> $1` could not match any row in any database), and
    // `not: value` keeps the NULL rows a caller reading "everything except
    // value" expects — plain `<>` silently drops them.
    if ("not" in f)
      clauses.push(
        f.not === null
          ? `${column} IS NOT NULL`
          : `(${column} <> ${params.add(f.not)} OR ${column} IS NULL)`,
      );
    if ("in" in f) clauses.push(`${column} = ANY(${params.add(f.in)})`);
    // Same negation rule as `not` — splitting their NULL behaviour would be
    // arbitrary. `notIn: []` stays "match everything": `<> ALL('{}')` is true
    // for every non-NULL row, and the OR now covers the NULL ones too.
    if ("notIn" in f)
      clauses.push(`(${column} <> ALL(${params.add(f.notIn)}) OR ${column} IS NULL)`);
    if ("lt" in f) clauses.push(`${column} < ${params.add(f.lt)}`);
    if ("lte" in f) clauses.push(`${column} <= ${params.add(f.lte)}`);
    if ("gt" in f) clauses.push(`${column} > ${params.add(f.gt)}`);
    if ("gte" in f) clauses.push(`${column} >= ${params.add(f.gte)}`);
    if ("contains" in f)
      clauses.push(
        `${column} ILIKE ${params.add(`%${escapeLikePattern(f.contains)}%`)}${LIKE_ESCAPE_CLAUSE}`,
      );
    if ("startsWith" in f)
      clauses.push(
        `${column} ILIKE ${params.add(`${escapeLikePattern(f.startsWith)}%`)}${LIKE_ESCAPE_CLAUSE}`,
      );
    if ("endsWith" in f)
      clauses.push(
        `${column} ILIKE ${params.add(`%${escapeLikePattern(f.endsWith)}`)}${LIKE_ESCAPE_CLAUSE}`,
      );
    return clauses.join(" AND ");
  }

  // Direct equality.
  return `${column} = ${params.add(raw)}`;
}

/** Whether `raw` is shaped like a `JsonFilter` — a plain object carrying a
 * `path` key (client-where-composition PR C). Checked BEFORE `fieldMeta.json`
 * so a `path` key against a non-JSON field is a typed error rather than a
 * silent equality bind of the raw filter object (design.md Decision "JSON
 * detection"). */
function isJsonPathFilter(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return "path" in value;
}

/** JSON path operator clauses — the exact operator handling table in
 * design.md "JSON Filter (PR C)". `$p = params.add(path)` is bound ONCE per
 * filter object as `text[]`; `equals`/`not` compile via jsonb equality
 * (`#>`), `gt`/`gte`/`lt`/`lte` compare the path's TEXT representation
 * (`#>>`), cast to `::numeric` only when the operand is a JS `number`
 * (design.md's explicit cast rule — `#>>` always returns `text`), and
 * `jsonContains` is `@>` containment. Multiple operator keys on the same
 * filter object join with `AND`, matching `fieldExpr`'s own join style. */
function jsonFilterExpr(column: string, raw: Record<string, unknown>, params: Params): string {
  const path = raw.path as string[];
  const p = `${params.add(path)}::text[]`;
  const clauses: string[] = [];

  if ("equals" in raw) {
    clauses.push(`(${column} #> ${p}) = ${params.add(JSON.stringify(raw.equals))}::jsonb`);
  }
  if ("not" in raw) {
    clauses.push(`(${column} #> ${p}) <> ${params.add(JSON.stringify(raw.not))}::jsonb`);
  }

  const textOp = (key: "gt" | "gte" | "lt" | "lte", sqlOp: string): void => {
    if (!(key in raw)) return;
    const value = raw[key];
    const cast = typeof value === "number" ? "::numeric" : "";
    clauses.push(`(${column} #>> ${p})${cast} ${sqlOp} ${params.add(value)}`);
  };
  textOp("gt", ">");
  textOp("gte", ">=");
  textOp("lt", "<");
  textOp("lte", "<=");

  if ("jsonContains" in raw) {
    clauses.push(`(${column} #> ${p}) @> ${params.add(JSON.stringify(raw.jsonContains))}::jsonb`);
  }

  return clauses.join(" AND ");
}

/** Recursion context threaded through `whereExpr` (design.md's `WhereCtx`).
 * `alias: null` at depth 0 keeps every pre-existing statement's SQL
 * byte-identical; a correlated subquery (PR B) passes `"t{depth}"`. */
interface WhereCtx {
  params: Params;
  alias: string | null;
  depth: number;
}

export class ModelDelegate<
  Row,
  CreateInput,
  UpdateInput,
  Rel = Record<string, never>,
  Where = WhereInput<Row>,
  /**
   * `createMany`'s scalar-only input type (client-batch-aggregate PR A.7,
   * spec "Nested relation writes are not accepted"): defaulted to
   * `CreateInput` so hand-authored `ModelDelegate` usage (tests, ad-hoc
   * callers) is unaffected, but the generated client passes a distinct
   * `<Model>CreateManyInput` — `CreateInput` with every relation key
   * omitted — so passing `{ author: { create: {...} } }` inside a
   * `createMany` data element is a compile-time excess-property error,
   * not just a runtime shape the planner happens to ignore. Follows the
   * `Where` 5th-generic precedent (design.md Decision #7 / `types.ts:98`).
   */
  CreateManyInput = CreateInput,
  /**
   * `findMany`'s `cursor` input type (client-batch-aggregate PR B,
   * design.md Decision #7 — specced as "the 6th generic" before PR A's
   * `CreateManyInput` claimed that slot, so this is the 7th). Defaults to
   * `never` so hand-authored `ModelDelegate` usage cannot pass a `cursor`
   * at all unless it opts in; the generated client passes `<Model>CursorInput`
   * (`{ <pk>: <type> }`) for single-column-PK models and `never` for
   * composite-PK/PK-less models — `cursor?: never` is unwritable in TS for
   * those, on top of `findManyImpl`'s runtime pk-count guard.
   */
  Cursor = never,
  /**
   * `aggregate`/`groupBy`'s numeric-restricted `_sum`/`_avg` field union
   * (client-aggregation PR C, design.md Decisions #9-11) — an 8th, defaulted
   * generic appended at the end (Cursor already claimed the 7th slot; this
   * follows the same defaulted-generic precedent without renumbering
   * anything). Defaults to `never` so hand-authored `ModelDelegate` usage
   * cannot pass any `_sum`/`_avg` field at all unless it opts in; the
   * generated client passes `<Model>NumericFields` (a string-literal union
   * of every field tagged `FieldMeta.numeric: true`) — a non-numeric field
   * is then a compile-time excess-property error, on top of
   * `aggregate`/`groupBy`'s runtime `NON_NUMERIC_AGGREGATE` guard.
   */
  Numeric extends string = never,
  /**
   * `upsert`'s conflict-target `where` shape (client-upsert PR D, design.md
   * Decisions #12-13) — a 9th, defaulted generic appended at the end
   * (`Numeric` already claimed the 8th slot; this follows the same
   * defaulted-generic precedent without renumbering anything). Defaults to
   * `never` so hand-authored `ModelDelegate` usage cannot call `upsert` at
   * all unless it opts in; the generated client passes
   * `<Model>WhereUniqueInput` — a union of one object shape per declared
   * unique group in `__meta.uniqueGroups` — making a `where` that doesn't
   * match a declared group a compile-time error, on top of `upsertImpl`'s
   * runtime `NO_MATCHING_UNIQUE_CONSTRAINT` guard.
   */
  UniqueWhere = never,
> {
  /**
   * Atomicity seam for nested writes (design.md Decision "atomicity via
   * `runAtomic`, a 4th `__delegates` argument"; see `RunAtomic`'s own doc
   * comment). Defaults to IDENTITY — calls `fn` with this delegate's own
   * `siblings()` registry directly, opening no new transaction — the shape
   * the generated `__delegates(exec, realtime)` factory relies on when
   * called from inside an already-open `$transaction`. The generated
   * top-level constructor passes an explicit `(fn) => this.$transaction(fn)`
   * instead, which opens a real transaction around `fn`.
   */
  protected readonly runAtomic: RunAtomic;

  constructor(
    protected readonly meta: ModelMeta,
    protected readonly exec: Executor,
    /** Thunk resolving every model's delegate by name, so `include` can
     * reach a sibling model's own `findMany` for the follow-up query
     * (design.md Decision #2/#3). Undefined for models with no relations —
     * `__delegates` always passes it when any model has relations. */
    protected readonly siblings?: () => SiblingRegistry,
    runAtomic?: RunAtomic,
  ) {
    this.runAtomic =
      runAtomic ?? (async (fn) => fn(this.siblings?.() ?? ({} as SiblingRegistry)));
  }

  private col(field: string): string {
    return this.meta.fields[field]?.db ?? field;
  }

  /** Serializes JSON column values so arrays/primitives bind as valid jsonb across pg and PGlite. */
  private paramValue(field: string, value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (this.meta.fields[field]?.json) return JSON.stringify(value);
    return value;
  }

  /** `"db" AS "field"` list for every column (or the selected subset). */
  private selectList(select?: SelectInput<Row>): string {
    const fields = Object.keys(this.meta.fields).filter((f) => {
      if (!select) return true;
      return (select as Record<string, boolean>)[f] === true;
    });
    const chosen = fields.length > 0 ? fields : Object.keys(this.meta.fields);
    return chosen.map((f) => `${quote(this.col(f))} AS ${quote(f)}`).join(", ");
  }

  /**
   * `some`/`every`/`none` relation-filter compilation (client-where-composition
   * PR B, design.md "Relation SQL Shapes (PR B)"). `R` is the CURRENT
   * model's relation metadata for `key` — `from`/`to` are FIELD names,
   * resolved to physical column names via `meta`/`targetMeta`. Parent
   * qualifier `P`: the physical table name at depth 0 (`ctx.alias === null`
   * — valid because the outer `FROM` has no alias there), else the alias
   * assigned to THIS model at its own depth. Child alias `C = "t{depth+1}"`
   * — depth-indexed so a self-relation nests without colliding with its own
   * parent alias (tasks.md B3.2). A `null` nested filter (`some: {}`) drops
   * the `AND (<f>)` term for `some`/`none` ("has any/no child" at all); for
   * `every` it instead substitutes `AND FALSE` so a trivial nested filter
   * still yields the vacuous-truth identity regardless of child count
   * (`every: {}` must always be true, not "no children exist").
   */
  private relationFilterExpr(
    op: "some" | "every" | "none",
    relMeta: RelationMeta,
    nested: unknown,
    meta: ModelMeta,
    ctx: WhereCtx,
  ): string {
    const registry = this.siblings?.();
    const targetDelegate = registry?.[relMeta.target];
    if (!targetDelegate) {
      throw new IndigoRelationError(
        `IndigoDB: no delegate registered for relation target "${relMeta.target}". ` +
          `This client was likely constructed without the generated sibling registry.`,
      );
    }
    const targetMeta = targetDelegate.meta;
    const childAlias = `t${ctx.depth + 1}`;
    const parentQualifier = ctx.alias !== null ? quote(ctx.alias) : quote(meta.table);
    const fromCol = meta.fields[relMeta.from]?.db ?? relMeta.from;
    const toCol = targetMeta.fields[relMeta.to]?.db ?? relMeta.to;
    const correlation = `${quote(childAlias)}.${quote(toCol)} = ${parentQualifier}.${quote(fromCol)}`;

    const nestedExpr = this.whereExpr(nested as Record<string, unknown> | undefined, targetMeta, {
      params: ctx.params,
      alias: childAlias,
      depth: ctx.depth + 1,
    });

    let subqueryWhere: string;
    if (op === "every") {
      subqueryWhere = nestedExpr !== null ? `${correlation} AND NOT (${nestedExpr})` : `${correlation} AND FALSE`;
    } else {
      subqueryWhere = nestedExpr !== null ? `${correlation} AND (${nestedExpr})` : correlation;
    }

    const subquery = `SELECT 1 FROM ${quote(targetMeta.table)} AS ${quote(childAlias)} WHERE ${subqueryWhere}`;
    return op === "some" ? `EXISTS (${subquery})` : `NOT EXISTS (${subquery})`;
  }

  /**
   * Recursive boolean-expression builder (client-where-composition PR A,
   * design.md). Dispatch order per object: `AND`/`OR`/`NOT` (structural,
   * checked BEFORE `meta.fields` so they can never be resolved as column
   * names — the exact defect this closes: `where: { OR: [...] }` used to
   * compile to `"OR" = $1` and crash at the database) → `meta.relations[key]`
   * (PR B relation filters) → `meta.fields[key]` → `IndigoWhereError` on
   * anything else. Returns `null` for "no constraint"
   * (`undefined`/`{}`/`AND:[{}]`/`NOT:{}`), distinct from a legitimately
   * empty string, so those identities stay explicit rather than accidental
   * (design.md Decision "Expr shape").
   */
  private whereExpr(
    where: Record<string, unknown> | null | undefined,
    meta: ModelMeta,
    ctx: WhereCtx,
  ): string | null {
    if (!where) return null;
    const parts: string[] = [];

    for (const [key, raw] of Object.entries(where)) {
      if (raw === undefined) continue;

      if (key === "AND" || key === "OR") {
        const list = Array.isArray(raw) ? raw : [raw];
        // Empty-array identity (spec "Empty AND/OR identity semantics"):
        // `AND: []` is a tautology, `OR: []` is a contradiction — NOT the
        // same as "contributes nothing" (see below, an all-null recursion).
        if (list.length === 0) {
          parts.push(key === "AND" ? "TRUE" : "FALSE");
          continue;
        }
        const subs = list
          .map((w) => this.whereExpr(w as Record<string, unknown>, meta, ctx))
          .filter((s): s is string => s !== null);
        // Every element compiled to "no constraint" (e.g. `AND: [{}]`) —
        // this AND/OR contributes nothing, distinct from `AND: []` above.
        if (subs.length === 0) continue;
        parts.push(subs.length === 1 ? subs[0]! : `(${subs.join(` ${key} `)})`);
        continue;
      }

      if (key === "NOT") {
        if (Array.isArray(raw)) {
          throw new IndigoWhereError(
            "NOT_MUST_BE_OBJECT",
            `IndigoDB: "NOT" on "${meta.name}" accepts a single where object, not an array.`,
          );
        }
        const sub = this.whereExpr(raw as Record<string, unknown>, meta, ctx);
        if (sub === null) continue; // `NOT: {}` contributes nothing.
        parts.push(`NOT (${sub})`);
        continue;
      }

      const relMeta = meta.relations?.[key];
      if (relMeta) {
        if ("composite" in relMeta) {
          throw new IndigoRelationError(
            `IndigoDB: relation "${key}" (→ ${relMeta.target}) spans more than one column and cannot be ` +
              `used in a \`where\` filter — only single-column relation keys are supported.`,
          );
        }
        const filter = raw as Record<string, unknown>;
        for (const op of ["some", "every", "none"] as const) {
          if (!(op in filter)) continue;
          parts.push(this.relationFilterExpr(op, relMeta, filter[op], meta, ctx));
        }
        continue;
      }

      const fieldMeta = meta.fields[key];
      if (!fieldMeta) {
        throw new IndigoWhereError(
          "UNKNOWN_WHERE_KEY",
          `IndigoDB: "${key}" is not a recognized \`where\` key on "${meta.name}" — check the generated ` +
            `<Model>WhereInput type.`,
        );
      }
      const column = qualifiedColumn(ctx.alias, fieldMeta.db);

      if (isJsonPathFilter(raw)) {
        if (!fieldMeta.json) {
          throw new IndigoWhereError(
            "PATH_ON_NON_JSON_FIELD",
            `IndigoDB: "${key}" on "${meta.name}" received a \`path\` filter, but "${key}" is not a ` +
              `Json/jsonb column — check the generated <Model>WhereInput type.`,
          );
        }
        parts.push(jsonFilterExpr(column, raw, ctx.params));
        continue;
      }

      parts.push(fieldExpr(column, raw, ctx.params));
    }

    if (parts.length === 0) return null;
    return parts.join(" AND ");
  }

  /** Thin wrapper (design.md): delegates to `whereExpr` at depth 0 with
   * `alias: null`, so every pre-existing generated statement stays
   * byte-identical, and wraps a non-null result in ` WHERE `. */
  private buildWhere(where: Where | undefined, params: Params): string {
    const expr = this.whereExpr(where as Record<string, unknown> | undefined, this.meta, {
      params,
      alias: null,
      depth: 0,
    });
    return expr !== null ? ` WHERE ${expr}` : "";
  }

  /** Guards `updateMany`/`deleteMany`'s required-`where` rule (spec
   * "updateMany and deleteMany require a non-empty where", design.md
   * Decision #4): an absent `where` or `where: {}` throws BEFORE any SQL is
   * built — `buildWhere` alone would silently compile `{}` to `""`
   * (no `WHERE` clause at all), turning the accident into
   * `UPDATE/DELETE ... <table>` with no filter. */
  private requireNonEmptyWhere(where: Where | undefined): void {
    if (!where || Object.keys(where as Record<string, unknown>).length === 0) {
      throw new IndigoWhereError(
        "EMPTY_WHERE",
        `IndigoDB: \`where\` on "${this.meta.name}" must be a non-empty object for this operation — ` +
          `an absent or empty \`where\` would affect every row.`,
      );
    }
  }

  /**
   * `cursorPk`/`cursorDir` (client-batch-aggregate PR B, design.md Decision
   * #6): when a `cursor` is in play, the primary-key column is appended as
   * the FINAL `ORDER BY` term — UNLESS it is already present among the
   * caller's own `orderBy` entries, in which case that entry's own
   * direction is authoritative (and is what `findManyImpl` uses to pick
   * `>=` vs `<=` for the cursor comparison) and nothing is appended.
   */
  /**
   * `distinctFields` (client-aggregation PR C, design.md Decision #8):
   * `SELECT DISTINCT ON (<fields>)` requires those exact fields to be the
   * `ORDER BY`'s LEFTMOST terms — prepended here, in order, UNLESS the
   * caller's own `orderBy` already leads with exactly that sequence (skip
   * re-emitting a duplicate column reference).
   */
  private buildOrderBy(
    orderBy: OrderByInput<Row> | Array<OrderByInput<Row>> | undefined,
    cursorPk?: string,
    cursorDir: OrderDirection = "asc",
    distinctFields?: string[],
  ): string {
    const entries = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
    const parts: string[] = [];
    let pkPresent = false;

    if (distinctFields && distinctFields.length > 0) {
      const flatFields = entries.flatMap((entry) => Object.keys(entry));
      const alreadyLeading = distinctFields.every((f, i) => flatFields[i] === f);
      if (!alreadyLeading) {
        for (const f of distinctFields) parts.push(`${quote(this.col(f))}`);
      }
    }

    for (const entry of entries) {
      for (const [field, dir] of Object.entries(entry)) {
        if (cursorPk !== undefined && field === cursorPk) pkPresent = true;
        parts.push(`${quote(this.col(field))} ${dir === "desc" ? "DESC" : "ASC"}`);
      }
    }
    if (cursorPk !== undefined && !pkPresent) {
      parts.push(`${quote(this.col(cursorPk))} ${cursorDir === "desc" ? "DESC" : "ASC"}`);
    }
    return parts.length > 0 ? ` ORDER BY ${parts.join(", ")}` : "";
  }

  /**
   * Runtime pk-count guard for `findMany`'s `cursor` option (design.md
   * Decision #7, client-cursor-pagination spec): resolves the model's
   * SINGLE primary-key field name, throwing a typed `IndigoArgumentError`
   * BEFORE any SQL is built when the model has none (`CURSOR_NO_PK`) or more
   * than one (`CURSOR_COMPOSITE_PK`) — the compile-time `cursor?: never` the
   * generator emits for those models is a TS-only guard; this catches
   * `as any`/stale-compiled-client bypasses.
   */
  private resolveCursorPk(): string {
    const pkFields = Object.keys(this.meta.fields).filter((f) => this.meta.fields[f]?.pk);
    if (pkFields.length === 0) {
      throw new IndigoArgumentError(
        "CURSOR_NO_PK",
        `IndigoDB: \`cursor\` on "${this.meta.name}" requires a declared primary key, but this model has none.`,
      );
    }
    if (pkFields.length > 1) {
      throw new IndigoArgumentError(
        "CURSOR_COMPOSITE_PK",
        `IndigoDB: \`cursor\` on "${this.meta.name}" is not supported for composite primary keys ` +
          `(${pkFields.join(", ")}) — cursor pagination on a composite PK is out of scope; use \`skip\`/\`take\` instead.`,
      );
    }
    return pkFields[0]!;
  }

  /** Direction to use for the pk's cursor comparison and its appended
   * `ORDER BY` tiebreaker: the direction of the pk's OWN entry in the
   * caller's `orderBy`, if present, else `asc` (design.md Decision #6). */
  private cursorDirection(
    orderBy: OrderByInput<Row> | Array<OrderByInput<Row>> | undefined,
    cursorPk: string,
  ): OrderDirection {
    const entries = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
    for (const entry of entries) {
      const dir = (entry as Record<string, OrderDirection>)[cursorPk];
      if (dir !== undefined) return dir;
    }
    return "asc";
  }

  /** Declared secondary/unique indexes on this model (`__meta[Model].indexes`). */
  get indexes(): readonly IndexMeta[] {
    return this.meta.indexes ?? [];
  }

  private buildFindManyQuery<
    A extends FindManyArgs<Row, Rel, Where, Cursor> = FindManyArgs<Row, Rel, Where, Cursor>,
  >(args: A, selectOverride?: SelectInput<Row>): { sql: string; params: unknown[] } {
    const cursor = args.cursor as Record<string, unknown> | undefined;
    let cursorPk: string | undefined;
    let cursorDir: OrderDirection = "asc";
    if (cursor !== undefined) {
      cursorPk = this.resolveCursorPk();
      cursorDir = this.cursorDirection(args.orderBy, cursorPk);
    }

    const distinct = args.distinct as string[] | undefined;

    const params = new Params();
    const distinctClause =
      distinct && distinct.length > 0
        ? `DISTINCT ON (${distinct.map((f) => quote(this.col(f))).join(", ")}) `
        : "";
    let sql = `SELECT ${distinctClause}${this.selectList(selectOverride ?? args.select)} FROM ${quote(this.meta.table)}`;

    const whereExpr = this.whereExpr(args.where as Record<string, unknown> | undefined, this.meta, {
      params,
      alias: null,
      depth: 0,
    });
    let combinedExpr = whereExpr;
    if (cursorPk !== undefined) {
      const column = quote(this.col(cursorPk));
      const op = cursorDir === "desc" ? "<=" : ">=";
      const cursorClause = `${column} ${op} ${params.add(cursor![cursorPk])}`;
      combinedExpr = combinedExpr !== null ? `${combinedExpr} AND ${cursorClause}` : cursorClause;
    }
    if (combinedExpr !== null) sql += ` WHERE ${combinedExpr}`;

    sql += this.buildOrderBy(args.orderBy, cursorPk, cursorDir, distinct);
    if (args.take !== undefined) sql += ` LIMIT ${params.add(args.take)}`;
    const skip = args.skip !== undefined ? args.skip : cursorPk !== undefined ? 1 : undefined;
    if (skip !== undefined) sql += ` OFFSET ${params.add(skip)}`;
    return { sql, params: params.values };
  }

  /**
   * Runs PostgreSQL `EXPLAIN (FORMAT JSON)` over the exact parameterized SQL
   * `findMany(args)` would execute and summarizes index usage (`usesIndex`,
   * `indexNames`, `scanTypes`, `totalCost`, and the raw root `plan` node).
   */
  async explain<
    A extends FindManyArgs<Row, Rel, Where, Cursor> = FindManyArgs<Row, Rel, Where, Cursor>,
  >(args: A = {} as A): Promise<ExplainResult> {
    const { sql, params } = this.buildFindManyQuery(args);
    const rows = (await this.exec(`EXPLAIN (FORMAT JSON) ${sql}`, params)) as Array<
      Record<string, unknown>
    >;
    const raw = rows[0]?.["QUERY PLAN"];
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const plan =
      Array.isArray(parsed) && parsed[0] && typeof parsed[0] === "object"
        ? (((parsed[0] as Record<string, unknown>).Plan as Record<string, unknown>) ?? {})
        : {};
    const scanTypes: string[] = [];
    const indexNames: string[] = [];
    const walk = (node: Record<string, unknown>) => {
      if (typeof node["Node Type"] === "string") scanTypes.push(node["Node Type"]);
      if (typeof node["Index Name"] === "string") indexNames.push(node["Index Name"]);
      if (Array.isArray(node.Plans)) {
        for (const child of node.Plans) {
          if (child && typeof child === "object") walk(child as Record<string, unknown>);
        }
      }
    };
    walk(plan);
    const totalCost = typeof plan["Total Cost"] === "number" ? plan["Total Cost"] : null;
    const usesIndex =
      indexNames.length > 0 || scanTypes.some((t) => t.includes("Index"));
    return { sql, params, usesIndex, indexNames, scanTypes, totalCost, plan };
  }

  findMany<
    A extends FindManyArgs<Row, Rel, Where, Cursor> = FindManyArgs<Row, Rel, Where, Cursor>,
  >(args: A = {} as A): IndigoPromise<Payload<Row, Rel, A>[]> {
    return defer(this.meta.name, "findMany", this, (d) =>
      withQueryContext({ model: d.meta.name, operation: "findMany" }, () => d.findManyImpl(args)),
    );
  }

  private async findManyImpl<
    A extends FindManyArgs<Row, Rel, Where, Cursor> = FindManyArgs<Row, Rel, Where, Cursor>,
  >(args: A): Promise<Payload<Row, Rel, A>[]> {
    const include = args.include as IncludeInput<Rel> | undefined;

    // Join-key stripping (design.md Data Flow, tasks.md Phase 4): when a
    // `select` is combined with `include`, force each included relation's
    // parent-side stitch key into the query even if it wasn't explicitly
    // selected, then strip it back off the final rows below.
    let select = args.select;
    const forcedParentKeys = new Set<string>();
    if (include && select) {
      for (const name of Object.keys(include)) {
        const spec = (include as Record<string, unknown>)[name];
        if (spec === undefined || spec === false) continue;
        const relMeta = this.meta.relations?.[name];
        if (!relMeta || "composite" in relMeta) continue; // validated in loadRelations
        if (!(select as Record<string, boolean>)[relMeta.from]) {
          forcedParentKeys.add(relMeta.from);
        }
      }
      if (forcedParentKeys.size > 0) {
        select = {
          ...(select as Record<string, boolean>),
          ...Object.fromEntries([...forcedParentKeys].map((f) => [f, true])),
        } as SelectInput<Row>;
      }
    }

    const { sql, params } = this.buildFindManyQuery(args, select);
    const rows = (await this.exec(sql, params)) as Record<string, unknown>[];

    if (include) {
      await this.loadRelations(rows, include);
      if (forcedParentKeys.size > 0) {
        for (const row of rows) {
          for (const key of forcedParentKeys) delete row[key];
        }
      }
    }

    return rows as unknown as Payload<Row, Rel, A>[];
  }

  findFirst<A extends FindFirstArgs<Row, Rel, Where> = FindFirstArgs<Row, Rel, Where>>(
    args: A = {} as A,
  ): IndigoPromise<Payload<Row, Rel, A> | null> {
    return defer(this.meta.name, "findFirst", this, (d) =>
      withQueryContext({ model: d.meta.name, operation: "findFirst" }, () => d.findFirstImpl(args)),
    );
  }

  private async findFirstImpl<
    A extends FindFirstArgs<Row, Rel, Where> = FindFirstArgs<Row, Rel, Where>,
  >(args: A): Promise<Payload<Row, Rel, A> | null> {
    const rows = await this.findMany({ ...args, take: 1 } as A);
    return rows[0] ?? null;
  }

  findUnique<A extends FindUniqueArgs<Row, Rel, Where> = FindUniqueArgs<Row, Rel, Where>>(
    args: A,
  ): IndigoPromise<Payload<Row, Rel, A> | null> {
    return defer(this.meta.name, "findUnique", this, (d) =>
      withQueryContext({ model: d.meta.name, operation: "findUnique" }, () => d.findUniqueImpl(args)),
    );
  }

  private async findUniqueImpl<
    A extends FindUniqueArgs<Row, Rel, Where> = FindUniqueArgs<Row, Rel, Where>,
  >(args: A): Promise<Payload<Row, Rel, A> | null> {
    return this.findFirst({ where: args.where, select: args.select, include: args.include } as A);
  }

  /**
   * Batched-by-key relation loader (design.md Data Flow). Mutates `rows` in
   * place, adding one property per included relation: the target's own
   * rows for a to-many relation (`[]` when none matched), or a single
   * target row / `null` for a to-one relation. One follow-up query per
   * included relation, issued through the target model's own sibling
   * delegate — never a new SQL construction path.
   */
  private async loadRelations(
    rows: Record<string, unknown>[],
    include: IncludeInput<Rel>,
  ): Promise<void> {
    const relations = this.meta.relations ?? {};
    const registry = this.siblings?.();

    for (const name of Object.keys(include)) {
      const spec = (include as Record<string, unknown>)[name];
      if (spec === undefined || spec === false) continue;

      const relMeta = relations[name];
      if (!relMeta) {
        throw new IndigoRelationError(
          `IndigoDB: unknown relation "${name}" in \`include\` — check the generated <Model>Relations type.`,
        );
      }
      if ("composite" in relMeta) {
        throw new IndigoRelationError(
          `IndigoDB: relation "${name}" (→ ${relMeta.target}) spans more than one column and cannot be ` +
            `used with \`include\` — only single-column relation keys are supported.`,
        );
      }

      const target = registry?.[relMeta.target];
      if (!target) {
        throw new IndigoRelationError(
          `IndigoDB: no delegate registered for relation target "${relMeta.target}" (relation "${name}"). ` +
            `This client was likely constructed without the generated sibling registry.`,
        );
      }

      const keys = [...new Set(rows.map((r) => r[relMeta.from]).filter((v) => v !== null && v !== undefined))];
      if (keys.length === 0) {
        for (const row of rows) row[name] = relMeta.list ? [] : null;
        continue;
      }

      const requestedSelect =
        typeof spec === "object" && spec !== null && "select" in spec
          ? { ...(spec as { select: Record<string, boolean> }).select }
          : undefined;
      const forceChildKey = requestedSelect !== undefined && requestedSelect[relMeta.to] !== true;
      if (requestedSelect) requestedSelect[relMeta.to] = true;

      const children = (await target.findMany({
        where: { [relMeta.to]: { in: keys } },
        select: requestedSelect,
      } as never)) as unknown as Record<string, unknown>[];

      const bucket = new Map<unknown, Record<string, unknown>[]>();
      for (const child of children) {
        const k = child[relMeta.to];
        const list = bucket.get(k);
        if (list) list.push(child);
        else bucket.set(k, [child]);
        if (forceChildKey) delete child[relMeta.to];
      }

      for (const row of rows) {
        const k = row[relMeta.from];
        const matched = k === null || k === undefined ? undefined : bucket.get(k);
        row[name] = relMeta.list ? (matched ?? []) : (matched?.[0] ?? null);
      }
    }
  }

  /** Raw scalar-only INSERT — the pre-nested-writes `create()` body, kept
   * byte-identical (tasks.md A4.2). The planner (`create()`) re-enters this
   * for the parent row write in phase 2; a scalar-only call skips the
   * planner entirely and calls this directly. */
  private async insertRow(data: Record<string, unknown>): Promise<Row> {
    const params = new Params();
    const fields = Object.keys(data).filter((f) => data[f] !== undefined);
    const cols = fields.map((f) => quote(this.col(f))).join(", ");
    const vals = fields.map((f) => params.add(this.paramValue(f, data[f]))).join(", ");
    const sql =
      fields.length > 0
        ? `INSERT INTO ${quote(this.meta.table)} (${cols}) VALUES (${vals}) RETURNING ${this.selectList()}`
        : `INSERT INTO ${quote(this.meta.table)} DEFAULT VALUES RETURNING ${this.selectList()}`;
    const rows = await this.exec(sql, params.values);
    return rows[0] as Row;
  }

  /**
   * Splits `data` into scalar columns and relation sub-operations (design.md
   * Data Flow: "split scalars | relOps | unknown"). Any key that is neither
   * a declared scalar field nor a declared relation throws `UNKNOWN_FIELD`
   * synchronously, BEFORE any SQL is issued (spec Requirement 5) — a
   * composite-key relation throws `COMPOSITE_RELATION` for the same reason
   * `loadRelations` rejects it on the read side.
   */
  private splitData(data: Record<string, unknown>): {
    scalars: Record<string, unknown>;
    relOps: Record<string, Record<string, unknown>>;
  } {
    const scalars: Record<string, unknown> = {};
    const relOps: Record<string, Record<string, unknown>> = {};
    for (const key of Object.keys(data)) {
      if (data[key] === undefined) continue;
      if (key in this.meta.fields) {
        scalars[key] = data[key];
        continue;
      }
      const relMeta = this.meta.relations?.[key];
      if (relMeta) {
        if ("composite" in relMeta) {
          throw new IndigoNestedWriteError(
            "COMPOSITE_RELATION",
            `IndigoDB: relation "${key}" (→ ${relMeta.target}) spans more than one column and cannot ` +
              `be used in a nested write — only single-column relation keys are supported.`,
          );
        }
        relOps[key] = data[key] as Record<string, unknown>;
        continue;
      }
      throw new IndigoNestedWriteError(
        "UNKNOWN_FIELD",
        `IndigoDB: "${key}" is not a scalar field or a declared relation on "${this.meta.name}".`,
      );
    }
    return { scalars, relOps };
  }

  /** Looks up a relation's target sibling delegate inside the current
   * transaction's registry (`tx`, from `runAtomic`'s callback) — never the
   * outer `this.siblings()`, which may be a different (or no) session. */
  private requireSibling(
    tx: SiblingRegistry,
    relMeta: RelationMeta,
    relName: string,
  ): ModelDelegate<any, any, any, any> {
    const target = tx[relMeta.target];
    if (!target) {
      throw new IndigoNestedWriteError(
        "NO_ATOMIC_SEAM",
        `IndigoDB: no delegate registered for relation target "${relMeta.target}" (relation "${relName}"). ` +
          `This client was likely constructed without the generated sibling registry.`,
      );
    }
    return target;
  }

  /**
   * Resolves a single-valued (to-one) relation sub-operation: `fkSide`
   * relations (phase 1, always to-one from the local table's perspective)
   * and non-`fkSide` to-one relations (1-1 inverse side, phase 3). Returns
   * the resolved child row — phase 1 reads `childRow[relMeta.to]` off it for
   * the parent's FK; phase 3 callers ignore the return value.
   */
  private async resolveToOneOp(
    target: ModelDelegate<any, any, any, any>,
    relName: string,
    op: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (op.create !== undefined) {
      return (await target.create({ data: op.create })) as Record<string, unknown>;
    }
    if (op.connect !== undefined) {
      const row = await target.findFirst({ where: op.connect as never });
      if (!row) {
        throw new IndigoNestedWriteError(
          "CONNECT_NOT_FOUND",
          `IndigoDB: \`connect\` on relation "${relName}" matched no row.`,
        );
      }
      return row as Record<string, unknown>;
    }
    if (op.connectOrCreate !== undefined) {
      const { where, create } = op.connectOrCreate as { where: unknown; create: unknown };
      const row = await target.findFirst({ where: where as never });
      if (row) return row as Record<string, unknown>;
      return (await target.create({ data: create })) as Record<string, unknown>;
    }
    throw new IndigoNestedWriteError(
      "UNKNOWN_RELATION_OP",
      `IndigoDB: relation "${relName}" received an unrecognized sub-operation — expected one of ` +
        `create/connect/connectOrCreate.`,
    );
  }

  /**
   * Applies a non-`fkSide` relation sub-operation (phase 3): the CHILD holds
   * the FK back to the just-inserted/updated parent row, so every op sets
   * `relMeta.to` to `parentKey`. To-many ops carry arrays and may combine
   * `create`/`connect`/`connectOrCreate` (plus, on `update`, `disconnect`/
   * `set` — spec Requirement 3) in the same call; non-list (1-1 inverse) ops
   * are single-valued, mirroring `resolveToOneOp`'s shape. `disconnect`/`set`
   * clear the child's FK to `NULL` and are gated by `relMeta.optionalFk`
   * (spec Requirement 4): a required FK throws `REQUIRED_RELATION_DISCONNECT`
   * instead of orphaning/cascading. `create()` callers never populate
   * `disconnect`/`set` (not part of `ToOneRelationInput`/`ToManyRelationInput`
   * at the type level), so this branch is inert for `create()`.
   */
  private async applyNonFkSideOp(
    target: ModelDelegate<any, any, any, any>,
    relMeta: RelationMeta,
    relName: string,
    op: Record<string, unknown>,
    parentKey: unknown,
  ): Promise<void> {
    // `target.update`'s direct scalar path now throws `IndigoNotFoundError`
    // on a zero-row match instead of resolving `undefined` (design.md
    // Decision D2) — caught here and folded back into this planner's own
    // `false` sentinel so `CONNECT_NOT_FOUND`'s semantics are unchanged.
    const connectByUpdate = async (where: unknown): Promise<boolean> => {
      try {
        await target.update({ where: where as never, data: { [relMeta.to]: parentKey } });
        return true;
      } catch (err) {
        if (err instanceof IndigoNotFoundError) return false;
        throw err;
      }
    };
    // `disconnect`/`set` clear an FK via `target.update`, which now throws
    // `IndigoNotFoundError` on a zero-row match (this PR's own guard). A
    // disconnect matching nothing — including `set: []` on a relation with
    // zero currently-linked rows, or `disconnect: true` on a to-one relation
    // with nothing linked — is a legitimate no-op (client-nested-writes spec
    // "set with an empty array disconnects everything"; there is nothing to
    // unlink, not an error), unlike `connect`, whose `where` names a row the
    // caller expects to exist. Swallows ONLY `IndigoNotFoundError`; any other
    // failure still propagates.
    const disconnectByUpdate = async (where: unknown): Promise<void> => {
      try {
        await target.update({ where: where as never, data: { [relMeta.to]: null } });
      } catch (err) {
        if (!(err instanceof IndigoNotFoundError)) throw err;
      }
    };
    const requireOptionalFk = (): void => {
      if (!relMeta.optionalFk) {
        throw new IndigoNestedWriteError(
          "REQUIRED_RELATION_DISCONNECT",
          `IndigoDB: relation "${relName}" is required (its FK column is NOT NULL) — it cannot be ` +
            `disconnected or set to null.`,
        );
      }
    };

    if (relMeta.list) {
      const creates = (op.create as Record<string, unknown>[] | undefined) ?? [];
      for (const item of creates) {
        await target.create({ data: { ...item, [relMeta.to]: parentKey } });
      }
      const connects = (op.connect as unknown[] | undefined) ?? [];
      for (const where of connects) {
        if (!(await connectByUpdate(where))) {
          throw new IndigoNestedWriteError(
            "CONNECT_NOT_FOUND",
            `IndigoDB: \`connect\` on relation "${relName}" matched no row.`,
          );
        }
      }
      const connectOrCreates =
        (op.connectOrCreate as Array<{ where: unknown; create: Record<string, unknown> }> | undefined) ?? [];
      for (const { where, create } of connectOrCreates) {
        if (!(await connectByUpdate(where))) {
          await target.create({ data: { ...create, [relMeta.to]: parentKey } });
        }
      }

      const disconnects = (op.disconnect as unknown[] | undefined) ?? [];
      if (disconnects.length > 0) {
        requireOptionalFk();
        for (const where of disconnects) {
          await disconnectByUpdate(where);
        }
      }

      // `set` REPLACES the entire linked set (spec Requirement 3): disconnect
      // everything currently linked to `parentKey`, then re-connect each
      // provided `where`. `set: []` disconnects everything and connects
      // nothing (design.md's confirmed product decision — reuses the
      // existing unbounded `update()`, not a scoped `updateMany`). Zero
      // currently-linked rows is the common idempotent case, not an error.
      if (op.set !== undefined) {
        requireOptionalFk();
        await disconnectByUpdate({ [relMeta.to]: parentKey });
        for (const where of op.set as unknown[]) {
          if (!(await connectByUpdate(where))) {
            throw new IndigoNestedWriteError(
              "CONNECT_NOT_FOUND",
              `IndigoDB: \`set\` on relation "${relName}" matched no row for one of its entries.`,
            );
          }
        }
      }
      return;
    }

    if (op.create !== undefined) {
      await target.create({ data: { ...(op.create as Record<string, unknown>), [relMeta.to]: parentKey } });
      return;
    }
    if (op.connect !== undefined) {
      if (!(await connectByUpdate(op.connect))) {
        throw new IndigoNestedWriteError(
          "CONNECT_NOT_FOUND",
          `IndigoDB: \`connect\` on relation "${relName}" matched no row.`,
        );
      }
      return;
    }
    if (op.connectOrCreate !== undefined) {
      const { where, create } = op.connectOrCreate as { where: unknown; create: Record<string, unknown> };
      if (!(await connectByUpdate(where))) {
        await target.create({ data: { ...create, [relMeta.to]: parentKey } });
      }
      return;
    }
    if (op.disconnect === true || (Object.prototype.hasOwnProperty.call(op, "set") && op.set === null)) {
      requireOptionalFk();
      await disconnectByUpdate({ [relMeta.to]: parentKey });
      return;
    }
    throw new IndigoNestedWriteError(
      "UNKNOWN_RELATION_OP",
      `IndigoDB: relation "${relName}" received an unrecognized sub-operation — expected one of ` +
        `create/connect/connectOrCreate/disconnect/set.`,
    );
  }

  /**
   * `data` splits into scalars and relation ops (`splitData`); an unknown
   * key throws `UNKNOWN_FIELD` before any SQL is issued (spec Requirement
   * 5). No relation ops present ⇒ the planner is skipped entirely and
   * `insertRow` runs directly — byte-identical SQL to the pre-nested-writes
   * `create()` (tasks.md A4.2, design.md Data Flow).
   *
   * Otherwise the whole call runs inside one `runAtomic` session, ordered by
   * FK direction (design.md Data Flow, spec Requirement 6): phase 1 resolves
   * every `fkSide` relation op and folds its child's key into the parent's
   * own scalars (the parent needs their key); phase 2 inserts the parent row
   * itself; phase 3 applies every non-`fkSide` relation op, now that the
   * parent's key exists for the child's FK (spec Requirement 1).
   */
  create(args: CreateArgs<CreateInput>): IndigoPromise<Row> {
    return defer(this.meta.name, "create", this, (d) =>
      withQueryContext({ model: d.meta.name, operation: "create" }, () => d.createImpl(args)),
    );
  }

  private async createImpl(args: CreateArgs<CreateInput>): Promise<Row> {
    const { scalars, relOps } = this.splitData(args.data as Record<string, unknown>);
    if (Object.keys(relOps).length === 0) {
      return this.insertRow(scalars);
    }

    return this.runAtomic(async (tx) => {
      const self = tx[this.meta.name] as ModelDelegate<Row, CreateInput, UpdateInput, Rel, Where> | undefined;
      if (!self) {
        throw new IndigoNestedWriteError(
          "NO_ATOMIC_SEAM",
          `IndigoDB: nested write on "${this.meta.name}" requires the generated sibling registry — ` +
            `this delegate was constructed without one.`,
        );
      }

      const finalScalars: Record<string, unknown> = { ...scalars };

      // Phase 1: fkSide ops resolve BEFORE the parent insert — the parent
      // row needs their key.
      for (const [name, op] of Object.entries(relOps)) {
        const relMeta = this.meta.relations![name] as RelationMeta;
        if (!relMeta.fkSide) continue;
        const target = this.requireSibling(tx, relMeta, name);
        const childRow = await this.resolveToOneOp(target, name, op);
        finalScalars[relMeta.from] = childRow[relMeta.to];
      }

      const parentRow = (await self.insertRow(finalScalars)) as unknown as Record<string, unknown>;

      // Phase 3: non-fkSide ops run AFTER the parent insert — the children
      // need the parent's key.
      for (const [name, op] of Object.entries(relOps)) {
        const relMeta = this.meta.relations![name] as RelationMeta;
        if (relMeta.fkSide) continue;
        const target = this.requireSibling(tx, relMeta, name);
        await this.applyNonFkSideOp(target, relMeta, name, op, parentRow[relMeta.from]);
      }

      return parentRow as unknown as Row;
    });
  }

  /** Raw scalar-only UPDATE — the pre-nested-writes `update()` body, kept
   * byte-identical (tasks.md A4.2/C2.1). The planner (`update()`) re-enters
   * this for the parent row write (phases 1-2) and reuses it verbatim for
   * to-many/child FK writes (`disconnect`/`set`/`connect` in
   * `applyNonFkSideOp`); a scalar-only call skips the planner entirely and
   * calls this directly. */
  private async rawUpdate(where: Where | undefined, data: Record<string, unknown>): Promise<Row> {
    const params = new Params();
    const fields = Object.keys(data).filter((f) => data[f] !== undefined);
    // Guarded here — not in `updateImpl` — because the planner (phase 2) and
    // `applyNonFkSideOp` both re-enter this method; guarding the single
    // SQL-emitting site closes every caller at once (design.md Decision D2).
    // An empty `SET` would be malformed SQL (`UPDATE "t" SET  WHERE …`).
    if (fields.length === 0) {
      throw new IndigoArgumentError(
        "EMPTY_UPDATE_DATA",
        `IndigoDB: \`update\` on "${this.meta.name}" received \`data\` with zero defined scalar ` +
          `assignments — nothing to update.`,
      );
    }
    const assignments = fields
      .map((f) => `${quote(this.col(f))} = ${params.add(this.paramValue(f, data[f]))}`)
      .join(", ");
    let sql = `UPDATE ${quote(this.meta.table)} SET ${assignments}`;
    sql += this.buildWhere(where, params);
    sql += ` RETURNING ${this.selectList()}`;
    const rows = await this.exec(sql, params.values);
    const row = rows[0] as Row | undefined;
    if (!row) {
      throw new IndigoNotFoundError(this.meta.name, "update");
    }
    return row;
  }

  /**
   * `data` splits into scalars and relation ops (`splitData`), mirroring
   * `create()`. No relation ops ⇒ the planner is skipped entirely and
   * `rawUpdate` runs directly — byte-identical SQL to the pre-nested-writes
   * `update()` (tasks.md A4.2, design.md Data Flow).
   *
   * Otherwise the whole call runs inside one `runAtomic` session. Because an
   * `UPDATE ... WHERE ...` is not guaranteed to target a single row, and
   * relation ops (fkSide FK writes, non-fkSide child FK writes) MUST apply to
   * exactly one parent, `args.where` is first resolved via `findMany`: more
   * than one match with relation ops present throws `AMBIGUOUS_UPDATE_TARGET`
   * (design.md Data Flow, spec Requirement 3/4). Phase 1 resolves every
   * `fkSide` relation op — `create`/`connect`/`connectOrCreate` fold the
   * child's key into `finalScalars[relMeta.from]`; `disconnect`/`set: null`
   * clear it to `NULL`, gated by `relMeta.optionalFk`
   * (`REQUIRED_RELATION_DISCONNECT` otherwise). Phase 2 runs the parent's own
   * `rawUpdate`. Phase 3 applies every non-`fkSide` relation op — including
   * `disconnect`/`set` on to-many relations, which reuse the existing
   * unbounded `update()` (design.md's confirmed product decision: `set: []`
   * disconnects the entire currently-linked set, deletes nothing).
   */
  /**
   * Guards `update`/`delete`'s `where` against a non-unique selector
   * (client-unique-write-selector spec, design.md Decision D4/D5): applies
   * ONLY when `__meta.uniqueGroups` is present and non-empty — every
   * hand-authored test meta omits it, so an unconditional guard would throw
   * on every `update`/`delete` in the existing suite (D4). Kept as a
   * separate sibling function from `resolveUpsertConflictTarget`, not a
   * reuse, per design.md's write-side/read-side separation, even though the
   * key-set-equality check is the same shape. Runs FIRST, before
   * `splitData`/`findMany` (D5): `NO_MATCHING_UNIQUE_CONSTRAINT` wins over
   * both `EMPTY_UPDATE_DATA` and `AMBIGUOUS_UPDATE_TARGET`.
   */
  private assertUniqueWhere(where: Record<string, unknown>, op: "update" | "delete"): void {
    const groups = this.meta.uniqueGroups;
    if (!groups || groups.length === 0) return;

    for (const [key, value] of Object.entries(where)) {
      if (isFilterObject(value)) {
        throw new IndigoArgumentError(
          "NO_MATCHING_UNIQUE_CONSTRAINT",
          `IndigoDB: \`${op}\` \`where\` on "${this.meta.name}" must contain only plain scalar equalities — ` +
            `"${key}" is an operator object, which cannot target a single unique row.`,
        );
      }
    }

    const keySet = new Set(Object.keys(where));
    const match = groups.find((g) => g.length === keySet.size && g.every((f) => keySet.has(f)));
    if (!match) {
      throw new IndigoArgumentError(
        "NO_MATCHING_UNIQUE_CONSTRAINT",
        `IndigoDB: \`${op}\` \`where\` on "${this.meta.name}" (keys: ${[...keySet].join(", ")}) does not ` +
          `exactly match any declared unique constraint — check the generated <Model>WhereUniqueInput type.`,
      );
    }
  }

  update(args: UpdateArgs<Row, UpdateInput, UniqueWhere>): IndigoPromise<Row> {
    return defer(this.meta.name, "update", this, (d) =>
      withQueryContext({ model: d.meta.name, operation: "update" }, () => d.updateImpl(args)),
    );
  }

  private async updateImpl(args: UpdateArgs<Row, UpdateInput, UniqueWhere>): Promise<Row> {
    this.assertUniqueWhere(args.where as Record<string, unknown>, "update");
    const data = args.data as Record<string, unknown>;
    const { scalars, relOps } = this.splitData(data);
    if (Object.keys(relOps).length === 0) {
      return this.rawUpdate(args.where as unknown as Where | undefined, scalars);
    }

    return this.runAtomic(async (tx) => {
      const self = tx[this.meta.name] as ModelDelegate<Row, CreateInput, UpdateInput, Rel, Where> | undefined;
      if (!self) {
        throw new IndigoNestedWriteError(
          "NO_ATOMIC_SEAM",
          `IndigoDB: nested write on "${this.meta.name}" requires the generated sibling registry — ` +
            `this delegate was constructed without one.`,
        );
      }

      // Relation ops need a single, unambiguous target row (design.md Data
      // Flow, spec Requirement 3/4) — resolve `where` up front instead of
      // trusting the UPDATE's own (possibly multi-row) WHERE clause.
      const matches = (await self.findMany({ where: args.where } as never)) as unknown as Record<
        string,
        unknown
      >[];
      if (matches.length > 1) {
        throw new IndigoNestedWriteError(
          "AMBIGUOUS_UPDATE_TARGET",
          `IndigoDB: \`update\` on "${this.meta.name}" matched ${matches.length} rows, but \`data\` ` +
            `includes relation sub-operations — relation ops require a single, unambiguous target row.`,
        );
      }

      const finalScalars: Record<string, unknown> = { ...scalars };

      // Phase 1: fkSide ops resolve BEFORE the parent update — the parent
      // row's own FK column needs their key (or NULL, for disconnect/set).
      for (const [name, op] of Object.entries(relOps)) {
        const relMeta = this.meta.relations![name] as RelationMeta;
        if (!relMeta.fkSide) continue;
        const target = this.requireSibling(tx, relMeta, name);

        if (op.disconnect === true || (Object.prototype.hasOwnProperty.call(op, "set") && op.set === null)) {
          if (!relMeta.optionalFk) {
            throw new IndigoNestedWriteError(
              "REQUIRED_RELATION_DISCONNECT",
              `IndigoDB: relation "${name}" is required (its FK column is NOT NULL) — it cannot be ` +
                `disconnected or set to null.`,
            );
          }
          finalScalars[relMeta.from] = null;
          continue;
        }

        const childRow = await this.resolveToOneOp(target, name, op);
        finalScalars[relMeta.from] = childRow[relMeta.to];
      }

      // Relation-ops-only `data` (no scalars, and no fkSide op resolved to a
      // scalar FK write) skips the UPDATE entirely — an empty `SET` would be
      // malformed SQL, and the already-fetched `matches[0]` IS the parent row
      // (design.md Data Flow: "reads the target via findMany instead of
      // emitting an empty SET"). Zero matching rows (`matches[0]` absent)
      // throws `IndigoNotFoundError` (client-write-preconditions spec,
      // client-nested-writes spec — supersedes the previous silent
      // `undefined` resolution); `rawUpdate`'s own guard covers the
      // non-empty-`finalScalars` branch.
      let updatedRow: Record<string, unknown>;
      if (Object.keys(finalScalars).length === 0) {
        const match = matches[0] as Record<string, unknown> | undefined;
        if (!match) {
          throw new IndigoNotFoundError(this.meta.name, "update");
        }
        updatedRow = match;
      } else {
        updatedRow = (await self.rawUpdate(
          args.where as unknown as Where | undefined,
          finalScalars,
        )) as unknown as Record<string, unknown>;
      }

      // Phase 3: non-fkSide ops run AFTER the parent update — they need the
      // parent's (possibly just-confirmed) key.
      for (const [name, op] of Object.entries(relOps)) {
        const relMeta = this.meta.relations![name] as RelationMeta;
        if (relMeta.fkSide) continue;
        const target = this.requireSibling(tx, relMeta, name);
        await this.applyNonFkSideOp(target, relMeta, name, op, updatedRow[relMeta.from]);
      }

      return updatedRow as unknown as Row;
    });
  }

  delete(args: DeleteArgs<Row, UniqueWhere>): IndigoPromise<Row> {
    return defer(this.meta.name, "delete", this, (d) =>
      withQueryContext({ model: d.meta.name, operation: "delete" }, () => d.deleteImpl(args)),
    );
  }

  private async deleteImpl(args: DeleteArgs<Row, UniqueWhere>): Promise<Row> {
    this.assertUniqueWhere(args.where as Record<string, unknown>, "delete");
    const params = new Params();
    let sql = `DELETE FROM ${quote(this.meta.table)}`;
    sql += this.buildWhere(args.where as unknown as Where | undefined, params);
    sql += ` RETURNING ${this.selectList()}`;
    const rows = await this.exec(sql, params.values);
    const row = rows[0] as Row | undefined;
    if (!row) {
      throw new IndigoNotFoundError(this.meta.name, "delete");
    }
    return row;
  }

  count(args: CountArgs<Row, Where> = {}): IndigoPromise<number> {
    return defer(this.meta.name, "count", this, (d) =>
      withQueryContext({ model: d.meta.name, operation: "count" }, () => d.countImpl(args)),
    );
  }

  private async countImpl(args: CountArgs<Row, Where>): Promise<number> {
    const params = new Params();
    let sql = `SELECT count(*)::int AS count FROM ${quote(this.meta.table)}`;
    sql += this.buildWhere(args.where, params);
    const rows = await this.exec(sql, params.values);
    return Number((rows[0] as { count: number }).count);
  }

  /**
   * Single multi-row `INSERT ... VALUES (...), (...) RETURNING 1` (design.md
   * SQL shapes, Decision #1/#3): no `runAtomic` — one statement is already
   * atomic — and the row count comes from `RETURNING 1` + `rows.length`
   * rather than widening `Executor` to expose `rowCount` (`Executor` returns
   * rows only; widening it would break every injected `db.exec`).
   *
   * The column list is the UNION of every element's own keys (each element
   * may legitimately omit a different optional field, exactly like
   * `insertRow`'s own per-call field set) — a key missing on one row binds
   * `NULL` for that row's tuple. `data: []` throws `EMPTY_BATCH` before any
   * SQL is issued (spec has no "0 rows" scenario; there is nothing to
   * `VALUES` list from).
   */
  createMany(args: CreateManyArgs<CreateManyInput>): IndigoPromise<BatchPayload> {
    return defer(this.meta.name, "createMany", this, (d) =>
      withQueryContext({ model: d.meta.name, operation: "createMany" }, () => d.createManyImpl(args)),
    );
  }

  private async createManyImpl(args: CreateManyArgs<CreateManyInput>): Promise<BatchPayload> {
    const data = args.data as unknown as Record<string, unknown>[];
    if (data.length === 0) {
      throw new IndigoArgumentError(
        "EMPTY_BATCH",
        `IndigoDB: \`createMany\` on "${this.meta.name}" requires a non-empty \`data\` array.`,
      );
    }

    const fieldSet = new Set<string>();
    for (const row of data) {
      for (const key of Object.keys(row)) {
        if (row[key] !== undefined) fieldSet.add(key);
      }
    }
    const fields = [...fieldSet];

    const params = new Params();
    const cols = fields.map((f) => quote(this.col(f))).join(", ");
    const tuples = data
      .map((row) => `(${fields.map((f) => params.add(this.paramValue(f, row[f] ?? null))).join(", ")})`)
      .join(", ");
    const sql = `INSERT INTO ${quote(this.meta.table)} (${cols}) VALUES ${tuples} RETURNING 1`;
    const rows = await this.exec(sql, params.values);
    return { count: rows.length };
  }

  /**
   * Single `UPDATE ... WHERE <whereExpr> RETURNING 1` (design.md SQL
   * shapes), reusing `buildWhere`/`whereExpr` unmodified — no second WHERE
   * compiler. `requireNonEmptyWhere` throws BEFORE any SQL is built (spec
   * "updateMany and deleteMany require a non-empty where").
   */
  updateMany(args: UpdateManyArgs<Row, UpdateInput, Where>): IndigoPromise<BatchPayload> {
    return defer(this.meta.name, "updateMany", this, (d) =>
      withQueryContext({ model: d.meta.name, operation: "updateMany" }, () => d.updateManyImpl(args)),
    );
  }

  private async updateManyImpl(args: UpdateManyArgs<Row, UpdateInput, Where>): Promise<BatchPayload> {
    this.requireNonEmptyWhere(args.where);
    const data = args.data as Record<string, unknown>;
    const params = new Params();
    const fields = Object.keys(data).filter((f) => data[f] !== undefined);
    const assignments = fields.map((f) => `${quote(this.col(f))} = ${params.add(this.paramValue(f, data[f]))}`).join(", ");
    let sql = `UPDATE ${quote(this.meta.table)} SET ${assignments}`;
    sql += this.buildWhere(args.where, params);
    sql += ` RETURNING 1`;
    const rows = await this.exec(sql, params.values);
    return { count: rows.length };
  }

  /**
   * Single `DELETE FROM ... WHERE <whereExpr> RETURNING 1` (design.md SQL
   * shapes), reusing `buildWhere` unmodified — same required-`where`
   * guard as `updateMany`.
   */
  deleteMany(args: DeleteManyArgs<Row, Where>): IndigoPromise<BatchPayload> {
    return defer(this.meta.name, "deleteMany", this, (d) =>
      withQueryContext({ model: d.meta.name, operation: "deleteMany" }, () => d.deleteManyImpl(args)),
    );
  }

  private async deleteManyImpl(args: DeleteManyArgs<Row, Where>): Promise<BatchPayload> {
    this.requireNonEmptyWhere(args.where);
    const params = new Params();
    let sql = `DELETE FROM ${quote(this.meta.table)}`;
    sql += this.buildWhere(args.where, params);
    sql += ` RETURNING 1`;
    const rows = await this.exec(sql, params.values);
    return { count: rows.length };
  }

  // ─── Aggregation (client-aggregation spec, PR C) ──────────────────────────

  /** Column + descriptor for one aggregate expression in a `SELECT` list —
   * `alias` is the positional `agg<N>` name `rebuildAggregateResult` reads
   * back off the result row (design.md Decision #9: "positional aliases
   * agg0…aggN + a JS-side descriptor array", collision-free against real
   * field names). */
  private validateAggregateField(op: "_sum" | "_avg" | "_min" | "_max", field: string): string {
    const fieldMeta = this.meta.fields[field];
    if (!fieldMeta) {
      throw new IndigoArgumentError(
        "UNKNOWN_AGGREGATE_FIELD",
        `IndigoDB: "${field}" is not a recognized field on "${this.meta.name}" for \`${op}\` — check the ` +
          `generated <Model>AggregateArgs/GroupByArgs type.`,
      );
    }
    if ((op === "_sum" || op === "_avg") && !fieldMeta.numeric) {
      throw new IndigoArgumentError(
        "NON_NUMERIC_AGGREGATE",
        `IndigoDB: \`${op}\` on "${this.meta.name}"."${field}" requires a numeric column ` +
          `(Int/Float/Decimal/BigInt) — check the generated <Model>NumericFields type.`,
      );
    }
    return fieldMeta.db;
  }

  /**
   * Builds the aggregate portion of a `SELECT` list — `count(*)::int AS
   * agg0, sum("c")::float8 AS agg1, …` (design.md SQL shapes) — plus the
   * matching descriptor array `rebuildAggregateResult` walks to rebuild the
   * nested `AggregateResult`/`GroupByResult` shape from the flat result row.
   * Validates every `_sum`/`_avg`/`_min`/`_max` field BEFORE any SQL text is
   * built (`validateAggregateField` throws synchronously). `requireNonEmpty`
   * (only `aggregate()` sets this) additionally rejects a call with no
   * aggregate option at all — `groupBy()` tolerates zero aggregates (a plain
   * "distinct combinations of `by`" query).
   */
  private buildAggregateClauses(
    args: {
      _count?: true;
      _sum?: Record<string, true | undefined>;
      _avg?: Record<string, true | undefined>;
      _min?: Record<string, true | undefined>;
      _max?: Record<string, true | undefined>;
    },
    requireNonEmpty: boolean,
  ): { clause: string; descriptors: Array<{ kind: "_count" | "_sum" | "_avg" | "_min" | "_max"; field?: string }> } {
    const descriptors: Array<{ kind: "_count" | "_sum" | "_avg" | "_min" | "_max"; field?: string }> = [];
    const parts: string[] = [];
    let idx = 0;
    const nextAlias = () => `agg${idx++}`;

    if (args._count) {
      descriptors.push({ kind: "_count" });
      parts.push(`count(*)::int AS ${nextAlias()}`);
    }

    const ops: Array<{ key: "_sum" | "_avg" | "_min" | "_max"; sqlFn: string; cast: string }> = [
      { key: "_sum", sqlFn: "sum", cast: "::float8" },
      { key: "_avg", sqlFn: "avg", cast: "::float8" },
      { key: "_min", sqlFn: "min", cast: "" },
      { key: "_max", sqlFn: "max", cast: "" },
    ];
    for (const { key, sqlFn, cast } of ops) {
      const sel = args[key];
      if (!sel) continue;
      for (const field of Object.keys(sel)) {
        if (sel[field] !== true) continue;
        const dbCol = this.validateAggregateField(key, field);
        descriptors.push({ kind: key, field });
        parts.push(`${sqlFn}(${quote(dbCol)})${cast} AS ${nextAlias()}`);
      }
    }

    if (requireNonEmpty && descriptors.length === 0) {
      throw new IndigoArgumentError(
        "EMPTY_AGGREGATE",
        `IndigoDB: \`aggregate\` on "${this.meta.name}" requires at least one of ` +
          `_count/_sum/_avg/_min/_max.`,
      );
    }

    return { clause: parts.join(", "), descriptors };
  }

  /** Rebuilds the nested `AggregateResult` shape (`_count`, `_sum: {
   * field }`, …) from a flat result row keyed by the positional `agg<N>`
   * aliases `buildAggregateClauses` assigned, in the same order. `_sum`/
   * `_avg` are `Number`-coerced (already `::float8` in SQL); `_min`/`_max`
   * keep the column's native (uncast) value (design.md Decision #11). */
  private rebuildAggregateResult(
    descriptors: Array<{ kind: "_count" | "_sum" | "_avg" | "_min" | "_max"; field?: string }>,
    row: Record<string, unknown>,
  ): AggregateResult {
    const result: AggregateResult = {};
    descriptors.forEach((d, i) => {
      const value = row[`agg${i}`];
      if (d.kind === "_count") {
        result._count = Number(value);
        return;
      }
      const coerced =
        value === null ? null : d.kind === "_sum" || d.kind === "_avg" ? Number(value) : value;
      if (d.kind === "_sum" || d.kind === "_avg") {
        const bucket = (result[d.kind] ??= {});
        bucket[d.field!] = coerced as number | null;
      } else {
        const bucket = (result[d.kind] ??= {});
        bucket[d.field!] = coerced;
      }
    });
    return result;
  }

  /**
   * `SELECT count(*)::int AS agg0, sum("c")::float8 AS agg1, … WHERE <expr>`
   * (client-aggregation spec "aggregate computes _count/_sum/_avg/_min/_max
   * over a where"; design.md SQL shapes). Reuses `buildWhere`/`whereExpr`
   * unmodified — no second WHERE compiler. Every `_sum`/`_avg`/`_min`/`_max`
   * field is validated BEFORE any SQL is built.
   */
  aggregate<A extends AggregateArgs<Row, Where, Numeric> = AggregateArgs<Row, Where, Numeric>>(
    args: A = {} as A,
  ): IndigoPromise<AggregateResult> {
    return defer(this.meta.name, "aggregate", this, (d) =>
      withQueryContext({ model: d.meta.name, operation: "aggregate" }, () => d.aggregateImpl(args)),
    );
  }

  private async aggregateImpl(args: AggregateArgs<Row, Where, Numeric>): Promise<AggregateResult> {
    const { clause, descriptors } = this.buildAggregateClauses(
      args as unknown as {
        _count?: true;
        _sum?: Record<string, true | undefined>;
        _avg?: Record<string, true | undefined>;
        _min?: Record<string, true | undefined>;
        _max?: Record<string, true | undefined>;
      },
      true,
    );
    const params = new Params();
    let sql = `SELECT ${clause} FROM ${quote(this.meta.table)}`;
    sql += this.buildWhere(args.where, params);
    const rows = await this.exec(sql, params.values);
    return this.rebuildAggregateResult(descriptors, (rows[0] ?? {}) as Record<string, unknown>);
  }

  /**
   * `SELECT <by fields>, <aggregates> … WHERE <expr> GROUP BY <by fields>`
   * (client-aggregation spec "groupBy groups by fields and returns
   * aggregates per group"; design.md SQL shapes). No `having` support — it
   * is not part of `GroupByArgs` at the type level, so it is a compile-time
   * excess-property error, not a runtime-ignored key. Every result row
   * carries the grouped `by` fields plus the requested aggregates,
   * flattened onto the same object.
   */
  groupBy<A extends GroupByArgs<Row, Where, Numeric> = GroupByArgs<Row, Where, Numeric>>(
    args: A,
  ): IndigoPromise<Array<GroupByResult<Row>>> {
    return defer(this.meta.name, "groupBy", this, (d) =>
      withQueryContext({ model: d.meta.name, operation: "groupBy" }, () => d.groupByImpl(args)),
    );
  }

  private async groupByImpl(args: GroupByArgs<Row, Where, Numeric>): Promise<Array<GroupByResult<Row>>> {
    const by = args.by as string[];
    const { clause: aggClause, descriptors } = this.buildAggregateClauses(
      args as unknown as {
        _count?: true;
        _sum?: Record<string, true | undefined>;
        _avg?: Record<string, true | undefined>;
        _min?: Record<string, true | undefined>;
        _max?: Record<string, true | undefined>;
      },
      false,
    );
    const groupCols = by.map((f) => `${quote(this.col(f))} AS ${quote(f)}`);
    const selectList = aggClause.length > 0 ? `${groupCols.join(", ")}, ${aggClause}` : groupCols.join(", ");

    const params = new Params();
    let sql = `SELECT ${selectList} FROM ${quote(this.meta.table)}`;
    sql += this.buildWhere(args.where, params);
    sql += ` GROUP BY ${by.map((f) => quote(this.col(f))).join(", ")}`;

    const rows = (await this.exec(sql, params.values)) as Record<string, unknown>[];
    return rows.map((row) => {
      const grouped: Record<string, unknown> = {};
      for (const f of by) grouped[f] = row[f];
      return { ...grouped, ...this.rebuildAggregateResult(descriptors, row) } as GroupByResult<Row>;
    });
  }

  // ─── Upsert (client-upsert spec, PR D) ─────────────────────────────────────

  /**
   * Resolves `upsert`'s `ON CONFLICT` target column list (client-upsert
   * spec, design.md Decision #13): `where` MUST contain only plain scalar
   * equalities — the same operator-object shape `isFilterObject` detects in
   * `whereExpr` — since `ON CONFLICT` cannot represent arbitrary `WHERE`
   * logic (a compound key like `AND`/`OR` also fails the key-set match
   * below, since those are never declared unique-group members). The
   * remaining key set must then exactly match one declared group in
   * `__meta.uniqueGroups` (order-independent set equality) — a partial
   * composite match is rejected the same as a wholly non-unique `where`.
   * Both failure modes throw the same `NO_MATCHING_UNIQUE_CONSTRAINT` code
   * BEFORE any SQL is built.
   */
  private resolveUpsertConflictTarget(where: Record<string, unknown>): string[] {
    for (const [key, value] of Object.entries(where)) {
      if (isFilterObject(value)) {
        throw new IndigoArgumentError(
          "NO_MATCHING_UNIQUE_CONSTRAINT",
          `IndigoDB: \`upsert\` \`where\` on "${this.meta.name}" must contain only plain scalar equalities — ` +
            `"${key}" is an operator object, which cannot target a single \`ON CONFLICT\` row.`,
        );
      }
    }

    const keySet = new Set(Object.keys(where));
    const groups = this.meta.uniqueGroups ?? [];
    const match = groups.find((g) => g.length === keySet.size && g.every((f) => keySet.has(f)));
    if (!match) {
      throw new IndigoArgumentError(
        "NO_MATCHING_UNIQUE_CONSTRAINT",
        `IndigoDB: \`upsert\` \`where\` on "${this.meta.name}" (keys: ${[...keySet].join(", ")}) does not ` +
          `exactly match any declared unique constraint — check the generated <Model>WhereUniqueInput type.`,
      );
    }
    return [...match];
  }

  /**
   * Single `INSERT ... ON CONFLICT (<unique columns>) DO UPDATE SET ... RETURNING <selectList>`
   * statement (design.md SQL shapes, Decision #3: no `runAtomic` — one
   * statement is already atomic), where the conflict target is resolved
   * from `where`'s keys matching a declared unique-constraint group
   * (client-upsert spec "upsert issues one ON CONFLICT statement targeting
   * a declared unique group").
   */
  upsert<
    A extends UpsertArgs<CreateInput, UpdateInput, UniqueWhere> = UpsertArgs<
      CreateInput,
      UpdateInput,
      UniqueWhere
    >,
  >(args: A): IndigoPromise<Row> {
    return defer(this.meta.name, "upsert", this, (d) =>
      withQueryContext({ model: d.meta.name, operation: "upsert" }, () => d.upsertImpl(args)),
    );
  }

  private async upsertImpl(args: UpsertArgs<CreateInput, UpdateInput, UniqueWhere>): Promise<Row> {
    const where = args.where as Record<string, unknown>;
    const conflictCols = this.resolveUpsertConflictTarget(where);

    const createData = args.create as Record<string, unknown>;
    const updateData = args.update as Record<string, unknown>;

    const params = new Params();
    const createFields = Object.keys(createData).filter((f) => createData[f] !== undefined);
    const cols = createFields.map((f) => quote(this.col(f))).join(", ");
    const vals = createFields.map((f) => params.add(this.paramValue(f, createData[f]))).join(", ");
    const target = conflictCols.map((f) => quote(this.col(f))).join(", ");

    const updateFields = Object.keys(updateData).filter((f) => updateData[f] !== undefined);
    const assignments = updateFields
      .map((f) => `${quote(this.col(f))} = ${params.add(this.paramValue(f, updateData[f]))}`)
      .join(", ");

    let sql =
      createFields.length > 0
        ? `INSERT INTO ${quote(this.meta.table)} (${cols}) VALUES (${vals})`
        : `INSERT INTO ${quote(this.meta.table)} DEFAULT VALUES`;
    sql += ` ON CONFLICT (${target}) DO UPDATE SET ${assignments}`;
    sql += ` RETURNING ${this.selectList()}`;

    const rows = await this.exec(sql, params.values);
    return rows[0] as Row;
  }
}
