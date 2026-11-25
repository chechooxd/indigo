/**
 * @indigodb/client/realtime — browser-safe `createChannel()` suite.
 *
 * Exercises `createChannel()` over an injectable `fetch` streaming SSE + POST
 * (zero Node/`pg` dependencies; snapshot identity stability verified).
 */

import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { createChannel } from "../dist/realtime.js";

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(String(err.stack ?? err.message).split("\n").slice(0, 20).join("\n"));
  }
}

console.log("client/realtime: createChannel suite");

await check("createChannel streams channel_ready, presence_join/leave, and broadcast with stable member snapshots", async () => {
  let controller;
  const encoder = new TextEncoder();
  const posts = [];

  const mockFetch = async (url, init = {}) => {
    const href = String(url);
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      posts.push({ href, body });
      if (href.includes("/broadcast")) {
        return new Response(JSON.stringify({ delivered: 2 }), { status: 202 });
      }
      return new Response(
        JSON.stringify({
          member: { clientId: body.clientId, state: body.state ?? {}, joinedAt: "t0", updatedAt: "t0" },
          members: [],
        }),
        { status: 200 },
      );
    }
    const stream = new ReadableStream({
      start(c) {
        controller = c;
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const ch = createChannel({
    baseUrl: "http://localhost:4477",
    channel: "doc:42",
    clientId: "u1",
    fetch: mockFetch,
  });

  strictEqual(ch.getStatus(), "idle");
  const initialRef = ch.getMembers();
  strictEqual(ch.getMembers(), initialRef, "getMembers() must return a stable reference");

  const changes = [];
  const unsub = ch.subscribe(() => changes.push(ch.getStatus()));
  const received = [];
  ch.onBroadcast("cursor", (msg) => received.push(msg));

  // Wait a microtask for stream start
  await new Promise((r) => setTimeout(r, 10));
  ok(controller, "SSE stream opened on first subscribe()");

  const send = (event, data) => {
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  send("channel_ready", {
    channel: "doc:42",
    members: [{ clientId: "u0", state: { active: true }, joinedAt: "t0", updatedAt: "t0" }],
  });
  await new Promise((r) => setTimeout(r, 15));
  strictEqual(ch.getStatus(), "connected");
  strictEqual(ch.getMembers().length, 1);
  const afterReadyRef = ch.getMembers();
  strictEqual(ch.getMembers(), afterReadyRef);

  send("presence_join", {
    channel: "doc:42",
    member: { clientId: "u1", state: { x: 1 }, joinedAt: "t1", updatedAt: "t1" },
  });
  await new Promise((r) => setTimeout(r, 15));
  strictEqual(ch.getMembers().length, 2);

  send("broadcast", { channel: "doc:42", event: "cursor", payload: { x: 7 }, ts: "t2" });
  await new Promise((r) => setTimeout(r, 15));
  strictEqual(received.length, 1);
  deepStrictEqual(received[0].payload, { x: 7 });

  const bRes = await ch.broadcast("cursor", { x: 9 });
  strictEqual(bRes.delivered, 2);
  await ch.track({ x: 9 });
  await ch.untrack();
  strictEqual(posts.length, 3);

  send("presence_leave", {
    channel: "doc:42",
    member: { clientId: "u0", state: {}, joinedAt: "t0", updatedAt: "t0" },
  });
  await new Promise((r) => setTimeout(r, 15));
  strictEqual(ch.getMembers().length, 1);
  strictEqual(ch.getMembers()[0].clientId, "u1");

  unsub();
  strictEqual(ch.getStatus(), "idle");
  ch.close();
  strictEqual(ch.getStatus(), "closed");
});

if (failures > 0) {
  console.error(`\nchannel: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nchannel: all passed");
