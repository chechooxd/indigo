/**
 * @indigodb/client — `findMany().live()` for `@@realtime` + `@@allow` models
 *
 * (`client-live-queries` spec, design.md `realtime-live-client`.) Owns the
 * handle payload decoder, the `LiveQuery` state machine (bootstrap, debounced
 * + coalesced refetch, handle-failure retry, resync, `$authSession`-nesting
 * surfacing) and the types the generated `LiveModelDelegate` (see
 * `realtime-delegate.ts`) wires up per qualifying model.
 *
 * DELIBERATELY imports NOTHING — value or type — from `@indigodb/realtime`:
 * that package's `handle.ts` pulls `node:crypto` (HMAC signing/verification,
 * server-only), and this file must stay safe to bundle into a browser build.
 * The handle payload segment is decoded here with a hand-rolled ~10-line
 * base64url + `JSON.parse` (via the WHATWG `atob` global, available in every
 * browser and Node ≥18) — no signature verification, ever: this file has no
 * secret and could not check it if it wanted to. The HMAC remains the
 * *server* endpoint's job (`@indigodb/realtime`'s `verifyHandle`).
 */

// ─── Handle payload decoding ────────────────────────────────────────────────

/** The signed handle payload's shape (mirrors `@indigodb/realtime`'s
 * `HandlePayload` structurally — NOT imported, per this file's header). */
export interface HandlePayload {
  v: 1;
  t: string;
  u: string;
  exp: number;
}

/**
 * Every distinct reason `decodeHandlePayload` can reject a token for
 * (tasks.md 1.1). All of these collapse to the SAME classification —
 * "verified handle failure" — one level up in the retry state machine
 * (section 3); the distinct reasons exist for test/debug granularity only.
 */
export type HandleFailureReason =
  | "no-separator"
  | "bad-base64url"
  | "bad-json"
  | "bad-version"
  | "table-mismatch"
  | "empty-user"
  | "bad-exp"
  | "expired";

export type DecodeResult =
  | { ok: true; payload: HandlePayload }
  | { ok: false; reason: HandleFailureReason };

/** Clock-skew allowance applied to `exp` validation, in seconds — a token
 * that expired up to 5s ago is still accepted (tasks.md 1.1: "a non-finite
 * or already-past exp (with a 5s skew allowance)"). Distinct from, and not
 * to be confused with, the CACHE's own proactive-refresh skew in
 * `client.ts` (`HANDLE_EXPIRY_SKEW_MS`), which re-mints a cached handle
 * BEFORE it actually expires — the two skews serve opposite directions and
 * are intentionally independent constants. */
const EXP_SKEW_SECONDS = 5;

function fail(reason: HandleFailureReason): DecodeResult {
  return { ok: false, reason };
}

/** `null` on any malformed base64url input rather than throwing. Uses the
 * WHATWG `atob` global (no `Buffer`, no `node:crypto`) — present in every
 * browser and in Node ≥18. */
function base64urlDecodeText(text: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decodes and locally validates a handle's payload segment — no signature
 * check (tasks.md 1.2). Splits on the FIRST `.` only (the signature segment
 * is ignored entirely). `table` is the caller's own table name; a decoded
 * `t` that does not match it is a verified handle failure ("table
 * confusion", threat matrix row).
 */
export function decodeHandlePayload(token: string, table: string): DecodeResult {
  if (typeof token !== "string" || token.length === 0) return fail("no-separator");
  const dot = token.indexOf(".");
  if (dot <= 0) return fail("no-separator");

  const payloadText = token.slice(0, dot);
  const decodedText = base64urlDecodeText(payloadText);
  if (decodedText === null) return fail("bad-base64url");

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodedText);
  } catch {
    return fail("bad-json");
  }
  if (parsed === null || typeof parsed !== "object") return fail("bad-json");
  const p = parsed as Record<string, unknown>;

  if (p.v !== 1) return fail("bad-version");
  if (typeof p.t !== "string" || p.t !== table) return fail("table-mismatch");
  if (typeof p.u !== "string" || p.u.length === 0) return fail("empty-user");
  if (typeof p.exp !== "number" || !Number.isFinite(p.exp)) return fail("bad-exp");

  const nowSeconds = Date.now() / 1000;
  if (p.exp < nowSeconds - EXP_SKEW_SECONDS) return fail("expired");

  return { ok: true, payload: { v: 1, t: p.t, u: p.u, exp: p.exp } };
}

/** Thrown by `client.ts`'s `$handle` when a freshly minted token fails
 * `decodeHandlePayload` — the "verified handle failure" branch of the retry
 * state machine below. Defined HERE (not in `client.ts`) so `client.ts` can
 * import it without creating a cycle: this file never imports from
 * `client.ts`. */
export class IndigoLiveHandleError extends Error {
  readonly reason: HandleFailureReason;
  constructor(reason: HandleFailureReason, message: string) {
    super(message);
    this.name = "IndigoLiveHandleError";
    this.reason = reason;
  }
}

// ─── Handle provisioning contract (implemented by `client.ts`'s `$handle`) ──

export interface HandleInfo {
  token: string;
  userId: string;
  expiresAtMs: number;
}

export type GetHandleFn = (
  table: string,
  opts?: { refresh?: boolean },
) => Promise<HandleInfo>;

/**
 * `runScoped(userId)` — provided by the generated `LiveModelDelegate`
 * (`realtime-delegate.ts`), already closed over the query's table, model
 * name and CAPTURED `args`. Every call builds a brand-new `findMany(args)`
 * op inside a fresh `$authSession({ userId })` — never re-awaiting or
 * re-using the bootstrap op (design decision 2 / tasks.md section 6:
 * `IndigoPromise` is single-use and throws `OPERATION_REUSED` on reuse).
 */
export type RunScoped<Row> = (userId: string) => Promise<Row[]>;

/**
 * The RAW generator-emitted closure (design.md Interfaces section,
 * `IndigoClient`'s `runScoped` field) — `LiveModelDelegate`'s constructor
 * receives this shape and curries it (with `model` and the captured `args`)
 * into the per-query `RunScoped<Row>` above before handing it to
 * `createLiveQuery`.
 */
export type ClientRunScoped = <T>(
  userId: string,
  model: string,
  run: (d: any) => Promise<T>,
) => Promise<T>;

/** Structurally compatible with `realtime.ts`'s `ChannelListener` (not
 * imported, to keep this file's import list minimal and self-contained —
 * `onEvent` stays required so a plain object literal here satisfies that
 * interface at the assignment site in `realtime-delegate.ts`). */
export interface LiveSubscribeListener {
  onEvent: (event: unknown) => void;
  onWake?: () => void;
  /** Fired on every successful (re)open of the shared channel, including the
   * state replay a late joiner receives (design.md D1). `.live()` uses it
   * only to clear its transport-error latch and to resume after a
   * `retry()`-driven revive — it deliberately does NOT refetch on an
   * ordinary open, so the bootstrap snapshot is never duplicated. */
  onOpen?: (reconnected: boolean) => void;
  onResync?: () => void;
  onError?: (error: Error) => void;
}

export type Unsubscribe = () => void;

// ─── Public `LiveQuery` surface ─────────────────────────────────────────────

export type LiveStatus = "connecting" | "live" | "error";

export interface LiveHandlers<Row> {
  onData?: (rows: Row[]) => void;
  onStatus?: (status: LiveStatus) => void;
  onError?: (error: Error) => void;
}

export interface LiveQuery<Row> {
  /** `[]` until the first snapshot settles. */
  readonly rows: Row[];
  readonly status: LiveStatus;
  /**
   * Revives the shared channel after a transport error (design.md D6).
   *
   * Mirrors `createLiveSubscription`'s own `retry()` exactly: it is
   * CHANNEL-level, so it revives the table's channel for every listener
   * attached to it — not only this `.live()` — and it is a NO-OP unless
   * this subscription is in a transport-error state, so a caller cannot
   * thrash a healthy channel.
   *
   * "Error state" for `.live()` is the *transport* error latch, not the
   * `status` field: `status` here tracks the data-fetch state machine
   * (bootstrap/refetch), a different axis from the primitive's
   * transport-only status. The latch is raised by the channel's `onError`
   * and lowered by its next successful `onOpen` — the exact condition the
   * primitive's `getStatus() === "error"` expresses on its own axis.
   *
   * Why it exists: D6 stops the retry loop at the CHANNEL level, and
   * channels are shared, so a terminal error raised by any consumer of a
   * table stops it for every consumer — including `.live()`, which before
   * this had no recovery path at all short of tearing the whole query down.
   *
   * After a successful revive the channel's `onOpen` forces one immediate
   * refetch (the same path `onResync` uses), so `.live()` resumes its normal
   * snapshot-then-tail behavior rather than tailing a stale snapshot.
   */
  retry(): void;
  /** Idempotent; safe to call before the bootstrap snapshot resolves. */
  unsubscribe(): void;
}

/** Internal constant — NOT a caller-facing option on `.live()` or
 * `RealtimeOptions` in this version (spec Requirement "fixed 50ms trailing
 * debounce"). */
export const LIVE_DEBOUNCE_MS = 50;

export interface LiveDeps<Row> {
  table: string;
  /** Throws SYNCHRONOUSLY if `realtime.getHandle` was never configured —
   * called at the very top of `createLiveQuery`, before anything else, so
   * `.live()` itself throws synchronously (mirrors `$realtime()`'s existing
   * missing-config pattern), never buried inside a rejected promise. */
  requireHandle: () => void;
  getHandle: GetHandleFn;
  runScoped: RunScoped<Row>;
  subscribe: (listener: LiveSubscribeListener) => Unsubscribe;
  /** Channel-level revive for `retry()` — wired by `LiveModelDelegate` to
   * `RealtimeConnectionManager.reviveChannel(table)`, the SAME path
   * `createLiveSubscription.retry()` takes (design.md D6). Kept as a dep
   * rather than an import so `live.ts` keeps importing nothing from
   * `realtime.ts` (design.md D2: `realtime.ts` already imports
   * `LIVE_DEBOUNCE_MS` from here, so a value import back would close a
   * cycle). */
  revive: () => void;
  handlers?: LiveHandlers<Row>;
}

/**
 * Builds and returns a `LiveQuery` SYNCHRONOUSLY (design decision 3 — React
 * `useEffect` cleanup needs `unsubscribe` to exist before the bootstrap
 * resolves). The bootstrap + debounce/coalesce/retry machinery all run
 * asynchronously in the background from here on.
 */
export function createLiveQuery<Row>(deps: LiveDeps<Row>): LiveQuery<Row> {
  // Config guard FIRST, synchronously — see `LiveDeps.requireHandle` doc.
  deps.requireHandle();

  let rows: Row[] = [];
  let status: LiveStatus = "connecting";
  let destroyed = false;
  let inFlight = false;
  let dirty = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeChannel: Unsubscribe | null = null;
  // The TRANSPORT-error latch that gates `retry()` (design.md D6). Deliberately
  // separate from `status`, which tracks the data-fetch state machine — the two
  // are different axes (see `LiveQuery.retry`'s doc). Raised by the shared
  // channel's `onError`, lowered by its next successful `onOpen`. This is the
  // `.live()` analogue of `createLiveSubscription`'s `getStatus() === "error"`.
  let channelError: Error | null = null;
  // Set by `retry()` and consumed by the next `onOpen`, so a revive — and ONLY
  // a revive — forces the one immediate refetch that resumes snapshot-then-tail.
  let revivePending = false;

  const setStatus = (next: LiveStatus): void => {
    if (status === next) return;
    status = next;
    deps.handlers?.onStatus?.(next);
  };

  const notifyData = (): void => {
    deps.handlers?.onData?.(rows);
  };

  const releaseChannel = (): void => {
    unsubscribeChannel?.();
    unsubscribeChannel = null;
  };

  /**
   * Mints/re-mints exactly once (handle failure/retry state machine,
   * section 3 — REACHABLE SCOPE ONLY). `.live()` in this PR never calls
   * `GET ?handle&offset`, so the spec's HTTP-401/404/400/5xx classification
   * (`client-live-queries` Requirement "Only a verified handle failure
   * triggers a re-mint") is UNREACHABLE from this code path — design.md
   * pins it forward as a later incremental-reconciliation slice's contract
   * (tasks.md section 3's scope note, cross-referenced in tasks.md C3). The
   * two triggers actually reachable here are: (a) `getHandle` itself
   * rejects (provider failure) and (b) the freshly minted token fails local
   * decode validation (`IndigoLiveHandleError`, verified handle failure).
   * Both get exactly one retry, forcing a fresh mint (`{refresh:true}`)
   * regardless of which triggered the first failure — bypassing the cache
   * outright is a safe superset of "re-mint on handle failure, retry once
   * on provider failure".
   */
  const mintOnce = async (refresh: boolean): Promise<{ ok: true; userId: string } | { ok: false; error: Error }> => {
    try {
      const info = await deps.getHandle(deps.table, refresh ? { refresh: true } : undefined);
      return { ok: true, userId: info.userId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
  };

  const mintWithRetry = async (): Promise<{ ok: true; userId: string } | { ok: false }> => {
    let attempt = await mintOnce(false);
    if (!attempt.ok) attempt = await mintOnce(true);
    if (!attempt.ok) {
      setStatus("error");
      deps.handlers?.onError?.(attempt.error);
      releaseChannel();
      return { ok: false };
    }
    return { ok: true, userId: attempt.userId };
  };

  const scheduleRefetch = (): void => {
    if (destroyed || status === "error") return;
    // First-wake-armed fixed window (design decision 4): a timer already
    // pending is NEVER reset/re-armed by a later wake in the same burst —
    // resetting on each wake is exactly the starvation bug this guards
    // against under sustained writes (tasks.md 5.3).
    if (debounceTimer !== null) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void refetch();
    }, LIVE_DEBOUNCE_MS);
    debounceTimer.unref?.();
  };

  const refetch = async (): Promise<void> => {
    if (destroyed || status === "error") return;
    if (inFlight) {
      // Coalescing (design decision 5): a wake during an in-flight refetch
      // never starts a second concurrent refetch — it marks dirty for
      // exactly one follow-up, run from this same refetch's `finally` below.
      dirty = true;
      return;
    }
    inFlight = true;
    try {
      const attempt = await mintWithRetry();
      if (!attempt.ok || destroyed) return;
      const data = await deps.runScoped(attempt.userId);
      if (destroyed) return;
      rows = data;
      notifyData();
    } catch (err) {
      // Refetch (SQL) transport failure: onError, rows/status unchanged,
      // no re-mint — the next wake retries normally (handle failure/retry
      // state machine table, "Refetch (SQL) rejects" row).
      deps.handlers?.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      inFlight = false;
      if (dirty && !destroyed) {
        dirty = false;
        void refetch();
      }
    }
  };

  const onResync = (): void => {
    if (destroyed || status === "error") return;
    // Forces one immediate tick(), independent of the debounce window
    // (design decision 9) — a reconnected `.live()` must not stay silently
    // stale forever.
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    void refetch();
  };

  const bootstrap = async (): Promise<void> => {
    const attempt = await mintWithRetry();
    if (!attempt.ok || destroyed) return;
    try {
      rows = await deps.runScoped(attempt.userId);
    } catch (err) {
      // Covers both the `$authSession` nesting-guard error (design Open
      // Question 2 / tasks.md section 8 — `.live()` called from inside an
      // existing `$transaction`/`$auth` callback) and a plain bootstrap SQL
      // failure: neither may throw into the host event loop.
      const error = err instanceof Error ? err : new Error(String(err));
      setStatus("error");
      deps.handlers?.onError?.(error);
      return;
    }
    if (destroyed) return;
    notifyData();
    setStatus("live");
    unsubscribeChannel = deps.subscribe({
      // `.live()` treats a `change` event and a `wake` event as the SAME
      // trigger (design decision 8 rationale) — future-proof if the
      // server-side gate ever widens to send full-payload `change` frames
      // to a `.live()`-consuming model.
      onEvent: () => scheduleRefetch(),
      onWake: () => scheduleRefetch(),
      onOpen: () => {
        // The channel is healthy again: lower the retry() gate. An ORDINARY
        // open (initial connect, state replay, transport-level backoff
        // recovery) does nothing else — refetching here would duplicate the
        // bootstrap snapshot and change `.live()`'s existing call counts.
        channelError = null;
        if (!revivePending) return;
        revivePending = false;
        // A revive means the channel was down long enough to be given up on,
        // so events were certainly missed: force one immediate refetch, the
        // same path a reconnect's `onResync` takes.
        onResync();
      },
      onResync: () => onResync(),
      onError: (error) => {
        channelError = error;
        deps.handlers?.onError?.(error);
      },
    });
  };

  void bootstrap();

  return {
    get rows() {
      return rows;
    },
    get status() {
      return status;
    },
    retry(): void {
      // No-op unless this subscription is in a transport-error state — never
      // let a caller thrash a healthy channel (design.md D6, mirroring
      // `createLiveSubscription.retry()`'s `status !== "error"` guard).
      if (destroyed || channelError === null) return;
      channelError = null;
      revivePending = true;
      // The SAME channel-level path the primitive takes
      // (`RealtimeConnectionManager.reviveChannel`): every listener sharing
      // this table's channel is revived, not only this `.live()`.
      deps.revive();
    },
    unsubscribe(): void {
      if (destroyed) return;
      destroyed = true;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      releaseChannel();
    },
  };
}
