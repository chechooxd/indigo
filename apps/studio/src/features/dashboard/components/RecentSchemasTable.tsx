/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Edit3, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { RecentSchema } from '../../../types';

interface RecentSchemasTableProps {
  schemas: RecentSchema[];
  onToggleActive: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string, e: React.MouseEvent) => void;
  onViewAll: () => void;
}

export function RecentSchemasTable({ schemas, onToggleActive, onEdit, onRemove, onViewAll }: RecentSchemasTableProps) {
  const { t } = useTranslation();

  return (
    <section className="max-w-7xl mx-auto mb-10">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-white font-sans">
            {t('dashboard.recent_schemas.title')}
          </h2>
          <span className="px-2.5 py-0.5 bg-zinc-900 border border-zinc-800 text-zinc-400 rounded-lg text-[10px] font-mono tracking-wider">
            {t('dashboard.recent_schemas.tag')}
          </span>
        </div>
        <button
          onClick={onViewAll}
          className="text-zinc-400 text-xs font-semibold hover:text-white hover:underline cursor-pointer"
        >
          {t('dashboard.recent_schemas.view_all')}
        </button>
      </div>

      <div className="bg-zinc-900/40 rounded-3xl border border-zinc-800 overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-zinc-900 border-b border-zinc-800/80">
                <th className="px-6 py-3.5 text-[10px] font-mono uppercase tracking-widest text-zinc-500">{t('dashboard.recent_schemas.col_name')}</th>
                <th className="px-6 py-3.5 text-[10px] font-mono uppercase tracking-widest text-zinc-500">{t('dashboard.recent_schemas.col_tables')}</th>
                <th className="px-6 py-3.5 text-[10px] font-mono uppercase tracking-widest text-zinc-500">{t('dashboard.recent_schemas.col_type')}</th>
                <th className="px-6 py-3.5 text-[10px] font-mono uppercase tracking-widest text-zinc-500">{t('dashboard.recent_schemas.col_modified')}</th>
                <th className="px-6 py-3.5 text-[10px] font-mono uppercase tracking-widest text-zinc-500 text-right">{t('dashboard.recent_schemas.col_actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {schemas.map((schema) => (
                <tr
                  key={schema.id}
                  onClick={() => onToggleActive(schema.id)}
                  className="hover:bg-zinc-900/40 transition-colors cursor-pointer group"
                >
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className={`w-2 h-2 rounded-full transition-all ${
                        schema.isActive
                          ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]'
                          : 'bg-zinc-600 group-hover:bg-zinc-400'
                      }`}></div>
                      <span className={`font-medium font-mono text-sm ${schema.isActive ? 'text-white' : 'text-zinc-300'}`}>
                        {schema.name}
                      </span>
                      {schema.isActive && (
                        <span className="text-[9px] bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-1.5 py-0.2 rounded font-mono">
                          {t('dashboard.recent_schemas.active')}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className="px-2.5 py-0.5 bg-zinc-800/60 rounded-lg text-zinc-400 border border-zinc-800/40 font-mono text-xs">
                      {t('dashboard.recent_schemas.tables_count', { count: schema.tablesCount })}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className="px-2 py-0.5 bg-zinc-900 text-zinc-300 border border-zinc-800 rounded-md text-[10px] font-bold uppercase font-mono">
                      {schema.type}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-zinc-500 text-xs font-mono">
                    {schema.lastModified}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        onClick={() => onEdit(schema.id)}
                        className="p-1.5 hover:bg-zinc-800 rounded-xl text-zinc-500 hover:text-white transition-colors h-auto"
                        title={t('dashboard.recent_schemas.btn_edit')}
                      >
                        <Edit3 className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={(e) => onRemove(schema.id, e)}
                        className="p-1.5 hover:bg-zinc-800 rounded-xl text-zinc-500 hover:text-red-400 transition-colors h-auto"
                        title={t('dashboard.recent_schemas.btn_delete')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
