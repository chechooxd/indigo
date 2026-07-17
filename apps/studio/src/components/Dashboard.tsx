import React from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal, Plus, Shield, RefreshCw, Layers, HardDrive, AlertTriangle, CheckCircle, Info, ArrowRight, Edit3, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStudioStore } from '../store/useStudioStore';

export default function Dashboard() {
  const { t } = useTranslation();
  const {
    schemas,
    setSchemas,
    alerts,
    clearAlerts,
    addNewSchema,
    removeSchema,
    toggleSchemaActive,
    navigate
  } = useStudioStore();

  const handleRemoveSchema = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    removeSchema(id);
  };

  return (
    <div id="dashboard-view" className="flex-1 overflow-y-auto custom-scrollbar bg-[#09090b] p-8">
      {/* Welcome Hero Section */}
      <section className="mb-8 max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6 border-b border-zinc-800/80 pb-6">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white mb-2 font-sans">
              {t('dashboard.welcome')}
            </h1>
            <p className="text-zinc-400 text-sm font-sans max-w-2xl">
              {t('dashboard.projectInfo_pt1')}<span className="text-white font-semibold font-mono">Global_Auth_Service_v2</span>{t('dashboard.projectInfo_pt2')}<span className="text-zinc-200 font-semibold">3 {t('dashboard.projectInfo_pt3').trim()}</span>{t('dashboard.projectInfo_pt4')}<span className="text-zinc-200 font-semibold">{schemas.length} {t('dashboard.projectInfo_pt5').trim()}</span>{t('dashboard.projectInfo_pt6')}
            </p>
          </div>
          <div className="flex gap-3">
            <Button 
              id="btn-open-cli"
              variant="outline"
              onClick={() => alert("Simulating CLI Connection...\n\nIndigoDB-CLI connected successfully on port 3000.\nRun 'indigo help' to see list of valid migration and sync instructions.")}
              className="px-4 py-2 bg-zinc-900 border border-zinc-800 rounded-xl hover:bg-zinc-800 text-zinc-300 text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer h-auto"
            >
              <Terminal className="w-4 h-4 text-zinc-400" />
              <span>{t('dashboard.btn_cli')}</span>
            </Button>

            <Button 
              id="btn-quick-create"
              onClick={() => {
                const name = prompt('Enter a name for your new database schema:', 'new_analytical_dw');
                if (name) addNewSchema(name);
              }}
              className="px-4 py-2 bg-white hover:bg-zinc-200 text-black rounded-xl text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer shadow-md shadow-white/5 h-auto"
            >
              <Plus className="w-4 h-4" />
              <span>{t('dashboard.btn_create_schema')}</span>
            </Button>
          </div>
        </div>
      </section>

      {/* Quick Start Cards */}
      <section className="mb-10 max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* New Schema */}
          <div 
            id="card-new-schema"
            onClick={() => navigate('editor')}
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
            onClick={() => {
              const ddlInput = prompt("Enter schema title:");
              if (ddlInput) {
                setSchemas(prev => [
                  { id: String(prev.length + 1), name: ddlInput.toLowerCase().replace(/ /g, '_'), tablesCount: 1, type: 'PostgreSQL', lastModified: 'Just imported', isActive: false },
                  ...prev
                ]);
              }
            }}
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
            onClick={() => navigate('studio', 'data')}
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

      {/* Recently Edited Schemas */}
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
            onClick={() => alert("Showing all schemas. Active schema is highlighted with an emerald indicator.")}
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
                    onClick={() => toggleSchemaActive(schema.id)}
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
                          onClick={() => {
                            toggleSchemaActive(schema.id);
                            navigate('editor');
                          }}
                          className="p-1.5 hover:bg-zinc-800 rounded-xl text-zinc-500 hover:text-white transition-colors h-auto"
                          title={t('dashboard.recent_schemas.btn_edit')}
                        >
                          <Edit3 className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost" 
                          onClick={(e) => handleRemoveSchema(schema.id, e)}
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

      {/* System Alerts */}
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
            onClick={clearAlerts}
            disabled={alerts.length === 0}
            className="w-full mt-6 py-2 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700 rounded-xl text-[10px] font-mono tracking-wider text-zinc-400 hover:text-white transition-all cursor-pointer disabled:opacity-30 disabled:pointer-events-none h-auto"
          >
            {t('dashboard.alerts.clear_all')}
          </Button>
        </div>
      </section>
    </div>
  );
}
