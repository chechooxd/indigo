import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import { StudioSubTabs } from './components/StudioSubTabs';
import Dashboard from '../features/dashboard/DashboardPage';
import QueryEngine from '../features/studio/query/QueryEnginePage';
import ERDDesigner from '../features/erd/ERDDesignerPage';
import TableBrowser from '../features/studio/browser/TableBrowserPage';
import DocBrowser from '../features/docs/DocBrowserPage';
import Settings from '../features/settings/SettingsPage';
import { useThemeStore } from '../store/useThemeStore';
import { useNavigationStore } from '../store/useNavigationStore';
import { useAuthStore } from '../store/useAuthStore';
import { useSchemaBootstrap } from './hooks/useSchemaBootstrap';
import { TAB_TITLE_KEYS } from './lib/tab-titles';
import LoginScreen from '../features/auth/LoginScreen';

export default function App() {
  const { t } = useTranslation();
  const { activeTab, studioSubTab, currentCluster, setCurrentCluster, setStudioSubTab } = useNavigationStore();
  const { themeAccent } = useThemeStore();
  const { authRequired, authenticated, checkStatus } = useAuthStore();

  useEffect(() => {
    // Inject theme accent class to document for global overrides
    document.documentElement.className = `theme-${themeAccent}`;
  }, [themeAccent]);

  useSchemaBootstrap();

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  if (authRequired && !authenticated) {
    return <LoginScreen />;
  }

  return (
    <div className="flex h-screen bg-[#09090b] text-white overflow-hidden font-sans antialiased selection:bg-indigo-500/30">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 bg-[#09090b] border-l border-zinc-800/80">
        <Header
          currentCluster={currentCluster}
          onClusterChange={setCurrentCluster}
          titleSuffix={t(TAB_TITLE_KEYS[activeTab])}
        />

        {activeTab === 'studio' && (
          <StudioSubTabs active={studioSubTab} onChange={setStudioSubTab} />
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
