# @indigodb/realtime

PostgreSQL logical-replication (`pgoutput`) SSE engine, ephemeral Presence & Broadcast channels, signed-handle replay endpoint, origin allowlist enforcement, backpressure eviction, and structured operational observability for IndigoDB.

Part of [Indigodb](https://github.com/chechooxd/indigo) (`Node >= 22`).

## Installation

```bash
npm install @indigodb/realtime
```

## Usage

```ts
import { createServer } from "node:http";
import { parse, resolve } from "@indigodb/core";
import { RealtimeEngine } from "@indigodb/realtime";

const schema = resolve(
  parse(`
  Table Message {
    id   Int    @id @default(autoincrement())
    body String

    @@realtime
  }
  `),
);

const engine = new RealtimeEngine({
  connectionString: process.env.DATABASE_URL!,
  schema,
  allowedOrigins: ["https://app.example.com"],
  onTelemetry: (event) => console.log(event),
});

await engine.start();

const server = createServer();
engine.attach(server); // mounts SSE wake, /log, /channels, /broadcast, /presence, and /metrics
server.listen(4477);
```

## Key Exports

- **Engine**: `RealtimeEngine`, `DEFAULT_MAX_BUFFERED_BYTES`
- **Event sources**: `WalSource` (default, logical replication over `pgoutput`), `PgNotifySource`, `resolveSlotName`
- **Handles & projection**: `mintHandle`, `verifyHandle`, `DEFAULT_HANDLE_TTL_SECONDS`, `project`, `projectionSet`
- **Protocol subpath (`@indigodb/realtime/protocol`)**: browser-safe zero-dependency constants and types (`REALTIME_PATH`, `REALTIME_LOG_PATH`, `REALTIME_CHANNELS_PATH`, `REALTIME_BROADCAST_PATH`, `REALTIME_PRESENCE_PATH`, `REALTIME_METRICS_PATH`, `RealtimeMetrics`, `RealtimeTelemetryEvent`, `PresenceMember`, `BroadcastMessage`)

## License

MIT
