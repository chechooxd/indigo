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
} from "./types.js";

function quote(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

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

export class ModelDelegate<Row, CreateInput, UpdateInput> {
  constructor(
    protected readonly meta: ModelMeta,
    protected readonly exec: Executor,
  ) {}

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

  async findMany(args: FindManyArgs<Row> = {}): Promise<Row[]> {
    const params = new Params();
    let sql = `SELECT ${this.selectList(args.select)} FROM ${quote(this.meta.table)}`;
    sql += this.buildWhere(args.where, params);
    sql += this.buildOrderBy(args.orderBy);
    if (args.take !== undefined) sql += ` LIMIT ${params.add(args.take)}`;
    if (args.skip !== undefined) sql += ` OFFSET ${params.add(args.skip)}`;
    return (await this.exec(sql, params.values)) as Row[];
  }

  async findFirst(args: FindFirstArgs<Row> = {}): Promise<Row | null> {
    const rows = await this.findMany({ ...args, take: 1 });
    return rows[0] ?? null;
  }

  async findUnique(args: FindUniqueArgs<Row>): Promise<Row | null> {
    return this.findFirst({ where: args.where, select: args.select });
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
