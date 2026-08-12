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

/**
 * Per-relation include spec: `true` for the full child row, or `{ select }`
 * to narrow the child's own scalars. One level deep only — no nested
 * `include`, no relation-scoped `where`/`orderBy`/`take`/`skip`
 * (client-relation-loading spec).
 */
export type IncludeInput<Rel> = {
  [K in keyof Rel]?: boolean | { select: Record<string, boolean> };
};

export interface FindManyArgs<Row, Rel = Record<string, never>> {
  where?: WhereInput<Row>;
  orderBy?: OrderByInput<Row> | Array<OrderByInput<Row>>;
  take?: number;
  skip?: number;
  select?: SelectInput<Row>;
  include?: IncludeInput<Rel>;
}

export interface FindFirstArgs<Row, Rel = Record<string, never>> extends FindManyArgs<Row, Rel> {}

export interface FindUniqueArgs<Row, Rel = Record<string, never>> {
  where: WhereInput<Row>;
  select?: SelectInput<Row>;
  include?: IncludeInput<Rel>;
}

// ─── Return-type narrowing (`select`/`include` → `Payload`) ─────────────────
//
// Hand-written here (not generated per-model conditional types, design.md
// Decision #4) so the narrowing is type-checked once by this package's own
// `tsc --noEmit` instead of being debugged through emitted text, and so the
// documented fallback (see below) is a one-line change with zero generator
// or runtime impact.

/** Narrows `Row` to exactly the keys requested by a `select` object, or the
 * full `Row` when `S` is `undefined` (no `select` given). */
export type SelectedScalars<Row, S> = [S] extends [undefined]
  ? Row
  : Pick<
      Row,
      {
        [K in keyof S]-?: S[K] extends true ? (K extends keyof Row ? K : never) : never;
      }[keyof S]
    >;

/**
 * Full return-type narrowing for a single query args object `A`:
 * `select` picks scalars, `include` adds relation keys (typed via `Rel`,
 * the per-model `<Model>Relations` interface the generator emits).
 *
 * GetPayload checkpoint (tasks.md 2.3, design.md Open Questions): this
 * conditional form held under `tsc --noEmit` against a compiled
 * generated-client fixture (see `packages/client/test/fixtures/`) — no
 * fallback to `Row & Partial<Pick<Rel, ...>>` was needed.
 */
export type Payload<Row, Rel, A> = SelectedScalars<
  Row,
  A extends { select: infer S } ? S : undefined
> &
  (A extends { include: infer I } ? { [K in keyof I & keyof Rel]: Rel[K] } : unknown);

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

/** A single-column relation, direction-collapsed at codegen time (design.md
 * Decision #1): `target WHERE to IN (parent.from values)`. */
export interface RelationMeta {
  target: string;
  from: string;
  to: string;
  list: boolean;
}

/** Emitted instead of `RelationMeta` for a relation whose key spans more
 * than one column — omitted from the generated `<Model>Relations` /
 * `<Model>IncludeInput` types, but still recorded here so `loadRelations`
 * can throw a precise error on a bypass attempt (`as any`, stale compiled
 * client, …) instead of a generic "unknown relation" failure. */
export interface CompositeRelationMeta {
  target: string;
  composite: true;
}

export interface ModelMeta {
  /** Physical table name. */
  table: string;
  /** Field name → column metadata. */
  fields: Record<string, FieldMeta>;
  /** Relation name → relation metadata (absent when the model has none). */
  relations?: Record<string, RelationMeta | CompositeRelationMeta>;
}

/** Executes a parameterized SQL statement, returning result rows. */
export type Executor = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * Runs `fn` on a session-scoped `Executor` bound to one exclusive
 * transaction, owned and lifecycle-managed by the host engine (e.g. PGlite's
 * own `db.transaction`). Used by `IndigoClientOptions.db.transaction` so
 * non-`pg` executors can support `$transaction`.
 */
export type TransactionHook = <T>(fn: (exec: Executor) => Promise<T>) => Promise<T>;
