/**
 * @indigodb/client — Query argument types
 *
 * Generic, Prisma-flavoured argument shapes shared by every generated model
 * delegate. The generated client narrows `Row`/`CreateInput`/`UpdateInput` per
 * model; `WhereInput` is derived structurally from `Row`.
 */

export type OrderDirection = "asc" | "desc";

/** Operator object usable in a `where` clause (MVP subset). */
export interface WhereFilter<T> {
  equals?: T;
  not?: T;
  in?: T[];
  notIn?: T[];
  lt?: T;
  lte?: T;
  gt?: T;
  gte?: T;
  /** Substring match (ILIKE %value%). String columns only. */
  contains?: string;
  startsWith?: string;
  endsWith?: string;
}

/** A where value is either a direct equality or an operator object. */
export type WhereValue<T> = T | WhereFilter<T>;

/** Structural where input derived from a row type. */
export type WhereInput<Row> = {
  [K in keyof Row]?: WhereValue<Row[K]>;
};

export type OrderByInput<Row> = {
  [K in keyof Row]?: OrderDirection;
};

export type SelectInput<Row> = {
  [K in keyof Row]?: boolean;
};

export interface FindManyArgs<Row> {
  where?: WhereInput<Row>;
  orderBy?: OrderByInput<Row> | Array<OrderByInput<Row>>;
  take?: number;
  skip?: number;
  select?: SelectInput<Row>;
}

export interface FindFirstArgs<Row> extends FindManyArgs<Row> {}

export interface FindUniqueArgs<Row> {
  where: WhereInput<Row>;
  select?: SelectInput<Row>;
}

export interface CreateArgs<CreateInput> {
  data: CreateInput;
}

export interface UpdateArgs<Row, UpdateInput> {
  where: WhereInput<Row>;
  data: UpdateInput;
}

export interface DeleteArgs<Row> {
  where: WhereInput<Row>;
}

export interface CountArgs<Row> {
  where?: WhereInput<Row>;
}

// ─── Model metadata (emitted by the generator) ───────────────────────────────

export interface FieldMeta {
  /** Physical column name. */
  db: string;
  /** Whether the field is (part of) the primary key. */
  pk?: boolean;
}

export interface ModelMeta {
  /** Physical table name. */
  table: string;
  /** Field name → column metadata. */
  fields: Record<string, FieldMeta>;
}

/** Executes a parameterized SQL statement, returning result rows. */
export type Executor = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
