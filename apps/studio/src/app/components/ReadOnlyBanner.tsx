/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../store/useAuthStore';

/**
 * Non-dismissible banner shown above the app shell whenever the server
 * reports global, server-side read-only mode (`GET /api/auth/status`'s
 * `readOnly` field, mirrored into `useAuthStore`). It reflects live server
 * state for the duration of the session, so there is no dismiss control —
 * styling matches `SampleDataBanner` (the app's one existing banner
 * precedent).
 */
export function ReadOnlyBanner() {
  const { t } = useTranslation();
  const readOnly = useAuthStore((s) => s.readOnly);

  if (!readOnly) return null;

  return (
    <div
      role="status"
      className="px-4 py-2 bg-amber-950/40 border-b border-amber-900/60 text-[11px] text-amber-300 font-sans font-medium shrink-0"
    >
      {t('readOnly.banner')}
    </div>
  );
}
