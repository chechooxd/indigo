/**
 * @indigodb/generator — golden regression: `$transaction` emission.
 *
 * `generateClient` must stop initializing delegates as class-field
 * expressions and instead emit a reusable `__delegates(exec, realtime)`
 * factory, a `TransactionClient` interface built from that same shape, a
 * constructor that calls the factory once, and a generated `$transaction`
 * method on `IndigoClient` that hands the callback a `TransactionClient`
 * bound to a session-scoped executor (see design.md, Decision #3/#5).
 *
 * Slice 3 (`client-transaction-array-form`, design.md Decision 4/5) changes
 * `__delegates`'s return shape to `{ tx, byModel }` and adds a second
 * `$transaction` overload for the array form (`$transaction([...])`),
 * sharing `$withSession`/`__delegates` with the callback form.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { deepStrictEqual } from "node:assert";
import { parse, resolve } from "@indigodb/core";
import { generateClient } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "fixtures/transaction-emission.indigo"), "utf8");
const schema = resolve(parse(source));
const output = generateClient(schema);

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.message).split("\n").slice(0, 30).join("\n"));
  }
}

console.log("generator regression: transaction emission");

check("emits a __delegates(exec, realtime, runAtomic?) factory returning { tx, byModel }", () => {
  deepStrictEqual(
    output.includes(
      "function __delegates(\n" +
        "  exec: Executor,\n" +
        "  realtime: () => RealtimeConnectionManager,\n" +
        "  runAtomic?: RunAtomic,\n" +
        "): { tx: TransactionClient; byModel: Record<string, unknown> } {",
    ),
    true,
  );
  deepStrictEqual(output.includes("return { tx: client, byModel: reg };"), true);
});

// UPS-3 (client-unique-write-selector spec PR 2, design.md Testing Strategy):
// exactly one `WhereUniqueInput` type is emitted per model, and `upsert`,
// `update`, `delete` all reference the SAME literal type name — proven here
// by the type declaration appearing exactly once and the `UpsertArgs`
// instantiation naming it; `update`/`delete`'s reference is the shared 9th
// `ModelDelegate` generic already asserted below (they take no separately
// emitted arg-interface name).
check("UPS-3: exactly one UserWhereUniqueInput type is emitted, and UserUpsertArgs references it", () => {
  const declarationCount = output.split("export type UserWhereUniqueInput = ").length - 1;
  deepStrictEqual(declarationCount, 1, `expected exactly one declaration, found ${declarationCount}`);
  deepStrictEqual(
    output.includes("export type UserUpsertArgs = UpsertArgs<UserCreateInput, UserUpdateInput, UserWhereUniqueInput>;"),
    true,
  );
});

check("__delegates builds the plain model's ModelDelegate", () => {
  deepStrictEqual(
    output.includes(
      "new ModelDelegate<User, UserCreateInput, UserUpdateInput, UserRelations, UserWhereInput, UserCreateManyInput, UserCursorInput, UserNumericFields, UserWhereUniqueInput>(",
    ),
    true,
  );
});

check("__delegates builds the @@realtime model's RealtimeModelDelegate", () => {
  deepStrictEqual(
    output.includes(
      "new RealtimeModelDelegate<Message, MessageCreateInput, MessageUpdateInput, MessageRelations, MessageWhereInput, MessageCreateManyInput, MessageCursorInput, MessageNumericFields, MessageWhereUniqueInput>(",
    ),
    true,
  );
});

check("emits a TransactionClient interface", () => {
  deepStrictEqual(output.includes("export interface TransactionClient {"), true);
});

check("TransactionClient exposes one readonly delegate field per model", () => {
  const start = output.indexOf("export interface TransactionClient {");
  const end = output.indexOf("}", start);
  const block = output.slice(start, end + 1);
  deepStrictEqual(
    block.includes(
      "readonly user: ModelDelegate<User, UserCreateInput, UserUpdateInput, UserRelations, UserWhereInput, UserCreateManyInput, UserCursorInput, UserNumericFields, UserWhereUniqueInput>;",
    ),
    true,
  );
  deepStrictEqual(
    block.includes(
      "readonly message: RealtimeModelDelegate<Message, MessageCreateInput, MessageUpdateInput, MessageRelations, MessageWhereInput, MessageCreateManyInput, MessageCursorInput, MessageNumericFields, MessageWhereUniqueInput>;",
    ),
    true,
  );
});

check("TransactionClient exposes $queryRaw", () => {
  const start = output.indexOf("export interface TransactionClient {");
  const end = output.indexOf("}", start);
  const block = output.slice(start, end + 1);
  deepStrictEqual(block.includes("$queryRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;"), true);
});

check("TransactionClient never exposes $transaction", () => {
  const start = output.indexOf("export interface TransactionClient {");
  const end = output.indexOf("}", start);
  const block = output.slice(start, end + 1);
  deepStrictEqual(block.includes("$transaction"), false);
});

check("IndigoClient declares readonly delegate fields without initializers", () => {
  deepStrictEqual(
    output.includes(
      "readonly user: ModelDelegate<User, UserCreateInput, UserUpdateInput, UserRelations, UserWhereInput, UserCreateManyInput, UserCursorInput, UserNumericFields, UserWhereUniqueInput>;",
    ),
    true,
  );
  deepStrictEqual(
    output.includes(
      "readonly message: RealtimeModelDelegate<Message, MessageCreateInput, MessageUpdateInput, MessageRelations, MessageWhereInput, MessageCreateManyInput, MessageCursorInput, MessageNumericFields, MessageWhereUniqueInput>;",
    ),
    true,
  );
});

check(
  "generated constructor calls __delegates(this.exec, this.$realtime, runAtomic) once, destructures d.tx, and assigns fields",
  () => {
    const ctorStart = output.indexOf("constructor(options?: IndigoClientOptions) {");
    deepStrictEqual(ctorStart >= 0, true);
    const ctorEnd = output.indexOf("\n  }", ctorStart);
    const ctorBlock = output.slice(ctorStart, ctorEnd);
    deepStrictEqual(
      ctorBlock.includes(
        "__delegates(this.exec, this.$realtime, (fn) => this.$transaction(fn as never))",
      ),
      true,
    );
    deepStrictEqual(ctorBlock.includes("this.user = d.tx.user;"), true);
    deepStrictEqual(ctorBlock.includes("this.message = d.tx.message;"), true);
    // exactly one factory call in the constructor
    const matches = ctorBlock.match(/__delegates\(/g) ?? [];
    deepStrictEqual(matches.length, 1);
  },
);

check("emits the callback-form $transaction overload signature", () => {
  deepStrictEqual(
    output.includes(
      "$transaction<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T>;",
    ),
    true,
  );
});

check("emits the array-form $transaction overload signature", () => {
  deepStrictEqual(
    output.includes(
      "$transaction<const Ops extends readonly IndigoPromise<unknown>[]>(ops: Ops): Promise<DeferredResults<Ops>>;",
    ),
    true,
  );
});

check("array-form implementation validates every element, short-circuits empty, and calls runDeferred via __delegates(...).byModel", () => {
  deepStrictEqual(output.includes("if (Array.isArray(fnOrOps)) {"), true);
  deepStrictEqual(output.includes("if (!isIndigoPromise(op)) {"), true);
  deepStrictEqual(output.includes('new IndigoTransactionError(\n            "NOT_A_DEFERRED_OPERATION",'), true);
  deepStrictEqual(output.includes("if (fnOrOps.length === 0) {"), true);
  deepStrictEqual(output.includes("return Promise.resolve([]);"), true);
  deepStrictEqual(
    output.includes(
      "return this.$withSession((exec) => runDeferred(fnOrOps, __delegates(exec, this.$realtime).byModel));",
    ),
    true,
  );
});

check("callback-form implementation still delegates to $withSession and __delegates(...).tx", () => {
  deepStrictEqual(
    output.includes("return this.$withSession((exec) => fnOrOps(__delegates(exec, this.$realtime).tx));"),
    true,
  );
});

check("imports the runtime deferred-operation contract (isIndigoPromise, runDeferred, IndigoTransactionError)", () => {
  deepStrictEqual(output.includes("isIndigoPromise"), true);
  deepStrictEqual(output.includes("runDeferred"), true);
  deepStrictEqual(output.includes("IndigoTransactionError"), true);
  deepStrictEqual(output.includes("IndigoPromise,"), true);
  deepStrictEqual(output.includes("DeferredResults,"), true);
});

if (failures > 0) {
  console.error(`\ngenerator regression: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ngenerator regression: all green");
