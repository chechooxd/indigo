/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchSchemaSource, saveSchemaSource, fetchLayout, saveLayout } from '../api';

describe('fetchSchemaSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns {source, version} from the body text and the version header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('model Foo {}', {
        status: 200,
        headers: { 'content-type': 'text/plain', 'X-Indigo-Schema-Version': 'abc123' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSchemaSource();

    expect(result).toEqual({ source: 'model Foo {}', version: 'abc123' });
  });

  it('resolves version: null when the server has no schemaPath (no header published)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('model Foo {}', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSchemaSource();

    expect(result).toEqual({ source: 'model Foo {}', version: null });
  });

  it('fails soft to null on a non-2xx or wrong content-type response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchSchemaSource()).toBeNull();
  });
});

describe('saveSchemaSource', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns {ok:true, version} on a 200 response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: true, version: 'v2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await saveSchemaSource('model Foo {}', 'v1');

    expect(result).toEqual({ ok: true, version: 'v2' });
  });

  it('returns a discriminated 409 result with the status and error, never throwing', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'stale' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await saveSchemaSource('model Foo {}', 'v1');

    expect(result).toEqual({ ok: false, status: 409, error: 'stale' });
  });

  it('returns 422 with parseErrors carried through, never throwing', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'invalid',
          parseErrors: [{ message: 'Unexpected token', line: 3, column: 1, endLine: 3, endColumn: 5 }],
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await saveSchemaSource('model Foo {', 'v1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.parseErrors).toEqual([
        { message: 'Unexpected token', line: 3, column: 1, endLine: 3, endColumn: 5 },
      ]);
    }
  });

  it('never throws on a network failure — returns a discriminated failure result instead', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));

    const result = await saveSchemaSource('model Foo {}', 'v1');

    expect(result.ok).toBe(false);
    expect(await saveSchemaSource('model Foo {}', 'v1')).toEqual(result);
  });
});

describe('fetchLayout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns {positions, version} from a 200 JSON response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ positions: { User: { x: 1, y: 2 } }, version: 'v1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchLayout();

    expect(result).toEqual({ positions: { User: { x: 1, y: 2 } }, version: 'v1' });
    expect(fetchMock).toHaveBeenCalledWith('/api/schema/layout');
  });

  it('resolves the null-sentinel shape verbatim when no sidecar exists yet', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ positions: {}, version: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchLayout();

    expect(result).toEqual({ positions: {}, version: null });
  });

  it('fails soft to null on a non-2xx or wrong content-type response (standalone dev, no backend)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchLayout()).toBeNull();
  });

  it('fails soft to null on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    expect(await fetchLayout()).toBeNull();
  });
});

describe('saveLayout', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns {ok:true, version} on a 200 response, PUTting the submitted positions/version', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ version: 'v2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await saveLayout({ User: { x: 5, y: 6 } }, 'v1');

    expect(result).toEqual({ ok: true, version: 'v2' });
    expect(fetch).toHaveBeenCalledWith('/api/schema/layout', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ positions: { User: { x: 5, y: 6 } }, version: 'v1' }),
    });
  });

  it('returns a discriminated 409 result with the status and error, never throwing', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'stale' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await saveLayout({ User: { x: 5, y: 6 } }, 'v1');

    expect(result).toEqual({ ok: false, status: 409, error: 'stale' });
  });

  it('never throws on a network failure — returns a discriminated failure result instead', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));

    const result = await saveLayout({ User: { x: 5, y: 6 } }, 'v1');

    expect(result).toEqual({ ok: false, status: 0, error: 'Network error' });
  });
});
