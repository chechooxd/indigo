/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import { loadSchemaIntoStore } from '../../lib/schema-loader';
import { useDataStore } from '../../store/useDataStore';

/**
 * When running under `indigodb studio`, loads the real schema's tables into
 * the data store. Standalone (`pnpm dev`) this fails soft and the mock data
 * seeded in useDataStore is kept.
 */
export function useSchemaBootstrap(): void {
  const { setTables, setResolvedSchema } = useDataStore();

  useEffect(() => {
    void loadSchemaIntoStore({ setTables, setResolvedSchema });
  }, [setTables, setResolvedSchema]);
}
