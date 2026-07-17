import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import Dashboard from './components/Dashboard';
import QueryEngine from './components/QueryEngine';
import ERDDesigner from './features/erd/ERDDesignerPage';
import TableBrowser from './components/TableBrowser';
import DocBrowser from './components/DocBrowser';
import Settings from './components/Settings';
import { Button } from '@/components/ui/button';
import { useThemeStore } from './store/useThemeStore';
import { useNavigationStore } from './store/useNavigationStore';
import { useDataStore } from './store/useDataStore';
import { fetchSchema } from './lib/api';
import { resolvedToTables } from './lib/schema-adapter';

export default function App() {
  const { t } = useTranslation();
  const { activeTab, studioSubTab, currentCluster, setCurrentCluster, setStudioSubTab } = useNavigationStore();
  const { themeAccent } = useThemeStore();
  const { setTables, setResolvedSchema } = useDataStore();

  useEffect(() => {
    // Inject theme accent class to document for global overrides
    document.documentElement.className = `theme-${themeAccent}`;
  }, [themeAccent]);

  useEffect(() => {
    // When running under `indigodb studio`, load the real schema's tables.
    // Standalone (`pnpm dev`) this fails soft and the mock data is kept.
    fetchSchema().then((resolved) => {
      if (resolved && resolved.tables.length > 0) {
        setResolvedSchema(resolved);
        setTables(resolvedToTables(resolved));
      }
    });
  }, [setTables, setResolvedSchema]);

  return (
    <div className="flex h-screen bg-[#09090b] text-white overflow-hidden font-sans antialiased selection:bg-indigo-500/30">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 bg-[#09090b] border-l border-zinc-800/80">
        <Header 
          currentCluster={currentCluster} 
          onClusterChange={setCurrentCluster} 
          titleSuffix={
            activeTab === 'home' ? t('sidebar.dashboard') :
            activeTab === 'studio' ? t('sidebar.studio') :
            activeTab === 'editor' ? t('sidebar.architecture') :
            activeTab === 'docs' ? t('sidebar.documentation') :
            activeTab === 'settings' ? t('sidebar.settings') : ''
          }
        />

        {/* Studio Sub-Navigation Tab bar */}
        {activeTab === 'studio' && (
          <div className="bg-[#09090b] h-10 border-b border-zinc-800/80 flex items-center px-6 gap-6 shrink-0 z-30">
            <Button
              variant="ghost"
              onClick={() => setStudioSubTab('query')}
              className={`h-full text-xs font-semibold py-3 border-b-2 rounded-none transition-all ${
                studioSubTab === 'query'
                  ? 'border-white text-white hover:bg-transparent hover:text-white'
                  : 'border-transparent text-zinc-500 hover:bg-transparent hover:text-zinc-300'
              }`}
            >
              {t('studio.sub_nav_query')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setStudioSubTab('data')}
              className={`h-full text-xs font-semibold py-3 border-b-2 rounded-none transition-all ${
                studioSubTab === 'data'
                  ? 'border-white text-white hover:bg-transparent hover:text-white'
                  : 'border-transparent text-zinc-500 hover:bg-transparent hover:text-zinc-300'
              }`}
            >
              {t('studio.sub_nav_data')}
            </Button>
          </div>
        )}

        <main className="flex-1 relative overflow-hidden flex flex-col">
          {activeTab === 'home' && (
            <Dashboard />
          )}

          {activeTab === 'studio' && studioSubTab === 'query' && (
            <QueryEngine />
          )}

          {activeTab === 'studio' && studioSubTab === 'data' && (
            <TableBrowser />
          )}

          {activeTab === 'editor' && (
            <ERDDesigner />
          )}

          {activeTab === 'docs' && (
            <DocBrowser />
          )}

          {activeTab === 'settings' && (
            <Settings />
          )}
        </main>
      </div>
    </div>
  );
}
