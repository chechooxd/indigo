import React from 'react';
import { useTranslation } from 'react-i18next';
import { Home, Database, Code, Book, Settings as SettingsIcon } from 'lucide-react';
import { ViewTab } from '../types';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useNavigationStore } from '../store/useNavigationStore';

export default function Sidebar() {
  const { t } = useTranslation();
  const { activeTab, setActiveTab } = useNavigationStore();
  
  const navItems: { id: ViewTab; icon: React.ElementType; label: string }[] = [
    { id: 'home', icon: Home, label: t('sidebar.dashboard') },
    { id: 'studio', icon: Database, label: t('sidebar.studio') },
    { id: 'editor', icon: Code, label: t('sidebar.architecture') },
    { id: 'docs', icon: Book, label: t('sidebar.documentation') },
  ];

  return (
    <aside id="main-sidebar" className="w-[68px] bg-[#09090b] border-r border-zinc-800/80 flex flex-col items-center py-4 z-40 shrink-0">
      <div 
        id="logo-container"
        className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20 mb-8 cursor-pointer hover:scale-105 transition-transform"
      >
        <span className="text-white font-extrabold text-xl font-sans tracking-tighter">I</span>
      </div>

      <nav className="flex flex-col gap-3 flex-1 w-full px-2 items-center">
        <TooltipProvider>
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <Tooltip key={item.id}>
                <TooltipTrigger
                  render={
                    <Button
                      id={`nav-${item.id}`}
                      variant="ghost"
                      onClick={() => setActiveTab(item.id)}
                      className={`group flex items-center justify-center w-12 h-12 rounded-xl transition-all ${
                        isActive
                          ? 'text-white bg-zinc-900 border border-zinc-800 shadow-inner hover:bg-zinc-900 hover:text-white'
                          : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/40'
                      }`}
                    />
                  }
                >
                  <Icon className="w-5 h-5 shrink-0" strokeWidth={1.75} />

                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={12}>
                  <p className="font-semibold text-xs">{item.label}</p>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </TooltipProvider>
      </nav>

      <div className="mt-auto px-2 w-full flex justify-center">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  onClick={() => setActiveTab('settings')}
                  className={`flex items-center justify-center w-12 h-12 rounded-xl transition-colors ${
                    activeTab === 'settings' 
                      ? 'text-white bg-zinc-900 border border-zinc-800 shadow-inner hover:bg-zinc-900 hover:text-white' 
                      : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/40'
                  }`}
                />
              }
            >
              <SettingsIcon className="w-5 h-5 shrink-0" strokeWidth={1.75} />

            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={12}>
              {t('sidebar.settings')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </aside>
  );
}
