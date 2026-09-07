/**
 * Unit suite (no DB) for `RealtimeEngine`'s D7 origin allowlist
 * (`realtime-origin-allowlist` spec, design.md D7, tasks 1.1-1.6, 1.10).
 *
 * Drives `handleRequest` (SSE) and `handleLogRequest` (`GET ?handle&offset`)
 * through a REAL ephemeral `node:http` server + `fetch()` — genuine
 * `IncomingMessage`/`ServerResponse` objects over an actual socket, so the
 * `Origin` request header and the response's CORS headers behave exactly as
 * a real browser would observe them (matches `endpoint.mjs`'s convention).
 *
 * Default-CLOSED (D7, binding): an unconfigured or non-matching `Origin`
 * gets `403`, never a reflected `access-control-allow-origin`. A request
 * with NO `Origin` header at all is always allowed — this is the
 * compatibility guarantee that keeps the `indigodb realtime` CLI daemon,
 * curl, an operator proxy, and the Studio's own same-origin embedded engine
 * working unchanged under a closed default. Matching is EXACT string
 * equality — no `startsWith`/`endsWith`/`includes` — proven by the
 * prefix/suffix threat-matrix negative case below.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { createServer } from "node:http";
import { RealtimeEngine, REALTIME_PATH, REALTIME_LOG_PATH, mintHandle } from "../dist/index.js";
import { testSchema } from "./fixtures-schema.mjs";

let passed = 0;
let ran = 0;
async function check(name, fn) {
  ran++;
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log("realtime engine: D7 origin allowlist (unit, no DB)");

const SECRET = "origin-allowlist-test-secret";

/** Captures the engine's `onEvent` callback without touching a real DB. */
function fakeSource() {
  let onEvent = null;
  return {
    source: {
      async start(cb) {
        onEvent = cb;
      },
      async stop() {},
    },
    emit(event) {
      ok(onEvent, "engine must call source.start() before emitting");
      onEvent(event);
    },
  };
}

/** In-memory fake `RealtimeLogDb` returning `rows` for every query. */
function fakeLogDb(rows = []) {
  return {
    async readOnly(fn) {
      const query = async (sql) => {
        if (/set_config/i.test(sql)) return { rows: [] };
        return { rows };
      };
      return fn(query);
    },
  };
}

function makeEngine(extra = {}) {
  const { source, emit } = fakeSource();
  const engine = new RealtimeEngine({
    connectionString: "postgres://unused/unused",
    schema: testSchema(),
    source,
    ...extra,
  });
  return { engine, emit };
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    // A still-open SSE connection (RED-phase behavior: unimplemented gating
    // would leave a 200 stream running instead of a short 403/204) must not
    // hang server.close() waiting for it to finish on its own.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * Reads a response body to completion within a bounded window. A response
 * that is unexpectedly still an open SSE stream (e.g. RED-phase: gating not
 * implemented yet, so a request that should have been rejected short
 * instead kept streaming) fails loudly with a clear message instead of
 * hanging the whole suite forever.
 */
async function readAllWithTimeout(response, ms = 2000) {
  if (!response.body) return await response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`response body did not end within ${ms}ms — likely an unexpectedly still-open stream`)),
      ms,
    );
  });
  const readAll = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  })();
  try {
    return await Promise.race([readAll, timeout]);
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
}

/**
 * Issues one request against `path`, reading at most one SSE chunk (the
 * `ready`/`wake` frame) before aborting the connection — never waits for
 * the stream to end. Non-streaming responses (403/204) are read to
 * completion via `.text()`.
 */
async function sseExchange(baseUrl, path, { method = "GET", headers = {} } = {}) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}${path}`, { method, headers, signal: controller.signal });
  const status = response.status;
  const responseHeaders = {};
  for (const [k, v] of response.headers.entries()) responseHeaders[k] = v;
  let firstChunk = "";
  let reader = null;
  if (response.status === 200 && response.body) {
    reader = response.body.getReader();
    const { value } = await reader.read();
    firstChunk = value ? Buffer.from(value).toString("utf8") : "";
  } else {
    await readAllWithTimeout(response).catch(() => {});
  }
  return {
    status,
    headers: responseHeaders,
    body: firstChunk,
    async readNext() {
      if (!reader) throw new Error("no readable stream on this response");
      const { value } = await reader.read();
      return value ? Buffer.from(value).toString("utf8") : "";
    },
    close() {
      controller.abort();
      if (reader) reader.cancel().catch(() => {});
    },
  };
}

/** Plain, bounded-read request (for `handleLogRequest`, and for expected
 * short 403/204 responses off `handleRequest`). */
async function exchange(baseUrl, path, { method = "GET", headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers });
  const bodyText = await readAllWithTimeout(response);
  const responseHeaders = {};
  for (const [k, v] of response.headers.entries()) responseHeaders[k] = v;
  return { status: response.status, headers: responseHeaders, body: bodyText };
}

// ── 1.1 — unconfigured engine + any Origin ⇒ 403, no CORS header ──────────

await check(
  "1.1: unconfigured allowlist + an Origin header present ⇒ 403, no access-control-allow-origin, never wildcard",
  async () => {
    const { engine } = makeEngine();
    await withServer(
      (req, res) => engine.handleRequest(req, res),
      async (baseUrl) => {
        const result = await exchange(baseUrl, REALTIME_PATH, { headers: { Origin: "https://app.example.com" } });
        strictEqual(result.status, 403, "unconfigured allowlist must reject any Origin with 403");
        ok(
          result.headers["access-control-allow-origin"] === undefined,
          `must not set access-control-allow-origin at all, got: ${result.headers["access-control-allow-origin"]}`,
        );
      },
    );
  },
);

// ── 1.2 — no Origin header at all ⇒ served normally, regardless of config ─

await check(
  "1.2: a request with NO Origin header is served 200 text/event-stream, even with the allowlist unconfigured",
  async () => {
    const { engine } = makeEngine();
    await withServer(
      (req, res) => engine.handleRequest(req, res),
      async (baseUrl) => {
        const result = await sseExchange(baseUrl, REALTIME_PATH);
        strictEqual(result.status, 200, "an originless request must be served, not rejected with 403");
        ok(
          (result.headers["content-type"] ?? "").includes("text/event-stream"),
          `expected content-type text/event-stream, got: ${result.headers["content-type"]}`,
        );
        result.close();
      },
    );
  },
);

// ── 1.3 — configured + matching Origin ⇒ exact echo, vary: origin, never * ─

await check(
  "1.3: a listed origin is granted access — exact echo, vary: origin, never a wildcard",
  async () => {
    const { engine } = makeEngine({ allowedOrigins: ["https://app.example.com"] });
    await withServer(
      (req, res) => engine.handleRequest(req, res),
      async (baseUrl) => {
        const result = await sseExchange(baseUrl, REALTIME_PATH, {
          headers: { Origin: "https://app.example.com" },
        });
        strictEqual(result.status, 200, "a listed origin must be admitted");
        strictEqual(
          result.headers["access-control-allow-origin"],
          "https://app.example.com",
          "must echo the exact listed origin, never a wildcard",
        );
        ok(result.headers["vary"] === "origin", `expected vary: origin, got: ${result.headers["vary"]}`);
        result.close();
      },
    );
  },
);

// ── 1.4 — mismatched Origin ⇒ 403, no CORS header, incl. prefix/suffix ─────

await check(
  "1.4: a non-listed origin is rejected with 403 and no CORS header",
  async () => {
    const { engine } = makeEngine({ allowedOrigins: ["https://app.example.com"] });
    await withServer(
      (req, res) => engine.handleRequest(req, res),
      async (baseUrl) => {
        const result = await exchange(baseUrl, REALTIME_PATH, {
          headers: { Origin: "https://evil.example.com" },
        });
        strictEqual(result.status, 403, "a non-listed origin must be rejected with 403");
        ok(result.headers["access-control-allow-origin"] === undefined, "must not set any CORS header");
      },
    );
  },
);

await check(
  "1.4b (threat matrix): an origin that merely prefixes or suffixes a listed one is NOT granted — exact equality only",
  async () => {
    const { engine } = makeEngine({ allowedOrigins: ["https://app.example.com"] });
    await withServer(
      (req, res) => engine.handleRequest(req, res),
      async (baseUrl) => {
        // Suffix confusion: listed origin as a PREFIX of the attacker's origin.
        const suffixAttack = await exchange(baseUrl, REALTIME_PATH, {
          headers: { Origin: "https://app.example.com.evil.test" },
        });
        strictEqual(suffixAttack.status, 403, "https://app.example.com.evil.test must be rejected (suffix confusion)");
        ok(
          suffixAttack.headers["access-control-allow-origin"] === undefined,
          "suffix-confusion origin must not receive any CORS header",
        );

        // Prefix confusion: listed origin as a SUFFIX of the attacker's origin.
        const prefixAttack = await exchange(baseUrl, REALTIME_PATH, {
          headers: { Origin: "https://evil-app.example.com" },
        });
        strictEqual(prefixAttack.status, 403, "https://evil-app.example.com must be rejected (prefix confusion)");
        ok(
          prefixAttack.headers["access-control-allow-origin"] === undefined,
          "prefix-confusion origin must not receive any CORS header",
        );
      },
    );
  },
);

// ── 1.5 — handleLogRequest obeys the identical gate ────────────────────────

await check(
  "1.5: handleLogRequest applies the same origin allowlist as handleRequest",
  async () => {
    const { engine } = makeEngine({
      allowedOrigins: ["https://app.example.com"],
      logDb: fakeLogDb([]),
    });
    process.env.INDIGODB_REALTIME_SECRET = SECRET;
    try {
      const handle = mintHandle({ table: "Post", userId: "u1" }, SECRET);
      await withServer(
        (req, res) => void engine.handleLogRequest(req, res),
        async (baseUrl) => {
          const allowed = await exchange(baseUrl, `${REALTIME_LOG_PATH}?handle=${handle}`, {
            headers: { Origin: "https://app.example.com" },
          });
          strictEqual(allowed.status, 200, "an allowed origin with a valid handle must be served");
          strictEqual(
            allowed.headers["access-control-allow-origin"],
            "https://app.example.com",
            "handleLogRequest must echo the exact allowed origin, same as handleRequest",
          );

          // Rejected origin, even carrying an otherwise-valid handle — proves
          // the origin gate runs BEFORE handle verification, i.e. it is a
          // real, independent gate, not skipped on this route.
          const rejected = await exchange(baseUrl, `${REALTIME_LOG_PATH}?handle=${handle}`, {
            headers: { Origin: "https://evil.example.com" },
          });
          strictEqual(rejected.status, 403, "a non-listed origin must be rejected on handleLogRequest too");
          ok(rejected.headers["access-control-allow-origin"] === undefined, "must not set any CORS header");
        },
      );
    } finally {
      delete process.env.INDIGODB_REALTIME_SECRET;
    }
  },
);

// ── 1.6 — OPTIONS preflight mirrors the route it precedes, on both paths ──

await check(
  "1.6: OPTIONS from an allowed origin ⇒ 204 with the exact echoed origin, on both handleRequest and handleLogRequest",
  async () => {
    const { engine } = makeEngine({ allowedOrigins: ["https://app.example.com"] });
    await withServer(
      (req, res) => void engine.handleRequest(req, res),
      async (baseUrl) => {
        const result = await exchange(baseUrl, REALTIME_PATH, {
          method: "OPTIONS",
          headers: { Origin: "https://app.example.com" },
        });
        strictEqual(result.status, 204, "an allowed preflight on handleRequest must be 204");
        strictEqual(result.headers["access-control-allow-origin"], "https://app.example.com");
        ok(result.headers["access-control-allow-origin"] !== "*", "preflight must never echo a wildcard");
      },
    );
    await withServer(
      (req, res) => void engine.handleLogRequest(req, res),
      async (baseUrl) => {
        const result = await exchange(baseUrl, REALTIME_LOG_PATH, {
          method: "OPTIONS",
          headers: { Origin: "https://app.example.com" },
        });
        strictEqual(result.status, 204, "an allowed preflight on handleLogRequest must be 204");
        strictEqual(result.headers["access-control-allow-origin"], "https://app.example.com");
        ok(result.headers["access-control-allow-origin"] !== "*", "preflight must never echo a wildcard");
      },
    );
  },
);

await check(
  "1.6b: OPTIONS from a rejected origin ⇒ 403, no CORS header, on both paths",
  async () => {
    const { engine } = makeEngine({ allowedOrigins: ["https://app.example.com"] });
    await withServer(
      (req, res) => void engine.handleRequest(req, res),
      async (baseUrl) => {
        const result = await exchange(baseUrl, REALTIME_PATH, {
          method: "OPTIONS",
          headers: { Origin: "https://evil.example.com" },
        });
        strictEqual(result.status, 403, "a rejected preflight on handleRequest must be 403");
        ok(result.headers["access-control-allow-origin"] === undefined);
      },
    );
    await withServer(
      (req, res) => void engine.handleLogRequest(req, res),
      async (baseUrl) => {
        const result = await exchange(baseUrl, REALTIME_LOG_PATH, {
          method: "OPTIONS",
          headers: { Origin: "https://evil.example.com" },
        });
        strictEqual(result.status, 403, "a rejected preflight on handleLogRequest must be 403");
        ok(result.headers["access-control-allow-origin"] === undefined);
      },
    );
  },
);

// ── 1.10 — dispatched wake frame is unchanged for an allowed-origin request
//    (closes the `realtime-live-endpoint` MODIFIED-scenario gap: CORS
//    admission is orthogonal to the wake-only, fail-closed payload shape) ──

await check(
  "1.10: an allowed-origin SSE subscriber still only ever receives the data-free wake frame — no pk/new/old leak",
  async () => {
    const { engine, emit } = makeEngine({ allowedOrigins: ["https://app.example.com"] });
    await withServer(
      (req, res) => engine.handleRequest(req, res),
      async (baseUrl) => {
        const result = await sseExchange(baseUrl, REALTIME_PATH, {
          headers: { Origin: "https://app.example.com" },
        });
        strictEqual(result.status, 200);
        ok(result.body.includes("event: ready"), `expected an initial event: ready frame, got: ${result.body}`);

        await engine.start();
        emit({
          table: "Post",
          op: "INSERT",
          pk: { id: "1" },
          new: { id: "1", title: "hi" },
          txid: "42",
          ts: "2026-01-01T00:00:00.000Z",
          lsn: "0/ABC",
        });
        const nextChunk = await result.readNext();
        ok(nextChunk.includes("event: wake"), `expected an event: wake frame, got: ${nextChunk}`);
        ok(!nextChunk.includes("event: change"), "must never emit event: change over SSE");
        const dataLine = nextChunk.split("\n").find((l) => l.startsWith("data: "));
        const payload = JSON.parse(dataLine.slice("data: ".length));
        deepStrictEqual(payload, { table: "Post", op: "INSERT", lsn: "0/ABC", seq: 1 });
        ok(!("pk" in payload), "wake frame must not carry pk, allowed-origin or not");
        ok(!("new" in payload), "wake frame must not carry new, allowed-origin or not");
        ok(!("old" in payload), "wake frame must not carry old, allowed-origin or not");
        result.close();
        await engine.stop();
      },
    );
  },
);

// Reachability guard: fails loudly if a case above is skipped/omitted.
strictEqual(ran, 9, "expected exactly 9 check() cases in origin-allowlist.mjs");

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error("\nFAILED");
} else {
  console.log("\nPASSED");
}
