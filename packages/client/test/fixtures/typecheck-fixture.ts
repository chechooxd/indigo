/**
 * GetPayload checkpoint fixture (tasks.md 2.1/2.3, design.md Open Questions).
 *
 * Hand-authored stand-in for a compiled generated client — a minimal
 * User/Post pair exercising `ModelDelegate`'s real 4th `Rel` generic and
 * `Payload<Row, Rel, A>` narrowing, exactly as `@indigodb/generator`'s
 * `client.ts` wires it (`<Model>Relations` interface + `__meta.relations`
 * shape). Compiled with `tsc --noEmit` by `test/typecheck.mjs`: every
 * `// @ts-expect-error` line below only compiles clean if TypeScript
 * actually raises an error there — an unmatched expectation is itself a
 * compile error, so `tsc --noEmit` exiting 0 IS the checkpoint's pass
 * condition (client-query-type-safety spec: excluded scalar/relation access
 * must be a compile error; select/include must narrow the inferred type).
 */

import { ModelDelegate } from "../../src/delegate.js";
import { IndigoClientBase } from "../../src/client.js";
import type { IndigoPromise } from "../../src/promise.js";
import type {
  ToOneRelationInput,
  ToManyRelationInput,
  ToManyRelationUpdateInput,
  WhereInput,
  WhereValue,
  RelationFilter,
  JsonFilter,
  GroupByArgs,
  UpsertArgs,
  DeferredResults,
} from "../../src/types.js";

// Mirrors the generator's const-object enum emission (client-query-type-
// safety spec "Generated enums emit as a const object with a paired type",
// design.md Decision "const-object enums, parenthesized typeof"): one
// identifier `Status` used both in value position (`Status.Active`) and
// type position (`status: Status`), proving both positions compile under
// `erasableSyntaxOnly` — the same shape the generator now emits instead of
// a nominal `export enum Status {...}`.
export const Status = {
  Active: "active",
  Inactive: "inactive",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

interface User {
  id: number;
  name: string;
  email: string;
  status: Status;
}

interface Post {
  id: number;
  title: string;
  authorId: number;
  /** `Json`/`jsonb` column (client-where-composition PR C). */
  metadata?: unknown;
  /** Numeric field (client-aggregation PR C) — tagged `numeric: true` in
   * the generated `__meta`, mirrored here as `PostNumericFields`. */
  viewCount: number;
}

// Mirrors the generator's nested-write relation members (tasks.md A2.1,
// design.md Decision "relation input unions live in
// packages/client/src/types.ts"): `Post.author` is `fkSide` (Post holds
// `authorId`), so the CreateInput member references `UserCreateInput`
// unomitted. `User.posts` is NOT `fkSide` (the child holds the FK back), so
// its member `Omit`s the child's own `authorId` — the planner supplies it,
// not the caller (PR B, not implemented here).
interface UserCreateInput {
  name: string;
  email: string;
  posts?: ToManyRelationInput<Omit<PostCreateInput, "authorId">, WhereInput<Post>>;
}

interface UserUpdateInput {
  name?: string;
  email?: string;
  posts?: ToManyRelationUpdateInput<Omit<PostCreateInput, "authorId">, WhereInput<Post>>;
}

interface PostCreateInput {
  title: string;
  authorId: number;
  author?: ToOneRelationInput<UserCreateInput, WhereInput<User>>;
}

interface PostUpdateInput {
  title?: string;
  // `author` is a REQUIRED to-one (Post.author has no `?`) — only
  // create/connect/connectOrCreate, never disconnect/set (spec Requirement 4).
  author?: ToOneRelationInput<UserCreateInput, WhereInput<User>>;
}

/** Mirrors the generator's `export interface UserRelations { posts: Post[] }`. */
interface UserRelations {
  posts: Post[];
}

interface PostRelations {
  author: User;
}

// Mirrors the generator's `export interface <Model>WhereInput { ... }`
// (client-where-composition PR A, design.md "Types stay per-model and
// generated, mirroring CreateInput/UpdateInput"): scalar predicates via
// `WhereValue<T>` plus self-referential `AND?`/`OR?`/`NOT?`. PR B adds
// `RelationFilter<W>` keys for to-many relations only — `User.posts` is
// to-many, so `UserWhereInput` gets a `posts` key; `Post.author` is to-one,
// so `PostWhereInput` gets NO `author` key (design.md "To-one relation
// filters stay out of scope").
interface UserWhereInput {
  id?: WhereValue<number>;
  name?: WhereValue<string>;
  email?: WhereValue<string>;
  posts?: RelationFilter<PostWhereInput>;
  AND?: UserWhereInput[];
  OR?: UserWhereInput[];
  NOT?: UserWhereInput;
}

// PR C adds a `JsonFilter` key for a `Json`/`jsonb` column (`metadata`),
// typed via `FieldMeta.json?: true` metadata (design.md "JSON detection"),
// never inferred structurally from the `path` key alone. Non-JSON fields
// keep their `WhereValue<T>` typing.
interface PostWhereInput {
  id?: WhereValue<number>;
  title?: WhereValue<string>;
  authorId?: WhereValue<number>;
  metadata?: JsonFilter;
  AND?: PostWhereInput[];
  OR?: PostWhereInput[];
  NOT?: PostWhereInput;
}

declare const userDelegate: ModelDelegate<
  User,
  UserCreateInput,
  UserUpdateInput,
  UserRelations,
  UserWhereInput
>;
declare const postDelegate: ModelDelegate<
  Post,
  PostCreateInput,
  PostUpdateInput,
  PostRelations,
  PostWhereInput
>;

// `declare const` is only legal at module/namespace top level, not inside a
// function body (TS1184) — module-scoped stand-ins for the generator's
// emitted array-form overload and `IndigoClientBase`, used by the
// `$transaction` array-form scenarios inside `scenarios()` below.
declare const arrayTransaction: <const Ops extends readonly IndigoPromise<unknown>[]>(
  ops: Ops,
) => Promise<DeferredResults<Ops>>;
declare const baseClient: IndigoClientBase;

// ── numeric-gated aggregate narrowing (client-aggregation PR C) — mirrors
//    the generator's `<Model>NumericFields` union: every field tagged
//    `numeric: true` (Int/Float/Decimal/BigInt, never an enum). `title` is
//    NOT numeric, so `_sum`/`_avg` on it must fail to type-check. ──
type PostNumericFields = "id" | "authorId" | "viewCount";

declare const postAggDelegate: ModelDelegate<
  Post,
  PostCreateInput,
  PostUpdateInput,
  PostRelations,
  PostWhereInput,
  PostCreateInput,
  never,
  PostNumericFields
>;

// ── uniqueGroups-gated upsert `where` narrowing (client-upsert PR D) —
//    mirrors the generator's `<Model>UpsertWhereInput`: a union of one
//    object shape per declared unique group. `User` has PK `id` and a
//    unique `email` column, so its upsert `where` accepts either shape, but
//    NOT `name` (not declared unique) and NOT a partial/extra-field shape. ──
type UserUpsertWhereInput = { id: number } | { email: string };

declare const userUpsertDelegate: ModelDelegate<
  User,
  UserCreateInput,
  UserUpdateInput,
  UserRelations,
  UserWhereInput,
  UserCreateInput,
  never,
  never,
  UserUpsertWhereInput
>;

// ── const-object enum: value position + type position (client-query-type-
//    safety spec "Value-position usage compiles" / "Type-position usage
//    compiles in function signatures") ──
function setStatus(s: Status): void {
  void s;
}
setStatus(Status.Active);
const enumValuePosition: Status = Status.Inactive;
void enumValuePosition;

async function scenarios() {
  // ── No select / no include → identical shape to Row (backward compat) ──
  const plain = await userDelegate.findMany();
  const p0 = plain[0];
  p0.id;
  p0.name;
  p0.email;
  // @ts-expect-error `posts` was never included
  p0.posts;

  // ── select-only narrows to exactly the selected scalars ──
  const selected = await userDelegate.findMany({ select: { name: true } });
  const s0 = selected[0];
  s0.name;
  // @ts-expect-error `id` was not selected
  s0.id;
  // @ts-expect-error `email` was not selected
  s0.email;

  // ── include-only adds the relation key; scalars stay full Row ──
  const included = await userDelegate.findMany({ include: { posts: true } });
  const i0 = included[0];
  i0.id;
  i0.email;
  i0.posts[0].title;
  i0.posts[0].authorId;

  // ── nested select inside include: accepted at the type level (design.md's
  //    Payload contract narrows the RELATION KEY via `Rel`, not the child's
  //    own shape per nested `select` — that runtime narrowing is proven by
  //    packages/client/test/relations.mjs's Phase 3.6 data-shape assertion,
  //    not by the type system here) ──
  const nested = await userDelegate.findMany({
    include: { posts: { select: { title: true } } },
  });
  const n0 = nested[0];
  n0.posts[0].title;
  n0.posts[0].authorId;

  // ── select + include combined: select narrows scalars, include adds relation ──
  const both = await userDelegate.findMany({
    select: { name: true },
    include: { posts: true },
  });
  const b0 = both[0];
  b0.name;
  b0.posts;
  // @ts-expect-error `id` was not selected
  b0.id;

  // ── to-one relation on the other side of the pair ──
  const posts = await postDelegate.findMany({ include: { author: true } });
  posts[0].author.email;

  // ── nested-write relation members (tasks.md A2.1/A2.2) — TYPE ONLY, no
  //    planner reads these yet (PR B/C). Every supported sub-op shape must
  //    compile on both Create/UpdateInput. ──

  // to-one (fkSide, Post.author): create / connect / connectOrCreate.
  const createWithNestedAuthorCreate: PostCreateInput = {
    title: "t",
    authorId: 1,
    author: { create: { name: "Ada", email: "ada@example.com" } },
  };
  const createWithNestedAuthorConnect: PostCreateInput = {
    title: "t",
    authorId: 1,
    author: { connect: { id: 1 } },
  };
  const createWithNestedAuthorConnectOrCreate: PostCreateInput = {
    title: "t",
    authorId: 1,
    author: {
      connectOrCreate: { where: { id: 1 }, create: { name: "Ada", email: "ada@example.com" } },
    },
  };
  void createWithNestedAuthorCreate;
  void createWithNestedAuthorConnect;
  void createWithNestedAuthorConnectOrCreate;

  // required to-one on UPDATE: disconnect/set are not part of the union.
  const updateWithNestedAuthorConnect: PostUpdateInput = {
    author: { connect: { id: 2 } },
  };
  void updateWithNestedAuthorConnect;
  // @ts-expect-error `author` is a REQUIRED to-one — no disconnect on update
  const updateWithNestedAuthorDisconnect: PostUpdateInput = { author: { disconnect: true } };
  void updateWithNestedAuthorDisconnect;

  // to-many (non-fkSide, User.posts): the child's own FK field is omitted —
  // the planner supplies it, not the caller.
  const createWithNestedPosts: UserCreateInput = {
    name: "Ada",
    email: "ada@example.com",
    posts: { create: [{ title: "Hello" }] },
  };
  void createWithNestedPosts;
  const leakingPostCreate: { title: string } = { title: "Hello" };
  const createWithNestedPostsLeakingFk: UserCreateInput = {
    name: "Ada",
    email: "ada@example.com",
    posts: {
      // @ts-expect-error `authorId` is supplied by the planner, not the caller
      create: [{ ...leakingPostCreate, authorId: 1 }],
    },
  };
  void createWithNestedPostsLeakingFk;

  // to-many on UPDATE: disconnect/set ARE part of the union, including `set: []`.
  const updateWithNestedPostsSetEmpty: UserUpdateInput = {
    posts: { set: [] },
  };
  const updateWithNestedPostsDisconnect: UserUpdateInput = {
    posts: { disconnect: [{ id: 1 }] },
  };
  void updateWithNestedPostsSetEmpty;
  void updateWithNestedPostsDisconnect;

  // ── WhereInput composition (client-where-composition PR A) — recursive
  //    AND/OR/NOT self-references typed on the per-model WhereInput. ──
  const orQuery = await userDelegate.findMany({
    where: { OR: [{ name: "Ada" }, { email: "ada@example.com" }] },
  });
  void orQuery;

  const nestedQuery = await userDelegate.findMany({
    where: {
      AND: [{ name: "Ada" }, { OR: [{ email: "a@x.com" }, { NOT: { id: 1 } }] }],
    },
  });
  void nestedQuery;

  // `NOT` accepts a single where object only, never an array.
  // @ts-expect-error `NOT` rejects an array — only a single `PostWhereInput` is accepted
  const notArrayRejected: PostWhereInput = { NOT: [{ id: 1 }] };
  void notArrayRejected;

  // ── Relation filters (client-where-composition PR B) — `some`/`every`/
  //    `none` on a to-many relation, typed against the TARGET's own
  //    WhereInput. To-one relations expose no such keys. ──
  const relSome: UserWhereInput = { posts: { some: { title: "Hello" } } };
  const relEvery: UserWhereInput = { posts: { every: { title: "Hello" } } };
  const relNone: UserWhereInput = { posts: { none: { title: "Hello" } } };
  void relSome;
  void relEvery;
  void relNone;

  // @ts-expect-error `author` is a to-one relation — no `some`/`every`/`none` keys
  const toOneRelationFilterRejected: PostWhereInput = { author: { some: {} } };
  void toOneRelationFilterRejected;

  // ── JSON path filters (client-where-composition PR C) — a `Json`/`jsonb`
  //    field is typed `JsonFilter`; a non-JSON field is not. ──
  const jsonEquals: PostWhereInput = { metadata: { path: ["status"], equals: "active" } };
  const jsonGt: PostWhereInput = { metadata: { path: ["score"], gt: 10 } };
  const jsonContains: PostWhereInput = { metadata: { path: [], jsonContains: { a: 1 } } };
  void jsonEquals;
  void jsonGt;
  void jsonContains;

  // @ts-expect-error `title` is not a Json column — the `JsonFilter` shape
  // (`path`) isn't assignable to `WhereValue<string>`
  const jsonFilterOnNonJsonField: PostWhereInput = { title: { path: ["x"], equals: "y" } };
  void jsonFilterOnNonJsonField;

  // ── aggregate/groupBy numeric narrowing (client-aggregation PR C) —
  //    `_sum`/`_avg` accept only `PostNumericFields` keys; `_min`/`_max`
  //    accept any scalar field. ──
  const agg = await postAggDelegate.aggregate({
    _count: true,
    _sum: { viewCount: true },
    _avg: { authorId: true },
    _min: { title: true },
    _max: { id: true },
  });
  agg._count;
  agg._sum?.viewCount;
  void agg;

  // @ts-expect-error `title` is not numeric-tagged — not a valid `_sum` key
  const aggNonNumericSum = await postAggDelegate.aggregate({ _sum: { title: true } });
  void aggNonNumericSum;

  // @ts-expect-error `title` is not numeric-tagged — not a valid `_avg` key
  const aggNonNumericAvg = await postAggDelegate.aggregate({ _avg: { title: true } });
  void aggNonNumericAvg;

  const groups = await postAggDelegate.groupBy({
    by: ["authorId"],
    _count: true,
    _sum: { viewCount: true },
  });
  groups[0]?.authorId;
  groups[0]?._count;
  void groups;

  // Excess-property checking against a generic-inferred call argument is
  // suppressed by TypeScript itself (a known limitation, not specific to
  // this codebase) — so `having`'s rejection is proven against the
  // GENERATED arg type directly, exactly as `<Model>GroupByArgs` shapes it.
  const groupByArgsWithHaving: GroupByArgs<Post, PostWhereInput, PostNumericFields> = {
    by: ["authorId"],
    // @ts-expect-error `having` is not part of the generated groupBy arg shape
    having: { authorId: { gt: 1 } },
  };
  void groupByArgsWithHaving;

  // ── distinct is a findMany option (client-aggregation PR C) ──
  const distinctPosts = await postDelegate.findMany({ distinct: ["authorId"] });
  void distinctPosts;

  // ── upsert (client-upsert PR D) — `where` only accepts a declared
  //    unique-constraint group shape (`UserUpsertWhereInput`). ──
  const upsertByEmail = await userUpsertDelegate.upsert({
    where: { email: "a@x.com" },
    create: { name: "Ada", email: "a@x.com" },
    update: { name: "Ada 2" },
  });
  upsertByEmail.id;
  void upsertByEmail;

  const upsertById = await userUpsertDelegate.upsert({
    where: { id: 1 },
    create: { name: "Ada", email: "a@x.com" },
    update: { name: "Ada 2" },
  });
  void upsertById;

  // Excess-property checking against a generic-inferred call argument is
  // suppressed by TypeScript itself (the same known limitation the
  // `groupBy`/`having` proof above documents) — so the rejection is proven
  // against the GENERATED arg type directly, exactly as `<Model>UpsertArgs`
  // shapes it.
  const upsertArgsWithNonUniqueWhere: UpsertArgs<UserCreateInput, UserUpdateInput, UserUpsertWhereInput> = {
    // @ts-expect-error `name` is not a declared unique-constraint group on User
    where: { name: "A" },
    create: { name: "A", email: "a@x.com" },
    update: { name: "A" },
  };
  void upsertArgsWithNonUniqueWhere;

  // ── $transaction array form typing (client-transaction-array-form,
  //    client-deferred-queries spec: "Existing Promise-typed call sites keep
  //    compiling", "Array form executes ops atomically in order on one
  //    session") ──

  // A delegate method's `IndigoPromise<T>` return value assigns directly to
  // a plain `Promise<T>`-typed variable and composes with `Promise.all`,
  // since `IndigoPromise<T>` structurally implements `Promise<T>`
  // (design.md Decision 1) — no subclassing, no special-casing needed at
  // any existing `Promise<T>`-typed call site.
  const assignableToPromise: Promise<User[]> = userDelegate.findMany();
  void assignableToPromise;

  const [viaPromiseAll, countViaPromiseAll] = await Promise.all([
    userDelegate.findMany(),
    postDelegate.count(),
  ]);
  void viaPromiseAll;
  void countViaPromiseAll;

  // Mirrors the generator's emitted array-form overload —
  // `$transaction<const Ops extends readonly IndigoPromise<unknown>[]>(ops:
  // Ops): Promise<DeferredResults<Ops>>` — without needing a full generated
  // `IndigoClient` fixture: `DeferredResults<Ops>` itself is the runtime
  // package's own type contract (types.ts), so this proves the tuple
  // inference directly.
  const [createdUser, createdPost]: [User, Post] = await arrayTransaction([
    userDelegate.create({ data: { name: "Ada", email: "ada@example.com" } }),
    postDelegate.create({ data: { title: "t", authorId: 1 } }),
  ]);
  void createdUser;
  void createdPost;

  // `IndigoClientBase` has no array-accepting `$transaction` overload
  // (client-transactions spec, "IndigoClientBase does not support the array
  // form") — enforced purely at compile time by never declaring one; an
  // array literal is not assignable to `fn: (exec: Executor) => Promise<T>`.
  // @ts-expect-error IndigoClientBase.$transaction only accepts the callback
  // form — an array is not assignable to `(exec: Executor) => Promise<T>`
  baseClient.$transaction([userDelegate.create({ data: { name: "Ada", email: "ada@example.com" } })]);
}

void scenarios;
