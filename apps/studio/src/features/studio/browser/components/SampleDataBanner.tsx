/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { isBackendAvailable } from '../../../../lib/api';

/**
 * Non-dismissible banner shown above the data grid whenever the Studio has
 * no live backend connection. Standalone `pnpm dev` always falls into this
 * state and renders mock data — this banner makes that explicit instead of
 * letting sample rows pass as real ones.
 */
export function SampleDataBanner() {
  if (isBackendAvailable()) return null;

  return (
    <div
      role="status"
      className="px-4 py-2 bg-amber-950/40 border-b border-amber-900/60 text-[11px] text-amber-300 font-sans font-medium shrink-0"
    >
      Showing sample data — no database is connected. Records and structure below are mock data, not your real database.
    </div>
  );
}
