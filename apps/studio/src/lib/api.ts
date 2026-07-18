/**
 * Studio API client.
 *
 * Talks to the `indigodb studio` backend (see @indigodb/cli studio-server).
 * Every call fails soft: when the Studio runs standalone (`pnpm dev`) there is
 * no backend, so these return null and the UI falls back to mock data.
 */

import type { ResolvedSchema } from '@indigodb/core';

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

let backendAvailable: boolean | null = null;

export function isBackendAvailable(): boolean {
  return backendAvailable === true;
}

/**
 * Standalone dev mode (`pnpm dev`) has no backend, so these API paths hit
 * Vite's own dev server instead — which has no route for them and, per Vite's
 * SPA fallback, answers with `index.html` and a 200 status rather than a 404.
 * A bare `res.ok` check can't tell that apart from a real API response, so
 * every fetch here also checks the content-type the real backend is known to
 * send (see @indigodb/cli's studio-server.ts) before trusting the body.
 */
function hasContentType(res: Response, expected: string): boolean {
  return (res.headers.get('content-type') ?? '').includes(expected);
}

export async function fetchSchema(): Promise<ResolvedSchema | null> {
  try {
    const res = await fetch('/api/schema');
    if (!res.ok || !hasContentType(res, 'application/json')) throw new Error();
    backendAvailable = true;
    return (await res.json()) as ResolvedSchema;
  } catch {
    backendAvailable = false;
    return null;
  }
}

export async function fetchSchemaSource(): Promise<string | null> {
  try {
    const res = await fetch('/api/schema/source');
    if (!res.ok || !hasContentType(res, 'text/plain')) throw new Error();
    return await res.text();
  } catch {
    return null;
  }
}

export async function fetchTableRows(name: string): Promise<QueryResult | null> {
  try {
    const res = await fetch(`/api/tables/${encodeURIComponent(name)}`);
    if (!res.ok || !hasContentType(res, 'application/json')) throw new Error();
    return (await res.json()) as QueryResult;
  } catch {
    return null;
  }
}

export async function runQuery(sql: string): Promise<QueryResult> {
  const res = await fetch('/api/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? 'Query failed');
  return body as QueryResult;
}
