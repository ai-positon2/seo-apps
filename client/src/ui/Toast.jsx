import { useCallback, useMemo, createContext, useContext } from 'react';
import { Toaster, toast } from 'sonner';
import { useTheme } from '../components/ThemeContext';

// ── Toasts, on Sonner ────────────────────────────────────────────────────────
//
// The hand-built stack this replaced had no screen-reader announcement, dropped
// error messages after five seconds like successes, had no exit motion (the
// remaining toasts snapped into place), injected a <style> tag per toast, and
// treated an unknown variant ("error") as "info". Sonner handles all of that
// (docs/design-audit/01-audit.md, APP-14; pick-ui-library: toasts → Sonner).
//
// The context API is unchanged — { add, remove }, with add({ title,
// description, variant, duration }) returning an id — so the twelve files that
// call useToast() did not change.

const ToastCtx = createContext(null);

// Errors stay until dismissed or read: 10s instead of the 5s a success gets.
const ERROR_DURATION = 10_000;

export function ToastProvider({ children }) {
  const { theme } = useTheme();

  const add = useCallback(({ title, description, variant = 'success', duration } = {}) => {
    const kind = variant === 'error' ? 'danger' : variant;
    const opts = {
      description,
      duration: duration > 0 ? duration : (kind === 'danger' ? ERROR_DURATION : undefined),
    };
    if (duration === 0) opts.duration = Infinity;
    switch (kind) {
      case 'danger': return toast.error(title, opts);
      case 'warning': return toast.warning(title, opts);
      case 'info': return toast.info(title, opts);
      default: return toast.success(title, opts);
    }
  }, []);

  const remove = useCallback((id) => { toast.dismiss(id); }, []);

  const value = useMemo(() => ({ add, remove }), [add, remove]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <Toaster
        theme={theme === 'light' ? 'light' : 'dark'}
        position="bottom-right"
        closeButton
        toastOptions={{
          style: {
            background: 'var(--card)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            fontFamily: 'var(--font-sans)',
          },
        }}
      />
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

export default ToastProvider;
