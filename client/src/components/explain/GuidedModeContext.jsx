import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';

// ── Guided mode ─────────────────────────────────────────────────────────────
//
// One switch for how every info icon behaves. On (the default, for a reader
// exploring on their own): clicking an icon opens the full explanation. Off
// (for someone who already knows the product): hovering shows a one-line
// summary and nothing gets in the way.
//
// `openKey` is the one popover open anywhere in the app. Each icon owns a
// unique id rather than its explainer key, because two icons can share a key
// ("Pages with an error" and "Pages with a warning" explain the same thing).

const STORAGE_KEY = 'seoStudio.guidedMode';

const GuidedModeContext = createContext(null);

// Outside the provider (a screen rendered on its own in a test, say) the icons
// still render, as hover tooltips, rather than throwing.
const OUTSIDE = { guided: false, setGuided: () => {}, openKey: null, setOpenKey: () => {} };

function readStored() {
  // Blocked site data makes localStorage throw outright, not return null.
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

export function GuidedModeProvider({ children }) {
  const [guided, setGuidedState] = useState(readStored);
  const [openKey, setOpenKey] = useState(null);
  const { pathname } = useLocation();

  // A popover belongs to the screen it was opened on.
  useEffect(() => { setOpenKey(null); }, [pathname]);

  const setGuided = useCallback((v) => {
    setGuidedState(v);
    setOpenKey(null);
    try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch { /* storage blocked — the choice holds for this session */ }
  }, []);

  const value = useMemo(() => ({ guided, setGuided, openKey, setOpenKey }), [guided, setGuided, openKey]);
  return <GuidedModeContext.Provider value={value}>{children}</GuidedModeContext.Provider>;
}

export function useGuidedMode() {
  return useContext(GuidedModeContext) || OUTSIDE;
}
