import { fmtCompact } from '../utils';

// Client-centric KPI tile: the client's value, its rank in the set, a delta
// vs. the leader (or vs. the median when the client IS the leader), and a
// thin inline bar for at-a-glance context. Answers "where do we stand" in
// one glance, before any full comparison chart.
export function KpiScorecard({ label, stat, formatValue = fmtCompact }) {
  if (!stat) return null;
  const { clientValue, rank, total, leaderValue, medianValue, isLeader } = stat;

  let deltaText = 'No data yet';
  let deltaVariant = 'neutral';
  if (total <= 1) {
    deltaText = 'No competitors yet';
  } else if (leaderValue > 0) {
    if (isLeader) {
      const ratio = medianValue > 0 ? clientValue / medianValue : 1;
      deltaText = ratio >= 1.05 ? `${ratio.toFixed(1)}× vs. median` : 'Leading the set';
      deltaVariant = 'success';
    } else {
      const ratio = clientValue > 0 ? leaderValue / clientValue : null;
      deltaText = ratio ? `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× behind leader` : 'Behind leader';
      deltaVariant = 'warning';
    }
  }

  const barPct = leaderValue > 0 ? Math.max((clientValue / leaderValue) * 100, clientValue > 0 ? 2 : 0) : 0;
  const deltaColors = {
    success: { bg: 'var(--success-soft)', fg: 'var(--success)' },
    warning: { bg: 'var(--warning-soft)', fg: 'var(--warning)' },
    neutral: { bg: 'var(--surface)', fg: 'var(--text-3)' },
  };
  const dc = deltaColors[deltaVariant];

  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)',
      padding: 16, display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-3)' }}>
        {label}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, color: 'var(--text)', letterSpacing: '-0.02em' }}>
          {formatValue(clientValue)}
        </span>
        <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>
          #{rank} of {total}
        </span>
      </div>

      <span style={{
        alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center',
        padding: '2px 8px', borderRadius: 'var(--r-pill)',
        fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 500,
        background: dc.bg, color: dc.fg,
      }}>
        {deltaText}
      </span>

      {total > 1 && (
        <div style={{ background: 'var(--surface)', borderRadius: 3, height: 6, marginTop: 2 }}>
          <div style={{ width: `${barPct}%`, height: '100%', minWidth: clientValue > 0 ? 3 : 0, background: 'var(--primary)', borderRadius: 3, transition: 'width var(--dur-slow) var(--ease)' }} />
        </div>
      )}
    </div>
  );
}

export default KpiScorecard;
