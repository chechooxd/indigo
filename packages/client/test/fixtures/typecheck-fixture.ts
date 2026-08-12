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

interface UserCreateInput {
  name: string;
  email: string;
}

interface UserUpdateInput {
  name?: string;
  email?: string;
}

interface PostCreateInput {
  title: string;
  authorId: number;
}

interface PostUpdateInput {
  title?: string;
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
}

void scenarios;
