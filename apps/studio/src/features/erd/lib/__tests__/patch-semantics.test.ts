/**
 * @license
 * SPDX-License-Identifier: MIT
 */

// @vitest-environment node

/**
 * Semantic tests for the ERD patch engine, against the REAL compiler.
 *
 * `patch.test.ts` mocks `@indigodb/core` wholesale — it has to, because the
 * WASM compiler is unavailable under jsdom. That mock is what made this
 * whole class of defect invisible: every assertion there is a string
 * comparison on emitted text, so a patch can be byte-perfect against its
 * expected string and still emit `.indigo` that means nothing. Phase 6's
 * `addRelation` shipped exactly that — `@relation(...)` appended to a
 * scalar field parses and resolves with no error and produces ZERO foreign
 * keys, so the relation is inert end to end: no FK in the IR, no DDL from
 * `migrate`, no edge on the canvas that drew it.
 *
 * This file exists to close that gap for good. It runs in the node
 * environment (no jsdom), imports the real `@indigodb/core`, and asserts on
 * the RESOLVED IR rather than on text. A patch is only correct here if the
 * compiler agrees it means what the user drew.
 */

import { describe, it, expect } from 'vitest';
import { parse, resolve } from '@indigodb/core';
import { applyErdEdit } from '../patch';

/** Resolves `source` and returns every foreign key, table-qualified. */
function foreignKeysOf(source: string) {
  const resolved = resolve(parse(source));
  return resolved.tables.flatMap((table) =>
    (table.foreignKeys ?? []).map((fk) => ({
      table: table.name,
      columns: fk.columns,
      refTable: fk.refTable,
      refColumns: fk.refColumns,
    })),
  );
}

const TWO_TABLES = `Table User {
  id    Int    @id @default(autoincrement())
  email String @unique
}

Table Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int    @map("author_id")
}
`;

describe('addRelation produces a relation the compiler actually resolves', () => {
  it('a drag from the FK field to the PK field yields a real foreign key', () => {
    const result = applyErdEdit(TWO_TABLES, {
      kind: 'addRelation',
      from: 'Post',
      fromField: 'authorId',
      to: 'User',
      toField: 'id',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');

    // The emitted buffer must still compile.
    expect(() => parse(result.text)).not.toThrow();

    // And it must MEAN something. This is the assertion Phase 6 never made.
    expect(foreignKeysOf(result.text)).toEqual([
      { table: 'Post', columns: ['author_id'], refTable: 'User', refColumns: ['id'] },
    ]);
  });

  it('the reverse drag direction yields the same foreign key, not an inverted one', () => {
    // React Flow's `source`/`target` follow whichever handle the user
    // grabbed first, not which side holds the FK — so the same intent
    // arrives with `from`/`to` swapped. The FK side is a property of the
    // schema (which field is the `@id`), not of the gesture.
    const result = applyErdEdit(TWO_TABLES, {
      kind: 'addRelation',
      from: 'User',
      fromField: 'id',
      to: 'Post',
      toField: 'authorId',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');

    expect(foreignKeysOf(result.text)).toEqual([
      { table: 'Post', columns: ['author_id'], refTable: 'User', refColumns: ['id'] },
    ]);
  });

  it('leaves every construct the ERD does not model byte-identical', () => {
    const source = `enum UserRole {
  ADMIN
  USER
}

Table User {
  id    Int      @id @default(autoincrement())
  email String   @unique @note("Corporate email")
  role  UserRole @default(USER)
}

Table Post {
  id       Int    @id @default(autoincrement())
  authorId Int    @map("author_id")
}
`;

    const result = applyErdEdit(source, {
      kind: 'addRelation',
      from: 'Post',
      fromField: 'authorId',
      to: 'User',
      toField: 'id',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');

    expect(result.text).toContain('enum UserRole {\n  ADMIN\n  USER\n}');
    expect(result.text).toContain('email String   @unique @note("Corporate email")');
    expect(result.text).toContain('role  UserRole @default(USER)');
    expect(result.text).toContain('authorId Int    @map("author_id")');

    expect(foreignKeysOf(result.text)).toEqual([
      { table: 'Post', columns: ['author_id'], refTable: 'User', refColumns: ['id'] },
    ]);
  });

  it('refuses a drag between two fields where neither side is a primary key', () => {
    // Emitting something inert here is the failure mode this whole file
    // exists to prevent: refuse loudly rather than write text that compiles
    // and does nothing.
    const source = `Table A {
  id   Int @id
  x    Int
}

Table B {
  id   Int @id
  y    Int
}
`;

    const result = applyErdEdit(source, {
      kind: 'addRelation',
      from: 'A',
      fromField: 'x',
      to: 'B',
      toField: 'y',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.message).toMatch(/primary key/i);
  });
});
