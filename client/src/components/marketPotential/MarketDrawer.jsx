// ── Market drill-down drawer (V2 Phase 2/3) ───────────────────────────────────
// Everything about ONE market: index + percentile, confidence in plain words,
// 12-month seasonality, term contribution, named competitors by type, and the
// directional dollar model with visible math.

import { Drawer } from '../../ui/Drawer';
import { Button } from '../../ui/Button';
import { TierChip, ConfidenceBadge, MiniBar, fmt } from './boardBits';
import { computeDollars, inquiriesMath, money, moneyExact } from './assumptions';

const TYPE_META = {
  provider:  { label: 'Provider',  color: 'var(--primary-text)', bg: 'var(--primary-soft)' },
  directory: { label: 'Directory', color: 'var(--text-2)',       bg: 'var(--surface)' },
  you:       { label: 'You',       color: 'var(--success)',      bg: 'var(--success-soft)' },
};

function monthLabel(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[(m || 1) - 1]} ${y}`;
}

// Wider seasonality area chart from the 12-month series.
function Seasonality({ series }) {
  if (!series || series.length < 2) return <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No monthly series.</div>;
  const w = 372, h = 68, pad = 4;
  const max = Math.max(...series), min = Math.min(...series);
  const range = max - min || 1;
  const pt = (v, i) => {
    const x = pad + (i / (series.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((v - min) / range) * (h - 2 * pad);
    return [x, y];
  };
  const line = series.map((v, i) => pt(v, i).join(',')).join(' ');
  const area = `${pad},${h - pad} ${line} ${w - pad},${h - pad}`;
  const [lx, ly] = pt(series[series.length - 1], series.length - 1);
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <polygon points={area} fill="var(--primary-soft)" />
      <polyline points={line} fill="none" stroke="var(--primary)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r={2.4} fill="var(--primary)" />
    </svg>
  );
}

function Row({ label, value, sub }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
      <div>
        <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{sub}</div>}
      </div>
      <div className="num" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap', marginLeft: 12 }}>{value}</div>
    </div>
  );
}

function SectionTitle({ children, right }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '22px 0 8px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-3)' }}>{children}</div>
      {right}
    </div>
  );
}

export default function MarketDrawer({ open, row, result, assumptions, onClose, onOpenAssumptions }) {
  if (!row) return null;
  const rankableTerms = result?.stats?.rankableTerms;
  const topN = result?.stats?.densityTopN ?? 10;
  const cb = row.competitorBreakdown;
  const dollars = computeDollars(row, assumptions);
  const maxShare = Math.max(...(row.termBreakdown || []).map((t) => t.share), 0.0001);
  const skewed = (row.termBreakdown || []).some((t) => !t.isOther && t.share > 0.6);

  return (
    <Drawer open={open} onClose={onClose} width={480}
      title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{row.region}{row.isHome ? ' · Home' : ''}</span>}
      footer={<Button variant="ghost" size="sm" onClick={onClose}>Close</Button>}>

      {/* Headline chips */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        {row.isHome ? (
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Baseline market · Demand Index 100</span>
        ) : (
          <>
            <TierChip tier={row.tier} />
            <ConfidenceBadge confidence={row.confidence} coverage={row.coverage} termsWithVolume={row.termsWithVolume} rankableTerms={rankableTerms} />
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>Opportunity Score <b style={{ color: 'var(--text)' }}>{row.opportunityScore ?? '—'}</b></span>
          </>
        )}
      </div>

      {/* Evidence */}
      <SectionTitle>Demand</SectionTitle>
      <Row label="Demand Index" sub="Per-capita search demand vs. home (= 100)" value={row.demandIndex ?? '—'} />
      <Row label="Rank in this run" value={row.percentileDemand != null ? `${row.percentileDemand}th pct` : '—'} />
      <Row label="Est. city-tagged searches / mo" sub={`A comparative floor · ${monthLabel(result?.yearMonth)}`} value={fmt(row.estMonthlySearches)} />
      <Row label="Confidence"
        sub={rankableTerms != null ? `${row.termsWithVolume} of ${rankableTerms} phrases returned volume (${Math.round((row.coverage || 0) * 100)}% coverage)` : `${Math.round((row.coverage || 0) * 100)}% coverage`}
        value={(row.confidence || '—').replace(/^./, (c) => c.toUpperCase())} />

      {/* Seasonality */}
      <SectionTitle>12-month seasonality</SectionTitle>
      <Seasonality series={row.monthlyTotals} />
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
        {row.yoyPct == null ? 'Trend unavailable' : `${row.yoyPct > 0 ? '+' : ''}${row.yoyPct}% year over year`}
      </div>

      {/* Term contribution */}
      <SectionTitle>What's driving demand</SectionTitle>
      {skewed && (
        <div style={{ fontSize: 11.5, color: 'var(--warning)', background: 'var(--warning-soft)', borderRadius: 'var(--r-sm)', padding: '6px 9px', marginBottom: 8 }}>
          Driven mainly by one phrase — a fragile signal.
        </div>
      )}
      {(row.termBreakdown || []).length === 0
        ? <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No term-level volume for this market.</div>
        : (row.termBreakdown || []).map((t) => (
          <div key={t.term} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7 }}>
            <span style={{ flex: 1, fontSize: 12.5, color: t.isOther ? 'var(--text-3)' : 'var(--text-2)', fontStyle: t.isOther ? 'italic' : 'normal', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.term}{!row.isHome && !t.isOther ? ' + city' : ''}
            </span>
            <div style={{ width: 120 }}><MiniBar value={t.share} max={maxShare} color={t.isOther ? 'var(--text-3)' : 'var(--primary)'} /></div>
            <span className="num" style={{ fontSize: 12, color: 'var(--text-3)', minWidth: 34, textAlign: 'right' }}>{Math.round(t.share * 100)}%</span>
          </div>
        ))}

      {/* Competitors */}
      <SectionTitle>Who ranks here {cb && <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--text-3)' }}>· top {topN}</span>}</SectionTitle>
      {row.competitorDensity == null ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Competitor density not measured for this run.</div>
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 8 }}>
            <b>{row.competitorDensity}</b> in the top {topN} — {cb ? <>{cb.providers} provider{cb.providers === 1 ? '' : 's'}, {cb.directories} director{cb.directories === 1 ? 'y' : 'ies'}</> : 'unclassified'}.
            {cb?.youRankHere && <span style={{ color: 'var(--success)', fontWeight: 600 }}> You already appear here.</span>}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(cb?.domains || (row.competitorDomains || []).map((d) => ({ domain: d, type: 'provider' }))).map(({ domain, type }) => {
              const m = TYPE_META[type] || TYPE_META.provider;
              return (
                <a key={domain} href={`https://${domain}`} target="_blank" rel="noopener noreferrer" title={m.label}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '3px 9px', borderRadius: 'var(--r-pill)',
                    background: m.bg, border: type === 'you' ? '1px solid var(--success)' : '1px solid var(--border)', color: m.color, textDecoration: 'none',
                  }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: m.color }} />
                  {domain}
                </a>
              );
            })}
          </div>
        </>
      )}

      {/* Directional dollars */}
      <SectionTitle right={<button onClick={onOpenAssumptions} style={{ fontSize: 11, background: 'none', border: 'none', color: 'var(--primary-text)', cursor: 'pointer', textTransform: 'none', letterSpacing: 0 }}>Edit assumptions</button>}>
        Directional value <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--text-3)' }}>· estimates, not a forecast</span>
      </SectionTitle>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: '4px 12px' }}>
        <Row label="Est. inquiries / mo" sub={inquiriesMath(row, assumptions)} value={fmt(dollars.estMonthlyInquiries)} />
        <Row label="Est. new patients / mo" value={fmt(dollars.estMonthlyPatients)} />
        <Row label="Est. annual revenue" sub="Directional floor — city-tagged demand only" value={money(dollars.estAnnualRevenue)} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '7px 0' }}>
          <div>
            <div style={{ fontSize: 13, color: 'var(--text-2)' }}>Est. SEM budget / mo</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{fmt(dollars.searches)} searches × {Math.round(assumptions.paidCtrShare * 100)}% × ${row.medianCpc.toFixed(2)} CPC</div>
          </div>
          <div className="num" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginLeft: 12 }}>{moneyExact(dollars.estMonthlySemBudget)}</div>
        </div>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5, marginTop: 10 }}>
        These count only searchers who typed the city name — true demand is a multiple of this. Read them as a
        comparative floor between markets, not a forecast.
      </p>
    </Drawer>
  );
}
