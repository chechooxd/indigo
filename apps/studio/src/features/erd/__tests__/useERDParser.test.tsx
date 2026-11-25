/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// `@indigodb/core` pulls in the real WASM compiler, unavailable in this
// jsdom/Vitest environment (see `app/__tests__/App.test.tsx` for the same
// stub). `IndigoParseError` is redefined as a real class inside the factory
// (hoisting forbids referencing an outer import) so `instanceof` inside the
// hook still narrows correctly — both the hook and this test import it from
// this same mocked module, which is all `instanceof` needs.
vi.mock('@indigodb/core', () => {
  class IndigoParseError extends Error {
    constructor(
      message: string,
      public readonly errors: Array<{
        message: string;
        line?: number;
        column?: number;
        endLine?: number;
        endColumn?: number;
      }>,
    ) {
      super(message);
      this.name = 'IndigoParseError';
    }
  }
  return {
    parse: vi.fn(),
    resolve: vi.fn(),
    validate: vi.fn(),
    IndigoParseError,
  };
});

import { parse, resolve, validate, IndigoParseError } from '@indigodb/core';
import { useERDParser } from '../hooks/useERDParser';

const EMPTY_RESOLVED = { tables: [], refs: [], tableGroups: [], enums: [] } as never;

describe('useERDParser diagnostics', () => {
  beforeEach(() => {
    vi.mocked(parse).mockReset();
    vi.mocked(resolve).mockReset();
    vi.mocked(validate).mockReset();
  });

  it('SD-1: a syntax error produces one diagnostic with the exact reported position', async () => {
    vi.mocked(parse).mockImplementation(() => {
      throw new IndigoParseError('Parse errors found in .indigo schema', [
        { message: 'Unexpected token', line: 4, column: 3, endLine: 4, endColumn: 9 },
      ]);
    });

    const { result } = renderHook(({ code }) => useERDParser(code), {
      initialProps: { code: 'model Broken {' },
    });

    await waitFor(() => expect(result.current.diagnostics).toHaveLength(1));

    expect(result.current.diagnostics[0]).toEqual({
      source: 'parse',
      message: 'Unexpected token',
      line: 4,
      column: 3,
      endLine: 4,
      endColumn: 9,
    });
  });

  it('fixing the error clears its marker — the diagnostic disappears, not merely superseded', async () => {
    vi.mocked(parse).mockImplementationOnce(() => {
      throw new IndigoParseError('Parse errors found in .indigo schema', [
        { message: 'Unexpected token', line: 1, column: 1, endLine: 1, endColumn: 2 },
      ]);
    });

    const { result, rerender } = renderHook(({ code }) => useERDParser(code), {
      initialProps: { code: 'model Broken {' },
    });

    await waitFor(() => expect(result.current.diagnostics).toHaveLength(1));

    vi.mocked(parse).mockReturnValue({} as never);
    vi.mocked(validate).mockReturnValue([]);
    vi.mocked(resolve).mockReturnValue(EMPTY_RESOLVED);

    rerender({ code: 'model Fixed { id Int @id }' });

    await waitFor(() => expect(result.current.diagnostics).toHaveLength(0));
  });

  it('SD-2: a validation error produces one position-less diagnostic and zero markers', async () => {
    vi.mocked(parse).mockReturnValue({} as never);
    vi.mocked(validate).mockReturnValue([{ message: 'Duplicate model name', model: 'User' }]);

    const { result } = renderHook(({ code }) => useERDParser(code), {
      initialProps: { code: 'model User {}\nmodel User {}' },
    });

    await waitFor(() => expect(result.current.diagnostics).toHaveLength(1));

    const [diagnostic] = result.current.diagnostics;
    expect(diagnostic.source).toBe('validate');
    expect(diagnostic.line).toBeUndefined();
    expect(diagnostic.message).toBe('Duplicate model name');
  });

  it('strengthened SD-2: no marker is fabricated via name search or at line 1', async () => {
    const buffer = 'model User {}\nmodel User {}';
    vi.mocked(parse).mockReturnValue({} as never);
    vi.mocked(validate).mockReturnValue([{ message: 'Duplicate model name', model: 'User' }]);

    const { result } = renderHook(({ code }) => useERDParser(code), {
      initialProps: { code: buffer },
    });

    await waitFor(() => expect(result.current.diagnostics).toHaveLength(1));

    const [diagnostic] = result.current.diagnostics;
    // No text-search inference and no line-1 anchoring: every position field
    // stays undefined even though "User" appears at a real line in the
    // buffer and line 1 is a plausible guessed fallback.
    expect(diagnostic.line).toBeUndefined();
    expect(diagnostic.column).toBeUndefined();
    expect(diagnostic.endLine).toBeUndefined();
    expect(diagnostic.endColumn).toBeUndefined();
  });
});
