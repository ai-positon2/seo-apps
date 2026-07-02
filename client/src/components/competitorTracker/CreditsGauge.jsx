import { useEffect, useState, useCallback } from 'react';
import { ct } from '../../lib/competitorTrackerApi';

function formatNumber(n) {
  return n == null ? '—' : n.toLocaleString('en-US');
}

/** CreditsGauge — quiet, single-line SEMrush credit usage indicator */
export function CreditsGauge() {
  const [usage, setUsage] = useState(null);

  const load = useCallback(() => {
    ct.semrushUsage().then(setUsage).catch(() => setUsage(null));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [load]);

  const unknown = !usage || usage.usedToday == null;
  const pct = unknown ? 0 : Math.min(100, Math.round((usage.usedToday / usage.cap) * 100));
  const color = unknown ? 'var(--text-3)' : pct >= 85 ? 'var(--danger)' : pct >= 60 ? 'var(--warning)' : 'var(--success)';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
      <div style={{ width: 60, height: 4, borderRadius: 'var(--r-pill)', background: 'var(--surface)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: unknown ? '0%' : `${pct}%`, background: color, transition: 'width var(--dur-slow) var(--ease)' }} />
      </div>
      <span style={{ color: 'var(--text-3)' }}>
        {unknown ? 'SEMrush usage unknown' : `${formatNumber(usage.usedToday)} / ${formatNumber(usage.cap)} credits today`}
      </span>
    </div>
  );
}

export default CreditsGauge;
