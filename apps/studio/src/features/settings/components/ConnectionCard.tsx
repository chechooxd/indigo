/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Database } from 'lucide-react';

interface ConnectionCardProps {
  host: string;
  poolLimit: number;
  onHostChange: (host: string) => void;
  onPoolChange: (limit: number) => void;
}

export function ConnectionCard({ host, poolLimit, onHostChange, onPoolChange }: ConnectionCardProps) {
  const { t } = useTranslation();

  return (
    <div className="bg-zinc-950 p-6 rounded-3xl border border-zinc-800 space-y-4">
      <h3 className="text-sm font-bold text-white flex items-center gap-2 border-b border-zinc-900 pb-3 uppercase tracking-wider">
        <Database className="w-4 h-4 text-zinc-500" />
        <span>{t('settings.connection.title')}</span>
      </h3>

      <div className="space-y-3">
        <div>
          <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block mb-1">
            {t('settings.connection.host')}
          </label>
          <input
            value={host}
            onChange={(e) => onHostChange(e.target.value)}
            type="text"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-2.5 text-xs text-zinc-200 font-mono outline-none focus:border-zinc-700"
          />
        </div>

        <div>
          <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block mb-1 flex justify-between">
            <span>{t('settings.connection.pool')}</span>
            <span className="font-mono text-zinc-400">{poolLimit} {t('settings.connection.conn')}</span>
          </label>
          <input
            type="range"
            min="5"
            max="150"
            value={poolLimit}
            onChange={(e) => onPoolChange(Number(e.target.value))}
            className="w-full accent-white"
          />
        </div>
      </div>
    </div>
  );
}
