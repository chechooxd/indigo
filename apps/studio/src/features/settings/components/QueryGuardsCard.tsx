/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Shield } from 'lucide-react';

interface QueryGuardsCardProps {
  autocommit: boolean;
  safeUpdates: boolean;
  onAutocommitChange: (value: boolean) => void;
  onSafeUpdatesChange: (value: boolean) => void;
}

export function QueryGuardsCard({ autocommit, safeUpdates, onAutocommitChange, onSafeUpdatesChange }: QueryGuardsCardProps) {
  const { t } = useTranslation();

  return (
    <div className="bg-zinc-950 p-6 rounded-3xl border border-zinc-800 space-y-4">
      <h3 className="text-sm font-bold text-white flex items-center gap-2 border-b border-zinc-900 pb-3 uppercase tracking-wider">
        <Shield className="w-4 h-4 text-zinc-500" />
        <span>{t('settings.guards.title')}</span>
      </h3>

      <div className="space-y-4">
        {/* Autocommit */}
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={autocommit}
            onChange={(e) => onAutocommitChange(e.target.checked)}
            className="rounded bg-zinc-900 border-zinc-800 text-zinc-300 focus:ring-0 mt-0.5"
          />
          <div>
            <span className="text-xs font-semibold text-zinc-200">{t('settings.guards.autocommit_title')}</span>
            <p className="text-[10px] text-zinc-500 mt-0.5">{t('settings.guards.autocommit_desc')}</p>
          </div>
        </label>

        {/* Safe Updates */}
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={safeUpdates}
            onChange={(e) => onSafeUpdatesChange(e.target.checked)}
            className="rounded bg-zinc-900 border-zinc-800 text-zinc-300 focus:ring-0 mt-0.5"
          />
          <div>
            <span className="text-xs font-semibold text-zinc-200">{t('settings.guards.safe_title')}</span>
            <p className="text-[10px] text-zinc-500 mt-0.5">{t('settings.guards.safe_desc')}</p>
          </div>
        </label>
      </div>
    </div>
  );
}
