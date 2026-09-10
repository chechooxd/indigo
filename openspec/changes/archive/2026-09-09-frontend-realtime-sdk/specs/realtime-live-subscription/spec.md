# Realtime Live Subscription Specification

## Purpose

Defines `createLiveSubscription({table, transport, onWake, debounceMs})`, the framework-agnostic,
browser-safe status-only wake subscription exported from `@indigodb/client/realtime`. It never
fetches data and never holds rows; it composes with an app's own data library via the caller's
`onWake` invalidation callback.

## Requirements

### Requirement: The primitive returns status, error, and control, never rows

`createLiveSubscription()` MUST return exactly
`{getStatus(), getError(), subscribe(cb), retry(), close()}`. Its public API MUST NOT expose row
data, `RealtimeEvent` payloads, or any table content; `onWake` is the only data-shaped input, and
it is caller-supplied. `getError()` is a diagnostic of the transport failure only — a message and
its classification — and MUST NOT carry table content either.

#### Scenario: Return shape carries no row data

- GIVEN a call to `createLiveSubscription({table, transport, onWake})`
- WHEN the returned object's own enumerable keys are inspected
- THEN only `getStatus`, `getError`, `subscribe`, `retry`, and `close` are present
- AND no key exposes rows, `RealtimeEvent` payloads, or any other table content

### Requirement: The triggering error is retrievable via getError() with a stable identity

`getError()` MUST return `LiveSubscriptionError { message, terminal, cause }` for the error that
put the primitive in `"error"` status, and `null` when there is none. It MUST return `null` before
any error has occurred. While the underlying error and its classification are unchanged, repeated
calls MUST return a **referentially identical** object — the React binding reads it as a
`useSyncExternalStore` snapshot (design.md D4), and a freshly allocated object per call tears.
`terminal` MUST match the transport's classification in the Requirement below. The error MUST be
cleared to `null` on the next successful open, and by `retry()`.

#### Scenario: getError() is null before any error

- GIVEN a subscription that has never seen a transport error, whether unsubscribed, connecting,
  or `"live"`
- WHEN `getError()` is called
- THEN it returns `null`

#### Scenario: A terminal error is retrievable with its classification

- GIVEN a subscribed primitive whose transport reports an error classified terminal
- WHEN `getError()` is called
- THEN it returns an object whose `message` is the error's message, whose `terminal` is `true`,
  and whose `cause` is the original error

#### Scenario: A transient error is retrievable as non-terminal

- GIVEN a subscribed primitive whose transport reports an error that is not classified terminal
- WHEN `getError()` is called
- THEN it returns an object whose `terminal` is `false`

#### Scenario: Repeated getError() calls return one identical object while unchanged

- GIVEN a subscription holding an error
- WHEN `getError()` is called several times with no new error, open, or `retry()` in between
- THEN every call returns the very same object reference

#### Scenario: getError() is cleared to null on the next successful open

- GIVEN a subscription holding an error
- WHEN the channel opens successfully again
- THEN `getError()` returns `null`

#### Scenario: retry() clears the retrievable error

- GIVEN a subscription in `"error"` status holding an error
- WHEN `retry()` is called
- THEN `getError()` returns `null` while the channel re-opens

### Requirement: Status machine is idle → connecting → live, with error and closed, exposed via getStatus() and subscribe()

`getStatus()` MUST return one of exactly five states: `"idle"`, `"connecting"`, `"live"`,
`"error"`, `"closed"`. It MUST return `"idle"` until the first `subscribe(cb)` — constructing the
primitive MUST NOT open a channel, start a timer, or otherwise leave `"idle"` on its own. From the
first `subscribe(cb)` it MUST return `"connecting"` before the underlying channel opens (fresh open
or replayed already-open state), `"live"` once opened, `"error"` on a transport error, and
`"closed"` after `close()`. `subscribe(cb)` MUST invoke `cb` with the new status on every
transition and MUST NOT invoke `cb` for a repeated identical status.

#### Scenario: A constructed but unsubscribed primitive is inert at idle

- GIVEN a call to `createLiveSubscription({table, transport, onWake})` with no subscriber yet
  registered
- WHEN `getStatus()` is read and the transport's opened-connection count is inspected
- THEN `getStatus()` reads `"idle"`
- AND the transport has opened zero connections

#### Scenario: The first subscribe() starts connecting then transitions live

- GIVEN a call to `createLiveSubscription({table, transport, onWake})` against a transport that
  has not yet opened
- WHEN `getStatus()` is read immediately after the first `subscribe(cb)`, then again after the
  transport reports open
- THEN it reads `"connecting"` first and `"live"` second

#### Scenario: A subscribed callback is notified once per transition, not per identical status

- GIVEN a subscriber registered via `subscribe(cb)` while the channel is already `"live"`
- WHEN the underlying channel signals open again for an unrelated resync at the same status
- THEN `cb` is not called a second time for a status that did not change

### Requirement: A transport error sets status to error and is never silently swallowed; only transient errors may exit it automatically

On the transport's `onError`, the primitive MUST set status to `"error"` and MUST make the
triggering error retrievable by a subscriber. After a **terminal** error (classified per the
Requirement below) status MUST NOT revert from `"error"` to `"live"` except through an explicit
`retry()` call. After a transient error the transport's own backoff MAY reopen the channel and
return status to `"live"` without a `retry()` call; that recovery is the only permitted automatic
exit from `"error"`.

#### Scenario: A terminal transport error transitions to error and stays there

- GIVEN a live subscription in `"live"` status
- WHEN the transport reports a terminal error
- THEN `getStatus()` reads `"error"`, and status does not return to `"live"` on its own

### Requirement: Transport errors are classified terminal or transient, and only terminal stops the retry loop

Every transport error MUST be classified. An HTTP response status that is not 2xx and is not 5xx,
408, or 429 MUST be classified **terminal**: the transport's retry loop MUST stop and MUST NOT
schedule a further connect attempt, and the error MUST be retrievable by a subscriber as terminal.
A 5xx, 408, or 429 response, a stream that ends, and a `fetch` rejection (`TypeError`) MUST be
classified **transient**: the retry loop MUST continue with backoff. A `fetch` `TypeError` MUST NOT
be classified terminal even though a cross-origin rejection can produce it, because in a browser a
CORS rejection and an offline network are indistinguishable at that call site. `retry()` is
channel-level — it revives every listener sharing that table's channel, not only the caller — and
MUST be a no-op unless the current status is `"error"`.

#### Scenario: A non-2xx that is not 5xx/408/429 is terminal and halts retrying

- GIVEN a subscription whose transport receives a `404` response to its connect attempt
- WHEN the transport's retry loop is given more than its backoff interval to act
- THEN the error is observable to a subscriber as terminal
- AND no further connect attempt is made

#### Scenario: 5xx, stream end, and a fetch TypeError stay transient and keep retrying

- GIVEN a subscription whose transport receives a `500` response, then a stream end, then a `fetch`
  rejection with a `TypeError`
- WHEN each is given more than its backoff interval to act
- THEN none of the three is classified terminal
- AND the transport makes a further connect attempt after each

#### Scenario: Every status named terminal by this Requirement is classified terminal at runtime

- GIVEN a transport receiving each of `400`, `401`, `403`, `404` and `410` in turn
- WHEN each is given more than its backoff interval to act
- THEN each one is classified terminal exactly once
- AND none of them makes a further connect attempt

#### Scenario: Every status named transient by this Requirement is classified transient at runtime

- GIVEN a transport receiving each of `408`, `429`, `500` and `502` in turn
- WHEN each is given more than its backoff interval to act
- THEN none of them is classified terminal — `408` and `429` stay transient despite being 4xx
- AND each one makes a further connect attempt

### Requirement: retry() re-opens a channel from error and is a no-op outside error

`retry()` MUST, when status is `"error"`, close any stale channel and re-open the subscription,
transitioning status back through `"connecting"`. `retry()` called while status is `"connecting"`
or `"live"` MUST be a no-op — it MUST NOT close and reopen an already-healthy channel.

#### Scenario: retry() from error re-opens the channel

- GIVEN a subscription in `"error"` status
- WHEN `retry()` is called and the transport's next connect attempt succeeds
- THEN status transitions to `"connecting"` and then to `"live"`

#### Scenario: retry() while live is a no-op

- GIVEN a subscription in `"live"` status
- WHEN `retry()` is called
- THEN no new channel open occurs and status remains `"live"` throughout

### Requirement: onWake fires through a first-wake-armed fixed debounce window, never re-armed within the same burst

On the first wake after an idle period, the primitive MUST arm a single fixed trailing timer of
`debounceMs` (default matching the existing 50ms constant). A subsequent wake arriving before that
timer fires MUST NOT reset or extend the timer. Only when the timer fires MUST the caller's
`onWake` be invoked, exactly once for the whole burst. This is a deliberate anti-starvation
choice: a debounce that resets on every wake can be starved indefinitely under sustained writes.

#### Scenario: A burst of wakes inside the window produces exactly one onWake call

- GIVEN a live subscription with `debounceMs: 50`
- WHEN 5 wake signals arrive from the transport within a 50ms span, each after the previous but
  before the timer elapses
- THEN `onWake` is called exactly once, at the elapsed time of the FIRST wake's timer — not
  extended by the later four

#### Scenario: Wakes separated by more than the window each trigger their own call

- GIVEN a live subscription with `debounceMs: 50`
- WHEN two wake signals arrive more than 50ms apart
- THEN `onWake` is called twice, once per wake

### Requirement: close() is idempotent and stops all future delivery

`close()` MUST release the underlying channel subscription. Calling `close()` more than once MUST
NOT throw and MUST have no additional effect. After `close()`, no further `onWake` invocation or
`subscribe` callback delivery MUST occur, even for a wake already in flight.

#### Scenario: Calling close() twice does not throw

- GIVEN a subscription that has already been closed once
- WHEN `close()` is called a second time
- THEN no error is thrown and no further side effect occurs

#### Scenario: A wake in flight at close time never reaches onWake

- GIVEN a pending debounce timer scheduled by an earlier wake
- WHEN `close()` is called before the timer elapses
- THEN `onWake` is never invoked for that pending wake

### Requirement: The primitive is SSR-inert until a caller starts it in a client environment

Importing the module exporting `createLiveSubscription` MUST NOT touch `window` or `document` or
open any network connection at module load time. A connection opens only when
`createLiveSubscription()` itself is called.

#### Scenario: Importing the module under Node with no DOM globals does not throw

- GIVEN a Node process with no `window` or `document` global defined
- WHEN the module exporting `createLiveSubscription` is imported
- THEN the import succeeds and no network connection is opened
