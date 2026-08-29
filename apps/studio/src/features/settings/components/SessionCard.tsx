/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { LogOut } from 'lucide-react';
import { useAuthStore } from '../../../store/useAuthStore';

/**
 * Logout affordance, alongside the Query Guards' Safe Updates toggle.
 * Hidden (not disabled) when this Studio instance has no password
 * configured — studio-ui-honesty: an inert control that can never do
 * anything is absent, not a disabled decoy (see the live-status badge for
 * the same convention).
 */
export function SessionCard() {
  const { t } = useTranslation();
  const authRequired = useAuthStore((state) => state.authRequired);
  const logout = useAuthStore((state) => state.logout);

  if (!authRequired) return null;

  return (
    <div className="bg-zinc-950 p-6 rounded-3xl border border-zinc-800 space-y-4">
      <h3 className="text-sm font-bold text-white flex items-center gap-2 border-b border-zinc-900 pb-3 uppercase tracking-wider">
        <LogOut className="w-4 h-4 text-zinc-500" />
        <span>{t('settings.session.title')}</span>
      </h3>

      <p className="text-[10px] text-zinc-500">{t('settings.session.desc')}</p>

      <button
        onClick={() => void logout()}
        className="flex items-center gap-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all"
      >
        <LogOut className="w-4 h-4" />
        <span>{t('settings.session.logout')}</span>
      </button>
    </div>
  );
}
