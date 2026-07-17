/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import { fetchSchema } from '../../lib/api';
import { resolvedToTables } from '../../lib/schema-adapter';
import { useDataStore } from '../../store/useDataStore';

/**
 * When running under `indigodb studio`, loads the real schema's tables into
 * the data store. Standalone (`pnpm dev`) this fails soft and the mock data
 * seeded in useDataStore is kept.
 */
export function useSchemaBootstrap(): void {
  const { setTables, setResolvedSchema } = useDataStore();

  useEffect(() => {
    fetchSchema().then((resolved) => {
      if (resolved && resolved.tables.length > 0) {
        setResolvedSchema(resolved);
        setTables(resolvedToTables(resolved));
      }
    });
  }, [setTables, setResolvedSchema]);
}
