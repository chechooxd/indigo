/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ResolvedRelation } from '@indigodb/core';

/** Cardinality label shown next to a relation (e.g. "1-to-N"). */
export function getRelationLabel(rel: ResolvedRelation): string {
  return rel.type === 'OneToOne' ? '1-to-1' : rel.list ? '1-to-N' : 'N-to-1';
}

/**
 * Human-readable FK detail line for a relation.
 *
 * On an inverse side (`rel.inverse`), `fkColumns`/`refColumns` describe the
 * paired counterpart's foreign key — a column on `rel.targetModel`'s table,
 * not on this relation's own model — so the line must not claim "Foreign
 * Key:" as if it belonged to this side.
 */
export function getRelationDetail(rel: ResolvedRelation): string {
  if (rel.inverse) {
    return `Referenced by ${rel.targetModel} via ${rel.fkColumns.join(', ')} → ${rel.refColumns.join(', ')}`;
  }
  return rel.fkColumns.length > 0
    ? `Foreign Key: ${rel.fkColumns.join(', ')} → ${rel.targetModel}.${rel.refColumns.join(', ')}`
    : `References ${rel.targetModel}`;
}
