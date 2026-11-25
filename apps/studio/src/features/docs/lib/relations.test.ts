/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import type { ResolvedRelation } from '@indigodb/core';
import { getRelationDetail, getRelationLabel } from './relations';

function relation(overrides: Partial<ResolvedRelation> = {}): ResolvedRelation {
  return {
    name: 'author',
    targetModel: 'User',
    // `@indigodb/ast`'s `RelationType` enum is not a direct dependency of
    // this package; its members serialize to these exact string values.
    type: 'OneToMany' as ResolvedRelation['type'],
    list: false,
    optional: false,
    fkColumns: [],
    refColumns: [],
    ...overrides,
  };
}

describe('getRelationDetail', () => {
  it('renders a Foreign Key line for an FK-holding relation', () => {
    const rel = relation({ fkColumns: ['author_id'], refColumns: ['id'] });
    expect(getRelationDetail(rel)).toBe('Foreign Key: author_id → User.id');
  });

  it('renders a bare reference line when there are no FK columns and no inverse pairing', () => {
    const rel = relation({ fkColumns: [], refColumns: [] });
    expect(getRelationDetail(rel)).toBe('References User');
  });

  it('does not claim ownership of the FK for an inverse-side relation', () => {
    // Inverse sides carry the counterpart's real FK/ref columns (per the
    // cross-model pairing pass), which live on the OTHER model's table —
    // rendering "Foreign Key: ..." here would misattribute ownership.
    const rel = relation({
      name: 'posts',
      targetModel: 'Post',
      list: true,
      fkColumns: ['author_id'],
      refColumns: ['id'],
      inverse: true,
    });
    const detail = getRelationDetail(rel);
    expect(detail).not.toContain('Foreign Key:');
    expect(detail).toBe('Referenced by Post via author_id → id');
  });

  it('getRelationLabel is unaffected by the inverse flag', () => {
    const rel = relation({ list: true, inverse: true });
    expect(getRelationLabel(rel)).toBe('1-to-N');
  });
});
