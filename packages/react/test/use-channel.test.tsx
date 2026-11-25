import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import React from "react";
import { useChannel } from "../src/index.js";

function RoomProbe({
  channel,
  fetchImpl,
  onBroadcast,
}: {
  channel: string | null;
  fetchImpl: typeof globalThis.fetch;
  onBroadcast?: (event: string, payload: unknown) => void;
}) {
  const { status, members } = useChannel(channel, {
    baseUrl: "http://localhost:4477",
    clientId: "u1",
    fetch: fetchImpl,
    onBroadcast: (msg) => onBroadcast?.(msg.event, msg.payload),
  });
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="members">{members.map((m) => m.clientId).join(",")}</span>
    </div>
  );
}

describe("useChannel", () => {
  it("connects lazily, updates status and presence members, and forwards broadcast events", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            controller = c;
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    const broadcasts: Array<{ event: string; payload: unknown }> = [];
    render(
      <RoomProbe
        channel="room:1"
        fetchImpl={mockFetch}
        onBroadcast={(event, payload) => broadcasts.push({ event, payload })}
      />,
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });

    await act(async () => {
      controller.enqueue(
        encoder.encode(
          `event: channel_ready\ndata: ${JSON.stringify({
            channel: "room:1",
            members: [{ clientId: "alice", state: {}, joinedAt: "t0", updatedAt: "t0" }],
          })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `event: broadcast\ndata: ${JSON.stringify({
            channel: "room:1",
            event: "ping",
            payload: { n: 1 },
            ts: "t1",
          })}\n\n`,
        ),
      );
      await new Promise((r) => setTimeout(r, 15));
    });

    expect(screen.getByTestId("status").textContent).toBe("connected");
    expect(screen.getByTestId("members").textContent).toBe("alice");
    expect(broadcasts).toEqual([{ event: "ping", payload: { n: 1 } }]);
  });

  it("stays idle when channel is null", () => {
    const neverFetch: typeof globalThis.fetch = async () => {
      throw new Error("should not connect");
    };
    render(<RoomProbe channel={null} fetchImpl={neverFetch} />);
    expect(screen.getByTestId("status").textContent).toBe("idle");
    expect(screen.getByTestId("members").textContent).toBe("");
  });
});
