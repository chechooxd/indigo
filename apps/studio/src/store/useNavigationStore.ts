import { create } from 'zustand';
import type { ViewTab } from '../types';

interface NavigationState {
  activeTab: ViewTab;
  studioSubTab: 'query' | 'data';
  currentCluster: string;

  setActiveTab: (tab: ViewTab) => void;
  setStudioSubTab: (subTab: 'query' | 'data') => void;
  setCurrentCluster: (cluster: string) => void;
  navigate: (tab: ViewTab, subTab?: string) => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  activeTab: 'home',
  studioSubTab: 'query',
  currentCluster: 'Production Cluster',

  setActiveTab: (tab) => set({ activeTab: tab }),
  setStudioSubTab: (subTab) => set({ studioSubTab: subTab }),
  setCurrentCluster: (cluster) => set({ currentCluster: cluster }),
  navigate: (tab, subTab) => set((state) => ({
    activeTab: tab,
    studioSubTab: subTab ? (subTab as 'query' | 'data') : state.studioSubTab,
  })),
}));
