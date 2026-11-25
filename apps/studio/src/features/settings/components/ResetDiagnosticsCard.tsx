/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Sliders } from 'lucide-react';

interface ResetDiagnosticsCardProps {
  onReset: () => void;
}

export function ResetDiagnosticsCard({ onReset }: ResetDiagnosticsCardProps) {
  const { t } = useTranslation();

  return (
    <div className="bg-zinc-950 p-6 rounded-3xl border border-zinc-800 flex items-center justify-between font-sans">
      <div className="flex items-center gap-3">
        <Sliders className="w-5 h-5 text-zinc-500" />
        <div>
          <div className="text-xs font-bold text-white">{t('settings.reset.title')}</div>
          <div className="text-[10px] text-zinc-500 mt-0.5">{t('settings.reset.desc')}</div>
        </div>
      </div>
      <button
        onClick={onReset}
        className="border border-red-900/30 hover:border-red-600 text-red-400 hover:bg-red-950/10 px-4 py-2 rounded-xl text-xs font-semibold uppercase tracking-wider transition-all cursor-pointer"
      >
        {t('settings.reset.btn')}
      </button>
    </div>
  );
}
