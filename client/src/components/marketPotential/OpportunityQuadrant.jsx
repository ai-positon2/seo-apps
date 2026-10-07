// ── Opportunity Quadrant (V2 Phase 3) — the board's signature element ─────────
// Scatter: x = competitor density (INVERTED so "more open" is to the right),
// y = Demand Index, bubble size = est. monthly searches, color = tier. Home is a
// distinct outlined reference marker at (its density, 100). Median-of-set lines
// split the four quadrants. Plain inline SVG, zero deps.

import { TIER_META } from './scoring';
import { shortName } from './boardBits';

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const QUADRANTS = [
  { x: 'right', y: 'top', label: 'Prime targets', hint: 'high demand · open' },
  { x: 'left', y: 'top', label: 'Contested', hint: 'high demand · crowded' },
  { x: 'right', y: 'bottom', label: 'Quiet', hint: 'low demand · open' },
  { x: 'left', y: 'bottom', label: 'Skip', hint: 'low demand · crowded' },
];

export default function OpportunityQuadrant({ rows, onSelect, height = 430, compact = false }) {
  const pts = rows.filter((r) => r.demandIndex != null && r.competitorDensity != null);
  const unplottable = rows.filter((r) => !r.isHome && (r.demandIndex == null || r.competitorDensity == null));

  if (pts.length < 2) {
    return (
      <div style={{ padding: 24, textAlign: 'center', fontSize: 13, color: 'var(--text-3)', border: '1px dashed var(--border-strong)', borderRadius: 'var(--r-lg)' }}>
        Not enough markets have both a Demand Index and competitor density to plot the quadrant.
        {rows.some((r) => r.competitorDensity == null) && ' Competitor density may be disabled for this run.'}
      </div>
    );
  }

  const W = 640, H = height, m = { t: 24, r: 24, b: 46, l: 54 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;

  const dens = pts.map((p) => p.competitorDensity);
  const dem = pts.map((p) => p.demandIndex);
  const dMin = Math.min(...dens), dMax = Math.max(...dens);
  const yMin = Math.min(...dem, 100), yMax = Math.max(...dem, 100);
  const dPad = (dMax - dMin) * 0.14 || 1, yPad = (yMax - yMin) * 0.14 || 10;
  const dLo = dMin - dPad, dHi = dMax + dPad;
  const yLo = Math.max(0, yMin - yPad), yHi = yMax + yPad;

  // x inverted: low density (more open) → right.
  const xOf = (d) => m.l + ((dHi - d) / (dHi - dLo)) * iw;
  const yOf = (v) => m.t + ((yHi - v) / (yHi - yLo)) * ih;

  const medX = xOf(median(dens));
  const medY = yOf(median(dem));
  const maxSearch = Math.max(...pts.map((p) => p.estMonthlySearches || 0), 1);
  const rOf = (s) => (compact ? 4 : 6) + Math.sqrt((s || 0) / maxSearch) * (compact ? 14 : 22);

  const cornerXY = (q) => ({
    x: q.x === 'right' ? m.l + iw - 6 : m.l + 6,
    y: q.y === 'top' ? m.t + 12 : m.t + ih - 6,
    anchor: q.x === 'right' ? 'end' : 'start',
  });

  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', maxWidth: '100%' }}>
        {/* plot frame */}
        <rect x={m.l} y={m.t} width={iw} height={ih} fill="var(--surface-2)" stroke="var(--border)" rx="6" />

        {/* median split lines */}
        <line x1={medX} y1={m.t} x2={medX} y2={m.t + ih} stroke="var(--border-strong)" strokeDasharray="4 4" />
        <line x1={m.l} y1={medY} x2={m.l + iw} y2={medY} stroke="var(--border-strong)" strokeDasharray="4 4" />

        {/* quadrant captions */}
        {QUADRANTS.map((q) => {
          const c = cornerXY(q);
          return (
            <text key={q.label} x={c.x} y={c.y} textAnchor={c.anchor} fontSize="11" fontWeight="700" fill="var(--text-3)" opacity="0.7">
              {q.label}
              <tspan fontSize="9" fontWeight="400"> · {q.hint}</tspan>
            </text>
          );
        })}

        {/* axis labels */}
        <text x={m.l + iw / 2} y={H - 10} textAnchor="middle" fontSize="10.5" fill="var(--text-3)">← more crowded          more open →</text>
        <text x={14} y={m.t + ih / 2} textAnchor="middle" fontSize="10.5" fill="var(--text-3)" transform={`rotate(-90 14 ${m.t + ih / 2})`}>Demand Index →</text>

        {/* bubbles */}
        {pts.map((p) => {
          const cx = xOf(p.competitorDensity), cy = yOf(p.demandIndex), r = rOf(p.estMonthlySearches);
          const tier = p.isHome ? null : (TIER_META[p.tier] || TIER_META.insufficient);
          const fill = p.isHome ? 'var(--primary)' : tier.color;
          return (
            <g key={p.geoId} style={{ cursor: onSelect ? 'pointer' : 'default' }} onClick={() => onSelect && onSelect(p.geoId)}>
              {p.isHome ? (
                <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--primary)" strokeWidth={2.2} strokeDasharray="3 2" />
              ) : (
                <circle cx={cx} cy={cy} r={r} fill={fill} fillOpacity={0.5} stroke={fill} strokeWidth={1.4} />
              )}
              <text x={cx} y={cy - r - 3} textAnchor="middle" fontSize="10" fontWeight={p.isHome ? 700 : 600} fill="var(--text)"
                style={{ paintOrder: 'stroke', stroke: 'var(--surface-2)', strokeWidth: 3 }}>
                {shortName(p.region)}{p.isHome ? ' (home)' : ''}
              </text>
              <title>{p.region}: Demand {p.demandIndex}, {p.competitorDensity} competitors, {(p.estMonthlySearches || 0).toLocaleString()} searches/mo</title>
            </g>
          );
        })}
      </svg>

      {unplottable.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
          Not plotted (missing demand or density): {unplottable.map((r) => shortName(r.region)).join(', ')}.
        </div>
      )}
    </div>
  );
}
