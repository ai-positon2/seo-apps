// ── Decision Board (V2) — the leader-facing results view ──────────────────────
// Information hierarchy (spec §6.2): verdict → evidence → detail → method. A leader
// reads top-to-bottom and can stop at any point with a correct conclusion:
//   verdict strip (+ grounded summary) → opportunity quadrant / map → ranked table
//   → per-market drill-down → methodology. Analysts keep full depth; one-pager +
//   CSV export the conclusion.

import { useState, useMemo, useEffect, useCallback } from 'react';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';
import { Tabs } from '../../ui/Tabs';
import { mp } from '../../lib/marketPotentialApi';
import USMetroMap from '../USMetroMap';
import WeightControls from './WeightControls';
import MarketDrawer from './MarketDrawer';
import AssumptionsDrawer from './AssumptionsDrawer';
import VerdictStrip from './VerdictStrip';
import OpportunityQuadrant from './OpportunityQuadrant';
import ReportView from './ReportView';
import { TierChip, ConfidenceBadge, ScoreBar, Sparkline, fmt, shortName } from './boardBits';
import { loadAssumptions, saveAssumptions } from './assumptions';

function indexColor(idx, isHome) {
  if (isHome) return 'var(--primary)';
  if (idx == null) return 'var(--text-3)';
  if (idx >= 120) return 'var(--success)';
  if (idx >= 80) return 'var(--warning)';
  return 'var(--info)';
}
function densityColor(n) {
  if (n == null) return 'var(--text-3)';
  if (n < 10) return 'var(--success)';
  if (n <= 25) return 'var(--warning)';
  return 'var(--danger)';
}

const thStyle = { padding: '10px 14px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-3)', whiteSpace: 'nowrap', textAlign: 'left' };
const tdStyle = { padding: '11px 14px', color: 'var(--text)', whiteSpace: 'nowrap' };

function Th({ label, k, sort, setSort, tip, align = 'left' }) {
  const active = k && sort.key === k;
  return (
    <th title={tip || undefined}
      onClick={() => k && setSort((s) => ({ key: k, dir: s.key === k && s.dir === 'desc' ? 'asc' : 'desc' }))}
      style={{ ...thStyle, textAlign: align, cursor: k ? 'pointer' : 'default', userSelect: 'none' }}>
      {label}
      {k && <span style={{ opacity: active ? 1 : 0.3, marginLeft: 3 }}>{active ? (sort.dir === 'desc' ? '▼' : '▲') : '↕'}</span>}
      {tip && <span style={{ marginLeft: 3, opacity: 0.5 }}>ⓘ</span>}
    </th>
  );
}

// Deterministic top pick — highest Opportunity Score among non-home markets that
// are at least Monitor-tier; fall back to the best-scoring non-home row.
export function topMarket(rows) {
  const cands = rows.filter((r) => !r.isHome && r.opportunityScore != null);
  const strong = cands.filter((r) => r.tier === 'prioritize' || r.tier === 'strong' || r.tier === 'monitor');
  const pool = strong.length ? strong : cands;
  return pool.slice().sort((a, b) => b.opportunityScore - a.opportunityScore)[0] || null;
}

// Trim a scored row to what /summary needs (keeps the payload small).
const trimForSummary = (r) => ({
  geoId: r.geoId, region: r.region, isHome: r.isHome, opportunityScore: r.opportunityScore, tier: r.tier,
  demandIndex: r.demandIndex, estMonthlySearches: r.estMonthlySearches, competitorDensity: r.competitorDensity,
  competitorBreakdown: r.competitorBreakdown, yoyPct: r.yoyPct, confidence: r.confidence,
});

export default function DecisionBoard({ result, scoredRows, weights, onWeightsChange, homeName, units, onExport, onSave, onBack }) {
  const [sort, setSort] = useState({ key: 'opportunityScore', dir: 'desc' });
  const [drawerGeo, setDrawerGeo] = useState(null);
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  const [assumptions, setAssumptions] = useState(() => loadAssumptions(result.service?.id));
  const [viz, setViz] = useState('quadrant');
  const [methodOpen, setMethodOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summarySource, setSummarySource] = useState(null);

  useEffect(() => { setAssumptions(loadAssumptions(result.service?.id)); }, [result.service?.id]);
  useEffect(() => { saveAssumptions(result.service?.id, assumptions); }, [assumptions, result.service?.id]);

  // Grounded summary — fetch once per run; user can regenerate for current weights.
  const fetchSummary = useCallback(async (w) => {
    if (!result?.service?.id) return;
    setSummaryLoading(true);
    try {
      const res = await mp.summary({
        serviceId: result.service.id, yearMonth: result.yearMonth,
        rows: scoredRows.map(trimForSummary), weightsUsed: w,
      });
      setSummary(res.summary || ''); setSummarySource(res.source || null);
    } catch { setSummary(''); setSummarySource(null); } finally { setSummaryLoading(false); }
  }, [result, scoredRows]);

  // Refetch only when a genuinely new run loads (not on every weight nudge).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchSummary(weights); }, [result?.service?.id, result?.yearMonth]);

  const sortedRows = useMemo(() => {
    const rows = [...scoredRows];
    const { key, dir } = sort;
    rows.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return dir === 'desc' ? bv - av : av - bv;
    });
    return rows;
  }, [scoredRows, sort]);

  const rankableTerms = result.stats?.rankableTerms;
  const homeShort = shortName(homeName);
  const pick = useMemo(() => topMarket(scoredRows), [scoredRows]);
  const drawerRow = drawerGeo ? scoredRows.find((r) => r.geoId === drawerGeo) : null;

  const homeVolumeLow = (result.warnings || []).includes('home_volume_low');
  const nonHome = scoredRows.filter((r) => !r.isHome);
  const allInsufficient = nonHome.length > 0 && nonHome.every((r) => r.confidence === 'insufficient' || r.demandIndex == null);

  return (
    <div>
      <style>{`
        .mp-brow{cursor:pointer;} .mp-brow:hover td{background:var(--surface-2);}
        @media screen { .mp-report{ display:none; } }
        @media print {
          body * { visibility: hidden !important; }
          .mp-report, .mp-report * { visibility: visible !important; }
          .mp-report { position: absolute; left: 0; top: 0; width: 100%; padding: 0 !important; }
          @page { size: auto; margin: 14mm; }
        }
      `}</style>

      {/* Run summary + actions */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
          <b>{result.service.name}</b>{result.basketVersion ? ` · v${result.basketVersion}` : ''} · {result.stats?.regions ?? scoredRows.length} regions
          {result.stats?.apiCalls != null && <> · {result.stats.apiCalls} fetched / {result.stats.cacheHits} cached</>}
          {units && result.stats?.unitsUsed != null && <> · <b>{result.stats.unitsUsed.toLocaleString()} units used</b></>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="ghost" size="sm" onClick={() => setAssumptionsOpen(true)}>Assumptions</Button>
          <Button variant="secondary" size="sm" onClick={onExport}>⬇ CSV</Button>
          <Button variant="secondary" size="sm" onClick={() => window.print()}>⎙ One-pager</Button>
          <Button variant="secondary" size="sm" onClick={onSave}>Save</Button>
        </div>
      </div>

      {/* Degraded-state banners (designed, not accidental — §6.3) */}
      {homeVolumeLow && (
        <Banner tone="warning">
          <b>Home market has very little city-tagged search volume</b> ({fmt(result.homeBase)} searches/mo for this basket), so every index below is unstable.
          Try a broader service definition, or treat this run as exploratory.
        </Banner>
      )}
      {allInsufficient && (
        <Banner tone="warning">
          <b>This service looks too niche for city-tagged search data.</b> None of the compared markets returned enough volume to rank confidently — try the broader service category.
        </Banner>
      )}

      {/* Verdict + grounded summary */}
      <VerdictStrip
        pick={pick} rows={scoredRows} rankableTerms={rankableTerms} homeShort={homeShort}
        summary={summary} summaryLoading={summaryLoading} summarySource={summarySource}
        onSelect={setDrawerGeo} onRegenerate={() => fetchSummary(weights)}
      />

      {/* Weight controls — reorder without refetch */}
      <div style={{ marginBottom: 18 }}>
        <WeightControls weights={weights} onChange={onWeightsChange} />
      </div>

      {/* Quadrant / Map toggle */}
      <div style={{ marginBottom: 8 }}>
        <Tabs variant="segmented" tabs={[{ key: 'quadrant', label: 'Opportunity quadrant' }, { key: 'map', label: 'US map' }]} active={viz} onChange={setViz} />
      </div>
      <div style={{ marginBottom: 22 }}>
        {viz === 'quadrant'
          ? <OpportunityQuadrant rows={scoredRows} onSelect={setDrawerGeo} />
          : <USMetroMap mode="result" rows={result.rows} />}
      </div>

      {/* Ranked table */}
      <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 880 }}>
          <thead>
            <tr style={{ background: 'var(--surface)' }}>
              <th style={thStyle}>#</th>
              <th style={thStyle}>Market</th>
              <Th label="Opportunity" k="opportunityScore" sort={sort} setSort={setSort} align="left"
                tip="Composite of demand, market openness, growth and cost, weighted by your priorities above. 0–100." />
              <Th label="Demand Index" k="demandIndex" sort={sort} setSort={setSort} align="right"
                tip="Search demand per 100k residents, indexed to your home market (home = 100)." />
              <Th label="Searches/mo" k="estMonthlySearches" sort={sort} setSort={setSort} align="right"
                tip="Estimated city-tagged searches per month for the basket. A comparative floor, not total market size." />
              <Th label="Competitors" k="competitorDensity" sort={sort} setSort={setSort} align="right"
                tip="Unique domains in the top 10 for this service here, split into providers · directories. Click the row for names." />
              <Th label="Trend (12mo)" k="yoyPct" sort={sort} setSort={setSort} align="right"
                tip="Year-over-year change in city-tagged search volume." />
              <Th label="CPC" k="medianCpc" sort={sort} setSort={setSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r, i) => {
              const dir = r.yoyPct == null ? 'flat' : r.yoyPct > 0 ? 'up' : r.yoyPct < 0 ? 'down' : 'flat';
              const cb = r.competitorBreakdown;
              return (
                <tr key={r.geoId} className="mp-brow" onClick={() => setDrawerGeo(r.geoId)}
                  style={{ borderTop: '1px solid var(--border)', background: r.isHome ? 'var(--primary-soft)' : 'transparent' }}>
                  <td style={tdStyle}>{i + 1}</td>
                  <td style={{ ...tdStyle, fontWeight: 600 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {r.region}
                      {r.isHome ? <Badge variant="brand">Home</Badge> : <TierChip tier={r.tier} size="sm" />}
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-3)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {r.population ? `${(r.population / 1e6).toFixed(1)}M residents` : ''}
                      {!r.isHome && r.confidence && <ConfidenceBadge confidence={r.confidence} coverage={r.coverage} termsWithVolume={r.termsWithVolume} rankableTerms={rankableTerms} />}
                    </div>
                  </td>
                  <td style={tdStyle}>
                    {r.isHome ? <span style={{ color: 'var(--text-3)', fontSize: 12 }}>baseline</span> : <ScoreBar score={r.opportunityScore} />}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: indexColor(r.demandIndex, r.isHome) }}>
                    {r.demandIndex != null ? r.demandIndex : '—'}
                    {!r.isHome && r.demandIndex != null && <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-3)' }}> ({(r.demandIndex / 100).toFixed(1)}×)</span>}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(r.estMonthlySearches)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    {r.competitorDensity == null
                      ? <span style={{ color: 'var(--text-3)' }}>—</span>
                      : (
                        <span style={{ fontWeight: 600, color: densityColor(r.competitorDensity), display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
                          {r.competitorDensity}
                          {cb && <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-3)' }}>· {cb.providers}p {cb.directories}d</span>}
                          {cb?.youRankHere && <span title="You rank here" style={{ color: 'var(--success)' }}>●</span>}
                        </span>
                      )}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                      <Sparkline series={r.monthlyTotals} dir={dir} />
                      <span style={{ fontSize: 12, minWidth: 44, textAlign: 'right', color: dir === 'up' ? 'var(--success)' : dir === 'down' ? 'var(--danger)' : 'var(--text-3)' }}>
                        {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '▬'} {r.yoyPct == null ? '—' : `${r.yoyPct > 0 ? '+' : ''}${r.yoyPct}%`}
                      </span>
                    </div>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>${r.medianCpc.toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Methodology (collapsed — trust feature, not fine print) */}
      <div style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'hidden' }}>
        <button onClick={() => setMethodOpen((v) => !v)}
          style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: 'var(--surface)', border: 'none', cursor: 'pointer', color: 'var(--text-2)', fontSize: 13, fontWeight: 600 }}>
          <span>How this works &amp; what it can't see</span>
          <span style={{ color: 'var(--text-3)' }}>{methodOpen ? '▲' : '▼'}</span>
        </button>
        {methodOpen && (
          <div style={{ padding: '14px 16px', fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.7, background: 'var(--card)' }}>
            <p style={{ margin: '0 0 8px' }}>
              <b>Demand Index</b> normalises each market's city-tagged search volume by its population (per 100k residents) and indexes it to your home market (= 100). <b>Opportunity Score</b> blends demand, market openness (fewer ranking domains), 12-month growth and click cost using the priorities you set — normalised within this comparison set.
            </p>
            <p style={{ margin: '0 0 8px' }}>
              <b>What it can't see:</b> because SEMrush is national, all local signal comes from searchers who typed the city name (the templated <code>[service] [city]</code> method). Absolute volumes therefore <b>undercount</b> real demand — read every figure as a relative index between markets, not total market size. Dollar figures are directional and assumption-driven.
            </p>
            <div style={{ color: 'var(--text-3)', fontSize: 11.5 }}>
              Data month: {result.yearMonth} · Source: {result.dataSource}{result.method ? ` · ${result.method} method` : ''}{result.basketVersion ? ` · basket v${result.basketVersion}` : ''} · {result.stats?.rankableTerms ?? '?'} terms measured.
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <Button variant="ghost" onClick={onBack}>← Adjust regions</Button>
      </div>

      {/* Drawers + hidden print report */}
      <MarketDrawer open={!!drawerRow} row={drawerRow} result={result} assumptions={assumptions}
        onClose={() => setDrawerGeo(null)} onOpenAssumptions={() => setAssumptionsOpen(true)} />
      <AssumptionsDrawer open={assumptionsOpen} onClose={() => setAssumptionsOpen(false)} assumptions={assumptions} onChange={setAssumptions} />
      <ReportView result={result} scoredRows={scoredRows} weights={weights} assumptions={assumptions} summary={summary} homeName={homeName} />
    </div>
  );
}

function Banner({ tone = 'warning', children }) {
  const bg = tone === 'danger' ? 'var(--danger-soft)' : 'var(--warning-soft)';
  const fg = tone === 'danger' ? 'var(--danger)' : 'var(--warning)';
  return (
    <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 'var(--r-md)', fontSize: 12.5, lineHeight: 1.5, background: bg, color: fg, border: `1px solid ${fg}22` }}>
      {children}
    </div>
  );
}
