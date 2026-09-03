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

/** Returns the exclusive end offset of the `{` opened at `openIndex`, by counting brace depth. */
function findMatchingBraceEnd(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error(`unbalanced braces in fixture starting at offset ${openIndex}`);
}

/**
 * Builds a minimal `SpanIndex` from real string offsets in `source`, one
 * `ModelSpan` per `Table <name>` declaration found. `nameToken` (read by
 * `renameTable`) and `bodyOpen`/`bodyClose` (`bodyClose.end` read by
 * `addTable`'s anchor) carry real offsets computed from `source` itself,
 * not hand-typed magic numbers; `decl`/`fields`/`attributes` stay unused
 * by both edit kinds under test, so they stay stubbed.
 */
function buildSpanIndex(source: string) {
  const models: Array<{
    name: string;
    decl: typeof dummySpan;
    nameToken: { start: number; end: number; line: number; column: number; endLine: number; endColumn: number };
    bodyOpen: { start: number; end: number; line: number; column: number; endLine: number; endColumn: number };
    bodyClose: { start: number; end: number; line: number; column: number; endLine: number; endColumn: number };
    fields: never[];
    attributes: never[];
  }> = [];
  const re = /Table\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const name = match[1];
    const nameStart = match.index + match[0].indexOf(name);
    const nameEnd = nameStart + name.length;
    const bodyOpenStart = match.index + match[0].length - 1;
    const bodyOpenEnd = bodyOpenStart + 1;
    const bodyCloseEnd = findMatchingBraceEnd(source, bodyOpenStart);
    models.push({
      name,
      decl: dummySpan,
      nameToken: { start: nameStart, end: nameEnd, line: 1, column: 1, endLine: 1, endColumn: 1 },
      bodyOpen: { start: bodyOpenStart, end: bodyOpenEnd, line: 1, column: 1, endLine: 1, endColumn: 1 },
      bodyClose: {
        start: bodyCloseEnd - 1,
        end: bodyCloseEnd,
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 1,
      },
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

  it('adding a table inserts after the last model, leaving @@allow, @@realtime(columns:), TableGroup, comments and irregular whitespace byte-identical (mutation target: off-by-one anchor)', () => {
    mockRealParse(COMBINED_FIXTURE);

    const edit: ErdEdit = { kind: 'addTable', name: 'Invoice' };
    const result = applyErdEdit(COMBINED_FIXTURE, edit);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');

    // The anchor is computed independently here (string search, not reused
    // production logic): right after the LAST model's (`ProjectedUser`)
    // closing `}`, before the blank line and `TableGroup` block that follow
    // it in the fixture.
    const lastModelClose = '@@realtime(columns: [id, email])\n}';
    const anchor = COMBINED_FIXTURE.indexOf(lastModelClose) + lastModelClose.length;
    const insertion = '\n\nTable Invoice {\n  id Int @id\n}';
    const expected =
      COMBINED_FIXTURE.slice(0, anchor) + insertion + COMBINED_FIXTURE.slice(anchor);
    expect(result.text).toBe(expected);

    // Byte-diff confinement: an off-by-one anchor (e.g. inserting at
    // `bodyClose.end + 1` instead of `bodyClose.end`) would consume the
    // first byte of the blank line separating `ProjectedUser` from
    // `TableGroup`, reaching into content adjacent to that construct —
    // this assertion on the exact expected string catches that class of
    // bug, and the constructs below are asserted individually too.
    expect(result.text).toContain('@@allow(read, auth.userId == this.ownerId)');
    expect(result.text).toContain('@@realtime(columns: [id, email])');
    expect(result.text).toContain('TableGroup "Billing" {');
    expect(result.text).toContain('// A table carrying a row-level access rule.');
    expect(result.text).toContain('\tlabel String');
    expect(result.text).toContain('Table Invoice {\n  id Int @id\n}');
  });

  it('adding a table to a buffer that declares no tables appends at the end of the buffer (mutation target: fallback anchor)', () => {
    // No `Table <name> {` declaration anywhere, so `spans.models` is empty
    // and the anchor falls back to `currentText.length`. The buffer still
    // carries a construct the ERD does not model, to prove the fallback is
    // an append rather than a prepend or a rewrite.
    const currentText = '// no tables declared yet\nTableGroup "Billing" {\n  color = "#fff"\n}\n';
    mockRealParse(currentText);

    const result = applyErdEdit(currentText, { kind: 'addTable', name: 'Invoice' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');

    expect(result.text).toBe(currentText + '\n\nTable Invoice {\n  id Int @id\n}');
    // Stated explicitly: a fallback anchor of anything other than the end
    // of the buffer (e.g. offset 0) would break this prefix relation.
    expect(result.text.startsWith(currentText)).toBe(true);
    expect(result.text).toContain('// no tables declared yet\nTableGroup "Billing" {');
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

  it('a fresh-parse failure refuses addTable as parse-failed — never anchor-missing, since an insertion has no anchor to miss', () => {
    vi.mocked(parseWithSpans).mockImplementation(() => {
      throw new IndigoParseError('Parse errors found in .indigo schema', [
        { message: 'Unexpected token' },
      ]);
    });

    const currentText = 'Table Broken {\n';
    const result = applyErdEdit(currentText, { kind: 'addTable', name: 'Invoice' });

    expect(result).toEqual({
      ok: false,
      reason: 'parse-failed',
      message: 'Parse errors found in .indigo schema',
    });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).not.toBe('anchor-missing');
    // Buffer untouched: the refusal carries no replacement text at all.
    expect('text' in result).toBe(false);
    expect(currentText).toBe('Table Broken {\n');
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

  it('an unchanged buffer applies addTable normally (positive control)', () => {
    const currentText = 'Table Post {\n  id Int @id\n}\n';
    mockRealParse(currentText);

    const result = applyErdEdit(currentText, { kind: 'addTable', name: 'Comment' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');

    const anchor = currentText.indexOf('}') + 1;
    const expected =
      currentText.slice(0, anchor) + '\n\nTable Comment {\n  id Int @id\n}' + currentText.slice(anchor);
    expect(result.text).toBe(expected);
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
