/**
 * @indigodb/client — Realtime model delegate
 *
 * `ModelDelegate` plus `subscribe()`. The generator wires this class only for
 * models marked `@@realtime`, so calling `subscribe` on any other model is a
 * compile-time error rather than a runtime one.
 */

import type { RealtimeEvent } from "@indigodb/realtime";
import { ModelDelegate } from "./delegate.js";
import type { SiblingRegistry } from "./delegate.js";
import type { ModelMeta, Executor, WhereInput } from "./types.js";
import type { RealtimeConnectionManager, Unsubscribe } from "./realtime.js";

export interface SubscribeHandlers<Row> {
  onInsert?: (e: { new: Row; pk: Record<string, unknown>; ts: string }) => void;
  onUpdate?: (e: { new: Row; old?: Row; pk: Record<string, unknown>; ts: string }) => void;
  onDelete?: (e: { old?: Row; pk: Record<string, unknown>; ts: string }) => void;
  /** Every event, verbatim off the wire (including `partial` ones). */
  onChange?: (e: RealtimeEvent<Row>) => void;
  /** Reconnected after a gap — events may have been missed; re-query. */
  onResync?: () => void;
  onError?: (error: Error) => void;
}

export class RealtimeModelDelegate<
  Row,
  CreateInput,
  UpdateInput,
  Rel = Record<string, never>,
> extends ModelDelegate<Row, CreateInput, UpdateInput, Rel> {
  constructor(
    meta: ModelMeta,
    exec: Executor,
    /** Thunk so a missing realtime URL only throws at `subscribe()` time. */
    private readonly realtime: () => RealtimeConnectionManager,
    /** Model name on the wire (`RealtimeEvent.table`), e.g. "User". */
    private readonly model: string,
    siblings?: () => SiblingRegistry,
  ) {
    super(meta, exec, siblings);
  }

  subscribe(handlers: SubscribeHandlers<Row>): Unsubscribe {
    return this.realtime().subscribe(this.model, {
      onEvent: (event) => {
        void this.dispatch(event as RealtimeEvent<Row>, handlers);
      },
      onResync: handlers.onResync,
      onError: handlers.onError,
    });
  }

  private async dispatch(
    event: RealtimeEvent<Row>,
    handlers: SubscribeHandlers<Row>,
  ): Promise<void> {
    handlers.onChange?.(event);

    // Oversized NOTIFY payloads arrive keyed-only; recover the row by PK so
    // op handlers always see full data. A deleted row has nothing to refetch.
    if (event.partial && event.op !== "DELETE") {
      try {
        const row = await this.findFirst({ where: event.pk as WhereInput<Row> });
        if (row) event = { ...event, new: row, partial: undefined };
      } catch (err) {
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }

    switch (event.op) {
      case "INSERT":
        if (event.new !== undefined) {
          handlers.onInsert?.({ new: event.new, pk: event.pk, ts: event.ts });
        }
        break;
      case "UPDATE":
        if (event.new !== undefined) {
          handlers.onUpdate?.({ new: event.new, old: event.old, pk: event.pk, ts: event.ts });
        }
        break;
      case "DELETE":
        handlers.onDelete?.({ old: event.old, pk: event.pk, ts: event.ts });
        break;
    }
  }
}
