/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ResolvedRelation } from '@indigodb/core';

/** Cardinality label shown next to a relation (e.g. "1-to-N"). */
export function getRelationLabel(rel: ResolvedRelation): string {
  return rel.type === 'OneToOne' ? '1-to-1' : rel.list ? '1-to-N' : 'N-to-1';
}

/** Human-readable FK detail line for a relation. */
export function getRelationDetail(rel: ResolvedRelation): string {
  return rel.fkColumns.length > 0
    ? `Foreign Key: ${rel.fkColumns.join(', ')} → ${rel.targetModel}.${rel.refColumns.join(', ')}`
    : `References ${rel.targetModel}`;
}
