// ── Verdict strip (V2 Phase 3) ────────────────────────────────────────────────
// Verdict first (spec §6.2): the top market, its score/tier/confidence, and a
// deterministic one-line reason — plus the grounded AI summary underneath.

import { TierChip, ConfidenceBadge } from './boardBits';

// Deterministic reason ("highest demand of the set, only 2 provider competitors…").
export function reasonFor(pick, rows) {
  if (!pick) return '';
  const bits = [];
  const nonHome = rows.filter((r) => !r.isHome && r.demandIndex != null).sort((a, b) => b.demandIndex - a.demandIndex);
  if (pick.demandIndex != null) {
    bits.push(nonHome[0]?.geoId === pick.geoId ? 'highest per-capita demand of the set' : `${(pick.demandIndex / 100).toFixed(1)}× home per-capita demand`);
  }
  if (pick.competitorBreakdown) {
    const p = pick.competitorBreakdown.providers;
    bits.push(`${p} provider competitor${p === 1 ? '' : 's'} in the top 10`);
  } else if (pick.competitorDensity != null) {
    bits.push(`${pick.competitorDensity} competitors in the top 10`);
  }
  if (pick.yoyPct != null) bits.push(`trend ${pick.yoyPct > 0 ? '+' : ''}${pick.yoyPct}%`);
  if (pick.competitorBreakdown?.youRankHere) bits.push('you already rank here');
  return bits.join(', ');
}

export default function VerdictStrip({ pick, rows, rankableTerms, homeShort, summary, summaryLoading, summarySource, onSelect, onRegenerate }) {
  return (
    <div style={{
      marginBottom: 18, borderRadius: 'var(--r-lg)', border: '1px solid rgba(99,91,255,0.28)',
      background: 'linear-gradient(180deg, var(--primary-soft), var(--card))', padding: '16px 18px',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--primary-text)', marginBottom: 10 }}>Verdict</div>

      {pick ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={() => onSelect?.(pick.geoId)} title="Open market detail"
              style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              🎯 {pick.region}
            </button>
            <TierChip tier={pick.tier} />
            <ConfidenceBadge confidence={pick.confidence} coverage={pick.coverage} termsWithVolume={pick.termsWithVolume} rankableTerms={rankableTerms} />
            <span style={{ fontSize: 13, color: 'var(--text-2)' }}>Opportunity Score <b style={{ color: 'var(--text)' }}>{pick.opportunityScore}</b></span>
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--text-2)', marginTop: 6, lineHeight: 1.5 }}>
            {reasonFor(pick, rows)}.
          </div>
        </>
      ) : (
        <div style={{ fontSize: 13.5, color: 'var(--text-2)' }}>
          No standout expansion market in this set — every candidate trails {homeShort} on the weighted score.
        </div>
      )}

      {/* Grounded AI summary */}
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed rgba(99,91,255,0.25)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-3)' }}>Summary</span>
          <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
            {summaryLoading ? 'generating…' : summarySource === 'openai' ? 'AI-generated — verify before sharing' : 'auto-generated — verify before sharing'}
          </span>
          {onRegenerate && !summaryLoading && (
            <button onClick={onRegenerate} title="Regenerate for the current priorities"
              style={{ marginLeft: 'auto', fontSize: 10.5, background: 'none', border: 'none', color: 'var(--primary-text)', cursor: 'pointer' }}>
              ↻ Regenerate
            </button>
          )}
        </div>
        {summaryLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[92, 86, 70].map((w, i) => (
              <div key={i} style={{ height: 10, width: `${w}%`, borderRadius: 4, background: 'linear-gradient(90deg, var(--surface), var(--surface-2), var(--surface))', backgroundSize: '200% 100%', animation: 'mpShimmer 1.2s var(--ease) infinite' }} />
            ))}
            <style>{`@keyframes mpShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
          </div>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap' }}>{summary}</p>
        )}
      </div>
    </div>
  );
}
