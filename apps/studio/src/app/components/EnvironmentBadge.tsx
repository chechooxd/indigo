/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../store/useAuthStore';

/**
 * Frozen map of complete, static Tailwind class strings keyed by lowercase
 * recognised label. MUST stay complete static strings — Tailwind v4's JIT
 * scanner cannot see interpolated/composed class names, so building these
 * from parts would silently render unstyled (and for `production`, that
 * failure IS a missing production warning, the exact case this badge
 * exists to prevent).
 */
const RECOGNISED_TONES: Record<string, string> = Object.freeze({
  production:
    'bg-rose-950/60 border border-rose-800 text-rose-300 font-bold',
  staging:
    'bg-transparent border border-amber-700 text-amber-400 font-semibold',
  development: 'bg-zinc-900/60 border border-zinc-800 text-zinc-400 font-medium',
});

/** Shared treatment for any structurally valid label outside the recognised set. */
const NEUTRAL_TONE =
  'bg-zinc-900 border border-dashed border-zinc-700 text-zinc-300 font-medium';

/**
 * Persistent, non-interactive badge showing the resolved `--env`/`INDIGODB_ENV`
 * label from `useAuthStore` (mirroring `ReadOnlyBanner`'s direct-store-read
 * pattern — no prop drilling). Renders nothing when `environment` is `null`.
 *
 * Deliberately uses `data-testid` + `aria-label` instead of `role="status"`:
 * this badge is persistent chrome present from first paint, not an event to
 * announce, and `App.test.tsx` asserts a SINGULAR `role="status"` for
 * `ReadOnlyBanner` — a second status node would break that assertion in
 * exactly the read-only + production combination this feature must support.
 */
export function EnvironmentBadge() {
  const { t } = useTranslation();
  const environment = useAuthStore((s) => s.environment);

  if (!environment) return null;

  const tone = RECOGNISED_TONES[environment.trim().toLowerCase()] ?? NEUTRAL_TONE;

  return (
    <span
      data-testid="environment-badge"
      aria-label={t('environment.badge_aria')}
      title={environment}
      className={`hidden sm:inline-flex items-center max-w-[16ch] truncate px-2.5 py-0.5 rounded-full text-[10px] uppercase tracking-wider ${tone}`}
    >
      {environment}
    </span>
  );
}
