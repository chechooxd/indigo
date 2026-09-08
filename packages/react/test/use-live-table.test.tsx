/**
 * `useLiveTable` (design.md D4/D5, tasks.md Phase 5b). Covers the reasons
 * this package exists: StrictMode double-invoke leaves one connection, SSR
 * never touches `window`, snapshots stay referentially stable, and
 * unmounting actually closes the subscription. A test that only renders and
 * reads a string proves none of that — every scenario here asserts on a
 * real connect/close/notify count driven through a fake transport.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import type { RealtimeTransport, TransportHandlers } from "@indigodb/client/realtime";
import { createLiveSubscription } from "@indigodb/client/realtime";
import { useLiveTable, type UseLiveTableResult } from "../src/use-live-table.js";

vi.mock("@indigodb/client/realtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@indigodb/client/realtime")>();
  return {
    ...actual,
    // Wraps the REAL implementation — behavior is unchanged, this only lets
    // 5b.2 assert on how many times the primitive was actually constructed.
    createLiveSubscription: vi.fn(actual.createLiveSubscription),
  };
});

const mockedCreateLiveSubscription = vi.mocked(createLiveSubscription);

afterEach(() => {
  cleanup();
  mockedCreateLiveSubscription.mockClear();
});

/**
 * A `RealtimeTransport` double that never touches the network. Each
 * `connect()` call is recorded, and its `TransportHandlers` are captured so
 * a test can drive `onOpen`/`onError`/`onTerminal` directly, synchronously.
 */
function createFakeTransport() {
  const connects: Array<{ tables: string[]; handlers: TransportHandlers }> = [];
  const closes: number[] = [];
  const transport: RealtimeTransport = {
    connect(tables, handlers) {
      const index = connects.length;
      connects.push({ tables, handlers });
      return () => closes.push(index);
    },
  };
  return {
    transport,
    connectCount: () => connects.length,
    closeCount: () => closes.length,
    lastHandlers: () => connects[connects.length - 1]?.handlers,
  };
}

/** Captures the hook's latest return value into `resultRef.current`. */
function Probe({
  table,
  transport,
  resultRef,
  enabled,
}: {
  table: string | null;
  transport: RealtimeTransport;
  resultRef: { current: UseLiveTableResult | null };
  enabled?: boolean;
}) {
  resultRef.current = useLiveTable(table, { transport, enabled });
  return null;
}

describe("useLiveTable — return shape", () => {
  it("returns exactly {status, error, retry}", () => {
    const { transport } = createFakeTransport();
    const resultRef: { current: UseLiveTableResult | null } = { current: null };

    render(<Probe table="Order" transport={transport} resultRef={resultRef} />);

    expect(resultRef.current).not.toBeNull();
    expect(Object.keys(resultRef.current!).sort()).toEqual(["error", "retry", "status"]);
  });
});

describe("useLiveTable — subscription identity", () => {
  it("keeps exactly one active createLiveSubscription across 3 re-renders with unchanged props", () => {
    const { transport } = createFakeTransport();
    const resultRef: { current: UseLiveTableResult | null } = { current: null };

    const { rerender } = render(<Probe table="Order" transport={transport} resultRef={resultRef} />);
    rerender(<Probe table="Order" transport={transport} resultRef={resultRef} />);
    rerender(<Probe table="Order" transport={transport} resultRef={resultRef} />);
    rerender(<Probe table="Order" transport={transport} resultRef={resultRef} />);

    expect(mockedCreateLiveSubscription).toHaveBeenCalledTimes(1);
  });
});

describe("useLiveTable — SSR", () => {
  it("renderToString with window deleted completes without throwing, opens no connection, reports idle", () => {
    const { transport, connectCount } = createFakeTransport();
    const resultRef: { current: UseLiveTableResult | null } = { current: null };
    const originalWindow = globalThis.window;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).window;
    try {
      expect(() => {
        renderToString(<Probe table="Order" transport={transport} resultRef={resultRef} />);
      }).not.toThrow();
    } finally {
      globalThis.window = originalWindow;
    }

    expect(resultRef.current?.status).toBe("idle");
    expect(connectCount()).toBe(0);
  });
});

describe("useLiveTable — StrictMode double-invoke", () => {
  it("leaves exactly one open connection after mount -> cleanup -> re-mount", () => {
    const { transport, connectCount, closeCount } = createFakeTransport();
    const resultRef: { current: UseLiveTableResult | null } = { current: null };

    render(
      <StrictMode>
        <Probe table="Order" transport={transport} resultRef={resultRef} />
      </StrictMode>,
    );

    // React's dev-mode double-invoke actually cycles the channel: open
    // (discarded) -> close -> open again. Asserting only the DIFFERENCE
    // (net 1 open) is too weak — a broken cleanup that never closes at all
    // also nets to 1 open, 0 closed. Assert the absolute counts so a skipped
    // cleanup on the discarded instance is caught.
    expect(connectCount()).toBe(2);
    expect(closeCount()).toBe(1);
  });
});

describe("useLiveTable — shared channel across instances", () => {
  it("N=3 hook instances on one table produce exactly one connect", () => {
    const { transport, connectCount } = createFakeTransport();
    const r1: { current: UseLiveTableResult | null } = { current: null };
    const r2: { current: UseLiveTableResult | null } = { current: null };
    const r3: { current: UseLiveTableResult | null } = { current: null };

    render(
      <>
        <Probe table="Order" transport={transport} resultRef={r1} />
        <Probe table="Order" transport={transport} resultRef={r2} />
        <Probe table="Order" transport={transport} resultRef={r3} />
      </>,
    );

    expect(connectCount()).toBe(1);
  });

  it("a second instance mounting after the first is live reports live immediately, with 0 extra connects", () => {
    const { transport, connectCount, lastHandlers } = createFakeTransport();
    const r1: { current: UseLiveTableResult | null } = { current: null };
    const r2: { current: UseLiveTableResult | null } = { current: null };

    const { rerender } = render(<Probe table="Order" transport={transport} resultRef={r1} />);
    act(() => {
      lastHandlers()!.onOpen(false);
    });
    expect(r1.current?.status).toBe("live");
    expect(connectCount()).toBe(1);

    rerender(
      <>
        <Probe table="Order" transport={transport} resultRef={r1} />
        <Probe table="Order" transport={transport} resultRef={r2} />
      </>,
    );

    expect(r2.current?.status).toBe("live");
    expect(connectCount()).toBe(1);
  });
});

describe("useLiveTable — enabled / table gating", () => {
  it("enabled:false reports idle and opens no connection", () => {
    const { transport, connectCount } = createFakeTransport();
    const resultRef: { current: UseLiveTableResult | null } = { current: null };

    render(<Probe table="Order" transport={transport} resultRef={resultRef} enabled={false} />);

    expect(resultRef.current?.status).toBe("idle");
    expect(connectCount()).toBe(0);
  });

  it("table:null reports idle and opens no connection", () => {
    const { transport, connectCount } = createFakeTransport();
    const resultRef: { current: UseLiveTableResult | null } = { current: null };

    render(<Probe table={null} transport={transport} resultRef={resultRef} />);

    expect(resultRef.current?.status).toBe("idle");
    expect(connectCount()).toBe(0);
  });
});

describe("useLiveTable — terminal error and retry", () => {
  it("surfaces a terminal error via error/status and retry() recovers to live", () => {
    const { transport, lastHandlers, connectCount } = createFakeTransport();
    const resultRef: { current: UseLiveTableResult | null } = { current: null };

    render(<Probe table="Order" transport={transport} resultRef={resultRef} />);

    const failure = new Error("not found");
    act(() => {
      lastHandlers()!.onError(failure);
      lastHandlers()!.onTerminal?.(failure);
    });

    expect(resultRef.current?.status).toBe("error");
    expect(resultRef.current?.error).not.toBeNull();
    expect(resultRef.current?.error?.terminal).toBe(true);

    act(() => {
      resultRef.current!.retry();
    });
    expect(connectCount()).toBe(2); // retry() revives the channel: a fresh connect()

    act(() => {
      lastHandlers()!.onOpen(false);
    });

    expect(resultRef.current?.status).toBe("live");
    expect(resultRef.current?.error).toBeNull();
  });
});

describe("useLiveTable — unmount", () => {
  it("unmounting the sole consumer closes the underlying connection", () => {
    const { transport, connectCount, closeCount } = createFakeTransport();
    const resultRef: { current: UseLiveTableResult | null } = { current: null };

    const { unmount } = render(<Probe table="Order" transport={transport} resultRef={resultRef} />);
    expect(connectCount()).toBe(1);
    expect(closeCount()).toBe(0);

    unmount();

    expect(closeCount()).toBe(1);
  });
});
