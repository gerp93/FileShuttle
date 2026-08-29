import React, { createContext, useContext, useEffect, useState } from 'react';
import { applyThemeFromFletId, DEFAULT_THEME_ID, FletThemeId, themeExists } from '../utils/themes';

interface ThemeContextValue {
  themeId: FletThemeId;
  setThemeId: (id: FletThemeId) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeId, setThemeIdState] = useState<FletThemeId>(DEFAULT_THEME_ID);

  useEffect(() => {
    void window.fileshuttleAPI.settings.getTheme().then((stored) => {
      const id = stored && themeExists(stored) ? stored : DEFAULT_THEME_ID;
      setThemeIdState(id);
      applyThemeFromFletId(id);
    });
  }, []);

  const setThemeId = async (id: FletThemeId) => {
    setThemeIdState(id);
    applyThemeFromFletId(id);
    await window.fileshuttleAPI.settings.setTheme(id);
  };

  return <ThemeContext.Provider value={{ themeId, setThemeId }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
