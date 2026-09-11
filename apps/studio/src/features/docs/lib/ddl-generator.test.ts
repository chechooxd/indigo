/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

/**
 * Real-pipeline tests for the docs-view DDL renderer.
 *
 * `.indigo` source → real `parse`+`resolve` (`@indigodb/core`, not mocked) →
 * `resolvedToTables` → `generateTableDDL`, same fixture pattern as
 * `features/erd/lib/__tests__/patch-semantics.test.ts`. This is what lets the
 * suite see the adapter boundary where `Table.indexes` used to be dropped —
 * a test built from a hand-crafted `Table` object can't observe that loss.
 *
 * Hand-built `Table` objects are used ONLY for the two renderer-only rows
 * (mock/sample-data shapes: `indexes` absent, `primaryKey` absent) where no
 * `.indigo` source can express "field entirely absent from real IR".
 */

import { describe, expect, it } from 'vitest';
import { parse, resolve } from '@indigodb/core';
import { resolvedToTables } from '../../../lib/schema-adapter';
import { generateTableDDL } from './ddl-generator';
import type { Table } from '../../../types';

/** Resolves `source` through the real pipeline and returns the adapted Table. */
function tableOf(source: string, tableName: string): Table {
  const tables = resolvedToTables(resolve(parse(source)));
  const table = tables.find((t) => t.name === tableName);
  if (!table) throw new Error(`table "${tableName}" not found in resolved schema`);
  return table;
}

/** Resolves `source` and renders the DDL for `tableName` end to end. */
function renderTable(source: string, tableName: string): string {
  return generateTableDDL(tableOf(source, tableName));
}

describe('resolvedToTables index mapping (adapter boundary)', () => {
  it('scenario: indexes reach the adapted Table', () => {
    const source = `
Table T {
  id    String @id
  email String

  @@unique([email])
}
`;
    const table = tableOf(source, 'T');
    expect(table.indexes).toEqual([{ columns: ['email'], unique: true }]);
  });

  it('scenario: a table with no indexes maps to an empty array, not undefined', () => {
    const source = `
Table T {
  id String @id
}
`;
    const table = tableOf(source, 'T');
    expect(table.indexes).toEqual([]);
  });
});

describe('generateTableDDL', () => {
  it('row 1: no @@index/@@unique, single PK id — exact rendered output', () => {
    const source = `
Table T {
  id   String @id
  name String
}
`;
    const ddl = renderTable(source, 'T');
    expect(ddl).toBe(
      'CREATE TABLE public.T (\n' +
        '  id string NOT NULL,\n' +
        '  name string NOT NULL,\n' +
        '  PRIMARY KEY (id)\n' +
        ');',
    );
    expect(ddl).not.toContain('CREATE INDEX');
    expect(ddl).not.toContain('idx_');
  });

  it('row 2: mock Table with indexes absent (renderer entry) renders no CREATE INDEX', () => {
    const table: Table = {
      name: 'Legacy',
      schema: 'public',
      primaryKey: ['id'],
      columns: [{ name: 'id', type: 'String', isPK: true, isNN: true, isUQ: false }],
      records: [],
    };
    const ddl = generateTableDDL(table);
    expect(ddl).not.toContain('CREATE INDEX');
    expect(ddl).not.toContain('idx_');
  });

  it('row 3: one plain index, unnamed, type absent', () => {
    const source = `
Table T {
  id       String @id
  authorId String

  @@index([authorId])
}
`;
    const ddl = renderTable(source, 'T');
    expect(ddl).toContain('CREATE INDEX ON public.T (authorId);');
    expect(ddl).not.toContain('USING');
  });

  it('row 4: @@unique([email]) renders CREATE UNIQUE INDEX, not a bare CREATE INDEX', () => {
    const source = `
Table T {
  id    String @id
  email String

  @@unique([email])
}
`;
    const ddl = renderTable(source, 'T');
    expect(ddl).toContain('CREATE UNIQUE INDEX ON public.T (email);');
    expect(ddl).not.toContain('CREATE INDEX ON public.T (email);');
  });

  it('row 5: composite index preserves declared column order', () => {
    const source = `
Table T {
  id        String   @id
  authorId  String
  createdAt DateTime

  @@index([authorId, createdAt])
}
`;
    const ddl = renderTable(source, 'T');
    expect(ddl).toContain('(authorId, createdAt)');
  });

  it('row 6: explicit type: gin + named index emits name verbatim and USING gin', () => {
    const source = `
Table T {
  id   String @id
  tags String

  @@index([tags], name: "post_tags_idx", type: gin)
}
`;
    const ddl = renderTable(source, 'T');
    expect(ddl).toContain('CREATE INDEX post_tags_idx ON public.T USING gin (tags);');
  });

  it('row 7: non-id single PK (uuid) + index on an unrelated column', () => {
    const source = `
Table T {
  uuid String @id
  slug String

  @@index([slug])
}
`;
    const ddl = renderTable(source, 'T');
    expect(ddl).toContain('PRIMARY KEY (uuid)');
    // "uuid" legitimately contains the substring "id" — assert no column
    // named exactly `id` appears anywhere, word-bounded.
    expect(ddl).not.toMatch(/\bid\b/);
  });

  it('row 8: composite PK (two @id fields) renders exactly one table-level PRIMARY KEY', () => {
    const source = `
Table T {
  tenantId String @id
  userId   String @id
  name     String
}
`;
    const ddl = renderTable(source, 'T');
    const pkMatches = ddl.match(/PRIMARY KEY/g) ?? [];
    expect(pkMatches).toHaveLength(1);
    expect(ddl).toContain('PRIMARY KEY (tenantId, userId)');
  });

  it('row 9: mock Table with PK absent (renderer entry) invents no PRIMARY KEY', () => {
    const table: Table = {
      name: 'Legacy',
      schema: 'public',
      columns: [{ name: 'note', type: 'String', isPK: false, isNN: false, isUQ: false }],
      records: [],
    };
    const ddl = generateTableDDL(table);
    expect(ddl).not.toContain('PRIMARY KEY');
  });

  it('row 10: two indexes, one unique one not, rendered in declaration order', () => {
    const source = `
Table T {
  id    String @id
  email String
  slug  String

  @@index([slug])
  @@unique([email])
}
`;
    const ddl = renderTable(source, 'T');
    const slugIdx = ddl.indexOf('CREATE INDEX ON public.T (slug);');
    const emailIdx = ddl.indexOf('CREATE UNIQUE INDEX ON public.T (email);');
    expect(slugIdx).toBeGreaterThan(-1);
    expect(emailIdx).toBeGreaterThan(-1);
    expect(slugIdx).toBeLessThan(emailIdx);
  });
});

describe('generateTableDDL — @map identifier correspondence (invariant)', () => {
  /**
   * Extracts every identifier referenced inside a `PRIMARY KEY (...)` or
   * `CREATE INDEX ...(...)` / `CREATE UNIQUE INDEX ...(...)` clause.
   */
  function referencedIdentifiers(ddl: string): string[] {
    const identifiers: string[] = [];
    const pkRe = /PRIMARY KEY \(([^)]*)\)/g;
    const idxRe = /CREATE (?:UNIQUE )?INDEX[^(]*\(([^)]*)\)/g;
    for (const re of [pkRe, idxRe]) {
      for (const match of ddl.matchAll(re)) {
        for (const col of match[1].split(',')) {
          identifiers.push(col.trim());
        }
      }
    }
    return identifiers;
  }

  /** Extracts every column identifier rendered as a `CREATE TABLE` column line. */
  function renderedColumnNames(ddl: string): string[] {
    const body = ddl.slice(ddl.indexOf('(') + 1, ddl.indexOf(');'));
    return body
      .split(',\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('PRIMARY KEY'))
      .map((line) => line.split(/\s+/)[0]);
  }

  it('every PRIMARY KEY / CREATE INDEX identifier appears as a rendered column line, with @map on both a PK column and an indexed column', () => {
    const source = `
Table Post {
  authorId String @id @map("author_id")
  slug     String @map("post_slug")

  @@index([slug])
}
`;
    const ddl = renderTable(source, 'Post');

    const referenced = referencedIdentifiers(ddl);
    const rendered = renderedColumnNames(ddl);

    // General invariant: every identifier in a PRIMARY KEY or CREATE INDEX
    // clause must correspond to a column line actually rendered in the same
    // statement — otherwise the DDL references a column that doesn't exist.
    expect(referenced.length).toBeGreaterThan(0);
    for (const id of referenced) {
      expect(rendered).toContain(id);
    }
  });
});
