import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HelpCircle, Moon, Sun, Database, ChevronDown, Check, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface HeaderProps {
  currentCluster: string;
  onClusterChange: (cluster: string) => void;
  titleSuffix?: string;
}

export default function Header({ currentCluster, onClusterChange, titleSuffix }: HeaderProps) {
  const { t } = useTranslation();
  const [simulatedDark, setSimulatedDark] = useState(true);

  const environments = [
    { name: 'Production Cluster', type: 'PROD', host: 'us-east-1' },
    { name: 'Staging Environment', type: 'STAGE', host: 'us-east-5' },
    { name: 'Development Sandbox', type: 'DEV', host: 'localhost' },
  ];

  return (
    <header 
      id="top-header"
      className="bg-[#09090b] text-zinc-300 flex justify-between items-center px-6 w-full h-[48px] z-50 border-b border-zinc-800/80 shrink-0"
    >
      <div className="flex items-center gap-4">
        <span className="font-sans font-extrabold text-lg tracking-tight text-white cursor-default">
          IndigoDB <span className="text-zinc-400 text-xs px-1.5 py-0.5 rounded-lg bg-zinc-900 border border-zinc-800 font-mono font-medium ml-1">{t('header.version')}</span>
        </span>
        
        {titleSuffix && (
          <>
            <div className="h-4 w-px bg-zinc-800 mx-1"></div>
            <span className="text-xs font-mono text-zinc-500 flex items-center gap-1">
              {titleSuffix}
            </span>
          </>
        )}

        <div className="h-4 w-px bg-zinc-800 mx-1"></div>

        {/* Interactive Environment / Cluster Selector Dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger>
            <Button
              id="cluster-selector-btn"
              variant="outline"
              className="flex items-center gap-2 px-3 py-1 bg-zinc-900 hover:bg-zinc-800 rounded-xl border border-zinc-800 cursor-pointer text-xs font-semibold uppercase tracking-wider text-zinc-200 transition-colors h-auto"
            >
              <Database className="w-3.5 h-3.5 text-zinc-400" />
              <span>{currentCluster}</span>
              <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-64 bg-[#09090b] border-zinc-800 rounded-2xl shadow-2xl shadow-black/80 p-1.5" align="start">
            <DropdownMenuLabel className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest px-2 pb-1 pt-2">
              {t('header.environments.select')}
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="bg-zinc-800/50" />
            {environments.map((env) => (
              <DropdownMenuItem
                key={env.name}
                onClick={() => onClusterChange(env.name)}
                className="w-full text-left px-3 py-2 text-xs flex items-center justify-between rounded-xl focus:bg-zinc-900 focus:text-white cursor-pointer text-zinc-200 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Server className="w-3.5 h-3.5 text-zinc-400" />
                  <div>
                    <div className="font-medium text-white">{env.name}</div>
                    <div className="text-[9px] text-zinc-500 font-mono">{env.host}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold font-mono ${
                    env.type === 'PROD' 
                      ? 'bg-zinc-900 text-zinc-300 border border-zinc-800' 
                      : env.type === 'STAGE'
                      ? 'bg-zinc-900 text-zinc-400 border border-zinc-800'
                      : 'bg-zinc-900 text-zinc-500 border border-zinc-805'
                  }`}>
                    {env.type}
                  </span>
                  {currentCluster === env.name && (
                    <Check className="w-3.5 h-3.5 text-white" />
                  )}
                </div>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex items-center gap-3">
        {/* Connection Diagnostics Badge */}
        <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-zinc-900 border border-zinc-800 text-[10px] text-zinc-300 font-semibold uppercase tracking-wider">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-pulse"></span>
          <span>{t('header.connected')}</span>
        </div>

        {/* Theme state switcher */}
        <Button 
          id="theme-toggle-btn"
          variant="ghost"
          onClick={() => setSimulatedDark(!simulatedDark)}
          className="p-1.5 hover:bg-zinc-900 text-zinc-500 hover:text-zinc-300 rounded-xl transition-colors cursor-pointer h-auto"
          title={simulatedDark ? t('header.themeLight') : t('header.themeDark')}
        >
          {simulatedDark ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
        </Button>

        {/* Help button */}
        <Button 
          id="help-btn"
          variant="ghost"
          onClick={() => alert("Welcome to IndigoDB! Toggle sidebar options to design schemas, browse tables, run SQL queries, and consult documentation.")}
          className="p-1.5 hover:bg-zinc-900 text-zinc-500 hover:text-zinc-300 rounded-xl transition-colors cursor-pointer h-auto"
          title={t('header.help')}
        >
          <HelpCircle className="w-4 h-4" />
        </Button>
      </div>
    </header>
  );
}
