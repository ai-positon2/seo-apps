import { useEffect, useState } from 'react';
import { subscribeSemrushBalance, refreshSemrushBalance } from '../lib/semrushBalanceStore';

// A units read-out for the app header. Token-based, so it is legible in both
// themes — it used to be painted with white alphas for the old navy sidebar,
// which disappeared against the light palette.
export default function SemrushBalanceBadge() {
  const [state, setState] = useState({ balance: null, loading: false, error: null });

  useEffect(() => {
    const unsubscribe = subscribeSemrushBalance(setState);
    refreshSemrushBalance();
    return unsubscribe;
  }, []);

  // Fail silently (e.g. key not configured) — this is a status widget, not
  // core functionality, so it shouldn't clutter the header with an error.
  if (state.error || state.balance === null) return null;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'center',
      gap: 5,
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: '5px 10px',
      fontSize: 11,
      fontFamily: 'var(--font-mono)',
      whiteSpace: 'nowrap',
    }}>
      <span style={{ color: '#ff642d', fontWeight: 600 }}>Semrush</span>
      <span style={{ fontWeight: 600, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
        {state.balance.toLocaleString()}
      </span>
      <span style={{ color: 'var(--text-3)' }}>units</span>
    </div>
  );
}
