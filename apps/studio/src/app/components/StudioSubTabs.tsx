/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

interface StudioSubTabsProps {
  active: 'query' | 'data';
  onChange: (tab: 'query' | 'data') => void;
}

export function StudioSubTabs({ active, onChange }: StudioSubTabsProps) {
  const { t } = useTranslation();

  return (
    <div className="bg-[#09090b] h-10 border-b border-zinc-800/80 flex items-center px-6 gap-6 shrink-0 z-30">
      <Button
        variant="ghost"
        onClick={() => onChange('query')}
        className={`h-full text-xs font-semibold py-3 border-b-2 rounded-none transition-all ${
          active === 'query'
            ? 'border-white text-white hover:bg-transparent hover:text-white'
            : 'border-transparent text-zinc-500 hover:bg-transparent hover:text-zinc-300'
        }`}
      >
        {t('studio.sub_nav_query')}
      </Button>
      <Button
        variant="ghost"
        onClick={() => onChange('data')}
        className={`h-full text-xs font-semibold py-3 border-b-2 rounded-none transition-all ${
          active === 'data'
            ? 'border-white text-white hover:bg-transparent hover:text-white'
            : 'border-transparent text-zinc-500 hover:bg-transparent hover:text-zinc-300'
        }`}
      >
        {t('studio.sub_nav_data')}
      </Button>
    </div>
  );
}
