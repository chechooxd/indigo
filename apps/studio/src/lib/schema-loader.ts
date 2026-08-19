/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ResolvedSchema } from '@indigodb/core';
import { fetchSchema } from './api';
import { resolvedToTables } from './schema-adapter';
import type { Table } from '../types';

export interface SchemaLoaderStore {
  setTables: (tables: Table[] | ((prev: Table[]) => Table[])) => void;
  setResolvedSchema: (schema: ResolvedSchema | null) => void;
}

/**
 * Loads the real schema (via the `indigodb studio` backend) into the data
 * store. Standalone (`pnpm dev`) this fails soft: `fetchSchema` resolves to
 * `null` and the store is left untouched, keeping the seeded mock data.
 *
 * Shared by `useSchemaBootstrap` (mount-time load) and any control that
 * triggers a real refresh (e.g. `SchemaBrowserPanel`'s Refresh button),
 * so both paths stay in sync.
 */
export async function loadSchemaIntoStore(store: SchemaLoaderStore): Promise<void> {
  const resolved = await fetchSchema();
  if (resolved && resolved.tables.length > 0) {
    store.setResolvedSchema(resolved);
    store.setTables(resolvedToTables(resolved));
  }
}
