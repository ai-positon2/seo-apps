import { useState, useCallback, useMemo, createContext, useContext, useRef } from 'react';

const ToastCtx = createContext(null);

const VARIANT_ICONS = {
  success: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  ),
  danger: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  ),
  warning: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
    </svg>
  ),
  info: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--info)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4m0-4h.01" />
    </svg>
  ),
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const add = useCallback(({ title, description, variant = 'success', duration = 5000 }) => {
    const id = ++idRef.current;
    setToasts(t => [...t, { id, title, description, variant }]);
    if (duration > 0) {
      setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), duration);
    }
    return id;
  }, []);

  const remove = useCallback((id) => {
    setToasts(t => t.filter(x => x.id !== id));
  }, []);

  // add and remove are already useCallback([]) and therefore permanently
  // stable; the object literal around them was not, so every consumer of this
  // context re-rendered whenever a toast appeared AND again when it expired
  // five seconds later. Twelve files call useToast. With the value memoized,
  // nothing outside this provider re-renders for a toast at all.
  const value = useMemo(() => ({ add, remove }), [add, remove]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      {/* Toast stack */}
      <div style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        zIndex: 2000,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        alignItems: 'flex-end',
      }}>
        {toasts.map(t => (
          <div
            key={t.id}
            style={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-lg)',
              boxShadow: 'var(--shadow-md)',
              padding: '12px 14px',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              minWidth: 280,
              maxWidth: 360,
              animation: 'toastIn 240ms var(--ease)',
            }}
          >
            <style>{`@keyframes toastIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
            <span style={{ flexShrink: 0, marginTop: 1 }}>
              {VARIANT_ICONS[t.variant] || VARIANT_ICONS.info}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{t.title}</div>
              {t.description && (
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{t.description}</div>
              )}
            </div>
            <button
              onClick={() => remove(t.id)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-3)', display: 'flex', alignItems: 'center',
                padding: 0, outline: 'none', flexShrink: 0,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

export default ToastProvider;
