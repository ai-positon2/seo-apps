// ── Shared presentational bits for the Decision Board (V2) ────────────────────
// Small, quiet, token-driven. Every status carries a text label, never color alone.

import { TIER_META, CONFIDENCE_META } from './scoring';

export const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString());
export const shortName = (name) => (name || '').split(',')[0].split('–')[0].trim();

// Tier chip — label + color (accessibility: text always shown).
export function TierChip({ tier, size = 'md' }) {
  if (!tier) return null;
  const m = TIER_META[tier] || TIER_META.insufficient;
  const pad = size === 'sm' ? '1px 7px' : '2px 9px';
  const fs = size === 'sm' ? 10.5 : 11.5;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: pad, borderRadius: 'var(--r-pill)',
      fontSize: fs, fontWeight: 600, lineHeight: 1.4, color: m.color, background: m.bg,
      border: m.dashed ? '1px dashed var(--border-strong)' : '1px solid transparent', whiteSpace: 'nowrap',
    }}>
      {m.label}
    </span>
  );
}

// Confidence badge — small, sits next to a score. Tooltip carries the plain rule.
export function ConfidenceBadge({ confidence, coverage, termsWithVolume, rankableTerms }) {
  const m = CONFIDENCE_META[confidence] || CONFIDENCE_META.insufficient;
  const tip = termsWithVolume != null && rankableTerms != null
    ? `${termsWithVolume} of ${rankableTerms} phrases returned volume (${Math.round((coverage || 0) * 100)}% coverage)`
    : `${Math.round((coverage || 0) * 100)}% of phrases returned volume`;
  return (
    <span title={tip} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 7px', borderRadius: 'var(--r-pill)',
      fontSize: 10.5, fontWeight: 600, color: m.color, background: m.bg, whiteSpace: 'nowrap', cursor: 'help',
    }}>
      {m.label}
    </span>
  );
}

// Score bar — 0–100 fill with the number beside it (bars alone aren't readable).
export function ScoreBar({ score, width = 90 }) {
  if (score == null) return <span style={{ color: 'var(--text-3)' }}>—</span>;
  const color = score >= 70 ? 'var(--success)' : score >= 55 ? 'var(--accent)' : score >= 35 ? 'var(--warning)' : 'var(--text-3)';
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width, height: 7, borderRadius: 'var(--r-pill)', background: 'var(--surface-2)', border: '1px solid var(--border)', overflow: 'hidden' }}>
        <div style={{ width: `${Math.max(2, Math.min(100, score))}%`, height: '100%', background: color, borderRadius: 'var(--r-pill)' }} />
      </div>
      <span className="num" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', minWidth: 22, textAlign: 'right' }}>{score}</span>
    </div>
  );
}

// Trend sparkline — 12 points, no axes, dot on last point, up/down tint.
export function Sparkline({ series, dir, w = 58, h = 20 }) {
  if (!series || series.length < 2) return <span style={{ color: 'var(--text-3)' }}>—</span>;
  const pad = 2;
  const max = Math.max(...series), min = Math.min(...series);
  const range = max - min || 1;
  const xy = (v, i) => {
    const x = pad + (i / (series.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((v - min) / range) * (h - 2 * pad);
    return [x, y];
  };
  const pts = series.map((v, i) => xy(v, i).map((n) => n.toFixed(1)).join(',')).join(' ');
  const [lx, ly] = xy(series[series.length - 1], series.length - 1);
  const color = dir === 'up' ? 'var(--success)' : dir === 'down' ? 'var(--danger)' : 'var(--text-3)';
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r={2} fill={color} />
    </svg>
  );
}

// Small horizontal contribution bar (term breakdown / component readout).
export function MiniBar({ value, max = 1, color = 'var(--primary)', width = '100%' }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div style={{ width, height: 6, borderRadius: 'var(--r-pill)', background: 'var(--surface-2)', overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 'var(--r-pill)' }} />
    </div>
  );
}
