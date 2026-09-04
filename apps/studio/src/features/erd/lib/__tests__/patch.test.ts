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
    resolve: vi.fn(),
    IndigoParseError,
  };
});

import { parseWithSpans, resolve, IndigoParseError } from '@indigodb/core';
import { applyEdits, applyErdEdit } from '../patch';
import type { ErdEdit } from '../patch';

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

type Span = { start: number; end: number; line: number; column: number; endLine: number; endColumn: number };

function fakeSpan(start: number, end: number): Span {
  return { start, end, line: 1, column: 1, endLine: 1, endColumn: 1 };
}

/**
 * Builds `FieldSpan`s for every simple `name Type[?]` line inside a model's
 * body (`[bodyOpenEnd, bodyCloseStart)`), by real string offsets — skips
 * blank lines, `@@`-prefixed block attributes and `//` comments. Only
 * covers the plain declarations the Phase 5 fixtures use; attributes are
 * left empty (unused by `addField`/`editField`/`deleteField`, which never
 * read `field.attributes`). `decl` spans the whole trimmed line (so it
 * includes any trailing `@id`-style attribute text), matching the real
 * parser's `decl_start..last_consumed_end` convention.
 */
function buildFieldSpans(source: string, bodyOpenEnd: number, bodyCloseStart: number) {
  const fields: Array<{ name: string; decl: Span; nameToken: Span; typeToken: Span; attributes: never[] }> = [];
  let cursor = bodyOpenEnd;
  const body = source.slice(bodyOpenEnd, bodyCloseStart);
  for (const line of body.split('\n')) {
    const lineStart = cursor;
    cursor += line.length + 1; // account for the split '\n'
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('@@') || trimmed.startsWith('//')) continue;
    const fieldMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\??/.exec(trimmed);
    if (!fieldMatch) continue;
    const leadingWs = line.length - line.trimStart().length;
    const nameStart = lineStart + leadingWs;
    const nameEnd = nameStart + fieldMatch[1].length;
    const typeStart = lineStart + line.indexOf(fieldMatch[2], leadingWs + fieldMatch[1].length);
    const typeEnd = typeStart + fieldMatch[2].length;
    const declEnd = lineStart + line.trimEnd().length;
    fields.push({
      name: fieldMatch[1],
      decl: fakeSpan(nameStart, declEnd),
      nameToken: fakeSpan(nameStart, nameEnd),
      typeToken: fakeSpan(typeStart, typeEnd),
      attributes: [],
    });
  }
  return fields;
}

/**
 * Builds a minimal `SpanIndex` from real string offsets in `source`, one
 * `ModelSpan` per `Table <name>` declaration found. `nameToken` (read by
 * `renameTable`), `bodyOpen`/`bodyClose` (`bodyClose.end` read by
 * `addTable`'s anchor, `bodyOpen.end` read by `addField`'s empty-table
 * anchor) and `decl` (the whole `Table <name> { ... }` block, read by
 * `deleteTable`) all carry real offsets computed from `source` itself, not
 * hand-typed magic numbers. `fields` (Phase 5) is computed by
 * `buildFieldSpans`; `attributes` stays unused by every edit kind under
 * test, so it stays stubbed.
 */
function buildSpanIndex(source: string) {
  const models: Array<{
    name: string;
    decl: Span;
    nameToken: Span;
    bodyOpen: Span;
    bodyClose: Span;
    fields: ReturnType<typeof buildFieldSpans>;
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
    const bodyCloseStart = bodyCloseEnd - 1;
    models.push({
      name,
      decl: fakeSpan(match.index, bodyCloseEnd),
      nameToken: fakeSpan(nameStart, nameEnd),
      bodyOpen: fakeSpan(bodyOpenStart, bodyOpenEnd),
      bodyClose: fakeSpan(bodyCloseStart, bodyCloseEnd),
      fields: buildFieldSpans(source, bodyOpenEnd, bodyCloseStart),
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

/**
 * Minimal `ResolvedTable`-shaped fixture for `deleteTable`'s IR-sourced
 * refusal (design D5). Only `name`/`dbName`/`foreignKeys` are read by the
 * production code under test; every other field is stubbed to satisfy the
 * type without asserting on it.
 */
function resolvedTable(name: string, foreignKeys: { columns: string[]; refTable: string }[] = []) {
  return {
    name,
    dbName: name,
    columns: [],
    primaryKey: [],
    foreignKeys,
    indexes: [],
    relations: [],
  };
}

function mockResolvedSchema(tables: ReturnType<typeof resolvedTable>[]): void {
  vi.mocked(resolve).mockReturnValue({
    tables,
    enums: [],
    tableGroups: [],
  } as never);
}

beforeEach(() => {
  vi.mocked(parseWithSpans).mockReset();
  vi.mocked(resolve).mockReset();
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

  it('renaming a referenced table leaves the referencing table\'s @relation(...) byte-unchanged (non-goal: relation propagation)', () => {
    // `Post.author` carries `@relation(fields: [authorId], references: [id])`
    // pointing at `User`. `renameTable` rewrites only `User`'s own name
    // token — task 4.2's mutation target is a rename that ALSO rewrites
    // `Post`'s `@relation(...)` attribute, which this fixture would catch:
    // that attribute text names `User`/`id` and must stay byte-identical.
    const source =
      'Table User {\n  id Int @id\n}\n\n' +
      'Table Post {\n  id Int @id\n  authorId Int\n  author User @relation(fields: [authorId], references: [id])\n}\n';
    mockRealParse(source);

    const result = applyErdEdit(source, { kind: 'renameTable', from: 'User', to: 'Author' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');

    expect(result.text).toContain('Table Author {\n  id Int @id\n}');
    // The exact, byte-unchanged relation attribute — still naming the
    // pre-rename identifier `User`, as this requirement's stated non-goal
    // demands.
    expect(result.text).toContain(
      'author User @relation(fields: [authorId], references: [id])',
    );
    expect(result.text).not.toContain('Table User {');
  });
});

describe('applyErdEdit — deleteTable (D5)', () => {
  it('deleting a table referenced by one other table is refused, naming the table and field', () => {
    const source = 'Table User {\n  id Int @id\n}\n\nTable Post {\n  id Int @id\n  authorId Int\n}\n';
    mockRealParse(source);
    mockResolvedSchema([
      resolvedTable('User'),
      resolvedTable('Post', [{ columns: ['authorId'], refTable: 'User' }]),
    ]);

    const result = applyErdEdit(source, { kind: 'deleteTable', name: 'User' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toBe('referenced');
    expect(result.message).toContain('Post');
    expect(result.message).toContain('authorId');
    // Buffer unchanged — no patch was applied when refused.
    expect('text' in result).toBe(false);
  });

  it('deleting a table referenced by multiple tables names all of them', () => {
    const source =
      'Table User {\n  id Int @id\n}\n\nTable Post {\n  id Int @id\n  authorId Int\n}\n\n' +
      'Table Comment {\n  id Int @id\n  userId Int\n}\n';
    mockRealParse(source);
    mockResolvedSchema([
      resolvedTable('User'),
      resolvedTable('Post', [{ columns: ['authorId'], refTable: 'User' }]),
      resolvedTable('Comment', [{ columns: ['userId'], refTable: 'User' }]),
    ]);

    const result = applyErdEdit(source, { kind: 'deleteTable', name: 'User' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toBe('referenced');
    expect(result.message).toContain('Post');
    expect(result.message).toContain('authorId');
    expect(result.message).toContain('Comment');
    expect(result.message).toContain('userId');
  });

  it('deleting an unreferenced table succeeds and removes the block', () => {
    const source = 'Table User {\n  id Int @id\n}\n\nTable Tag {\n  id Int @id\n}\n';
    mockRealParse(source);
    mockResolvedSchema([resolvedTable('User'), resolvedTable('Tag')]);

    const result = applyErdEdit(source, { kind: 'deleteTable', name: 'Tag' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    // Exact string, not a substring check: the `Tag` declaration — from
    // `Table` through its closing `}` — is removed with no residue (e.g. an
    // off-by-one that leaves a stray trailing `}` behind).
    expect(result.text).toBe('Table User {\n  id Int @id\n}\n\n\n');
    expect(result.text).not.toContain('Table Tag {');
    expect(result.text).not.toContain('}\n}');
  });

  it('a target table absent from the fresh parse refuses as anchor-missing without consulting the IR (mutation: reuse a cached referencing-table list)', () => {
    // The target was removed by an intervening edit before this call, so
    // it is absent from the fresh `SpanIndex` — there is no cached scan to
    // fall back to (design D3), and the refusal is computed before ever
    // calling `resolve()`.
    const source = 'Table Post {\n  id Int @id\n}\n';
    mockRealParse(source);

    const result = applyErdEdit(source, { kind: 'deleteTable', name: 'User' });

    expect(result).toEqual({
      ok: false,
      reason: 'anchor-missing',
      message: 'Table "User" was not found in the current buffer.',
    });
    expect(resolve).not.toHaveBeenCalled();
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

describe('applyErdEdit — addField (5.1/5.2)', () => {
  it('adding a field to a table with existing fields inserts one new line inside the block, rest byte-unchanged', () => {
    const source = 'Table User {\n  id Int @id\n}\n';
    mockRealParse(source);

    const result = applyErdEdit(source, { kind: 'addField', table: 'User', name: 'email', fieldType: 'String' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.text).toBe('Table User {\n  id Int @id\n  email String\n}\n');
  });

  it('adding a field to an empty table inserts right after the opening brace', () => {
    const source = 'Table User {\n}\n';
    mockRealParse(source);

    const result = applyErdEdit(source, { kind: 'addField', table: 'User', name: 'id', fieldType: 'Int' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.text).toBe('Table User {\n  id Int\n}\n');
  });

  it('RED/byte-diff: adding a field to Widget leaves every other construct in the combined fixture byte-identical (mutation target: off-by-one anchor)', () => {
    mockRealParse(COMBINED_FIXTURE);

    const result = applyErdEdit(COMBINED_FIXTURE, {
      kind: 'addField',
      table: 'Widget',
      name: 'note',
      fieldType: 'String',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');

    // Exactly one new line inserted right after Widget's last existing
    // field ("\tlabel String"), before Widget's closing "}".
    const expected = COMBINED_FIXTURE.replace(
      '\tlabel String\n}',
      '\tlabel String\n  note String\n}',
    );
    expect(result.text).toBe(expected);

    // Everything outside Widget's block, including its own pre-existing
    // "id Int @id" line, is unchanged.
    expect(result.text).toContain('    id        Int     @id');
    expect(result.text).toContain('@@allow(read, auth.userId == this.ownerId)');
    expect(result.text).toContain('@@realtime(columns: [id, email])');
    expect(result.text).toContain('TableGroup "Billing" {');
  });

  it('addField refuses as anchor-missing when the target table is absent from the fresh parse', () => {
    const source = 'Table Post {\n  id Int @id\n}\n';
    mockRealParse(source);

    const result = applyErdEdit(source, { kind: 'addField', table: 'User', name: 'email', fieldType: 'String' });

    expect(result).toEqual({
      ok: false,
      reason: 'anchor-missing',
      message: 'Table "User" was not found in the current buffer.',
    });
  });
});

describe('applyErdEdit — editField (5.3/5.4)', () => {
  it('renames a field, changing only its name token', () => {
    const source = 'Table User {\n  id Int @id\n  mail String\n}\n';
    mockRealParse(source);

    const result = applyErdEdit(source, { kind: 'editField', table: 'User', field: 'mail', name: 'email' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.text).toBe('Table User {\n  id Int @id\n  email String\n}\n');
  });

  it('changes a field type, changing only its type token', () => {
    const source = 'Table User {\n  id Int @id\n  age String\n}\n';
    mockRealParse(source);

    const result = applyErdEdit(source, { kind: 'editField', table: 'User', field: 'age', fieldType: 'Int' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.text).toBe('Table User {\n  id Int @id\n  age Int\n}\n');
  });

  it('marks a field optional by inserting a trailing "?" after its type', () => {
    const source = 'Table User {\n  id Int @id\n  bio String\n}\n';
    mockRealParse(source);

    const result = applyErdEdit(source, { kind: 'editField', table: 'User', field: 'bio', optional: true });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.text).toBe('Table User {\n  id Int @id\n  bio String?\n}\n');
  });

  it('clears an optional field by removing its trailing "?"', () => {
    const source = 'Table User {\n  id Int @id\n  bio String?\n}\n';
    mockRealParse(source);

    const result = applyErdEdit(source, { kind: 'editField', table: 'User', field: 'bio', optional: false });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.text).toBe('Table User {\n  id Int @id\n  bio String\n}\n');
  });

  it('RED/mutation: editField changes only the targeted field — the id Int @id line and everything outside the block stays byte-unchanged', () => {
    const source = 'Table User {\n  id Int @id\n  mail String\n}\n\nTable Post {\n  id Int @id\n}\n';
    mockRealParse(source);

    const result = applyErdEdit(source, {
      kind: 'editField',
      table: 'User',
      field: 'mail',
      name: 'email',
      fieldType: 'Text',
      optional: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.text).toBe(
      'Table User {\n  id Int @id\n  email Text?\n}\n\nTable Post {\n  id Int @id\n}\n',
    );
    // The mutation this test guards against: widening the name-token
    // replacement span by one extra character (e.g. `nameToken.end + 1`)
    // would eat the leading space before the type, corrupting "email" into
    // "emailString" — this exact-string assertion catches that class of
    // off-by-one directly, without needing a separate mutation run.
    expect(result.text).not.toContain('emailText');
    expect(result.text).toContain('id Int @id\n}\n');
  });

  it('RED/mutation: editField leaves the edited field\'s own attributes (@id, @default(...), @relation(...)) byte-untouched', () => {
    const source =
      'Table Post {\n' +
      '  id Int @id @default(autoincrement())\n' +
      '  authorId Int @relation(fields: [authorId], references: [id])\n' +
      '}\n';
    mockRealParse(source);

    const result = applyErdEdit(source, {
      kind: 'editField',
      table: 'Post',
      field: 'authorId',
      name: 'ownerId',
      fieldType: 'BigInt',
      optional: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    // Only the name and type tokens move; the `?` lands between the type
    // token and the space preceding `@relation`, so every attribute byte —
    // on the edited line AND on the untouched `id` line — is carried
    // through verbatim.
    expect(result.text).toBe(
      'Table Post {\n' +
        '  id Int @id @default(autoincrement())\n' +
        '  ownerId BigInt? @relation(fields: [authorId], references: [id])\n' +
        '}\n',
    );
    // The mutation this guards against: replacing the whole `decl` span
    // (name through end-of-line) instead of the `nameToken`/`typeToken`
    // spans would drop `@relation(...)` entirely — asserted explicitly so
    // the guarantee cannot be silently lost to a rewrite of the edit.
    expect(result.text).toContain('@relation(fields: [authorId], references: [id])');
    expect(result.text).toContain('@id @default(autoincrement())');
  });

  it('editField refuses as anchor-missing when the field is absent from the fresh parse', () => {
    const source = 'Table User {\n  id Int @id\n}\n';
    mockRealParse(source);

    const result = applyErdEdit(source, { kind: 'editField', table: 'User', field: 'missing', name: 'x' });

    expect(result).toEqual({
      ok: false,
      reason: 'anchor-missing',
      message: 'Field "missing" was not found on table "User".',
    });
  });
});

describe('applyErdEdit — deleteField (5.5/5.6)', () => {
  it('deletes a field, removing exactly its own line', () => {
    const source = 'Table User {\n  id Int @id\n  email String\n}\n';
    mockRealParse(source);

    const result = applyErdEdit(source, { kind: 'deleteField', table: 'User', field: 'email' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.text).toBe('Table User {\n  id Int @id\n}\n');
  });

  it('RED/boundary: deleting the middle field of three leaves the first and last field lines exactly intact, no blank/indentation-only residue', () => {
    const source = 'Table User {\n  id Int @id\n  mail String\n  age Int\n}\n';
    mockRealParse(source);

    const result = applyErdEdit(source, { kind: 'deleteField', table: 'User', field: 'mail' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    // Exact string, not a substring check — a boundary bug that leaves the
    // line's indentation or its trailing newline behind produces a blank
    // or whitespace-only line here instead of a clean two-field body.
    expect(result.text).toBe('Table User {\n  id Int @id\n  age Int\n}\n');
    expect(result.text).not.toContain('mail');
    expect(result.text).not.toMatch(/\n\s*\n\s*age/);
  });

  it('deleteField refuses as anchor-missing when the field is absent from the fresh parse', () => {
    const source = 'Table User {\n  id Int @id\n}\n';
    mockRealParse(source);

    const result = applyErdEdit(source, { kind: 'deleteField', table: 'User', field: 'missing' });

    expect(result).toEqual({
      ok: false,
      reason: 'anchor-missing',
      message: 'Field "missing" was not found on table "User".',
    });
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
