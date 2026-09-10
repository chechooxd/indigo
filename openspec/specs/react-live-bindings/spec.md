# React Live Bindings Specification

## Purpose

Defines `@indigodb/react`'s `useLiveTable(table, {onWake})` hook: a `useSyncExternalStore`
binding over `createLiveSubscription()`, returning `{status, error, retry}`. Owns no rows, no
cache, and no fetcher — it exists solely to make `useSyncExternalStore`'s subscribe-identity and
snapshot-stability rules hard to get wrong.

## Requirements

### Requirement: The hook returns exactly `{status, error, retry}` and owns no data

`useLiveTable(table, options)` MUST return an object with exactly `status`, `error`, and `retry`.
It MUST NOT return rows, a query result, or any cache-shaped value.

#### Scenario: Return shape has no data field

- GIVEN a component calling `useLiveTable("Order", { onWake })`
- WHEN the returned object's keys are inspected
- THEN only `status`, `error`, and `retry` are present

### Requirement: The hook is built on useSyncExternalStore with a stable subscribe identity

`useLiveTable` MUST use `useSyncExternalStore` with a `subscribe` function that does not change
identity across re-renders for the same `table`, and MUST NOT create a new underlying
`createLiveSubscription` call on every render. The subscription MUST be created once per mount
(or StrictMode double-mount pair) for a given `table`.

#### Scenario: Re-rendering with unchanged props does not create a second subscription

- GIVEN a mounted `useLiveTable("Order", { onWake })` and no prop change
- WHEN the host component re-renders 3 times
- THEN exactly one underlying `createLiveSubscription` call remains active

### Requirement: The hook is SSR-safe — no `window` access during render or module load

Calling `useLiveTable` during server rendering MUST NOT throw and MUST NOT touch `window` or open
a network connection; it MUST report a connecting/inert status without ever transitioning until
hydrated on the client.

#### Scenario: Rendering to a string on the server does not throw

- GIVEN a React server-rendering pass (no `window` global) rendering a component that calls
  `useLiveTable("Order", { onWake })`
- WHEN the render completes
- THEN it completes without throwing and opens no network connection

### Requirement: StrictMode's mount/unmount/remount double-invoke leaves exactly one live subscription

Under React StrictMode's development double-invoke of effects, mounting, unmounting, and
remounting `useLiveTable` for the same table MUST leave exactly one open underlying connection.

#### Scenario: StrictMode double-invoke leaves one connection, not two

- GIVEN React StrictMode's mount → cleanup → re-mount cycle for a component calling
  `useLiveTable("Order", { onWake })`
- WHEN the cycle completes
- THEN exactly one underlying subscription remains open on table `Order`

### Requirement: A terminal transport error surfaces via `error` and `status: "error"`, with `retry()` recovering it

When the underlying subscription's status becomes `"error"`, the hook MUST expose the triggering
error via `error` alongside `status: "error"`. Calling the returned `retry()` MUST invoke the
underlying primitive's `retry()` and MUST NOT throw.

#### Scenario: A transport error is observable and retry() recovers it

- GIVEN `useLiveTable("Order", { onWake })` whose underlying subscription enters `"error"` after a
  transport failure
- WHEN the component reads `status` and `error`, then calls `retry()`, and the transport
  subsequently reconnects
- THEN `status` reads `"error"` with a non-null `error` before `retry()`, and `status` transitions
  back to `"live"` after `retry()` succeeds

### Requirement: Unmounting closes the subscription

Unmounting the component using `useLiveTable` MUST close its underlying subscription, subject to
the connection manager's refcounting across other subscribers of the same table.

#### Scenario: Unmounting the sole consumer of a table closes the connection

- GIVEN one component instance is the only `useLiveTable("Order", ...)` consumer
- WHEN it unmounts
- THEN the underlying SSE connection for `Order` closes
