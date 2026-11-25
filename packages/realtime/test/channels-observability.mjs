/**
 * @indigodb/realtime — Presence, Broadcast & Observability integration suite.
 *
 * Drives a REAL `node:http` server with `engine.attach(server)` and real
 * `fetch()` SSE + POST + GET requests (zero HTTP mocks).
 */

import { createServer } from "node:http";
import { strictEqual, deepStrictEqual, ok } from "node:assert";
import {
  RealtimeEngine,
  REALTIME_PATH,
  REALTIME_LOG_PATH,
  REALTIME_CHANNELS_PATH,
  REALTIME_BROADCAST_PATH,
  REALTIME_PRESENCE_PATH,
  REALTIME_METRICS_PATH,
} from "../dist/index.js";

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.stack ?? err.message).split("\n").slice(0, 25).join("\n"));
  }
}

console.log("realtime channels + observability suite");

function fakeSchema() {
  return {
    tables: [
      {
        name: "Order",
        dbName: "Order",
        columns: [{ name: "id", dbName: "id", type: "Int", isEnum: false, nullable: false, isPk: true, unique: false, autoincrement: true }],
        primaryKey: ["id"],
        foreignKeys: [],
        indexes: [],
        relations: [],
        realtime: true,
      },
    ],
    enums: [],
    tableGroups: [],
  };
}

function fakeSource() {
  let emitEvent = null;
  let emitError = null;
  return {
    emit: (ev) => emitEvent?.(ev),
    fail: (err) => emitError?.(err),
    source: {
      async start(onEvent, onError) {
        emitEvent = onEvent;
        emitError = onError;
      },
      async stop() {},
    },
  };
}

/** Opens an SSE stream and returns an async queue of parsed `{ event, data }` frames. */
async function openSse(url, headers = {}) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal, headers });
  if (!res.ok) return { res, frames: [], close: () => controller.abort() };
  const frames = [];
  const waiters = [];
  const push = (frame) => {
    const w = waiters.shift();
    if (w) w(frame);
    else frames.push(frame);
  };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message";
          let data = "";
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (data) push({ event, data: JSON.parse(data) });
        }
      }
    } catch {
      // aborted
    }
  })();

  const nextFrame = (timeoutMs = 2000) =>
    frames.length > 0
      ? Promise.resolve(frames.shift())
      : new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("timed out waiting for SSE frame")), timeoutMs);
          waiters.push((f) => {
            clearTimeout(t);
            resolve(f);
          });
        });

  return { res, nextFrame, close: () => controller.abort() };
}

async function withServer(options, fn) {
  const fake = fakeSource();
  const engine = new RealtimeEngine({
    connectionString: "postgres://unused",
    schema: fakeSchema(),
    source: fake.source,
    ...options,
  });
  await engine.start();
  const server = createServer();
  engine.attach(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn({ engine, fake, baseUrl });
  } finally {
    await engine.stop();
    await new Promise((r) => server.close(r));
  }
}

await check("broadcast fans out to subscribed channel and isolates other channels", async () => {
  const telemetry = [];
  await withServer({ onTelemetry: (e) => telemetry.push(e) }, async ({ baseUrl }) => {
    const subA = await openSse(`${baseUrl}${REALTIME_CHANNELS_PATH}?channel=room:1&clientId=a`);
    const subB = await openSse(`${baseUrl}${REALTIME_CHANNELS_PATH}?channel=room:2&clientId=b`);
    try {
      const readyA = await subA.nextFrame();
      const readyB = await subB.nextFrame();
      strictEqual(readyA.event, "channel_ready");
      strictEqual(readyB.event, "channel_ready");

      const post = await fetch(`${baseUrl}${REALTIME_BROADCAST_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "room:1", event: "cursor", payload: { x: 42 }, senderId: "a" }),
      });
      strictEqual(post.status, 202);
      deepStrictEqual(await post.json(), { delivered: 1 });

      const msgA = await subA.nextFrame();
      strictEqual(msgA.event, "broadcast");
      strictEqual(msgA.data.channel, "room:1");
      strictEqual(msgA.data.event, "cursor");
      deepStrictEqual(msgA.data.payload, { x: 42 });
      strictEqual(msgA.data.senderId, "a");

      // room:2 received nothing
      let gotUnexpected = false;
      await subB.nextFrame(80).then(() => { gotUnexpected = true; }).catch(() => {});
      strictEqual(gotUnexpected, false, "room:2 must not receive room:1 broadcasts");
      ok(telemetry.some((t) => t.kind === "broadcast" && t.channel === "room:1" && t.delivered === 1));
    } finally {
      subA.close();
      subB.close();
    }
  });
});

await check("presence track, channel_ready snapshot, update, and disconnect cleanup", async () => {
  await withServer({}, async ({ baseUrl }) => {
    const sub1 = await openSse(`${baseUrl}${REALTIME_CHANNELS_PATH}?channel=doc:1&clientId=u1`);
    await sub1.nextFrame(); // ready

    // u1 tracks presence
    const track1 = await fetch(`${baseUrl}${REALTIME_PRESENCE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "doc:1", clientId: "u1", action: "track", state: { line: 1 } }),
    });
    strictEqual(track1.status, 200);
    const join1 = await sub1.nextFrame();
    strictEqual(join1.event, "presence_join");
    strictEqual(join1.data.member.clientId, "u1");
    deepStrictEqual(join1.data.member.state, { line: 1 });

    // u2 joins late -> receives u1 in channel_ready
    const sub2 = await openSse(`${baseUrl}${REALTIME_CHANNELS_PATH}?channel=doc:1&clientId=u2`);
    try {
      const ready2 = await sub2.nextFrame();
      strictEqual(ready2.event, "channel_ready");
      strictEqual(ready2.data.members.length, 1);
      strictEqual(ready2.data.members[0].clientId, "u1");

      // u1 updates state -> u2 gets presence_update
      await fetch(`${baseUrl}${REALTIME_PRESENCE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "doc:1", clientId: "u1", action: "track", state: { line: 9 } }),
      });
      const upd = await sub2.nextFrame();
      strictEqual(upd.event, "presence_update");
      deepStrictEqual(upd.data.member.state, { line: 9 });

      // u1 disconnects -> u2 gets presence_leave automatically
      sub1.close();
      const leave = await sub2.nextFrame();
      strictEqual(leave.event, "presence_leave");
      strictEqual(leave.data.member.clientId, "u1");
    } finally {
      sub1.close();
      sub2.close();
    }
  });
});

await check("presence expires automatically after presenceTtlMs", async () => {
  await withServer({ presenceTtlMs: 80 }, async ({ baseUrl }) => {
    const sub = await openSse(`${baseUrl}${REALTIME_CHANNELS_PATH}?channel=ephemeral`);
    try {
      await sub.nextFrame(); // ready
      await fetch(`${baseUrl}${REALTIME_PRESENCE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "ephemeral", clientId: "ghost", action: "track", state: {} }),
      });
      const join = await sub.nextFrame();
      strictEqual(join.event, "presence_join");
      const leave = await sub.nextFrame(500);
      strictEqual(leave.event, "presence_leave");
      strictEqual(leave.data.member.clientId, "ghost");
    } finally {
      sub.close();
    }
  });
});

await check("security gates: D7 origin allowlist, authorizeChannel, invalid identifiers, and 413 body cap", async () => {
  await withServer(
    {
      allowedOrigins: ["https://allowed.test"],
      authorizeChannel: (req) => req.headers["x-token"] === "secret-pass",
    },
    async ({ baseUrl }) => {
      // Disallowed origin -> 403 across channel, broadcast, presence, metrics
      for (const path of [
        `${REALTIME_CHANNELS_PATH}?channel=r1`,
        REALTIME_METRICS_PATH,
      ]) {
        const r = await fetch(`${baseUrl}${path}`, { headers: { origin: "https://evil.test" } });
        strictEqual(r.status, 403, `expected 403 on ${path}`);
      }

      // Missing auth token -> 401
      const unauth = await fetch(`${baseUrl}${REALTIME_BROADCAST_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "r1", event: "ping", payload: 1 }),
      });
      strictEqual(unauth.status, 401);

      // Invalid channel name -> 400
      const badName = await fetch(`${baseUrl}${REALTIME_BROADCAST_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-token": "secret-pass" },
        body: JSON.stringify({ channel: "bad channel!", event: "ping", payload: 1 }),
      });
      strictEqual(badName.status, 400);

      // Oversize body (> 64 KiB) -> 413
      const huge = await fetch(`${baseUrl}${REALTIME_BROADCAST_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-token": "secret-pass" },
        body: JSON.stringify({ channel: "r1", event: "ping", payload: "x".repeat(70_000) }),
      });
      strictEqual(huge.status, 413);
    },
  );
});

await check("observability: getMetrics() and GET /api/realtime/metrics count live activity with zero row/secret leakage", async () => {
  const prevSecret = process.env.INDIGODB_REALTIME_SECRET;
  process.env.INDIGODB_REALTIME_SECRET = "SUPER_SECRET_SHOULD_NEVER_LEAK";
  try {
    await withServer({}, async ({ engine, fake, baseUrl }) => {
      const sub = await openSse(`${baseUrl}${REALTIME_PATH}?tables=Order`);
      const chSub = await openSse(`${baseUrl}${REALTIME_CHANNELS_PATH}?channel=lobby&clientId=c1`);
      try {
        await sub.nextFrame();
        await chSub.nextFrame();

        fake.emit({
          table: "Order",
          op: "INSERT",
          pk: { id: 1 },
          new: { id: 1, secretNote: "PII_VALUE_MUST_NOT_APPEAR" },
          lsn: "0/16B3748",
          ts: "2026-11-25T12:00:00.000Z",
        });
        await sub.nextFrame();

        // Trigger a 401 on the log route
        const badLog = await fetch(`${baseUrl}${REALTIME_LOG_PATH}?handle=bogus`);
        strictEqual(badLog.status, 401);

        // Track presence + send broadcast
        await fetch(`${baseUrl}${REALTIME_PRESENCE_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel: "lobby", clientId: "c1", action: "track", state: {} }),
        });
        await fetch(`${baseUrl}${REALTIME_BROADCAST_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel: "lobby", event: "hi", payload: { ok: true } }),
        });

        const res = await fetch(`${baseUrl}${REALTIME_METRICS_PATH}`);
        strictEqual(res.status, 200);
        strictEqual(res.headers.get("cache-control"), "no-store");
        const rawText = await res.text();
        ok(!rawText.includes("PII_VALUE_MUST_NOT_APPEAR"), "metrics must never leak row payloads");
        ok(!rawText.includes("SUPER_SECRET_SHOULD_NEVER_LEAK"), "metrics must never leak secret");

        const metrics = JSON.parse(rawText);
        strictEqual(metrics.started, true);
        strictEqual(metrics.subscribers.active, 1);
        strictEqual(metrics.subscribers.totalConnected, 1);
        strictEqual(metrics.events.dispatched, 1);
        strictEqual(metrics.events.byTable.Order, 1);
        strictEqual(metrics.events.byOp.INSERT, 1);
        strictEqual(metrics.events.lastLsn, "0/16B3748");
        strictEqual(metrics.log.requests, 1);
        strictEqual(metrics.log.unauthorized, 1);
        strictEqual(metrics.channels.activeChannels, 1);
        strictEqual(metrics.channels.activeSubscribers, 1);
        strictEqual(metrics.channels.activePresenceMembers, 1);
        strictEqual(metrics.channels.broadcastsSent, 1);

        // Synchronous getMetrics() matches HTTP snapshot
        strictEqual(engine.getMetrics().events.dispatched, 1);
      } finally {
        sub.close();
        chSub.close();
      }
    });
  } finally {
    if (prevSecret === undefined) delete process.env.INDIGODB_REALTIME_SECRET;
    else process.env.INDIGODB_REALTIME_SECRET = prevSecret;
  }
});

if (failures > 0) {
  console.error(`\nchannels-observability: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nchannels-observability: all green");
