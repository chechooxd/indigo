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
  RelationMeta,
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

  /** Raw scalar-only INSERT — the pre-nested-writes `create()` body, kept
   * byte-identical (tasks.md A4.2). The planner (`create()`) re-enters this
   * for the parent row write in phase 2; a scalar-only call skips the
   * planner entirely and calls this directly. */
  private async insertRow(data: Record<string, unknown>): Promise<Row> {
    const params = new Params();
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
   * `create`/`connect`/`connectOrCreate` in the same call; non-list (1-1
   * inverse) ops are single-valued, mirroring `resolveToOneOp`'s shape.
   */
  private async applyNonFkSideOp(
    target: ModelDelegate<any, any, any, any>,
    relMeta: RelationMeta,
    relName: string,
    op: Record<string, unknown>,
    parentKey: unknown,
  ): Promise<void> {
    const connectByUpdate = async (where: unknown): Promise<boolean> => {
      const updated = await target.update({ where: where as never, data: { [relMeta.to]: parentKey } });
      return updated !== undefined;
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
    throw new IndigoNestedWriteError(
      "UNKNOWN_RELATION_OP",
      `IndigoDB: relation "${relName}" received an unrecognized sub-operation — expected one of ` +
        `create/connect/connectOrCreate.`,
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
  async create(args: CreateArgs<CreateInput>): Promise<Row> {
    const { scalars, relOps } = this.splitData(args.data as Record<string, unknown>);
    if (Object.keys(relOps).length === 0) {
      return this.insertRow(scalars);
    }

    return this.runAtomic(async (tx) => {
      const self = tx[this.meta.name] as ModelDelegate<Row, CreateInput, UpdateInput, Rel> | undefined;
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
