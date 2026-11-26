# @indigodb/react

Browser-safe React hooks (`useLiveTable`, `useChannel`) and realtime channel primitives built over `useSyncExternalStore` and `@indigodb/client/realtime`.

Part of [IndigoDB](https://github.com/chechooxd/indigo) (`Node >= 22`, peer dependency `react >= 18`).

## Installation

```bash
npm install @indigodb/react @indigodb/client
```

> `@indigodb/react` imports only `@indigodb/client/realtime` (browser-safe Web APIs — zero `pg` or `node:*` imports).

## Usage

### Live table invalidation (`useLiveTable`)

```tsx
import { useLiveTable, browserTransport } from "@indigodb/react";

function OrdersWatcher({ refetchOrders }: { refetchOrders: () => void }) {
  const { status, error, retry } = useLiveTable("Order", {
    transport: browserTransport(),
    onWake: refetchOrders,
    onResync: refetchOrders,
  });

  if (status === "error") {
    return <button onClick={retry}>Reconnect ({error?.message})</button>;
  }
  return <span>Realtime: {status}</span>;
}
```

### Ephemeral Presence & Broadcast (`useChannel`)

```tsx
import { useChannel } from "@indigodb/react";

function RoomPresence({ userId }: { userId: string }) {
  const { status, members, track, untrack, broadcast } = useChannel("room:lobby", {
    baseUrl: window.location.origin,
    clientId: userId,
    onBroadcast: (msg) => console.log(msg.event, msg.payload),
  });

  return (
    <div>
      <span>{status} ({members.length} online)</span>
      <button onClick={() => void track({ cursor: { x: 10, y: 20 } })}>Join</button>
      <button onClick={() => void broadcast("ping", { ts: Date.now() })}>Ping</button>
      <button onClick={() => void untrack()}>Leave</button>
    </div>
  );
}
```

## Exports

- Hooks: `useLiveTable`, `useChannel`
- Re-exported browser-safe primitives: `createLiveSubscription`, `browserTransport`, `createChannel`
- Types: `UseLiveTableOptions`, `UseLiveTableResult`, `UseChannelOptions`, `UseChannelResult`, `RealtimeChannel`, `ChannelOptions`, `ChannelStatus`, `PresenceMember`, `BroadcastMessage`

## License

MIT
