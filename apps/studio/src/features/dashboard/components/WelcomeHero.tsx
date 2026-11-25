/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

const CLI_DISABLED_TITLE = "Connecting to the CLI isn't available from the browser.";

interface WelcomeHeroProps {
  schemasCount: number;
  onQuickCreate: () => void;
}

export function WelcomeHero({ schemasCount, onQuickCreate }: WelcomeHeroProps) {
  const { t } = useTranslation();

  return (
    <section className="mb-8 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6 border-b border-zinc-800/80 pb-6">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-white mb-2 font-sans">
            {t('dashboard.welcome')}
          </h1>
          <p className="text-zinc-400 text-sm font-sans max-w-2xl">
            {t('dashboard.projectInfo_pt1')}<span className="text-white font-semibold font-mono">Global_Auth_Service_v2</span>{t('dashboard.projectInfo_pt2')}<span className="text-zinc-200 font-semibold">3 {t('dashboard.projectInfo_pt3').trim()}</span>{t('dashboard.projectInfo_pt4')}<span className="text-zinc-200 font-semibold">{schemasCount} {t('dashboard.projectInfo_pt5').trim()}</span>{t('dashboard.projectInfo_pt6')}
          </p>
        </div>
        <div className="flex gap-3">
          <Button
            id="btn-open-cli"
            variant="outline"
            disabled
            title={CLI_DISABLED_TITLE}
            className="px-4 py-2 bg-zinc-900 border border-zinc-800 rounded-xl hover:bg-zinc-800 text-zinc-300 text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer h-auto"
          >
            <Terminal className="w-4 h-4 text-zinc-400" />
            <span>{t('dashboard.btn_cli')}</span>
          </Button>

          <Button
            id="btn-quick-create"
            onClick={onQuickCreate}
            className="px-4 py-2 bg-white hover:bg-zinc-200 text-black rounded-xl text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer shadow-md shadow-white/5 h-auto"
          >
            <Plus className="w-4 h-4" />
            <span>{t('dashboard.btn_create_schema')}</span>
          </Button>
        </div>
      </div>
    </section>
  );
}
