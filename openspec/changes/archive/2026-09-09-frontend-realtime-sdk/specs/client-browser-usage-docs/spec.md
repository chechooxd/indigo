# Client Browser Usage Docs Specification

## Purpose

Defines what `packages/client/README.md` MUST state about the browser entry point, the wake-only
contract, and this change's stated non-goals, so a reader learns the whole browser story without
reading source.

## Requirements

### Requirement: The README names the browser entry point explicitly

`packages/client/README.md` MUST contain the literal string `@indigodb/client/realtime` in a
section describing browser usage, distinct from the root `@indigodb/client` entry's Node-only
description.

#### Scenario: README mentions the browser subpath

- GIVEN the current `packages/client/README.md`
- WHEN the file is searched for the literal string `@indigodb/client/realtime`
- THEN at least one match is found within a browser-usage section

### Requirement: The README states the wake-only contract in the browser section

The README's browser section MUST state that the SSE channel delivers wake/invalidation signals
only, and that no row data crosses it — mirroring `realtime-live-endpoint`'s fail-closed dispatch
contract.

#### Scenario: README states wake-only, no-row-data explicitly

- GIVEN the current `packages/client/README.md`'s browser section
- WHEN the section text is inspected
- THEN it explicitly states that the SSE stream carries no row data and only a wake signal

### Requirement: The README states the query non-goal from this change

The README MUST state, in its browser section, that IndigoDB does not provide a browser-side
query API and that queries must go through the application's own authenticated backend.

#### Scenario: README states the query non-goal

- GIVEN the current `packages/client/README.md`'s browser section
- WHEN the section text is inspected
- THEN it states that browser code cannot query IndigoDB directly and must go through the app's
  own backend

### Requirement: The README includes a worked TanStack Query recipe using `createLiveSubscription`

The README MUST include a code sample wiring `createLiveSubscription`'s `onWake` to
`queryClient.invalidateQueries`, demonstrating composition rather than SDK-owned data fetching.

#### Scenario: README's recipe invalidates via onWake

- GIVEN the current `packages/client/README.md`
- WHEN its TanStack Query recipe code sample is inspected
- THEN it calls `createLiveSubscription` with an `onWake` callback that calls
  `queryClient.invalidateQueries`
