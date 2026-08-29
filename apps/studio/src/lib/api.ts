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

/** Page size options the server accepts (see @indigodb/cli's `studio-server.ts`). */
export const PAGE_SIZES = [25, 50, 100, 200] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export interface FetchTableRowsOptions {
  cursor?: string | null;
  direction?: 'forward' | 'backward';
  limit?: PageSize;
}

export interface TablePage {
  columns: string[];
  rows: Record<string, unknown>[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  /** `false` for a PK-less table: a single unpaginated page, no stable cursor key. */
  paginated: boolean;
}

let backendAvailable: boolean | null = null;

export function isBackendAvailable(): boolean {
  return backendAvailable === true;
}

export interface AuthStatus {
  authRequired: boolean;
  authenticated: boolean;
}

export interface LoginResult {
  ok: boolean;
  error?: string;
}

/**
 * Fired whenever any `/api/*` call answers 401, mid-session (session expiry
 * or a revoked/tampered cookie). This is a backstop, not the primary auth
 * detection mechanism — the startup `fetchAuthStatus()` probe (driven by
 * `useAuthStore.checkStatus`) is. Registered by `useAuthStore` itself so this
 * module never imports the store back (would be circular).
 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

function notifyIfUnauthorized(res: Response): void {
  if (res.status === 401) onUnauthorized?.();
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
    notifyIfUnauthorized(res);
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
    notifyIfUnauthorized(res);
    if (!res.ok || !hasContentType(res, 'text/plain')) throw new Error();
    return await res.text();
  } catch {
    return null;
  }
}

export async function fetchTableRows(
  name: string,
  options?: FetchTableRowsOptions,
): Promise<TablePage | null> {
  try {
    const params = new URLSearchParams();
    if (options?.cursor) params.set('cursor', options.cursor);
    if (options?.direction) params.set('direction', options.direction);
    if (options?.limit) params.set('limit', String(options.limit));
    const qs = params.toString();
    const res = await fetch(`/api/tables/${encodeURIComponent(name)}${qs ? `?${qs}` : ''}`);
    notifyIfUnauthorized(res);
    if (!res.ok || !hasContentType(res, 'application/json')) throw new Error();
    return (await res.json()) as TablePage;
  } catch {
    return null;
  }
}

/**
 * Updates one row, identified by primary key. `pk` and `patch` are both
 * keyed by schema field name (not the physical `dbName`), matching
 * `fetchTableRows`'s aliasing. Returns the persisted row on success; throws
 * with the server's error message otherwise.
 */
export async function updateRow(
  table: string,
  pk: Record<string, unknown>,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/rows/${encodeURIComponent(table)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pk, patch }),
  });
  notifyIfUnauthorized(res);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? 'Update failed');
  return body.row as Record<string, unknown>;
}

/**
 * Inserts a new row. `values` is the full set of column values for the row,
 * keyed by schema field name, minus any generated/autoincrement primary key
 * column — the server rejects one if supplied. Returns the persisted row
 * (including any database-generated primary key) on success; throws with
 * the server's error message otherwise.
 */
export async function createRow(
  table: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/rows/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(values),
  });
  notifyIfUnauthorized(res);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? 'Create failed');
  return body.row as Record<string, unknown>;
}

/**
 * Deletes one row, identified by primary key. `pk` is keyed by schema field
 * name (not the physical `dbName`), matching `updateRow`'s `pk` shape.
 * Throws with the server's error message on failure (including "no row
 * matched", surfaced as a 404).
 */
export async function deleteRow(table: string, pk: Record<string, unknown>): Promise<void> {
  const res = await fetch(`/api/rows/${encodeURIComponent(table)}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pk }),
  });
  notifyIfUnauthorized(res);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? 'Delete failed');
  }
}

export async function runQuery(sql: string): Promise<QueryResult> {
  const res = await fetch('/api/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  notifyIfUnauthorized(res);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? 'Query failed');
  return body as QueryResult;
}

/**
 * Auth status probe (see @indigodb/cli's studio-server.ts `/api/auth/status`
 * route). Always ungated, and always answers even with no password
 * configured (`{authRequired:false}`). Fails soft to `null` in standalone dev
 * (no backend) — treated by `useAuthStore` the same as "no gate".
 */
export async function fetchAuthStatus(): Promise<AuthStatus | null> {
  try {
    const res = await fetch('/api/auth/status');
    if (!res.ok || !hasContentType(res, 'application/json')) throw new Error();
    return (await res.json()) as AuthStatus;
  } catch {
    return null;
  }
}

/**
 * Submits the shared Studio password. Never throws: both outcomes are
 * regular return values so the login screen can show an inline error
 * without a try/catch at the call site. The server returns an identical
 * body for a wrong password and for auth being unconfigured, so this
 * mirrors that: no `login`-side hint beyond the message itself.
 */
export async function login(password: string): Promise<LoginResult> {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body?.error ?? 'Invalid password' };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Invalid password' };
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    // Fail soft, matching every other call in this module — a network
    // failure here still lets the client-side session state clear locally.
  }
}
