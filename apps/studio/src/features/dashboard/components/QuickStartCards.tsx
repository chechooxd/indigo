/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Layers, HardDrive, RefreshCw, Shield, Terminal, ArrowRight } from 'lucide-react';

interface QuickStartCardsProps {
  onDesigner: () => void;
  onImport: () => void;
  onExplore: () => void;
}

export function QuickStartCards({ onDesigner, onImport, onExplore }: QuickStartCardsProps) {
  const { t } = useTranslation();

  return (
    <section className="mb-10 max-w-7xl mx-auto">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* New Schema */}
        <div
          id="card-new-schema"
          onClick={onDesigner}
          className="group relative overflow-hidden bg-zinc-900/50 p-6 rounded-3xl border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/80 transition-all cursor-pointer shadow-lg"
        >
          <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
            <Layers className="w-16 h-16 text-zinc-600" />
          </div>
          <div className="relative z-10">
            <div className="w-10 h-10 bg-zinc-800 border border-zinc-750 rounded-2xl flex items-center justify-center mb-4">
              <Plus className="w-5 h-5 text-white" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2 font-sans group-hover:text-zinc-300 transition-colors flex items-center gap-2">
              <span>{t('dashboard.cards.designer_title')}</span>
              <ArrowRight className="w-4 h-4 opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
            </h3>
            <p className="text-zinc-400 text-xs font-sans leading-relaxed">
              {t('dashboard.cards.designer_desc')}
            </p>
          </div>
        </div>

        {/* Import DDL */}
        <div
          id="card-import-ddl"
          onClick={onImport}
          className="group relative overflow-hidden bg-zinc-900/50 p-6 rounded-3xl border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/80 transition-all cursor-pointer shadow-lg"
        >
          <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
            <HardDrive className="w-16 h-16 text-zinc-600" />
          </div>
          <div className="relative z-10">
            <div className="w-10 h-10 bg-zinc-800 border border-zinc-750 rounded-2xl flex items-center justify-center mb-4">
              <RefreshCw className="w-5 h-5 text-white" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2 font-sans group-hover:text-zinc-300 transition-colors flex items-center gap-2">
              <span>{t('dashboard.cards.import_title')}</span>
              <ArrowRight className="w-4 h-4 opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
            </h3>
            <p className="text-zinc-400 text-xs font-sans leading-relaxed">
              {t('dashboard.cards.import_desc')}
            </p>
          </div>
        </div>

        {/* Explore Data */}
        <div
          id="card-explore-data"
          onClick={onExplore}
          className="group relative overflow-hidden bg-zinc-900/50 p-6 rounded-3xl border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/80 transition-all cursor-pointer shadow-lg"
        >
          <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
            <Shield className="w-16 h-16 text-zinc-600" />
          </div>
          <div className="relative z-10">
            <div className="w-10 h-10 bg-zinc-800 border border-zinc-750 rounded-2xl flex items-center justify-center mb-4">
              <Terminal className="w-5 h-5 text-white" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2 font-sans group-hover:text-zinc-300 transition-colors flex items-center gap-2">
              <span>{t('dashboard.cards.explorer_title')}</span>
              <ArrowRight className="w-4 h-4 opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
            </h3>
            <p className="text-zinc-400 text-xs font-sans leading-relaxed">
              {t('dashboard.cards.explorer_desc')}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
