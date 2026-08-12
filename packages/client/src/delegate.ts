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
  Executor,
  FindManyArgs,
  FindFirstArgs,
  FindUniqueArgs,
  CreateArgs,
  UpdateArgs,
  DeleteArgs,
  CountArgs,
  WhereInput,
  WhereFilter,
  OrderByInput,
  SelectInput,
  IncludeInput,
  Payload,
} from "./types.js";

function quote(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
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

export class ModelDelegate<Row, CreateInput, UpdateInput, Rel = Record<string, never>> {
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

  /** `"db" AS "field"` list for every column (or the selected subset). */
  private selectList(select?: SelectInput<Row>): string {
    const fields = Object.keys(this.meta.fields).filter((f) => {
      if (!select) return true;
      return (select as Record<string, boolean>)[f] === true;
    });
    const chosen = fields.length > 0 ? fields : Object.keys(this.meta.fields);
    return chosen.map((f) => `${quote(this.col(f))} AS ${quote(f)}`).join(", ");
  }

  private buildWhere(where: WhereInput<Row> | undefined, params: Params): string {
    if (!where) return "";
    const clauses: string[] = [];
    for (const [field, raw] of Object.entries(where)) {
      if (raw === undefined) continue;
      const column = quote(this.col(field));

      if (raw === null) {
        clauses.push(`${column} IS NULL`);
        continue;
      }

      if (isFilterObject(raw)) {
        const f = raw as WhereFilter<unknown>;
        if ("equals" in f) clauses.push(`${column} = ${params.add(f.equals)}`);
        if ("not" in f) clauses.push(`${column} <> ${params.add(f.not)}`);
        if ("in" in f) clauses.push(`${column} = ANY(${params.add(f.in)})`);
        if ("notIn" in f) clauses.push(`${column} <> ALL(${params.add(f.notIn)})`);
        if ("lt" in f) clauses.push(`${column} < ${params.add(f.lt)}`);
        if ("lte" in f) clauses.push(`${column} <= ${params.add(f.lte)}`);
        if ("gt" in f) clauses.push(`${column} > ${params.add(f.gt)}`);
        if ("gte" in f) clauses.push(`${column} >= ${params.add(f.gte)}`);
        if ("contains" in f) clauses.push(`${column} ILIKE ${params.add(`%${f.contains}%`)}`);
        if ("startsWith" in f) clauses.push(`${column} ILIKE ${params.add(`${f.startsWith}%`)}`);
        if ("endsWith" in f) clauses.push(`${column} ILIKE ${params.add(`%${f.endsWith}`)}`);
        continue;
      }

      // Direct equality.
      clauses.push(`${column} = ${params.add(raw)}`);
    }
    return clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  }

  private buildOrderBy(
    orderBy: OrderByInput<Row> | Array<OrderByInput<Row>> | undefined,
  ): string {
    if (!orderBy) return "";
    const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
    const parts: string[] = [];
    for (const entry of entries) {
      for (const [field, dir] of Object.entries(entry)) {
        parts.push(`${quote(this.col(field))} ${dir === "desc" ? "DESC" : "ASC"}`);
      }
    }
    return parts.length > 0 ? ` ORDER BY ${parts.join(", ")}` : "";
  }

  async findMany<A extends FindManyArgs<Row, Rel> = FindManyArgs<Row, Rel>>(
    args: A = {} as A,
  ): Promise<Payload<Row, Rel, A>[]> {
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

    const params = new Params();
    let sql = `SELECT ${this.selectList(select)} FROM ${quote(this.meta.table)}`;
    sql += this.buildWhere(args.where, params);
    sql += this.buildOrderBy(args.orderBy);
    if (args.take !== undefined) sql += ` LIMIT ${params.add(args.take)}`;
    if (args.skip !== undefined) sql += ` OFFSET ${params.add(args.skip)}`;
    const rows = (await this.exec(sql, params.values)) as Record<string, unknown>[];

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

  async findFirst<A extends FindFirstArgs<Row, Rel> = FindFirstArgs<Row, Rel>>(
    args: A = {} as A,
  ): Promise<Payload<Row, Rel, A> | null> {
    const rows = await this.findMany({ ...args, take: 1 } as A);
    return rows[0] ?? null;
  }

  async findUnique<A extends FindUniqueArgs<Row, Rel> = FindUniqueArgs<Row, Rel>>(
    args: A,
  ): Promise<Payload<Row, Rel, A> | null> {
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

  async create(args: CreateArgs<CreateInput>): Promise<Row> {
    const params = new Params();
    const data = args.data as Record<string, unknown>;
    const fields = Object.keys(data).filter((f) => data[f] !== undefined);
    const cols = fields.map((f) => quote(this.col(f))).join(", ");
    const vals = fields.map((f) => params.add(data[f])).join(", ");
    const sql =
      fields.length > 0
        ? `INSERT INTO ${quote(this.meta.table)} (${cols}) VALUES (${vals}) RETURNING ${this.selectList()}`
        : `INSERT INTO ${quote(this.meta.table)} DEFAULT VALUES RETURNING ${this.selectList()}`;
    const rows = await this.exec(sql, params.values);
    return rows[0] as Row;
  }

  async update(args: UpdateArgs<Row, UpdateInput>): Promise<Row> {
    const params = new Params();
    const data = args.data as Record<string, unknown>;
    const fields = Object.keys(data).filter((f) => data[f] !== undefined);
    const assignments = fields
      .map((f) => `${quote(this.col(f))} = ${params.add(data[f])}`)
      .join(", ");
    let sql = `UPDATE ${quote(this.meta.table)} SET ${assignments}`;
    sql += this.buildWhere(args.where, params);
    sql += ` RETURNING ${this.selectList()}`;
    const rows = await this.exec(sql, params.values);
    return rows[0] as Row;
  }

  async delete(args: DeleteArgs<Row>): Promise<Row> {
    const params = new Params();
    let sql = `DELETE FROM ${quote(this.meta.table)}`;
    sql += this.buildWhere(args.where, params);
    sql += ` RETURNING ${this.selectList()}`;
    const rows = await this.exec(sql, params.values);
    return rows[0] as Row;
  }

  async count(args: CountArgs<Row> = {}): Promise<number> {
    const params = new Params();
    let sql = `SELECT count(*)::int AS count FROM ${quote(this.meta.table)}`;
    sql += this.buildWhere(args.where, params);
    const rows = await this.exec(sql, params.values);
    return Number((rows[0] as { count: number }).count);
  }
}
