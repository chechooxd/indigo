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
import type {
  ToOneRelationInput,
  ToManyRelationInput,
  ToManyRelationUpdateInput,
  WhereInput,
} from "../../src/types.js";

interface User {
  id: number;
  name: string;
  email: string;
}

interface Post {
  id: number;
  title: string;
  authorId: number;
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

declare const userDelegate: ModelDelegate<User, UserCreateInput, UserUpdateInput, UserRelations>;
declare const postDelegate: ModelDelegate<Post, PostCreateInput, PostUpdateInput, PostRelations>;

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
}

void scenarios;
