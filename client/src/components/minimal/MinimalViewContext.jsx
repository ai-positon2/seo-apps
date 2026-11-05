import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

// ── Minimal version ─────────────────────────────────────────────────────────
//
// The CMO-facing view of the Overview and the reports is the default. In it,
// every element marked with HIDE (./hide.js) is hidden by one CSS rule in
// index.css, keyed off <html data-view="minimal">. The header switch,
// "Advanced mode", brings every section back. Nothing is unmounted either way:
// polling, run tracking, downloads and the Legend's Ask Vimi registration keep
// working in both. The choice is remembered per browser, like Guided mode.

// Stores the Advanced mode choice: '1' = advanced (everything shown). Absent
// means nobody has chosen yet, which is the minimal default.
const STORAGE_KEY = 'seoStudio.advancedMode';

const MinimalViewContext = createContext(null);

// Outside the provider (a screen rendered on its own in a test) everything shows.
const OUTSIDE = { minimal: false, setMinimal: () => {} };

function readStored() {
  // Blocked site data makes localStorage throw outright, not return null.
  try {
    return localStorage.getItem(STORAGE_KEY) !== '1';
  } catch {
    return true;
  }
}

export function MinimalViewProvider({ children }) {
  const [minimal, setMinimalState] = useState(readStored);

  useEffect(() => {
    const root = document.documentElement;
    if (minimal) root.setAttribute('data-view', 'minimal');
    else root.removeAttribute('data-view');
    // Signing out unmounts the provider; the login screen should not inherit it.
    return () => root.removeAttribute('data-view');
  }, [minimal]);

  const setMinimal = useCallback((v) => {
    setMinimalState(v);
    try { localStorage.setItem(STORAGE_KEY, v ? '0' : '1'); } catch { /* storage blocked — the choice holds for this session */ }
  }, []);

  const value = useMemo(() => ({ minimal, setMinimal }), [minimal, setMinimal]);
  return <MinimalViewContext.Provider value={value}>{children}</MinimalViewContext.Provider>;
}

export function useMinimalView() {
  return useContext(MinimalViewContext) || OUTSIDE;
}
