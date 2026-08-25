import { createContext, useContext, useEffect, useState, useCallback } from 'react';

// ── Theme ───────────────────────────────────────────────────────────────────
// Dark and light are both designed states in this theme (see index.css), so the
// toggle is real again — it was a no-op while the app was dark-only.
//
// Dark is the default: index.html stamps data-theme="dark" so the first paint is
// already correct for everyone who has not chosen otherwise, and only someone
// who explicitly picked light sees a transition on mount.
//
// The context shape is unchanged ({ theme, toggle }) so existing useTheme()
// consumers keep working; `setTheme` and `isDark` are additions.

const STORAGE_KEY = 'seo-studio-theme';
const DEFAULT_THEME = 'dark';

const ThemeContext = createContext({
  theme: DEFAULT_THEME,
  isDark: true,
  toggle: () => {},
  setTheme: () => {},
});

function readStoredTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : DEFAULT_THEME;
  } catch {
    // Private browsing, or storage blocked. A theme is a preference, not state
    // worth failing a render over.
    return DEFAULT_THEME;
  }
}

function applyTheme(theme) {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  // Keeps native form controls, scrollbars and the browser's own surfaces in
  // step with the page; without it a light page keeps dark scrollbars.
  root.style.colorScheme = theme;
}

export function ThemeProvider({ children }) {
  // Read synchronously on first render so the very first commit already matches
  // the stored choice — a useEffect-only read paints dark first, then swaps.
  const [theme, setThemeState] = useState(readStoredTheme);

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch {}
  }, [theme]);

  const setTheme = useCallback((next) => {
    setThemeState(next === 'light' ? 'light' : 'dark');
  }, []);

  const toggle = useCallback(() => {
    setThemeState((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, isDark: theme === 'dark', toggle, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
