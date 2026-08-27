/**
 * @indigodb/client — Query argument types
 *
 * Generic, Prisma-flavoured argument shapes shared by every generated model
 * delegate. The generated client narrows `Row`/`CreateInput`/`UpdateInput` per
 * model; `WhereInput` is derived structurally from `Row`.
 */

import type { IndigoPromise } from "./promise.js";

export type OrderDirection = "asc" | "desc";

/** Operator object usable in a `where` clause (MVP subset). */
export interface WhereFilter<T> {
  /** Equality. `equals: null` selects the NULL rows (same as the `field: null` shorthand). */
  equals?: T;
  /**
   * Negated equality. `not: null` selects every non-NULL row.
   *
   * Rows where the column IS NULL are included in `not: <value>`, matching
   * Prisma — plain SQL `<>` would drop them, which surprises anyone reading
   * the filter as "everything except this value". Same rule for `notIn`.
   */
  not?: T;
  in?: T[];
  /** Negated membership. Includes NULL rows, like `not`. */
  notIn?: T[];
  lt?: T;
  lte?: T;
  gt?: T;
  gte?: T;
  /**
   * Case-insensitive substring match. String columns only.
   *
   * The value matches as literal text: `%`, `_` and `\` are escaped before
   * reaching the underlying `ILIKE`, so `contains: "100%"` matches "100%"
   * and not "1000". Same for `startsWith`/`endsWith` below.
   */
  contains?: string;
  /** Case-insensitive prefix match, literal (see `contains`). */
  startsWith?: string;
  /** Case-insensitive suffix match, literal (see `contains`). */
  endsWith?: string;
}

/** A where value is either a direct equality or an operator object. */
export type WhereValue<T> = T | WhereFilter<T>;

/**
 * JSON path filter for a `Json`/`jsonb` column (client-where-composition PR
 * C, design.md "JSON Filter (PR C)"): `path: []` addresses the whole column.
 * `equals`/`not` compile via jsonb equality (`#>` + `= $v::jsonb`);
 * `gt`/`gte`/`lt`/`lte` compare the path's TEXT representation (`#>>`), cast
 * to `::numeric` when the operand is a `number`; `jsonContains` is `@>`
 * containment. Named `jsonContains`, not `contains` (design.md Decision
 * "`@>` key name") — `contains` already means string `ILIKE %v%` in
 * `WhereFilter`, and reusing it here would be a same-key/two-meaning
 * footgun even inside this disjoint shape. Detected via `FieldMeta.json`,
 * never inferred structurally from the presence of `path` alone (design.md
 * Decision "JSON detection").
 */
export interface JsonFilter {
  path: string[];
  equals?: unknown;
  not?: unknown;
  gt?: unknown;
  gte?: unknown;
  lt?: unknown;
  lte?: unknown;
  jsonContains?: unknown;
}

/**
 * Relation filter for a to-many relation (client-where-composition PR B,
 * design.md "Relation SQL Shapes (PR B)"): `some`/`every`/`none` each accept
 * a nested `<Target>WhereInput`, compiled to a correlated `EXISTS`/
 * `NOT EXISTS` subquery against the related table. To-one relation filters
 * are out of scope (proposal.md "Out of Scope").
 */
export interface RelationFilter<W> {
  some?: W;
  every?: W;
  none?: W;
}

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

/**
 * `Where` is a 5th, defaulted generic (client-where-composition PR A,
 * design.md "ModelDelegate gains a 5th generic `Where`"): the generated
 * client passes its per-model `<Model>WhereInput` (recursive `AND`/`OR`/
 * `NOT` composition, emitted by `@indigodb/generator`); hand-authored
 * `ModelDelegate` usage (tests, ad-hoc callers) keeps the flat structural
 * `WhereInput<Row>` default unchanged.
 *
 * `Cursor` is a 7th, defaulted generic on `ModelDelegate` (client-batch-
 * aggregate PR B, design.md Decision #7 — originally specced as the "6th"
 * generic before PR A claimed that slot for `CreateManyInput`, so this
 * threads through as the 7th): defaults to `never`, so hand-authored
 * `ModelDelegate` usage cannot pass a `cursor` at all unless it opts in. The
 * generated client passes `<Model>CursorInput` (a single-field `{ <pk>:
 * <type> }` shape) for single-column-PK models, and `never` for
 * composite-PK (or PK-less) models — making `cursor` unwritable in TS for
 * those, on top of the runtime pk-count guard in `findManyImpl` that catches
 * `as any`/stale-client bypasses.
 */
export interface FindManyArgs<Row, Rel = Record<string, never>, Where = WhereInput<Row>, Cursor = never> {
  where?: Where;
  orderBy?: OrderByInput<Row> | Array<OrderByInput<Row>>;
  /**
   * Keyset pagination anchor (client-cursor-pagination spec): identifies a
   * single row by its primary-key value. Combined with `skip` (implicit `1`
   * when a `cursor` is given and `skip` is omitted — Prisma's own default)
   * to resume immediately AFTER that row, ordered by the primary key (or by
   * `orderBy` if also supplied, with the primary key appended as a
   * deterministic tiebreaker). See design.md Decisions #5/#6.
   */
  cursor?: Cursor;
  take?: number;
  skip?: number;
  /**
   * `SELECT DISTINCT ON (<fields>)` (client-aggregation spec "distinct is a
   * findMany option, not a standalone method", design.md Decision #8): at
   * most one row per distinct combination of the named fields. Postgres
   * requires `DISTINCT ON`'s expressions to be the `ORDER BY`'s leftmost
   * terms, so `findManyImpl` prepends `distinct`'s fields onto `orderBy`
   * (skipped when the caller's own `orderBy` already leads with exactly that
   * sequence) — see `delegate.ts`'s `buildOrderBy`.
   */
  distinct?: Array<Extract<keyof Row, string>>;
  select?: SelectInput<Row>;
  include?: IncludeInput<Rel>;
}

export interface FindFirstArgs<Row, Rel = Record<string, never>, Where = WhereInput<Row>>
  extends FindManyArgs<Row, Rel, Where> {}

export interface FindUniqueArgs<Row, Rel = Record<string, never>, Where = WhereInput<Row>> {
  where: Where;
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

export interface UpdateArgs<Row, UpdateInput, Where = WhereInput<Row>> {
  where: Where;
  data: UpdateInput;
}

export interface DeleteArgs<Row, Where = WhereInput<Row>> {
  where: Where;
}

export interface CountArgs<Row, Where = WhereInput<Row>> {
  where?: Where;
}

// ─── Batch mutations (client-batch-mutations spec, PR A) ────────────────────
//
// `createMany`/`updateMany`/`deleteMany` — scalar-only, one round trip.
// `CreateInput` is reused unchanged (design.md File Changes: no `__meta`
// change for this slice); a compile-time-narrower scalar-only input is
// deferred to the generator work this slice does not touch.

/** `createMany(data: CreateInput[])` args (spec "createMany inserts all rows
 * atomically in one statement"). */
export interface CreateManyArgs<CreateInput> {
  data: CreateInput[];
}

/** `updateMany({ where, data })` args — `where` is REQUIRED (spec "updateMany
 * and deleteMany require a non-empty where"); an absent/empty `where` throws
 * before any SQL is built, so it is typed as required here even though the
 * runtime check is what actually enforces "non-empty". */
export interface UpdateManyArgs<Row, UpdateInput, Where = WhereInput<Row>> {
  where: Where;
  data: UpdateInput;
}

/** `deleteMany({ where })` args — same required-`where` reasoning as
 * `UpdateManyArgs`. */
export interface DeleteManyArgs<Row, Where = WhereInput<Row>> {
  where: Where;
}

/** Return shape shared by `createMany`/`updateMany`/`deleteMany` (design.md
 * Interfaces/Contracts) — the number of rows actually affected, derived from
 * `RETURNING 1` + `rows.length` since `Executor` returns rows only (design.md
 * Decision "Batch counts"). */
export interface BatchPayload {
  count: number;
}

// ─── Aggregation (client-aggregation spec, PR C) ────────────────────────────
//
// `Numeric` is an 8th, defaulted generic on `ModelDelegate` (design.md
// Decisions #9-11, following the `Where`/`CreateManyInput`/`Cursor` 5th/6th/
// 7th-generic precedents — appended at the end, not renumbered): the
// per-model UNION of field names tagged `FieldMeta.numeric: true` in
// generated `__meta`. Defaults to `never` so hand-authored `ModelDelegate`
// usage cannot pass any `_sum`/`_avg` field at all unless it opts in; the
// generated client passes `<Model>NumericFields` (a string-literal union),
// making a non-numeric field a compile-time excess-property error on top of
// `delegate.ts`'s runtime `NON_NUMERIC_AGGREGATE` guard for `as any`/
// stale-client bypasses.

/** `_min`/`_max` accept ANY scalar field (client-aggregation spec — only
 * `_sum`/`_avg` are numeric-restricted). */
export type AggregateSelection<Row> = Partial<Record<Extract<keyof Row, string>, true>>;

/** `aggregate({ where?, _count?, _sum?, _avg?, _min?, _max? })` args
 * (client-aggregation spec "aggregate computes _count/_sum/_avg/_min/_max
 * over a where"). */
export interface AggregateArgs<Row, Where = WhereInput<Row>, Numeric extends string = never> {
  where?: Where;
  _count?: true;
  _sum?: Partial<Record<Numeric, true>>;
  _avg?: Partial<Record<Numeric, true>>;
  _min?: AggregateSelection<Row>;
  _max?: AggregateSelection<Row>;
}

/** `groupBy({ by, where?, _count?, _sum?, _avg?, _min?, _max? })` args
 * (client-aggregation spec "groupBy groups by fields and returns aggregates
 * per group"). `having` is deliberately NOT part of this interface — the
 * spec's "having is not part of the accepted input shape" scenario requires
 * a compile-time excess-property error, not a runtime-ignored key. */
export interface GroupByArgs<Row, Where = WhereInput<Row>, Numeric extends string = never> {
  by: Array<Extract<keyof Row, string>>;
  where?: Where;
  _count?: true;
  _sum?: Partial<Record<Numeric, true>>;
  _avg?: Partial<Record<Numeric, true>>;
  _min?: AggregateSelection<Row>;
  _max?: AggregateSelection<Row>;
}

/** `aggregate`'s result shape (design.md Interfaces/Contracts) — keyed
 * identically to the requested aggregate options. `_sum`/`_avg` are cast
 * `::float8` in SQL (design.md Decision #11): `number | null`, with a known,
 * accepted precision limitation above 2^53 for `BigInt`/`Decimal` columns in
 * this slice. `_min`/`_max` return the column's native (uncast) type. */
export interface AggregateResult {
  _count?: number;
  _sum?: Record<string, number | null>;
  _avg?: Record<string, number | null>;
  _min?: Record<string, unknown>;
  _max?: Record<string, unknown>;
}

/** `groupBy`'s per-group result row: the requested `by` fields plus the
 * requested aggregates, flattened onto the same object (client-aggregation
 * spec "one row per distinct combination of the by fields, each carrying the
 * requested aggregates"). */
export type GroupByResult<Row> = Partial<Row> & AggregateResult;

// ─── Upsert (client-upsert spec, PR D) ──────────────────────────────────────
//
// `UniqueWhere` is a 9th, defaulted generic on `ModelDelegate` (design.md
// Decisions #12/#13, appended after `Numeric`'s 8th slot — nothing
// renumbered): the per-model UNION of exact unique-constraint-group shapes
// sourced from generated `__meta.uniqueGroups`. Defaults to `never` so
// hand-authored `ModelDelegate` usage cannot call `upsert` at all unless it
// opts in; the generated client passes `<Model>UpsertWhereInput` — a union
// of one object shape per declared unique group (PK first, then `@unique`
// columns, then unique indexes) — making a `where` that doesn't exactly
// match a declared group a compile-time error, on top of `upsertImpl`'s
// runtime `NO_MATCHING_UNIQUE_CONSTRAINT` guard for `as any`/stale-client
// bypasses.

/** `upsert({ where, create, update })` args (client-upsert spec "upsert
 * issues one ON CONFLICT statement targeting a declared unique group"). */
export interface UpsertArgs<CreateInput, UpdateInput, UniqueWhere> {
  where: UniqueWhere;
  create: CreateInput;
  update: UpdateInput;
}

// ─── Model metadata (emitted by the generator) ───────────────────────────────

export interface FieldMeta {
  /** Physical column name. */
  db: string;
  /** Whether the field is (part of) the primary key. */
  pk?: boolean;
  /**
   * `true` for a `Json`/`jsonb` column (client-where-composition PR C,
   * design.md Decision "JSON detection"). Drives `whereExpr`'s field-level
   * dispatch: a `path` key in a `where` filter against a field WITHOUT this
   * bit throws `IndigoWhereError` instead of silently emitting `#>` on a
   * non-JSON column.
   */
  json?: true;
  /**
   * `true` for a numeric scalar column — `Int`/`Float`/`Decimal`/`BigInt`,
   * never an enum (client-aggregation spec, design.md Decision #10). Drives
   * `_sum`/`_avg`'s runtime guard in `delegate.ts`: requesting either on a
   * field WITHOUT this bit throws `IndigoArgumentError` code
   * `NON_NUMERIC_AGGREGATE` instead of emitting `SUM`/`AVG` against a
   * non-numeric Postgres column.
   */
  numeric?: true;
}

/** A single-column relation, direction-collapsed at codegen time (design.md
 * Decision #1): `target WHERE to IN (parent.from values)`. */
export interface RelationMeta {
  target: string;
  from: string;
  to: string;
  list: boolean;
  /**
   * `true` when this model physically holds the FK column for the pair
   * (`!ResolvedRelation.inverse`). Nested-write planner ordering (design.md
   * Decision "`list` is insufficient to order writes", spec Requirement 6):
   * `fkSide` relations execute BEFORE the parent row write, non-`fkSide`
   * relations execute AFTER it.
   */
  fkSide: boolean;
  /** Whether the relation FIELD itself is optional (`Type?`). */
  optional: boolean;
  /**
   * Nullability of the PHYSICAL FK column backing this pair, wherever it
   * physically lives. Gates `disconnect`/`set` (spec Requirement 4): only an
   * `optionalFk` relation can have its FK cleared to NULL — a required FK
   * throws a typed error instead of orphaning/cascading.
   */
  optionalFk: boolean;
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
  /** The model's own schema name (e.g. "User"). Lets the nested-write
   * planner find its own session-bound sibling delegate by name. */
  name: string;
  /** Physical table name. */
  table: string;
  /** Field name → column metadata. */
  fields: Record<string, FieldMeta>;
  /** Relation name → relation metadata (absent when the model has none). */
  relations?: Record<string, RelationMeta | CompositeRelationMeta>;
  /**
   * Declared unique-constraint groups (client-upsert spec, design.md
   * Decision #12): PK first, then `@unique` columns, then unique `@@index`/
   * `@@unique` groups, each entry an array of FIELD names (schema names,
   * not physical column names). Drives `upsert`'s `ON CONFLICT` target
   * resolution — a `where` whose key set doesn't exactly match one of these
   * groups is rejected before any SQL is built. Readonly array typing is
   * REQUIRED: `__meta` is emitted `as const`, and a mutable array type here
   * would fail `typecheck.mjs`'s fixture.
   */
  uniqueGroups: readonly (readonly string[])[];
}

// ─── Nested-write relation input unions (client-nested-writes spec) ─────────
//
// Hand-written here (design.md Decision "relation input unions live in
// packages/client/src/types.ts"), same reasoning as `Payload` — type-checked
// once by this package's own `tsc --noEmit` instead of debugged through
// generated text. The generator only REFERENCES these per relation; it never
// re-derives the sub-op shapes itself.
//
// PR A (this file) ships the TYPES ONLY — no runtime planner reads them yet
// (that's PR B/C, tasks.md). `ChildCreateInput` is the target model's own
// `CreateInput`, already narrowed by the generator (e.g.
// `Omit<PostCreateInput, "authorId">` for a non-fkSide relation whose child
// FK field is supplied by the planner, not the caller).

/** Sub-operations for a to-one relation on `create` (and on `update` for a
 * REQUIRED to-one — a required relation can be replaced, never disconnected). */
export type ToOneRelationInput<ChildCreateInput, ChildWhere> =
  | { create: ChildCreateInput }
  | { connect: ChildWhere }
  | { connectOrCreate: { where: ChildWhere; create: ChildCreateInput } };

/** `ToOneRelationInput` plus `disconnect`/`set` — only valid on an OPTIONAL
 * to-one relation (`RelationMeta.optionalFk`), which can clear its FK to
 * NULL instead of orphaning/cascading (spec Requirement 4). */
export type ToOneRelationUpdateInput<ChildCreateInput, ChildWhere> =
  | ToOneRelationInput<ChildCreateInput, ChildWhere>
  | { disconnect: true }
  | { set: null };

/** Sub-operations for a to-many relation on `create`. */
export interface ToManyRelationInput<ChildCreateInput, ChildWhere> {
  create?: ChildCreateInput[];
  connect?: ChildWhere[];
  connectOrCreate?: Array<{ where: ChildWhere; create: ChildCreateInput }>;
}

/** `ToManyRelationInput` plus `disconnect`/`set` on `update`. `set: []`
 * disconnects the entire currently-linked set without deleting anything
 * (spec Requirement 3). */
export interface ToManyRelationUpdateInput<ChildCreateInput, ChildWhere>
  extends ToManyRelationInput<ChildCreateInput, ChildWhere> {
  disconnect?: ChildWhere[];
  set?: ChildWhere[];
}

/** Executes a parameterized SQL statement, returning result rows. */
export type Executor = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

// ─── Query extension seam (client-query-extensions spec) ───────────────────

/**
 * Per-query metadata visible to a `QueryExtension` for a delegate-issued
 * query (`db.<model>.<method>(...)`). `undefined` for `$queryRaw` and any
 * other internal statement — see `context.ts`'s `currentQueryContext()`.
 */
export interface QueryContext {
  /** The model's own schema name (`ModelMeta.name`), e.g. "User". */
  model: string;
  /** The delegate method name that issued the query, e.g. "findMany". */
  operation: string;
}

/**
 * User-supplied middleware composing around the `Executor` seam — the same
 * shape `IndigoClientBase`'s private `wrapLog` already uses internally.
 * An extension MAY call `next` with rewritten `sql`/`params`, MAY skip
 * calling `next` entirely and return rows itself (short-circuit, e.g. a
 * cache), and observes rejections from `next` (or throws its own) with no
 * swallowing — errors propagate unwrapped (client-query-extensions spec).
 */
export type QueryExtension = (next: Executor) => Executor;

/**
 * Runs `fn` on a session-scoped `Executor` bound to one exclusive
 * transaction, owned and lifecycle-managed by the host engine (e.g. PGlite's
 * own `db.transaction`). Used by `IndigoClientOptions.db.transaction` so
 * non-`pg` executors can support `$transaction`.
 */
export type TransactionHook = <T>(fn: (exec: Executor) => Promise<T>) => Promise<T>;

// ─── Driver adapter seam (client-driver-adapters spec) ──────────────────────

/**
 * Shape of `IndigoClientOptions.db` (design.md Decision 1): a pre-built
 * query executor, plus optional teardown and transaction hooks, produced by
 * a named adapter factory (`createPgAdapter`, `createPGliteAdapter`) or
 * hand-written by the caller. Defined here — a leaf module — so `client.ts`
 * can reference it without an import cycle with `src/adapters/`.
 */
export interface DriverAdapter {
  /** Runs a parameterized SQL statement and returns its result rows. */
  exec: Executor;
  /** Optional teardown hook invoked by `$disconnect()`. */
  close?: () => Promise<void>;
  /**
   * Optional transaction hook. When present, `$transaction`/`$withSession`
   * delegates session lifecycle (begin/commit/rollback) to the host engine
   * instead of issuing raw `BEGIN`/`COMMIT`/`ROLLBACK` itself. Required for
   * `$transaction` to work; absent it, `$transaction` rejects with an
   * explicit error.
   */
  transaction?: TransactionHook;
}

// ─── Array-form `$transaction([...])` (client-transaction-array-form spec) ──

/**
 * Tuple-preserving result type for `$transaction([op1, op2, ...])`
 * (design.md "Contracts"): reads `T` directly out of each element's
 * `IndigoPromise<T>` — not `Awaited<Ops[K]>` — so a non-deferred array
 * element (a plain value or a stale eager `Promise<T>`) is a compile error
 * instead of silently widening to `never`/`unknown` through `Awaited`.
 */
export type DeferredResults<Ops extends readonly unknown[]> = {
  -readonly [K in keyof Ops]: Ops[K] extends IndigoPromise<infer T> ? T : never;
};
