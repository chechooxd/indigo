/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings as SettingsIcon, Save, Database, Shield, Sliders, CheckCircle, Palette, Globe } from 'lucide-react';
import { useStudioStore } from '../store/useStudioStore';

export default function Settings() {
  const { t, i18n } = useTranslation();
  const { themeAccent, setThemeAccent } = useStudioStore();
  const [host, setHost] = useState('production-indigo-cluster.c6e83d8a.us-east-1.rds.amazonaws.com');
  const [poolLimit, setPoolLimit] = useState(50);
  const [autocommit, setAutocommit] = useState(true);
  const [safeUpdates, setSafeUpdates] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const handleSave = () => {
    setSaveSuccess(true);
    setTimeout(() => {
      setSaveSuccess(false);
      alert(t('settings.success_title'));
    }, 1500);
  };

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
          {/* Card: Connection Parameters */}
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
                  onChange={(e) => setHost(e.target.value)}
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
                  onChange={(e) => setPoolLimit(Number(e.target.value))}
                  className="w-full accent-white"
                />
              </div>
            </div>
          </div>

          {/* Card: Safety & Query Guard rails */}
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
                  onChange={(e) => setAutocommit(e.target.checked)}
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
                  onChange={(e) => setSafeUpdates(e.target.checked)}
                  className="rounded bg-zinc-900 border-zinc-800 text-zinc-300 focus:ring-0 mt-0.5" 
                />
                <div>
                  <span className="text-xs font-semibold text-zinc-200">{t('settings.guards.safe_title')}</span>
                  <p className="text-[10px] text-zinc-500 mt-0.5">{t('settings.guards.safe_desc')}</p>
                </div>
              </label>
            </div>
          </div>

          {/* UI Preferences Card */}
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
                  {[
                    { id: 'indigo', bg: 'bg-indigo-500' },
                    { id: 'emerald', bg: 'bg-emerald-500' },
                    { id: 'rose', bg: 'bg-rose-500' },
                    { id: 'amber', bg: 'bg-amber-500' },
                  ].map(theme => (
                    <button
                      key={theme.id}
                      onClick={() => setThemeAccent(theme.id)}
                      className={`w-8 h-8 rounded-full ${theme.bg} transition-all border-2 ${
                        themeAccent === theme.id 
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
        </div>

        {/* Extra Diagnostics block */}
        <div className="bg-zinc-950 p-6 rounded-3xl border border-zinc-800 flex items-center justify-between font-sans">
          <div className="flex items-center gap-3">
            <Sliders className="w-5 h-5 text-zinc-500" />
            <div>
              <div className="text-xs font-bold text-white">{t('settings.reset.title')}</div>
              <div className="text-[10px] text-zinc-500 mt-0.5">{t('settings.reset.desc')}</div>
            </div>
          </div>
          <button 
            onClick={() => {
              if (confirm("Are you sure you want to reset all cached variables to system defaults?")) {
                window.location.reload();
              }
            }}
            className="border border-red-900/30 hover:border-red-600 text-red-400 hover:bg-red-950/10 px-4 py-2 rounded-xl text-xs font-semibold uppercase tracking-wider transition-all cursor-pointer"
          >
            {t('settings.reset.btn')}
          </button>
        </div>
      </div>
    </div>
  );
}
