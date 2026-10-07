import { useState } from 'react';
import { Badge } from '../../../ui/Badge';
import { fmtNum, fmtCompact, seriesColor, CLIENT_COLOR, COMPETITOR_COLOR } from '../utils';

// Ranked horizontal bar chart for a single magnitude metric (Organic Traffic,
// Organic Keywords, Backlinks, Ref. Domains, ...). Bar length is always
// proportional to the leader (the natural, honest reading of a ranked bar
// chart) — the "Index to leader" toggle only switches what the end-label
// prints: the true compact value, or the 0-100 index vs. the leader. This
// keeps geometry stable and avoids ever needing a log scale.
export function RankedBarChart({ domains = [], valueFn, emptyText = 'No data yet.' }) {
  const [indexed, setIndexed] = useState(false);

  if (!domains.length) {
    return <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 12, color: 'var(--text-3)' }}>{emptyText}</div>;
  }

  const rows = domains
    .map((d) => ({ id: d.domain, label: d.label || d.domain, isClient: d.isClient, value: valueFn(d) || 0 }))
    .sort((a, b) => b.value - a.value);

  const leader = rows[0]?.value || 0;
  const hasCompetitors = rows.length > 1;

  return (
    <div>
      {hasCompetitors && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 14, marginBottom: 12 }}>
          <Legend />
          <button
            onClick={() => setIndexed((v) => !v)}
            style={{
              fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 500,
              padding: '3px 10px', borderRadius: 'var(--r-pill)',
              border: '1px solid var(--border-strong)',
              background: indexed ? 'var(--primary-soft)' : 'var(--surface)',
              color: indexed ? 'var(--primary-text)' : 'var(--text-2)',
              cursor: 'pointer',
            }}
            title="Toggle between true values and an index where the leader = 100"
          >
            {indexed ? 'Indexed to leader' : 'True values'}
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((row) => {
          const pct = leader > 0 ? Math.max((row.value / leader) * 100, row.value > 0 ? 1.5 : 0) : 0;
          const labelText = indexed
            ? (row.value === leader ? '100' : leader > 0 ? (row.value / leader * 100).toFixed(row.value / leader * 100 < 10 ? 1 : 0) : '0')
            : fmtCompact(row.value);
          return (
            <div key={row.id} style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }} title={`${row.label}: ${fmtNum(row.value)}`}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
                fontSize: 13, fontWeight: row.isClient ? 700 : 400,
                color: row.isClient ? 'var(--text)' : 'var(--text-2)',
              }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.label}</span>
                {row.isClient && <Badge variant="brand" style={{ flexShrink: 0 }}>Client</Badge>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 20 }}>
                <div style={{ flex: 1, background: 'var(--surface)', borderRadius: 4, height: 18, position: 'relative' }}>
                  <div style={{
                    width: `${pct}%`,
                    height: '100%',
                    minWidth: row.value > 0 ? 4 : 0,
                    background: seriesColor(row.isClient),
                    borderRadius: '4px',
                    transition: 'width var(--dur-slow) var(--ease)',
                  }} />
                </div>
                <span style={{
                  minWidth: 46, textAlign: 'right', flexShrink: 0,
                  fontSize: 12, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
                  fontWeight: row.isClient ? 700 : 500,
                  color: row.isClient ? 'var(--text)' : 'var(--text-2)',
                }}>
                  {labelText}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {!hasCompetitors && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>Add competitors to compare.</div>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 11, color: 'var(--text-3)' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: CLIENT_COLOR, display: 'inline-block' }} />
        Client
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: COMPETITOR_COLOR, display: 'inline-block' }} />
        Competitors
      </span>
    </div>
  );
}

export default RankedBarChart;
