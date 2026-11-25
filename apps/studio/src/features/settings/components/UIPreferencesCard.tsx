/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Palette, Globe } from 'lucide-react';
import { THEME_ACCENTS } from '../constants';

interface UIPreferencesCardProps {
  accent: string;
  onAccentChange: (accent: string) => void;
}

export function UIPreferencesCard({ accent, onAccentChange }: UIPreferencesCardProps) {
  const { t, i18n } = useTranslation();

  return (
    <div className="bg-zinc-950 p-6 rounded-3xl border border-zinc-800 space-y-4">
      <h3 className="text-sm font-bold text-white flex items-center gap-2 border-b border-zinc-900 pb-3 uppercase tracking-wider">
        <Palette className="w-4 h-4 text-zinc-500" />
        <span>{t('settings.ui.title')}</span>
      </h3>

      <div className="space-y-4">
        <div>
          <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block mb-1 flex items-center gap-1.5">
            <Globe className="w-3.5 h-3.5" />
            {t('settings.ui.language')}
          </label>
          <select
            value={i18n.language}
            onChange={(e) => i18n.changeLanguage(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-2.5 text-xs text-zinc-200 outline-none focus:border-zinc-700"
          >
            <option value="en">English (US)</option>
            <option value="es">Español (ES)</option>
          </select>
        </div>

        <div>
          <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block mb-2">
            {t('settings.ui.theme_accent')}
          </label>
          <div className="flex gap-3">
            {THEME_ACCENTS.map((theme) => (
              <button
                key={theme.id}
                onClick={() => onAccentChange(theme.id)}
                className={`w-8 h-8 rounded-full ${theme.bg} transition-all border-2 ${
                  accent === theme.id
                    ? 'border-white scale-110 shadow-lg shadow-white/20'
                    : 'border-transparent hover:scale-110 opacity-70 hover:opacity-100'
                }`}
                title={theme.id}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
