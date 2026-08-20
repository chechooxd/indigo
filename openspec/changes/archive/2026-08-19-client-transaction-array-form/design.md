# Design: `$transaction([...])` array form

## Technical Approach

Every one of the 13 public `ModelDelegate` methods becomes a thin, non-`async` wrapper
returning a **lazy, rebindable operation thunk** (`IndigoPromise<T>`) instead of a live
`Promise`. The thunk carries `{ model, operation, self, run(delegate) }`. Awaiting it runs
`run` against its own originating delegate (today's behavior, byte-identical SQL);
`$transaction([...])` instead runs each `run` against the **session-scoped delegate of the
same model name**, resolved out of the registry `__delegates` already builds for the
callback form. Both forms therefore share one wiring path and cannot drift.

### Source evidence: SQL-capture is impossible (proposal claim CONFIRMED)

Read of `packages/client/src/delegate.ts` (1675 lines) confirms it, and is stronger than
the proposal stated — three of the 13 are *data-dependent* multi-statement, not merely
multi-statement:

| Method | Evidence (delegate.ts) | Capturable as `{sql, params}`? |
|---|---|---|
| `findMany` + `include` | `loadRelations` (l.794-859) derives `keys` from the **rows returned** by the first SELECT, then issues one follow-up per relation through the sibling's own `findMany` | No — follow-up params unknown until statement 1 returns |
| `create` + relOps | `createImpl` (l.1111-1152): phase 1 child key folds into the parent INSERT's params; phase 3 needs `parentRow[relMeta.from]` returned by that INSERT | No |
| `update` + relOps | `updateImpl` (l.1200-1283): a `findMany` decides `AMBIGUOUS_UPDATE_TARGET`; `Object.keys(finalScalars).length === 0` decides whether an `UPDATE` is emitted **at all** | No — statement count is result-dependent |
| `upsert`, `count`, `delete`, `createMany`, `updateMany`, `deleteMany`, `aggregate`, `groupBy` | single statement | Yes, but uniformity forbids two contracts |
| `findFirst`, `findUnique` | delegate to `findMany` (inherits its multi-statement case) | No |

Rebindable thunks are the only mechanism that survives all 13. Confirmed.

### Second source finding: the split is already 9/13 done

`findMany`, `create`, `update`, `createMany`, `updateMany`, `deleteMany`, `aggregate`,
`groupBy`, `upsert` already have a private `<op>Impl`. Only **`findFirst`, `findUnique`,
`delete`, `count`** still inline their bodies inside `withQueryContext` and need extraction.
This materially shrinks slice 2.

## Architecture Decisions

### Decision: `IndigoPromise<T>` is `implements Promise<T>`, not `extends Promise<T>`

| Option | Tradeoff | Decision |
|---|---|---|
| `class IndigoPromise<T> extends Promise<T>` | Real subclass. But `Promise`'s constructor **runs its executor eagerly** — laziness requires a no-op executor plus stashed `resolve`/`reject`; and `.then()` species-constructs `new IndigoPromise(executor)`, which our `(model, op, self, run)` constructor cannot satisfy, forcing `static get [Symbol.species]() { return Promise }`. Two subtle hazards for zero gain. | Rejected |
| Structural thenable `implements Promise<T>` | TS's `Promise<T>` is a structural interface (`then`/`catch`/`finally`/`[Symbol.toStringTag]`). Implementing all four makes it **assignable to `Promise<T>`**, which is the entire compatibility requirement. `await`, `Promise.all`, `Promise.resolve` all assimilate any thenable. Cost: `p instanceof Promise === false`. | **Chosen** |

Rationale: assignability is a *type* requirement, and TS structural typing satisfies it
without inheriting `Promise`'s eager-executor and species semantics. The `instanceof`
caveat is documented; nothing in `packages/` performs `instanceof Promise`.

### Decision: memoized single-fire, with reuse detected at claim time

One private field `promise: Promise<T> | null` is both the memo and the reuse detector.

- `.then()` standalone: return the memo, else execute against `this.self`.
- `__claim(delegate)` (transaction path): if the memo is **already** set → throw
  `IndigoTransactionError("OPERATION_REUSED")`; else set it from `run(delegate)`.

Because `__claim` sets the memo **synchronously**, the same op appearing twice in one array,
or reused across two `$transaction` calls, is caught deterministically. Awaiting an op
*after* its transaction returns the memoized transaction result (matches Prisma).
Rejected alternative: a 4-state `pending→claimed→running→settled` enum — it adds states no
caller can observe, since claim and execution are synchronous neighbours.

### Decision: brand check, not `instanceof`, for the stale-client guard

`isIndigoPromise(v)` tests a `Symbol.for("indigodb.deferred")` property. `instanceof` would
produce a false negative when two copies of `@indigodb/client` exist in `node_modules` —
turning a dependency-hoisting accident into the *same* error message as a genuinely stale
generated client. The brand is realm- and copy-safe.

### Decision: `__delegates` returns a bundle, so the array form reuses `reg`

`packages/generator/src/client.ts` l.399/435 already builds `reg`, keyed by **model name**
(`table.name`, e.g. `"User"`) — the exact key `IndigoPromise.model` carries (`meta.name`).
It is currently closure-private. Change the emitted factory's return to
`{ tx: TransactionClient, byModel: SiblingRegistry }` (2 emitted lines, 2 call sites).

| Option | Tradeoff | Decision |
|---|---|---|
| Re-derive `delegateName()` (camelCase) in the runtime client | Duplicates a generator-private naming rule in a second package; silently breaks if it changes | Rejected |
| Add `__models` to the `TransactionClient` interface | Leaks an internal onto the user-facing `tx` object the callback form receives | Rejected |
| Return `{ tx, byModel }` | Fully typed, no leakage, and `byModel` is *literally* the same `SiblingRegistry` type nested writes already resolve through (`requireSibling`, l.921) | **Chosen** |

### Decision: `IndigoClientBase` array-form boundary — types *and* an explicit throw

Compile time is free: the base signature is `$transaction<T>(fn: (exec: Executor) => Promise<T>)`,
and an array is not assignable to a function — already a type error, no `never` overload needed.
Runtime adds an explicit `Array.isArray` guard throwing
`IndigoTransactionError("ARRAY_FORM_REQUIRES_GENERATED_CLIENT")`. Without it, a JS or `as any`
caller gets `fn is not a function` from deep inside `$withSession`, *after* `BEGIN` was issued.
Four lines buys a correct, actionable message before any session is opened.

### Decision: `withQueryContext` moves inside the thunk

The ALS frame must wrap **execution**, not construction — otherwise an extension reads
`{model, operation}` of whatever op was *constructed* last. `run` is
`(d) => withQueryContext({ model, operation }, () => d.<op>Impl(args))`. Internal callers
(`findFirst`→`findMany`, `loadRelations`→`target.findMany`, planner→`target.create`) keep
calling the **public** methods and `await` them, preserving today's innermost-wins nesting
documented in `context.ts` exactly.

### Decision: nested writes inside the array form need no special casing

`$transaction` calls `__delegates(exec, this.$realtime)` **without** `runAtomic`, so each
session delegate falls back to the identity default (`delegate.ts` l.386): a nested write
issued during an array op reuses the current session and opens no inner transaction.
This is pre-existing wiring; the array form inherits it for free.

## Data Flow

    db.user.create({...})                    ← constructs, executes NOTHING
        │  IndigoPromise{ model:"User", operation:"create", self:d_user, run }
        │
        ├── await p ──────────→ run(self) ──→ withQueryContext ─→ createImpl ─→ this.exec
        │                                                          (pool executor, today)
        │
        └── db.$transaction([p, q, r])
                 │
                 ├─ guard: non-empty, every element branded, no duplicates
                 └─ $withSession(exec)          ← BEGIN via adapter txHook
                        │
                        └─ { byModel } = __delegates(exec, $realtime)
                             for op of ops (in array order, sequential):
                               d = byModel[op.model]  ← "User" → session delegate
                               if (!d) throw MODEL_NOT_IN_REGISTRY
                               results.push(await op.__claim(d))
                        │
                        └─ COMMIT   (any throw → adapter ROLLBACK, whole array)

## Interfaces / Contracts

```ts
// packages/client/src/promise.ts  (new)
const BRAND = Symbol.for("indigodb.deferred");

export type TransactionErrorCode =
  | "OPERATION_REUSED"
  | "NOT_A_DEFERRED_OPERATION"
  | "MODEL_NOT_IN_REGISTRY"
  | "EMPTY_TRANSACTION"
  | "ARRAY_FORM_REQUIRES_GENERATED_CLIENT";

export class IndigoTransactionError extends Error {
  readonly code: TransactionErrorCode;
  constructor(code: TransactionErrorCode, message: string) { … }
}

/** Lazy, single-fire, rebindable operation handle. Assignable to `Promise<T>`
 *  structurally — `then`/`catch`/`finally`/`[Symbol.toStringTag]` are the whole
 *  `Promise<T>` interface. Nothing runs until `then` or `__claim`. */
export class IndigoPromise<T> implements Promise<T> {
  readonly [BRAND] = true as const;
  readonly [Symbol.toStringTag] = "IndigoPromise";
  private promise: Promise<T> | null = null;

  constructor(
    readonly model: string,          // ModelMeta.name — the registry key
    readonly operation: string,      // QueryContext.operation
    private readonly self: unknown,  // originating delegate (standalone target)
    private readonly run: (delegate: any) => Promise<T>,
  ) {}

  /** @internal — transaction path. Rebinds to `delegate`; single-fire. */
  __claim(delegate: unknown): Promise<T> {
    if (this.promise) {
      throw new IndigoTransactionError("OPERATION_REUSED",
        `IndigoDB: this ${this.model}.${this.operation} operation has already been executed — ` +
        `a deferred operation may be used once. Build a fresh one per $transaction call.`);
    }
    return (this.promise = this.run(delegate));
  }

  private settle(): Promise<T> {
    return (this.promise ??= this.run(this.self));
  }

  then<A = T, B = never>(onOk?, onErr?): Promise<A | B> { return this.settle().then(onOk, onErr); }
  catch<B = never>(onErr?): Promise<T | B>              { return this.settle().catch(onErr); }
  finally(onDone?): Promise<T>                          { return this.settle().finally(onDone); }
}

export function isIndigoPromise(v: unknown): v is IndigoPromise<unknown> {
  return typeof v === "object" && v !== null && (v as any)[BRAND] === true;
}

/** Delegate-side factory. `D` infers as the delegate's polymorphic `this`, so
 *  `d.<op>Impl(...)` type-checks against private members inside the class body. */
export function defer<T, D>(
  model: string, operation: string, self: D, run: (delegate: D) => Promise<T>,
): IndigoPromise<T> {
  return new IndigoPromise<T>(model, operation, self,
    (d) => withQueryContext({ model, operation }, () => run(d as D)));
}

/** The array-form engine. Called only by the generated `$transaction`, inside
 *  an already-open `$withSession`. Sequential by construction: whole-transaction
 *  rollback, no per-op tolerance. */
export async function runDeferred(
  ops: readonly unknown[], byModel: Record<string, unknown>,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const op of ops) {
    if (!isIndigoPromise(op)) {
      throw new IndigoTransactionError("NOT_A_DEFERRED_OPERATION",
        `IndigoDB: $transaction([...]) received a value that is not a deferred IndigoDB operation. ` +
        `If this is a plain Promise from db.<model>.<method>(), regenerate your client ` +
        `(\`indigodb generate\`) — it was built against an older @indigodb/client.`);
    }
    const d = byModel[op.model];
    if (!d) {
      throw new IndigoTransactionError("MODEL_NOT_IN_REGISTRY",
        `IndigoDB: no delegate registered for model "${op.model}" in this transaction.`);
    }
    out.push(await (op as any).__claim(d));
  }
  return out;
}
```

```ts
// packages/client/src/types.ts  (additions)
/** Tuple-preserving result type for `$transaction([...])`. Reads `T` out of each
 *  element directly rather than via `Awaited`, so a non-deferred element is a
 *  compile error instead of silently widening. */
export type DeferredResults<Ops extends readonly IndigoPromise<unknown>[]> = {
  -readonly [K in keyof Ops]: Ops[K] extends IndigoPromise<infer T> ? T : never;
};
```

```ts
// packages/generator/src/client.ts  — emitted overloads on IndigoClient
$transaction<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T>;
$transaction<const Ops extends readonly IndigoPromise<unknown>[]>(
  ops: Ops): Promise<DeferredResults<Ops>>;
$transaction(arg: unknown): Promise<unknown> {
  if (Array.isArray(arg)) {
    if (arg.length === 0) return Promise.resolve([]);          // no BEGIN at all
    return this.$withSession((exec) =>
      runDeferred(arg, __delegates(exec, this.$realtime).byModel));
  }
  return this.$withSession((exec) =>
    (arg as (tx: TransactionClient) => Promise<unknown>)(__delegates(exec, this.$realtime).tx));
}
```

## Rewrap Examples (before → after)

**1. `count` — single statement, body currently inline (needs extraction):**

```ts
// before (delegate.ts l.1296)
async count(args: CountArgs<Row, Where> = {}): Promise<number> {
  return withQueryContext({ model: this.meta.name, operation: "count" }, async () => {
    const params = new Params(); … return Number((rows[0] as { count: number }).count);
  });
}
// after
count(args: CountArgs<Row, Where> = {}): IndigoPromise<number> {
  return defer(this.meta.name, "count", this, (d) => d.countImpl(args));
}
private async countImpl(args: CountArgs<Row, Where>): Promise<number> {
  const params = new Params(); … return Number((rows[0] as { count: number }).count);  // verbatim
}
```

**2. `findMany` — multi-statement (`loadRelations`), `Impl` already exists:**

```ts
// before (l.672)
async findMany<A …>(args: A = {} as A): Promise<Payload<Row, Rel, A>[]> {
  return withQueryContext({ model: this.meta.name, operation: "findMany" }, () => this.findManyImpl(args));
}
// after — findManyImpl UNTOUCHED; its `this.exec` and `this.siblings()` are the
// rebound delegate's, so inside a transaction both the SELECT and every
// loadRelations follow-up run on the session executor.
findMany<A …>(args: A = {} as A): IndigoPromise<Payload<Row, Rel, A>[]> {
  return defer(this.meta.name, "findMany", this, (d) => d.findManyImpl(args));
}
```

**3. `create` — nested writes via `runAtomic`, `Impl` already exists:**

```ts
create(args: CreateArgs<CreateInput>): IndigoPromise<Row> {
  return defer(this.meta.name, "create", this, (d) => d.createImpl(args));
}
```

`createImpl` is unchanged. Rebinding is what makes this correct: `d` is the session
delegate, whose `runAtomic` is the identity default, so phase 1/2/3 all run on the array
form's session — one `BEGIN`, not a nested one.

**Extraction needed (4):** `findFirst`, `findUnique`, `delete`, `count` → `*Impl`.
**Wrapper-only rewrite (9):** the rest.

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/client/src/promise.ts` | Create | `IndigoPromise`, `isIndigoPromise`, `defer`, `runDeferred`, `IndigoTransactionError` |
| `packages/client/src/types.ts` | Modify | `DeferredResults<Ops>` tuple type; re-export surface |
| `packages/client/src/index.ts` | Modify | Export the new public names |
| `packages/client/src/delegate.ts` | Modify | 4 `*Impl` extractions + 13 wrappers rewritten to `defer(...)` |
| `packages/client/src/client.ts` | Modify | `Array.isArray` guard in base `$transaction` + doc comment on the boundary |
| `packages/generator/src/client.ts` | Modify | `__delegates` → `{ tx, byModel }`; 2 call sites; `$transaction` overloads + array branch; `IndigoPromise`/`DeferredResults`/`runDeferred` imports in the emitted preamble |
| `packages/client/test/deferred.mjs` | Create | Unit: laziness, memoization, reuse, brand, guards |
| `packages/client/test/transactions.mjs` | Modify | Array-form ordering, atomicity, rollback |
| `packages/client/test/transactions-pg.mjs` | Modify | Real-Postgres rollback proof |
| `packages/client/test/fixtures/typecheck-fixture.ts` | Modify | `const p: Promise<User> = db.user.findUnique(...)`; tuple-typed array result |

## Testing Strategy

Follows the existing plain-Node `.mjs` + `node:assert` + `tsconfig.typecheck.json` harness —
no new test framework.

| Layer | What | Approach |
|---|---|---|
| Unit (`deferred.mjs`) | Constructing an op issues **zero** `exec` calls | Fake `Executor` counting invocations; assert 0 after construction, 1 after `await` |
| Unit | Memoization: two `await`s → one execution | Assert executor call count stays 1 |
| Unit | `OPERATION_REUSED` on the same op in two `$transaction` calls, and twice in one array | Assert `err.code` |
| Unit | `NOT_A_DEFERRED_OPERATION` for a plain `Promise.resolve(1)` element | Assert code + "regenerate your client" text |
| Unit | `MODEL_NOT_IN_REGISTRY`; empty array returns `[]` with **no** `BEGIN` | Spy on the tx hook |
| Unit | Base-client `$transaction([])` throws `ARRAY_FORM_REQUIRES_GENERATED_CLIENT` before `BEGIN` | `IndigoClientBase` directly |
| Unit | `withQueryContext` fires at execution, not construction | Extension records `{model,operation}`; construct A, construct B, await A → observes A |
| Integration (`transactions.mjs`, PGlite) | Standalone SQL is **byte-identical to today** for all 13 | Capture SQL through a recording executor; compare against the existing assertions unchanged |
| Integration | `$transaction([a,b,c])`: one `BEGIN`/`COMMIT`, ops in array order, all on one session | Statement log assertion |
| Integration | Rollback: op 2 fails → op 1's row absent, one `ROLLBACK` | Query after the rejection |
| Integration | A `create` with nested writes inside the array opens **no** inner transaction | Assert exactly one `BEGIN` in the log |
| Integration (`transactions-pg.mjs`) | Same rollback proof against real Postgres | Existing harness |
| Typecheck (`typecheck.mjs`) | `const p: Promise<User \| null> = db.user.findUnique(…)` compiles; `Promise.all([…])` compiles; `$transaction([a,b])` is `[User, Post]` not `unknown[]`; base client rejects an array at compile time (`@ts-expect-error`) | `tsc --noEmit` over the fixture |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. The change is confined to in-process TypeScript runtime types
and generated code; SQL construction is untouched (`*Impl` bodies move verbatim).

## Migration / Rollout

No data migration. The runtime contract is additive and backward-compatible by
assignability, but **generator and client must ship in the same release**: a client
regenerated against the new generator requires the new `@indigodb/client` (it imports
`runDeferred`), and a stale generated client passed to `$transaction([...])` hits the
`NOT_A_DEFERRED_OPERATION` guard with a "regenerate" message. `pnpm build`'s `^build`
ordering already enforces the build direction. Rollback is per slice; reverting
`promise.ts` + the delegate wrappers restores byte-identical eager `Promise` returns
because no `*Impl` body changes.

## PR / Commit Slicing

Review budget is 800 lines; the total lands near ~1000 authored lines given this
codebase's heavy doc-comment convention. The proposal's 3-slice split is **confirmed**,
with the boundary refined: `runDeferred` moves into slice 1 (it belongs with the contract
and its unit tests), which thins slice 3.

| Slice | Content | Est. add/del | Ships green? |
|---|---|---|---|
| **PR 1 — contract** | `promise.ts` (new, ~150 with doc comments), `types.ts` `DeferredResults` (~30), `index.ts` exports (~5), `test/deferred.mjs` (~180) | ~365 / 0 | Yes — purely additive, nothing consumes it yet |
| **PR 2 — delegate rewrap** | 4 `*Impl` extractions (~60 add), 13 wrappers (~55 add / ~55 del), doc comments (~40) | ~155 / ~55 | Yes — standalone behavior unchanged; existing suites must pass untouched, which is the proof |
| **PR 3 — wiring + tests** | `client.ts` guard (~25), `generator/src/client.ts` bundle + overloads (~50 add / ~15 del), `transactions.mjs` (~180), `transactions-pg.mjs` (~40), typecheck fixture (~40) | ~335 / ~15 | Yes — the feature lands here |

Each slice has a clear start/finish, autonomous verification (PR 2's verification is
literally "the existing suite is unchanged and green"), and independent revert.
Feature Branch Chain: PR 1 → tracker; PR 2 → PR 1; PR 3 → PR 2.

`400-line budget risk: Medium` per slice, `Low` after slicing; no single slice exceeds 400
authored changed lines.

## Open Questions

- [ ] `p instanceof Promise === false` is the one observable behavior change for user code.
      No occurrence exists in `packages/`, but it is a documentation item for the release note.
- [ ] `IndigoPromise` is not `Symbol.asyncIterator`-related and carries no cancellation;
      if a future `$queryRaw` deferred form (explicitly out of scope) needs a client-level
      (model-less) op, `runDeferred`'s `byModel[op.model]` lookup will need a `null`-model
      branch. Noted so the follow-up does not have to reopen this contract.
