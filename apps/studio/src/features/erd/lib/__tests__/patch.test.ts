/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// `@indigodb/core` pulls in the real WASM compiler, unavailable in this
// jsdom/Vitest environment (see `useERDParser.test.tsx`). `parseWithSpans`
// is stubbed with a deterministic, regex-based span locator built directly
// from the exact fixture text each test passes in, so `start`/`end` here
// are genuine offsets into that string, not hand-typed magic numbers.
// `IndigoParseError` is redefined as a real class inside the factory
// (hoisting forbids referencing an outer import) so `instanceof` inside the
// module under test still narrows correctly.
vi.mock('@indigodb/core', () => {
  class IndigoParseError extends Error {
    constructor(
      message: string,
      public readonly errors: Array<{ message: string }>,
    ) {
      super(message);
      this.name = 'IndigoParseError';
    }
  }
  return {
    parseWithSpans: vi.fn(),
    IndigoParseError,
  };
});

import { parseWithSpans, IndigoParseError } from '@indigodb/core';
import { applyEdits, applyErdEdit } from '../patch';
import type { ErdEdit } from '../patch';

const dummySpan = { start: 0, end: 0, line: 1, column: 1, endLine: 1, endColumn: 1 };

/**
 * Builds a minimal `SpanIndex` from real string offsets in `source`, one
 * `ModelSpan` per `Table <name>` declaration found. Only `nameToken` carries
 * real offsets — the only field `applyErdEdit`'s `renameTable` case reads.
 */
function buildSpanIndex(source: string) {
  const models: Array<{
    name: string;
    decl: typeof dummySpan;
    nameToken: { start: number; end: number; line: number; column: number; endLine: number; endColumn: number };
    bodyOpen: typeof dummySpan;
    bodyClose: typeof dummySpan;
    fields: never[];
    attributes: never[];
  }> = [];
  const re = /Table\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const name = match[1];
    const start = match.index + match[0].length - name.length;
    const end = start + name.length;
    models.push({
      name,
      decl: dummySpan,
      nameToken: { start, end, line: 1, column: 1, endLine: 1, endColumn: 1 },
      bodyOpen: dummySpan,
      bodyClose: dummySpan,
      fields: [],
      attributes: [],
    });
  }
  return { models };
}

const COMBINED_FIXTURE = readFileSync(
  path.resolve(__dirname, './fixtures/combined.indigo'),
  'utf8',
);

function mockRealParse(source: string): void {
  vi.mocked(parseWithSpans).mockReturnValue({
    schema: {} as never,
    spans: buildSpanIndex(source) as never,
  });
}

beforeEach(() => {
  vi.mocked(parseWithSpans).mockReset();
});

describe('applyEdits', () => {
  it('splices non-overlapping edits right-to-left, leaving untouched bytes verbatim', () => {
    const result = applyEdits('Table Foo {\n  id Int @id\n}\n', [
      { start: 6, end: 9, text: 'Bar' },
    ]);
    expect(result).toBe('Table Bar {\n  id Int @id\n}\n');
  });

  it('RED/mutation: throws on overlapping edit ranges', () => {
    expect(() =>
      applyEdits('0123456789', [
        { start: 0, end: 5, text: 'x' },
        { start: 3, end: 7, text: 'y' },
      ]),
    ).toThrow(/overlapping/i);
  });

  it('does not throw for adjacent, non-overlapping ranges', () => {
    expect(() =>
      applyEdits('0123456789', [
        { start: 0, end: 3, text: 'a' },
        { start: 3, end: 6, text: 'b' },
      ]),
    ).not.toThrow();
  });
});

describe('applyErdEdit — untouched-by-construction (D4)', () => {
  it('renaming an unrelated table leaves @@allow, @@realtime(columns:), TableGroup, comments and irregular whitespace byte-identical', () => {
    mockRealParse(COMBINED_FIXTURE);

    const edit: ErdEdit = { kind: 'renameTable', from: 'Widget', to: 'Gadget' };
    const result = applyErdEdit(COMBINED_FIXTURE, edit);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');

    const expected = COMBINED_FIXTURE.replace('Table   Widget {', 'Table   Gadget {');
    expect(result.text).toBe(expected);

    // Byte-diff confinement, stated explicitly rather than inferred from
    // equality above: everything except the renamed token is identical.
    expect(result.text).toContain('@@allow(read, auth.userId == this.ownerId)');
    expect(result.text).toContain('@@realtime(columns: [id, email])');
    expect(result.text).toContain('TableGroup "Billing" {');
    expect(result.text).toContain('// A table carrying a row-level access rule.');
    expect(result.text).toContain('\tlabel String');
  });
});

describe('applyErdEdit — staleness gate (D3)', () => {
  it('a fresh-parse failure refuses the edit as parse-failed, buffer untouched', () => {
    vi.mocked(parseWithSpans).mockImplementation(() => {
      throw new IndigoParseError('Parse errors found in .indigo schema', [
        { message: 'Unexpected token' },
      ]);
    });

    const currentText = 'Table Broken {\n';
    const result = applyErdEdit(currentText, { kind: 'renameTable', from: 'Broken', to: 'Fixed' });

    expect(result).toEqual({
      ok: false,
      reason: 'parse-failed',
      message: 'Parse errors found in .indigo schema',
    });
  });

  it('a missing anchor after an intervening edit refuses the patch as anchor-missing, buffer untouched', () => {
    const currentText = 'Table Post {\n  id Int @id\n}\n';
    // The fresh parse reflects a buffer where `User` (the rename target)
    // has already been removed by an intervening edit — it is absent from
    // the fresh SpanIndex, so there is no stale span to fall back to.
    mockRealParse(currentText);

    const result = applyErdEdit(currentText, { kind: 'renameTable', from: 'User', to: 'Account' });

    expect(result).toEqual({
      ok: false,
      reason: 'anchor-missing',
      message: 'Table "User" was not found in the current buffer.',
    });
  });

  it('an unchanged buffer applies the patch normally', () => {
    const currentText = 'Table Post {\n  id Int @id\n}\n';
    mockRealParse(currentText);

    const result = applyErdEdit(currentText, { kind: 'renameTable', from: 'Post', to: 'Article' });

    expect(result).toEqual({ ok: true, text: 'Table Article {\n  id Int @id\n}\n' });
  });
});

describe('patch module export surface (D3 enforceability guard)', () => {
  it('RED/mutation: exposes exactly applyEdits and applyErdEdit — no export returns a SpanIndex or span', async () => {
    const patchModule = await import('../patch');
    const exportedKeys = Object.keys(patchModule).sort();

    expect(exportedKeys).toEqual(['applyEdits', 'applyErdEdit']);
    expect(exportedKeys).not.toContain('parseWithSpans');
    expect(exportedKeys).not.toContain('SpanIndex');
  });
});
