/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SystemAlert } from '../../../types';

interface AlertsPanelProps {
  alerts: SystemAlert[];
  onClearAll: () => void;
}

export function AlertsPanel({ alerts, onClearAll }: AlertsPanelProps) {
  const { t } = useTranslation();

  return (
    <section className="max-w-7xl mx-auto">
      <div className="max-w-md bg-zinc-900/40 p-6 rounded-3xl border border-zinc-800 flex flex-col shadow-lg justify-between">
        <div>
          <h3 className="text-base font-bold text-white mb-4 font-sans">
            {t('dashboard.alerts.title')}
          </h3>

          <div className="space-y-3 max-h-[220px] overflow-y-auto custom-scrollbar pr-1">
            {alerts.length === 0 ? (
              <div className="py-12 text-center text-zinc-500 text-xs">
                {t('dashboard.alerts.no_alerts')}
              </div>
            ) : (
              alerts.map((alert) => (
                <div
                  key={alert.id}
                  className="flex gap-3 p-3 rounded-2xl border text-xs leading-relaxed border-zinc-800/60 bg-zinc-900 text-zinc-300"
                >
                  {alert.type === 'warning' ? (
                    <AlertTriangle className="w-5 h-5 shrink-0 text-zinc-400" />
                  ) : alert.type === 'success' ? (
                    <CheckCircle className="w-5 h-5 shrink-0 text-emerald-400" />
                  ) : (
                    <Info className="w-5 h-5 shrink-0 text-zinc-400" />
                  )}
                  <div>
                    <div className="font-bold flex justify-between items-center text-white">
                      <span>{alert.title}</span>
                      <span className="text-[9px] font-normal text-zinc-500 font-mono">
                        {alert.timestamp}
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1">{alert.message}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <Button
          variant="outline"
          onClick={onClearAll}
          disabled={alerts.length === 0}
          className="w-full mt-6 py-2 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700 rounded-xl text-[10px] font-mono tracking-wider text-zinc-400 hover:text-white transition-all cursor-pointer disabled:opacity-30 disabled:pointer-events-none h-auto"
        >
          {t('dashboard.alerts.clear_all')}
        </Button>
      </div>
    </section>
  );
}
