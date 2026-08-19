/**
 * @indigodb/client — deferred operation contract (`client-transaction-array-form`
 * spec, Slice 1). Purely additive: covers `promise.ts` in isolation, with no
 * real `ModelDelegate`/database — fake `run` functions and a fake `byModel`
 * registry stand in for the delegate wiring `delegate.ts` gains in Slice 2.
 */

import {
  IndigoPromise,
  isIndigoPromise,
  defer,
  runDeferred,
  IndigoTransactionError,
} from "../dist/promise.js";

let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.stack || err.message).split("\n").slice(0, 30).join("\n"));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ─── Construction issues no execution ──────────────────────────────────────

await check("constructing a deferred op issues no execution", async () => {
  let calls = 0;
  defer("User", "create", {}, async () => {
    calls++;
    return { id: 1 };
  });
  assert(calls === 0, `expected 0 calls at construction, got ${calls}`);
});

// ─── Memoization: single execution across repeated awaits ──────────────────

await check("awaiting twice executes the underlying op exactly once", async () => {
  let calls = 0;
  const op = defer("User", "create", {}, async () => {
    calls++;
    return { id: 1 };
  });
  const a = await op;
  const b = await op;
  assert(calls === 1, `expected 1 execution, got ${calls}`);
  assert(a === b, "both awaits must resolve to the same memoized value");
});

// ─── OPERATION_REUSED ───────────────────────────────────────────────────────

await check("__claim throws OPERATION_REUSED when called a second time", async () => {
  const op = defer("User", "create", {}, async () => ({ id: 1 }));
  await op.__claim({});
  let threw = null;
  try {
    await op.__claim({});
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof IndigoTransactionError, "must throw IndigoTransactionError");
  assert(threw.code === "OPERATION_REUSED", `expected OPERATION_REUSED, got ${threw && threw.code}`);
});

await check("OPERATION_REUSED when __claim is called after a standalone await", async () => {
  const op = defer("User", "create", {}, async () => ({ id: 1 }));
  await op;
  let threw = null;
  try {
    await op.__claim({});
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof IndigoTransactionError, "must throw IndigoTransactionError");
  assert(threw.code === "OPERATION_REUSED", `expected OPERATION_REUSED, got ${threw && threw.code}`);
});

await check("runDeferred throws OPERATION_REUSED for the same op referenced twice", async () => {
  const op = defer("User", "create", {}, async () => ({ id: 1 }));
  const byModel = { User: {} };
  let threw = null;
  try {
    await runDeferred([op, op], byModel);
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof IndigoTransactionError, "must throw IndigoTransactionError");
  assert(threw.code === "OPERATION_REUSED", `expected OPERATION_REUSED, got ${threw && threw.code}`);
});

// ─── NOT_A_DEFERRED_OPERATION ───────────────────────────────────────────────

await check("runDeferred throws NOT_A_DEFERRED_OPERATION for a plain value", async () => {
  const op = defer("User", "create", {}, async () => ({ id: 1 }));
  const byModel = { User: {} };
  let threw = null;
  try {
    await runDeferred([op, 42], byModel);
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof IndigoTransactionError, "must throw IndigoTransactionError");
  assert(
    threw.code === "NOT_A_DEFERRED_OPERATION",
    `expected NOT_A_DEFERRED_OPERATION, got ${threw && threw.code}`,
  );
});

await check("runDeferred throws NOT_A_DEFERRED_OPERATION for a plain Promise", async () => {
  const op = defer("User", "create", {}, async () => ({ id: 1 }));
  const byModel = { User: {} };
  let threw = null;
  try {
    await runDeferred([op, Promise.resolve(1)], byModel);
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof IndigoTransactionError, "must throw IndigoTransactionError");
  assert(
    threw.code === "NOT_A_DEFERRED_OPERATION",
    `expected NOT_A_DEFERRED_OPERATION, got ${threw && threw.code}`,
  );
});

// ─── MODEL_NOT_IN_REGISTRY ───────────────────────────────────────────────────

await check("runDeferred throws MODEL_NOT_IN_REGISTRY when the model is missing", async () => {
  const op = defer("Ghost", "create", {}, async () => ({ id: 1 }));
  let threw = null;
  try {
    await runDeferred([op], {});
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof IndigoTransactionError, "must throw IndigoTransactionError");
  assert(
    threw.code === "MODEL_NOT_IN_REGISTRY",
    `expected MODEL_NOT_IN_REGISTRY, got ${threw && threw.code}`,
  );
});

// ─── Empty array short-circuits, no session/lookup work ────────────────────

await check("runDeferred([]) resolves to [] without touching byModel", async () => {
  let accessed = false;
  const byModel = new Proxy(
    {},
    {
      get() {
        accessed = true;
        return undefined;
      },
    },
  );
  const result = await runDeferred([], byModel);
  assert(Array.isArray(result) && result.length === 0, "expected an empty array");
  assert(accessed === false, "byModel must not be accessed for an empty array");
});

// ─── Base-client array-form guard (contract only; full wiring in Slice 3) ──

await check(
  "IndigoTransactionError carries the ARRAY_FORM_REQUIRES_GENERATED_CLIENT contract",
  async () => {
    function baseClientTransactionGuard(arg) {
      if (Array.isArray(arg)) {
        throw new IndigoTransactionError(
          "ARRAY_FORM_REQUIRES_GENERATED_CLIENT",
          "The array form of $transaction requires a generated IndigoDB client.",
        );
      }
    }
    let threw = null;
    try {
      baseClientTransactionGuard([]);
    } catch (err) {
      threw = err;
    }
    assert(threw instanceof IndigoTransactionError, "must throw IndigoTransactionError");
    assert(
      threw.code === "ARRAY_FORM_REQUIRES_GENERATED_CLIENT",
      `expected ARRAY_FORM_REQUIRES_GENERATED_CLIENT, got ${threw && threw.code}`,
    );
  },
);

// ─── Execution fires only when awaited, not at construction ───────────────

await check("run only fires when awaited, never at construction", async () => {
  const events = [];
  const op = defer("User", "create", {}, async () => {
    events.push("run");
    return { id: 1 };
  });
  events.push("constructed");
  assert(events.join(",") === "constructed", "run must not fire before await");
  await op;
  assert(events.join(",") === "constructed,run", "run must fire exactly once, only when awaited");
});

// ─── Brand check / structural Promise assignability ────────────────────────

await check("isIndigoPromise brand-checks correctly", async () => {
  const op = defer("User", "create", {}, async () => ({ id: 1 }));
  assert(isIndigoPromise(op) === true, "an IndigoPromise must brand-check true");
  assert(op instanceof IndigoPromise, "an IndigoPromise must be an instance of its own class");
  assert(isIndigoPromise(Promise.resolve(1)) === false, "a plain Promise must brand-check false");
  assert(isIndigoPromise(42) === false, "a plain value must brand-check false");
  assert(isIndigoPromise(null) === false, "null must brand-check false");
  assert(isIndigoPromise(undefined) === false, "undefined must brand-check false");
});

await check("then/catch/finally all delegate to the settled promise", async () => {
  const ok = defer("User", "create", {}, async () => 42);
  const thenResult = await new Promise((resolve, reject) => ok.then(resolve, reject));
  assert(thenResult === 42, "then() must resolve with the run() result");

  const failing = defer("User", "create", {}, async () => {
    throw new Error("boom");
  });
  let caught = null;
  await failing.catch((err) => {
    caught = err;
  });
  assert(caught instanceof Error && caught.message === "boom", "catch() must observe the rejection");

  let finallyRan = false;
  const succeeding = defer("User", "create", {}, async () => "value");
  const value = await succeeding.finally(() => {
    finallyRan = true;
  });
  assert(value === "value", "finally() must pass through the resolved value");
  assert(finallyRan === true, "finally() callback must run");
});

if (failures > 0) {
  console.error(`\n@indigodb/client deferred: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client deferred: all checks passed");
}
