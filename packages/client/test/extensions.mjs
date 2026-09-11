/**
 * @indigodb/client — Query extension seam regression suite
 * (`client-query-extensions` / `client-executor-injection` specs).
 *
 * Plain Node, no test framework, mirroring `client.mjs`/`atomicity.mjs`'s
 * style. Covers: composition order, `wrapLog` placement, zero-overhead when
 * absent, sql/params mutation, short-circuit, error propagation, per-query
 * `QueryContext` on delegate methods, concurrency (no context bleed), and
 * coverage across the pool, injected-executor, and `$transaction` paths.
 */

import { IndigoClientBase } from "../dist/client.js";
import { ModelDelegate } from "../dist/delegate.js";
import { currentQueryContext } from "../dist/context.js";
import { withDatabase, createPgliteExecutor, createPgliteDb } from "./pglite-harness.mjs";
import { withRealPostgres } from "./pglite-socket-harness.mjs";

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

function stubExecutor(rows = []) {
  const calls = [];
  const exec = async (sql, params) => {
    calls.push({ sql, params });
    return rows;
  };
  return { exec, calls };
}

const postMeta = {
  name: "Post",
  table: "Post",
  fields: {
    id: { db: "id", pk: true },
    title: { db: "title" },
  },
};

// ─── Phase 1: Foundation — types and context ──────────────────────────────

await check(
  "QueryExtension is a plain function taking/returning an Executor (runtime shape check)",
  async () => {
    /** @type {import("../dist/types.js").QueryExtension} */
    const ext = (next) => async (sql, params) => next(sql, params);
    assert(typeof ext === "function", "expected a QueryExtension to be a plain function");
    const { exec } = stubExecutor([{ ok: true }]);
    const wrapped = ext(exec);
    assert(typeof wrapped === "function", "expected calling a QueryExtension with `next` to return an Executor");
    const rows = await wrapped("SELECT 1", []);
    assert(rows[0].ok === true, "expected the composed executor to still forward to `next`");
  },
);

await check("currentQueryContext() returns undefined outside any withQueryContext run", () => {
  assert(currentQueryContext() === undefined, "expected no ambient QueryContext outside a delegate call");
});

// ─── Phase 2: Core — composition order, wrapLog placement, zero overhead ──

await check("extensions run in declared order: a observes call before b, and result after b", async () => {
  const events = [];
  const a = (next) => async (sql, params) => {
    events.push("a:call");
    const rows = await next(sql, params);
    events.push("a:result");
    return rows;
  };
  const b = (next) => async (sql, params) => {
    events.push("b:call");
    const rows = await next(sql, params);
    events.push("b:result");
    return rows;
  };
  const { exec } = stubExecutor([{ id: 1 }]);
  const client = new IndigoClientBase({ db: { exec }, extensions: [a, b] });
  await client.$queryRaw("SELECT 1", []);
  assert(
    events.join(",") === "a:call,b:call,b:result,a:result",
    `expected a to wrap b (a outermost); got: ${events.join(",")}`,
  );
});

await check("wrapLog logs the SQL each extension actually forwards, not the original caller SQL", async () => {
  const rewriter = (next) => async (sql, params) => next(sql + " -- rewritten", params);
  const logged = [];
  const originalLog = console.log;
  console.log = (...args) => logged.push(args);
  try {
    const { exec } = stubExecutor([]);
    const client = new IndigoClientBase({ db: { exec }, extensions: [rewriter], log: true });
    await client.$queryRaw("SELECT 1", []);
  } finally {
    console.log = originalLog;
  }
  const loggedSql = logged.find((args) => args[0] === "[indigodb]")?.[1];
  assert(
    loggedSql === "SELECT 1 -- rewritten",
    `expected the logged SQL to include the extension's rewrite, got: ${loggedSql}`,
  );
});

await check("absent extensions: behavior is unchanged, no composition overhead", async () => {
  const rows = [{ id: 1 }];
  const { exec, calls } = stubExecutor(rows);
  const client = new IndigoClientBase({ db: { exec } });
  const result = await client.$queryRaw("SELECT 1", []);
  assert(result === rows, "expected $queryRaw to return the exact injected rows, unmodified");
  assert(calls.length === 1, "expected exactly one call to the base executor");
});

await check("empty extensions array: behavior is unchanged", async () => {
  const rows = [{ id: 1 }];
  const { exec } = stubExecutor(rows);
  const client = new IndigoClientBase({ db: { exec }, extensions: [] });
  const result = await client.$queryRaw("SELECT 1", []);
  assert(result === rows, "expected $queryRaw to return the exact injected rows with an empty extensions array");
});

// ─── Phase 3: Integration — per-query context on delegate methods ─────────

await check('db.<model>.findMany(...) extension observes { model: "post", operation: "findMany" }', async () => {
  await withDatabase(async (db) => {
    await db.exec(`CREATE TABLE "Post" (id SERIAL PRIMARY KEY, title TEXT NOT NULL);`);
    const observed = [];
    const contextObserver = (next) => async (sql, params) => {
      observed.push(currentQueryContext());
      return next(sql, params);
    };
    const client = new IndigoClientBase({
      db: { exec: createPgliteExecutor(db) },
      extensions: [contextObserver],
    });
    const posts = new ModelDelegate(postMeta, client.exec);
    await posts.findMany({});
    assert(observed.length === 1, "expected exactly one observed query");
    assert(
      observed[0]?.model === "Post" && observed[0]?.operation === "findMany",
      `expected { model: "Post", operation: "findMany" }, got: ${JSON.stringify(observed[0])}`,
    );
  });
});

await check("$queryRaw extension observes undefined context", async () => {
  const observed = [];
  const contextObserver = (next) => async (sql, params) => {
    observed.push(currentQueryContext());
    return next(sql, params);
  };
  const { exec } = stubExecutor([]);
  const client = new IndigoClientBase({ db: { exec }, extensions: [contextObserver] });
  await client.$queryRaw("SELECT 1", []);
  assert(observed.length === 1 && observed[0] === undefined, "expected $queryRaw to carry no ambient QueryContext");
});

await check(
  "concurrent delegate queries for different models each observe only their own context, no bleed",
  async () => {
    await withDatabase(async (db) => {
      await db.exec(`
        CREATE TABLE "Post" (id SERIAL PRIMARY KEY, title TEXT NOT NULL);
        CREATE TABLE "User" (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
      `);
      const userMeta = { name: "User", table: "User", fields: { id: { db: "id", pk: true }, name: { db: "name" } } };

      const observed = [];
      const contextObserver = (next) => async (sql, params) => {
        // Yield to the event loop so the two concurrent calls below actually
        // interleave instead of running sequentially to completion.
        await new Promise((resolve) => setTimeout(resolve, 0));
        observed.push({ sql, ctx: currentQueryContext() });
        return next(sql, params);
      };
      const client = new IndigoClientBase({
        db: { exec: createPgliteExecutor(db) },
        extensions: [contextObserver],
      });
      const posts = new ModelDelegate(postMeta, client.exec);
      const users = new ModelDelegate(userMeta, client.exec);

      await Promise.all([posts.findMany({}), users.create({ data: { name: "Ada" } })]);

      const postObservation = observed.find((o) => o.sql.includes('"Post"'));
      const userObservation = observed.find((o) => o.sql.includes('"User"'));
      assert(postObservation?.ctx?.model === "Post", "expected the Post query to observe its own model context");
      assert(
        postObservation?.ctx?.operation === "findMany",
        "expected the Post query to observe its own operation context",
      );
      assert(userObservation?.ctx?.model === "User", "expected the User query to observe its own model context");
      assert(
        userObservation?.ctx?.operation === "create",
        "expected the User query to observe its own operation context",
      );
    });
  },
);

// ─── Phase 4: Extension semantics — mutation, short-circuit, errors ───────

await check("an extension that rewrites sql/params before calling next reaches the base executor", async () => {
  const rewriter = (next) => async (sql, params) => next("SELECT 2", [...params, "extra"]);
  const { exec, calls } = stubExecutor([]);
  const client = new IndigoClientBase({ db: { exec }, extensions: [rewriter] });
  await client.$queryRaw("SELECT 1", ["orig"]);
  assert(calls.length === 1, "expected exactly one base executor call");
  assert(calls[0].sql === "SELECT 2", `expected the rewritten sql to reach the base, got: ${calls[0].sql}`);
  assert(
    calls[0].params.join(",") === "orig,extra",
    `expected the rewritten params to reach the base, got: ${calls[0].params.join(",")}`,
  );
});

await check(
  "an extension that returns rows without calling next short-circuits: base and inner extensions never invoked",
  async () => {
    const cachedRows = [{ cached: true }];
    let innerCalled = false;
    const inner = (next) => async (sql, params) => {
      innerCalled = true;
      return next(sql, params);
    };
    const cache = (_next) => async () => cachedRows;
    const { exec, calls } = stubExecutor([{ cached: false }]);
    const client = new IndigoClientBase({ db: { exec }, extensions: [cache, inner] });
    const result = await client.$queryRaw("SELECT 1", []);
    assert(result === cachedRows, "expected the caller to receive the short-circuiting extension's own rows");
    assert(innerCalled === false, "expected the inner extension to never be invoked");
    assert(calls.length === 0, "expected the base executor to never be invoked");
  },
);

await check("a synchronously throwing extension fails the query with the unwrapped original error", async () => {
  const boom = (_next) => async () => {
    throw new Error("sync-boom");
  };
  const { exec } = stubExecutor([]);
  const client = new IndigoClientBase({ db: { exec }, extensions: [boom] });
  let caught;
  try {
    await client.$queryRaw("SELECT 1", []);
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof Error && caught.message === "sync-boom", "expected the exact thrown error to propagate");
});

await check("an extension that returns a rejected promise fails the query with the unwrapped rejection", async () => {
  const boom = (_next) => () => Promise.reject(new Error("rejected-boom"));
  const { exec } = stubExecutor([]);
  const client = new IndigoClientBase({ db: { exec }, extensions: [boom] });
  let caught;
  try {
    await client.$queryRaw("SELECT 1", []);
  } catch (err) {
    caught = err;
  }
  assert(
    caught instanceof Error && caught.message === "rejected-boom",
    "expected the exact rejection reason to propagate",
  );
});

await check(
  "outer.call to next rejects with inner's error and propagates unless outer substitutes a result",
  async () => {
    const events = [];
    const outer = (next) => async (sql, params) => {
      events.push("outer:call");
      try {
        return await next(sql, params);
      } catch (err) {
        events.push(`outer:caught:${err.message}`);
        throw err;
      }
    };
    const inner = (_next) => async () => {
      events.push("inner:throw");
      throw new Error("inner-boom");
    };
    const { exec } = stubExecutor([]);
    const client = new IndigoClientBase({ db: { exec }, extensions: [outer, inner] });
    let caught;
    try {
      await client.$queryRaw("SELECT 1", []);
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof Error && caught.message === "inner-boom", "expected inner's error to propagate to the caller");
    assert(
      events.join(",") === "outer:call,inner:throw,outer:caught:inner-boom",
      `expected outer to observe the inner rejection via its own next() call, got: ${events.join(",")}`,
    );
  },
);

// ─── Phase 5: Coverage — pool, injected executor, transactions ────────────

await check("extension wraps the default pg.Pool-backed executor", async () => {
  await withRealPostgres(async ({ connectionString }) => {
    const observed = [];
    const observer = (next) => async (sql, params) => {
      observed.push(sql);
      return next(sql, params);
    };
    const client = new IndigoClientBase({ connectionString, extensions: [observer] });
    try {
      await client.$queryRaw("SELECT 1 AS x");
      assert(observed.length === 1, "expected the extension to observe the pg.Pool-backed query");
    } finally {
      await client.$disconnect();
    }
  });
});

await check(
  "extension wraps an injected (PGlite) executor identically to the pool path",
  async () => {
    await withDatabase(async (db) => {
      const observed = [];
      const observer = (next) => async (sql, params) => {
        observed.push(sql);
        return next(sql, params);
      };
      const client = new IndigoClientBase({ db: { exec: createPgliteExecutor(db) }, extensions: [observer] });
      await client.$queryRaw("SELECT 1 AS x");
      assert(observed.length === 1, "expected the extension to observe the injected-executor query");
    });
  },
);

await check(
  "extension observes each query issued inside $transaction (injected db.transaction path), same order as non-tx path",
  async () => {
    await withDatabase(async (db) => {
      await db.exec(`CREATE TABLE "Post" (id SERIAL PRIMARY KEY, title TEXT NOT NULL);`);
      const events = [];
      const a = (next) => async (sql, params) => {
        events.push("a:call");
        const rows = await next(sql, params);
        events.push("a:result");
        return rows;
      };
      const { exec, transaction } = createPgliteDb(db);
      const client = new IndigoClientBase({ db: { exec, transaction }, extensions: [a] });

      await client.$transaction(async (tx) => {
        const posts = new ModelDelegate(postMeta, tx);
        await posts.create({ data: { title: "InsideTx" } });
      });

      assert(
        events.join(",") === "a:call,a:result",
        `expected the extension to observe the query inside $transaction, got: ${events.join(",")}`,
      );
    });
  },
);

await check(
  "extension observes each query issued inside $transaction (pg.Pool BEGIN/COMMIT path)",
  async () => {
    await withRealPostgres(async ({ connectionString }) => {
      const events = [];
      const a = (next) => async (sql, params) => {
        events.push(sql);
        return next(sql, params);
      };
      const client = new IndigoClientBase({ connectionString, extensions: [a] });
      try {
        await client.$queryRaw('CREATE TABLE "Post" (id SERIAL PRIMARY KEY, title TEXT NOT NULL)');
        events.length = 0; // only care about statements issued inside $transaction below

        await client.$transaction(async (tx) => {
          await tx('INSERT INTO "Post" (title) VALUES ($1)', ["InsideTx"]);
        });

        assert(
          events.some((sql) => sql.includes("INSERT INTO")),
          "expected the extension to observe the INSERT issued inside $transaction",
        );
        assert(
          !events.some((sql) => sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK"),
          "expected BEGIN/COMMIT/ROLLBACK to remain outside the extension seam (documented boundary)",
        );
      } finally {
        await client.$disconnect();
      }
    });
  },
);

await check(
  "documented boundary: pg.Pool BEGIN/COMMIT/ROLLBACK are issued directly on the raw client, never observed by extensions",
  async () => {
    await withRealPostgres(async ({ connectionString }) => {
      const observedSql = [];
      const observer = (next) => async (sql, params) => {
        observedSql.push(sql);
        return next(sql, params);
      };
      const client = new IndigoClientBase({ connectionString, extensions: [observer] });
      try {
        await client.$queryRaw('CREATE TABLE "Post" (id SERIAL PRIMARY KEY, title TEXT NOT NULL)');
        observedSql.length = 0;
        await client.$transaction(async (tx) => {
          await tx('INSERT INTO "Post" (title) VALUES ($1)', ["Boundary"]);
        });
        assert(
          observedSql.every((sql) => sql !== "BEGIN" && sql !== "COMMIT" && sql !== "ROLLBACK"),
          `expected no control statement to reach the extension seam, observed: ${observedSql.join(" | ")}`,
        );
      } finally {
        await client.$disconnect();
      }
    });
  },
);

await check(
  "demonstration: a timing/slow-query extension observes duration end-to-end across pool + delegate paths without forking the client",
  async () => {
    await withDatabase(async (db) => {
      await db.exec(`CREATE TABLE "Post" (id SERIAL PRIMARY KEY, title TEXT NOT NULL);`);
      const timings = [];
      const timing = (next) => async (sql, params) => {
        const start = Date.now();
        try {
          return await next(sql, params);
        } finally {
          timings.push({ sql, ms: Date.now() - start, ctx: currentQueryContext() });
        }
      };
      const client = new IndigoClientBase({ db: { exec: createPgliteExecutor(db) }, extensions: [timing] });
      const posts = new ModelDelegate(postMeta, client.exec);
      await posts.create({ data: { title: "Timed" } });
      await posts.findMany({});

      assert(timings.length === 2, `expected two timed queries, got ${timings.length}`);
      for (const t of timings) {
        assert(typeof t.ms === "number" && t.ms >= 0, "expected a non-negative duration for every query");
      }
      assert(
        timings[0].ctx?.operation === "create" && timings[1].ctx?.operation === "findMany",
        "expected the timing extension to also see per-query context alongside duration",
      );
    });
  },
);

// ─── Phase 4: wrapLog redaction (client-log-redaction) ────────────────────
//
// Additive to the `wrapLog` case at :98-115, never a replacement — that case
// stays evidence for the SQL-rewrite requirement with its own empty-params
// fixture. Every case here uses a NON-EMPTY params array carrying the
// sentinel below, so the assertion actually exercises the redaction branch
// (design.md's `C1.3a` defect class: a regression test whose fixture never
// reaches the branch it is named for).

const LOG_REDACTION_SENTINEL = "hunter2-SENTINEL";

await check(
  "bound parameter values never appear in captured stdout (log: true, no extensions)",
  async () => {
    const { exec } = stubExecutor([]);
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => logged.push(args);
    try {
      const client = new IndigoClientBase({ db: { exec }, log: true });
      await client.$queryRaw("SELECT 1", [LOG_REDACTION_SENTINEL]);
    } finally {
      console.log = originalLog;
    }
    const leaked = logged.some((args) => JSON.stringify(args).includes(LOG_REDACTION_SENTINEL));
    assert(
      !leaked,
      `expected the sentinel to be absent from stdout; found it in: ${JSON.stringify(logged)}`,
    );
    const line = logged.find((args) => args[0] === "[indigodb]");
    assert(line !== undefined, "expected a captured [indigodb] log line");
    assert(line[1] === "SELECT 1", `expected args[1] to be the SQL, got: ${line[1]}`);
    assert(
      line[2] === "$1=<redacted>",
      `expected args[2] to be the redacted positional placeholder, got: ${line[2]}`,
    );
  },
);

await check("log: false and log omitted never emit an [indigodb] line", async () => {
  const logged = [];
  const originalLog = console.log;
  console.log = (...args) => logged.push(args);
  try {
    const { exec: execFalse } = stubExecutor([]);
    const clientFalse = new IndigoClientBase({ db: { exec: execFalse }, log: false });
    await clientFalse.$queryRaw("SELECT 1", [LOG_REDACTION_SENTINEL]);

    const { exec: execOmitted } = stubExecutor([]);
    const clientOmitted = new IndigoClientBase({ db: { exec: execOmitted } });
    await clientOmitted.$queryRaw("SELECT 1", [LOG_REDACTION_SENTINEL]);
  } finally {
    console.log = originalLog;
  }
  const indigoLines = logged.filter((args) => args[0] === "[indigodb]");
  assert(
    indigoLines.length === 0,
    `expected zero [indigodb] log lines with log disabled/omitted; got: ${JSON.stringify(indigoLines)}`,
  );
});

await check(
  "redaction holds when an extension rewrites sql (non-empty sentinel params passed through)",
  async () => {
    const rewriter = (next) => async (sql, params) => next("SELECT 1 -- rewritten", params);
    const { exec } = stubExecutor([]);
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => logged.push(args);
    try {
      const client = new IndigoClientBase({ db: { exec }, extensions: [rewriter], log: true });
      await client.$queryRaw("SELECT 1", [LOG_REDACTION_SENTINEL]);
    } finally {
      console.log = originalLog;
    }
    const leaked = logged.some((args) => JSON.stringify(args).includes(LOG_REDACTION_SENTINEL));
    assert(
      !leaked,
      `expected the sentinel to be absent from stdout; found it in: ${JSON.stringify(logged)}`,
    );
    const line = logged.find((args) => args[0] === "[indigodb]");
    assert(
      line?.[1] === "SELECT 1 -- rewritten",
      `expected the logged SQL to be the post-extension rewrite, got: ${line?.[1]}`,
    );
  },
);

await check("empty params print the (0 params) constant; arity/shape still 3 args", async () => {
  const { exec } = stubExecutor([]);
  const logged = [];
  const originalLog = console.log;
  console.log = (...args) => logged.push(args);
  try {
    const client = new IndigoClientBase({ db: { exec }, log: true });
    await client.$queryRaw("SELECT 1", []);
  } finally {
    console.log = originalLog;
  }
  const line = logged.find((args) => args[0] === "[indigodb]");
  assert(line !== undefined, "expected a captured [indigodb] log line");
  assert(line.length === 3, `expected exactly 3 captured args, got: ${line.length}`);
  assert(line[2] === "(0 params)", `expected args[2] to be the empty-params constant, got: ${line[2]}`);
});

await check("redaction holds inside $transaction/$withSession", async () => {
  const { exec } = stubExecutor([]);
  const db = {
    exec,
    transaction: async (fn) => fn(exec),
  };
  const logged = [];
  const originalLog = console.log;
  console.log = (...args) => logged.push(args);
  try {
    const client = new IndigoClientBase({ db, log: true });
    await client.$transaction(async (txExec) => txExec("SELECT 1", [LOG_REDACTION_SENTINEL]));
  } finally {
    console.log = originalLog;
  }
  const leaked = logged.some((args) => JSON.stringify(args).includes(LOG_REDACTION_SENTINEL));
  assert(
    !leaked,
    `expected the sentinel to be absent from stdout inside $transaction; found it in: ${JSON.stringify(logged)}`,
  );
  const line = logged.find((args) => args[0] === "[indigodb]");
  assert(line !== undefined, "expected a captured [indigodb] log line inside $transaction");
  assert(
    line[2] === "$1=<redacted>",
    `expected args[2] to be the redacted placeholder inside $transaction, got: ${line[2]}`,
  );
});

await check(
  "redacted placeholders render identically regardless of parameter shape",
  async () => {
    const { exec } = stubExecutor([]);
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => logged.push(args);
    try {
      const client = new IndigoClientBase({ db: { exec }, log: true });
      await client.$queryRaw("SELECT 1", [new Date(), null, ["a", "b"], Buffer.from("x")]);
    } finally {
      console.log = originalLog;
    }
    const line = logged.find((args) => args[0] === "[indigodb]");
    assert(line !== undefined, "expected a captured [indigodb] log line");
    assert(
      line[2] === "$1=<redacted>, $2=<redacted>, $3=<redacted>, $4=<redacted>",
      `expected uniform redacted placeholders regardless of parameter shape, got: ${line[2]}`,
    );
    assert(!line[2].includes("[object Object]"), "expected no shape-specific object formatting to leak through");
  },
);

await check(
  "redaction is display-only: the base executor still receives real parameter values",
  async () => {
    const { exec, calls } = stubExecutor([]);
    const originalLog = console.log;
    console.log = () => {};
    try {
      const client = new IndigoClientBase({ db: { exec }, log: true });
      await client.$queryRaw("SELECT 1", [LOG_REDACTION_SENTINEL]);
    } finally {
      console.log = originalLog;
    }
    assert(calls.length === 1, "expected exactly one call to the base executor");
    assert(
      calls[0].params[0] === LOG_REDACTION_SENTINEL,
      `expected the base executor to receive the real, unredacted value; got: ${calls[0].params[0]}`,
    );
  },
);

if (failures > 0) {
  console.error(`\n@indigodb/client extensions: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n@indigodb/client extensions: all checks passed");
}
