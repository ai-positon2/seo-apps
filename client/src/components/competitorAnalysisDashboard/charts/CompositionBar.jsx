import { Badge } from '../../../ui/Badge';
import { fmtNum } from '../utils';

// 100%-stacked horizontal bar per domain — for composition metrics (Branded
// vs. Non-Branded keywords, Follow vs. Nofollow backlinks). Segment colors
// are fixed per category across every row; the client is distinguished by
// its bolded label + badge, not by different segment coloring.
export function CompositionBar({ domains = [], segments = [], emptyText = 'No data yet.', rowEmptyText = 'No data' }) {
  if (!domains.length) {
    return <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 12, color: 'var(--text-3)' }}>{emptyText}</div>;
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 14, marginBottom: 12 }}>
        {segments.map((seg) => (
          <span key={seg.key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-3)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: seg.color, display: 'inline-block' }} />
            {seg.label}
          </span>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {domains.map((d) => {
          const parts = segments.map((seg) => ({ ...seg, value: Math.max(seg.valueFn(d) || 0, 0) }));
          const total = parts.reduce((s, p) => s + p.value, 0);
          const label = d.label || d.domain;
          return (
            <div key={d.domain} style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
                fontSize: 13, fontWeight: d.isClient ? 700 : 400,
                color: d.isClient ? 'var(--text)' : 'var(--text-2)',
              }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                {d.isClient && <Badge variant="brand" style={{ flexShrink: 0 }}>Client</Badge>}
              </div>

              {total === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{rowEmptyText}</div>
              ) : (
                <div style={{ display: 'flex', height: 20, borderRadius: 4, overflow: 'hidden', gap: 2 }} title={parts.map((p) => `${p.label}: ${fmtNum(p.value)} (${Math.round((p.value / total) * 100)}%)`).join(' · ')}>
                  {parts.map((p) => {
                    const pct = (p.value / total) * 100;
                    if (pct <= 0) return null;
                    const showLabel = pct >= 14;
                    return (
                      <div
                        key={p.key}
                        style={{
                          width: `${pct}%`,
                          minWidth: pct > 0 ? 2 : 0,
                          background: p.color,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        {showLabel && (
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#fff', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                            {Math.round(pct)}%
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default CompositionBar;
