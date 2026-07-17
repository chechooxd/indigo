import { create } from 'zustand';

interface ThemeState {
  themeAccent: string;
  setThemeAccent: (theme: string) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  themeAccent: localStorage.getItem('themeAccent') || 'indigo',
  setThemeAccent: (theme) => {
    localStorage.setItem('themeAccent', theme);
    set({ themeAccent: theme });
  },
}));
