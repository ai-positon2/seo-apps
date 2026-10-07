// ── One-pager report (V2 Phase 3) ─────────────────────────────────────────────
// A print-styled single page a leader can forward. Always in the DOM but hidden on
// screen; the print stylesheet in DecisionBoard reveals only `.mp-report`.
// Export = window.print() → "Save as PDF". Fits one US-Letter / A4 page.

import OpportunityQuadrant from './OpportunityQuadrant';
import { reasonFor } from './VerdictStrip';
import { TIER_META } from './scoring';
import { ASSUMPTION_DEFS } from './assumptions';

function monthLabel(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[(m || 1) - 1]} ${y}`;
}

const cell = { padding: '5px 8px', fontSize: 10.5, borderBottom: '1px solid #E6EBF3', textAlign: 'left', color: '#0A2540' };
const cellR = { ...cell, textAlign: 'right' };

export default function ReportView({ result, scoredRows, weights, assumptions, summary, homeName }) {
  const pick = scoredRows.filter((r) => !r.isHome && r.opportunityScore != null).sort((a, b) => b.opportunityScore - a.opportunityScore)[0] || null;
  const top5 = [...scoredRows].sort((a, b) => {
    if (a.isHome) return 1; if (b.isHome) return -1;
    return (b.opportunityScore ?? -1) - (a.opportunityScore ?? -1);
  }).slice(0, 5);
  const w = weights || {};
  const assumptionLine = ASSUMPTION_DEFS.map((d) => {
    const v = assumptions?.[d.key];
    return `${d.label} ${d.kind === 'pct' ? `${Math.round((v ?? 0) * 100)}%` : `$${(v ?? 0).toLocaleString()}`}`;
  }).join(' · ');

  return (
    <div className="mp-report" style={{ background: '#fff', color: '#0A2540', fontFamily: 'var(--font-sans)', padding: 0 }}>
      {/* Title */}
      <div style={{ borderBottom: '2px solid #635BFF', paddingBottom: 8, marginBottom: 12 }}>
        <div style={{ fontSize: 18, fontWeight: 800 }}>Market Potential — {result.service?.name}</div>
        <div style={{ fontSize: 11, color: '#425466', marginTop: 2 }}>
          Home market: {homeName} · Data month: {monthLabel(result.yearMonth)} · Source: {result.dataSource === 'semrush' ? 'SEMrush (templated method)' : result.dataSource}
        </div>
      </div>

      {/* Verdict + summary */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#635BFF' }}>Verdict</div>
        {pick ? (
          <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2 }}>
            {pick.region} — Opportunity Score {pick.opportunityScore} ({TIER_META[pick.tier]?.label})
            <span style={{ fontSize: 11, fontWeight: 400, color: '#425466' }}> · {reasonFor(pick, scoredRows)}.</span>
          </div>
        ) : <div style={{ fontSize: 12, color: '#425466' }}>No standout expansion market in this set.</div>}
        {summary && <p style={{ fontSize: 11, color: '#0A2540', lineHeight: 1.5, margin: '6px 0 0' }}>{summary}</p>}
      </div>

      {/* Quadrant */}
      <div style={{ marginBottom: 12 }}>
        <OpportunityQuadrant rows={scoredRows} height={300} compact />
      </div>

      {/* Top-5 table */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10 }}>
        <thead>
          <tr style={{ background: '#F6F9FC' }}>
            <th style={cell}>#</th><th style={cell}>Market</th><th style={cellR}>Score</th>
            <th style={cell}>Tier</th><th style={cellR}>Demand Idx</th><th style={cellR}>Searches/mo</th>
            <th style={cellR}>Competitors</th><th style={cellR}>YoY</th>
          </tr>
        </thead>
        <tbody>
          {top5.map((r, i) => (
            <tr key={r.geoId}>
              <td style={cell}>{r.isHome ? '—' : i + 1}</td>
              <td style={cell}>{r.region}{r.isHome ? ' (home)' : ''}</td>
              <td style={cellR}>{r.isHome ? '—' : r.opportunityScore ?? '—'}</td>
              <td style={cell}>{r.isHome ? 'Home' : (TIER_META[r.tier]?.label || '—')}</td>
              <td style={cellR}>{r.demandIndex ?? '—'}</td>
              <td style={cellR}>{(r.estMonthlySearches ?? 0).toLocaleString()}</td>
              <td style={cellR}>{r.competitorDensity == null ? '—' : `${r.competitorDensity}${r.competitorBreakdown ? ` (${r.competitorBreakdown.providers}p/${r.competitorBreakdown.directories}d)` : ''}`}</td>
              <td style={cellR}>{r.yoyPct == null ? '—' : `${r.yoyPct > 0 ? '+' : ''}${r.yoyPct}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Assumptions + method */}
      <div style={{ fontSize: 9.5, color: '#425466', lineHeight: 1.5 }}>
        <div><b>Score weights:</b> demand {Math.round((w.demand ?? 0) * 100)}% · openness {Math.round((w.competition ?? 0) * 100)}% · growth {Math.round((w.trend ?? 0) * 100)}% · cost {Math.round((w.cost ?? 0) * 100)}%</div>
        <div style={{ marginTop: 2 }}><b>Revenue assumptions (for any $ figures):</b> {assumptionLine}</div>
        <div style={{ marginTop: 4, color: '#8792A2' }}>
          Relative index of city-tagged searches, home = 100 · Source: SEMrush national database, templated method · Not a market-size estimate.
        </div>
      </div>
    </div>
  );
}
