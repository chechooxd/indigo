# Studio app and its CLI server

Loaded when working under `apps/studio/`. The CLI-side server lives at
`packages/cli/src/studio-server.ts`; it is documented here because it exists to serve
this app. The root `CLAUDE.md` carries the commands, CI workflow, and conventions.

### Studio app (`apps/studio`)
React 19 + Vite + Tailwind v4 + Zustand SPA. **It now depends on `@indigodb/core`** and parses
the single `.indigo` dialect in-browser (`useERDParser` → `parse`+`resolve`), adapting the IR via
`src/lib/schema-adapter.ts`. `src/lib/api.ts` talks to the `indigodb studio` backend
(`/api/schema`, `/api/schema/source`, `/api/tables/:name`, `/api/query`) and **fails soft**:
standalone `pnpm dev` has no backend, so components fall back to mock data (`src/data/mockData.ts`).
The old regex parser in `src/lib/parser.ts` now only provides the ERD view-model types.

Studio internals: single Zustand store (`src/store/useStudioStore.ts`, which also holds the
`resolvedSchema` used by `DocBrowser.tsx` for real relations); `@/` alias → `apps/studio/src`;
shadcn-style UI in `src/components/ui/`; feature modules in `src/features/` (`erd/` renders with
**React Flow** (`@xyflow/react`) — `ERDCanvas.tsx` plus `components/TableNode.tsx` and
`components/GroupNode.tsx` as custom node types, graph assembly in `lib/build-graph.ts`, node
sizing in `src/shared/lib/node-geometry.ts`. It was a hand-rolled SVG canvas with its own
orthogonal edge routing in `src/lib/routing.ts`; that file is gone and so is the routing code —
React Flow owns edges now. `TableNode.tsx`'s per-field `Handle`s carry `isConnectable={false}`:
live connection seams deliberately switched off, not dead scaffolding. `studio/browser/` = data
browser);
i18n via `react-i18next` (`src/i18n/locales/` en/es). `studio/browser/hooks/useLiveTable.ts`
gives the Table Browser its live-refresh: it opens `@indigodb/client`'s `SseTransport` directly
against `REALTIME_PATH` for the active `@@realtime` table and debounces/coalesces a refetch on
each change — this is Studio's own dev-only connection to the **embedded, unauthenticated**
realtime stream, separate from (and simpler than) the generated client's `.live()`, which is
gated behind `@@allow` + a signed handle.

### CLI Studio server (`packages/cli/src/studio-server.ts`)
`indigodb studio` starts a `node:http` server that serves the built Studio SPA (located via
`require.resolve("@indigodb/studio/package.json")` → `dist`, overridable with `INDIGODB_STUDIO_DIST`)
plus the JSON API backed by the user's Postgres. `/api/query` only permits a single read-only
SELECT/WITH; `/api/tables/:name` aliases physical columns back to schema field names.
