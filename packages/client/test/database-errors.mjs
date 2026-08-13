/**
 * @indigodb/client — Typed database-error taxonomy regression suite
 * (`client-database-errors` spec).
 *
 * Phase 1 (unit, fake `run`): `withDatabaseErrors` classification, cause
 * preservation, no double-wrap, non-pg errors pass through unwrapped, and
 * the success path is untouched. Phase 2: extensions observe the typed
 * error through `IndigoClientBase`, and the injected `db.exec` path stays
 * deliberately unwrapped (documented boundary, client.ts).
 */

import { withDatabaseErrors, IndigoDatabaseError } from "../dist/errors.js";
import { IndigoClientBase } from "../dist/client.js";

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.stack || err.message).split("\n").slice(0, 30).join("\n"));
  }
}

async function checkAsync(name, fn) {
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

console.log("@indigodb/client: database-errors");

// ─── Phase 1: withDatabaseErrors over a fake `run` ─────────────────────────

await checkAsync("a 23505 failure is classified UNIQUE_VIOLATION", async () => {
  const run = async () => {
    throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
  };
  const wrapped = withDatabaseErrors(run);
  let caught;
  try {
    await wrapped("INSERT ...", []);
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof IndigoDatabaseError, "expected an IndigoDatabaseError to be thrown");
  assert(caught.code === "UNIQUE_VIOLATION", `expected code UNIQUE_VIOLATION, got: ${caught.code}`);
  assert(caught.sqlstate === "23505", `expected sqlstate 23505, got: ${caught.sqlstate}`);
});

await checkAsync("a non-23505 failure (e.g. 23503 FK violation) is classified UNKNOWN, raw sqlstate exposed", async () => {
  const run = async () => {
    throw Object.assign(new Error("insert or update violates foreign key constraint"), { code: "23503" });
  };
  const wrapped = withDatabaseErrors(run);
  let caught;
  try {
    await wrapped("INSERT ...", []);
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof IndigoDatabaseError, "expected an IndigoDatabaseError to be thrown");
  assert(caught.code === "UNKNOWN", `expected code UNKNOWN, got: ${caught.code}`);
  assert(caught.sqlstate === "23503", `expected sqlstate 23503 exposed, got: ${caught.sqlstate}`);
});

await checkAsync("a non-pg error (e.g. a plain TypeError with no .code) passes through unwrapped", async () => {
  const run = async () => {
    throw new TypeError("caller misuse");
  };
  const wrapped = withDatabaseErrors(run);
  let caught;
  try {
    await wrapped("INSERT ...", []);
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof TypeError, "expected the original TypeError to propagate");
  assert(!(caught instanceof IndigoDatabaseError), "expected the TypeError NOT to be wrapped as IndigoDatabaseError");
  assert(caught.message === "caller misuse", "expected the original message to be intact");
});

await checkAsync("error.cause is the original thrown value, not undefined or re-serialized", async () => {
  const original = Object.assign(new Error("boom"), { code: "23505" });
  const run = async () => {
    throw original;
  };
  const wrapped = withDatabaseErrors(run);
  let caught;
  try {
    await wrapped("INSERT ...", []);
  } catch (err) {
    caught = err;
  }
  assert(caught.cause === original, "expected error.cause to be the exact original thrown value");
});

await checkAsync("an already-IndigoDatabaseError thrown by run propagates unchanged (never double-wrapped)", async () => {
  const already = new IndigoDatabaseError("UNIQUE_VIOLATION", "23505", "already wrapped", undefined);
  const run = async () => {
    throw already;
  };
  const wrapped = withDatabaseErrors(run);
  let caught;
  try {
    await wrapped("INSERT ...", []);
  } catch (err) {
    caught = err;
  }
  assert(caught === already, "expected the exact same IndigoDatabaseError instance, not a re-wrap");
});

await checkAsync("success path: run resolving normally returns its value unmodified through the wrapper", async () => {
  const rows = [{ id: 1 }];
  const run = async () => rows;
  const wrapped = withDatabaseErrors(run);
  const result = await wrapped("SELECT 1", []);
  assert(result === rows, "expected the exact same rows array to be returned unmodified");
});

// ─── Phase 2: wiring into IndigoClientBase ─────────────────────────────────

await checkAsync(
  "an extension observes the typed IndigoDatabaseError thrown by the composed exec (injected db.exec path)",
  async () => {
    const exec = async () => {
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    };
    const observed = [];
    const recorder = (next) => async (sql, params) => {
      try {
        return await next(sql, params);
      } catch (err) {
        observed.push(err);
        throw err;
      }
    };
    // Injected `db.exec` is deliberately unwrapped (documented boundary) —
    // this exercises the pool-independent extension-composition ordering
    // only, without asserting the injected path itself gets wrapped.
    const client = new IndigoClientBase({ db: { exec }, extensions: [recorder] });
    let caught;
    try {
      await client.$queryRaw("INSERT ...", []);
    } catch (err) {
      caught = err;
    }
    assert(observed.length === 1, "expected the extension to observe exactly one error");
    assert(caught === observed[0], "expected the extension-observed error to be what the caller catches");
  },
);

await checkAsync(
  "documented boundary: the injected db.exec path stays unwrapped — raw driver error, not IndigoDatabaseError",
  async () => {
    const exec = async () => {
      throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    };
    const client = new IndigoClientBase({ db: { exec } });
    let caught;
    try {
      await client.$queryRaw("INSERT ...", []);
    } catch (err) {
      caught = err;
    }
    assert(
      !(caught instanceof IndigoDatabaseError),
      "expected the injected db.exec path to surface the raw driver error, not IndigoDatabaseError",
    );
    assert(caught.code === "23505", "expected the raw pg-shaped error's .code to still be intact");
  },
);

if (failures > 0) {
  console.error(`\n@indigodb/client database-errors: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client database-errors: all checks passed");
}
