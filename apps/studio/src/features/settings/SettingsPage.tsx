/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Settings as SettingsIcon, Save, CheckCircle } from 'lucide-react';
import { useSettingsForm } from './hooks/useSettingsForm';
import { ConnectionCard } from './components/ConnectionCard';
import { QueryGuardsCard } from './components/QueryGuardsCard';
import { UIPreferencesCard } from './components/UIPreferencesCard';
import { ResetDiagnosticsCard } from './components/ResetDiagnosticsCard';

export default function SettingsPage() {
  const { t } = useTranslation();
  const {
    themeAccent,
    setThemeAccent,
    host,
    setHost,
    poolLimit,
    setPoolLimit,
    autocommit,
    setAutocommit,
    safeUpdates,
    setSafeUpdates,
    saveSuccess,
    save,
    resetDefaults,
  } = useSettingsForm();

  const handleSave = () => save(() => alert(t('settings.success_title')));

  return (
    <div id="settings-view" className="flex-1 overflow-y-auto custom-scrollbar bg-[#09090b] p-8">
      <div className="max-w-3xl mx-auto space-y-8">
        {/* Title */}
        <div className="border-b border-zinc-800 pb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-extrabold text-white tracking-tight font-sans flex items-center gap-2">
              <SettingsIcon className="w-6 h-6 text-zinc-400" />
              <span>{t('settings.title')}</span>
            </h1>
            <p className="text-zinc-500 text-xs mt-1">
              {t('settings.subtitle')}
            </p>
          </div>
          <button
            onClick={handleSave}
            className="bg-white hover:bg-zinc-200 text-black px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 transition-all cursor-pointer shadow-lg"
          >
            <Save className="w-4 h-4" />
            <span>{t('settings.btn_save')}</span>
          </button>
        </div>

        {/* Success Alert */}
        {saveSuccess && (
          <div className="p-4 bg-emerald-950/10 border border-emerald-900/30 rounded-2xl flex gap-3 text-emerald-400 text-xs font-sans">
            <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0" />
            <div>
              <div className="font-bold">{t('settings.success_title')}</div>
              <p className="text-[11px] text-zinc-400 mt-1">{t('settings.success_desc')}</p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 font-sans">
          <ConnectionCard host={host} poolLimit={poolLimit} onHostChange={setHost} onPoolChange={setPoolLimit} />
          <QueryGuardsCard
            autocommit={autocommit}
            safeUpdates={safeUpdates}
            onAutocommitChange={setAutocommit}
            onSafeUpdatesChange={setSafeUpdates}
          />
          <UIPreferencesCard accent={themeAccent} onAccentChange={setThemeAccent} />
        </div>

        <ResetDiagnosticsCard onReset={resetDefaults} />
      </div>
    </div>
  );
}
