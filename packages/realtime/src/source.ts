/**
 * @indigodb/realtime — LISTEN/NOTIFY event source (v1)
 *
 * One dedicated `pg.Client` holding `LISTEN indigo_events` (the channel the
 * `indigo_notify_trigger()` function emitted by the migrator publishes to).
 * Trigger payloads speak physical table/column names; this source translates
 * them to model/field names using the `ResolvedSchema` before handing events
 * to the engine. Events for unknown or non-`@@realtime` tables are dropped.
 *
 * Reconnects with exponential backoff (1s → 30s) and re-issues LISTEN after
 * the connection is lost. NOTIFY delivered while disconnected is gone — that
 * gap is why the SDK surfaces `resync` on reconnect (v2 WAL removes it).
 */

import pg from "pg";
import type { ResolvedSchema } from "@indigodb/core";
import type { RealtimeEvent, RealtimeOp, RealtimeSource } from "./protocol.js";

const CHANNEL = "indigo_events";

interface TableNames {
  /** Model name for the wire. */
  model: string;
  /** Physical column name → field name. */
  columns: Map<string, string>;
}

export class PgNotifySource implements RealtimeSource {
  private client: pg.Client | null = null;
  private stopped = true;
  private retryMs = 1_000;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly tables = new Map<string, TableNames>();

  constructor(
    private readonly connectionString: string,
    schema: ResolvedSchema,
  ) {
    for (const table of schema.tables) {
      if (!table.realtime) continue;
      const columns = new Map<string, string>();
      for (const col of table.columns) columns.set(col.dbName, col.name);
      this.tables.set(table.dbName, { model: table.name, columns });
    }
  }

  /** Model names of the tables this source will emit events for. */
  get models(): string[] {
    return [...this.tables.values()].map((t) => t.model);
  }

  async start(
    onEvent: (event: RealtimeEvent) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    this.stopped = false;
    // Initial connect failures throw so a daemon fails fast with a clear
    // error; once established, losses are retried with backoff instead.
    await this.connect(onEvent, onError);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => {});
  }

  private async connect(
    onEvent: (event: RealtimeEvent) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString });
    this.client = client;

    client.on("notification", (msg) => {
      if (!msg.payload) return;
      const event = this.translate(msg.payload);
      if (event) onEvent(event);
    });
    // 'error' fires on connection loss and is followed by 'end'; swallowing
    // it here (reporting only) avoids an unhandled 'error' crash.
    client.on("error", (err) => onError(err));
    client.on("end", () => {
      if (this.stopped || this.client !== client) return;
      this.scheduleReconnect(onEvent, onError);
    });

    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    this.retryMs = 1_000;
  }

  private scheduleReconnect(
    onEvent: (event: RealtimeEvent) => void,
    onError: (error: Error) => void,
  ): void {
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    this.retryTimer = setTimeout(() => {
      this.connect(onEvent, onError).catch((err) => {
        onError(err instanceof Error ? err : new Error(String(err)));
        if (!this.stopped) this.scheduleReconnect(onEvent, onError);
      });
    }, delay);
  }

  /** Trigger payload (physical names) → wire event (schema names), or null to drop. */
  private translate(payload: string): RealtimeEvent | null {
    let raw: {
      table?: string;
      op?: RealtimeOp;
      pk?: Record<string, unknown>;
      new?: Record<string, unknown> | null;
      old?: Record<string, unknown> | null;
      partial?: boolean;
      txid?: string;
      ts?: string;
    };
    try {
      raw = JSON.parse(payload);
    } catch {
      return null;
    }
    if (!raw.table || !raw.op || !raw.ts) return null;
    const names = this.tables.get(raw.table);
    if (!names) return null;

    const event: RealtimeEvent = {
      table: names.model,
      op: raw.op,
      pk: renameKeys(raw.pk ?? {}, names.columns),
      ts: raw.ts,
      txid: raw.txid,
    };
    if (raw.partial) event.partial = true;
    if (raw.new) event.new = renameKeys(raw.new, names.columns);
    if (raw.old) event.old = renameKeys(raw.old, names.columns);
    return event;
  }
}

function renameKeys(
  row: Record<string, unknown>,
  columns: Map<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[columns.get(key) ?? key] = value;
  }
  return out;
}
