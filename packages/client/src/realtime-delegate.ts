/**
 * @indigodb/client — Realtime model delegate
 *
 * `ModelDelegate` plus `subscribe()`. The generator wires this class only for
 * models marked `@@realtime`, so calling `subscribe` on any other model is a
 * compile-time error rather than a runtime one.
 */

import type { RealtimeEvent } from "@indigodb/realtime";
import { ModelDelegate } from "./delegate.js";
import type { SiblingRegistry, RunAtomic } from "./delegate.js";
import type { ModelMeta, Executor, WhereInput, FindManyArgs, Payload } from "./types.js";
import type { RealtimeConnectionManager, Unsubscribe } from "./realtime.js";
import type { IndigoPromise } from "./promise.js";
import { createLiveQuery } from "./live.js";
import type { ClientRunScoped, GetHandleFn, LiveHandlers, LiveQuery } from "./live.js";

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
  Where = WhereInput<Row>,
  /** Forwarded to `ModelDelegate`'s own 6th generic — see its doc comment. */
  CreateManyInput = CreateInput,
  /** Forwarded to `ModelDelegate`'s own 7th generic (`Cursor`) — see its doc comment. */
  Cursor = never,
  /** Forwarded to `ModelDelegate`'s own 8th generic (`Numeric`) — see its doc comment. */
  Numeric extends string = never,
  /** Forwarded to `ModelDelegate`'s own 9th generic (`UniqueWhere`) — see its doc comment. */
  UniqueWhere = never,
> extends ModelDelegate<
  Row,
  CreateInput,
  UpdateInput,
  Rel,
  Where,
  CreateManyInput,
  Cursor,
  Numeric,
  UniqueWhere
> {
  constructor(
    meta: ModelMeta,
    exec: Executor,
    /** Thunk so a missing realtime URL only throws at `subscribe()` time. */
    private readonly realtime: () => RealtimeConnectionManager,
    /** Model name on the wire (`RealtimeEvent.table`), e.g. "User". */
    private readonly model: string,
    siblings?: () => SiblingRegistry,
    runAtomic?: RunAtomic,
  ) {
    super(meta, exec, siblings, runAtomic);
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
        const row = await this.findFirst({ where: event.pk as Where });
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

/**
 * `RealtimeModelDelegate` plus `.live()` — the generator wires this class
 * only for models where `table.realtime && table.allow?.length`
 * (`client-live-queries` spec), so calling `.live()` on any other model is a
 * compile-time error rather than a runtime one (mirrors `subscribe`'s own
 * "compile-time, not runtime" convention above). `subscribe()` is inherited
 * UNTOUCHED — this class only overrides `findMany`.
 */
export class LiveModelDelegate<
  Row,
  CreateInput,
  UpdateInput,
  Rel = Record<string, never>,
  Where = WhereInput<Row>,
  CreateManyInput = CreateInput,
  Cursor = never,
  Numeric extends string = never,
  UniqueWhere = never,
> extends RealtimeModelDelegate<
  Row,
  CreateInput,
  UpdateInput,
  Rel,
  Where,
  CreateManyInput,
  Cursor,
  Numeric,
  UniqueWhere
> {
  private readonly liveModel: string;
  private readonly liveRealtime: () => RealtimeConnectionManager;
  private readonly liveRunScoped: ClientRunScoped;
  private readonly liveGetHandle: GetHandleFn;
  private readonly liveRequireHandle: () => void;

  constructor(
    meta: ModelMeta,
    exec: Executor,
    realtime: () => RealtimeConnectionManager,
    model: string,
    /** Generator-emitted per-client closure (design.md Interfaces section):
     * `(userId, model, run) => this.$authSession({userId}, exec => run(...))`.
     * Threaded through so `.live()`'s bootstrap/refetch runs every read
     * inside `$authSession` — a bare `findMany` returns zero rows under
     * `@@allow` RLS (design.md's "Correction to the proposal"). */
    runScoped: ClientRunScoped,
    getHandle: GetHandleFn,
    requireHandle: () => void,
    siblings?: () => SiblingRegistry,
    runAtomic?: RunAtomic,
  ) {
    super(meta, exec, realtime, model, siblings, runAtomic);
    this.liveModel = model;
    this.liveRealtime = realtime;
    this.liveRunScoped = runScoped;
    this.liveGetHandle = getHandle;
    this.liveRequireHandle = requireHandle;
  }

  override findMany<
    A extends FindManyArgs<Row, Rel, Where, Cursor> = FindManyArgs<Row, Rel, Where, Cursor>,
  >(
    args: A = {} as A,
  ): IndigoPromise<Payload<Row, Rel, A>[]> & {
    live(handlers?: LiveHandlers<Payload<Row, Rel, A>>): LiveQuery<Payload<Row, Rel, A>>;
  } {
    const op = super.findMany(args) as IndigoPromise<Payload<Row, Rel, A>[]> & {
      live(handlers?: LiveHandlers<Payload<Row, Rel, A>>): LiveQuery<Payload<Row, Rel, A>>;
    };

    op.live = (handlers) =>
      createLiveQuery<Payload<Row, Rel, A>>({
        table: this.liveModel,
        requireHandle: this.liveRequireHandle,
        getHandle: this.liveGetHandle,
        // Every call builds a FRESH `findMany(args)` op from the CAPTURED
        // `args` — never re-awaiting/re-using the bootstrap `IndigoPromise`
        // (tasks.md section 6, design decision 2: `IndigoPromise` is
        // single-use and throws `OPERATION_REUSED` on reuse).
        runScoped: (userId: string) =>
          this.liveRunScoped<Payload<Row, Rel, A>[]>(userId, this.liveModel, (d: { findMany: (a: A) => unknown }) =>
            Promise.resolve(d.findMany(args)) as Promise<Payload<Row, Rel, A>[]>,
          ),
        subscribe: (listener) => this.liveRealtime().subscribe(this.liveModel, listener),
        // `.live()`'s `retry()` goes through the exact channel-level path
        // `createLiveSubscription.retry()` uses (design.md D6) — reviving the
        // shared channel for every listener on this table, not just this query.
        revive: () => this.liveRealtime().reviveChannel(this.liveModel),
        handlers,
      });

    return op;
  }
}
