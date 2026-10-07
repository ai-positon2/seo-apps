// ── The SEO & GEO report's own small pieces ─────────────────────────────────
//
// Same role as crawlScope/report/reportPrimitives.jsx for the Tech Audit report,
// and deliberately the same measurements: a reader moving between the two
// reports should not feel the type change under them.
//
// A NOTE ON THE TYPE SCALE, because it is a deliberate departure from the
// handoff file. The SEO GEO design's 56px shell is identical to the Tech Audit
// design's (13.5 / 12 / 14px), but its page content is compressed into 16–28px:
// uppercase eyebrows at 16–17.5px where Tech Audit used 10–11px, body at 17px
// where Tech Audit used 13px — while its big score is 38px where Tech Audit's
// was 64px. Small text up ~1.55×, large text down ~0.85×, so the hierarchy is
// almost flat and the small print ends up larger than the body copy. That is the
// signature of an editing pass in the canvas, not an intention. Structure,
// layout, colour and copy are taken from the design exactly; the type is mapped
// back onto the app's scale.

/** Status → chip tone, for a check or an issue. */
export const SEV_TONE = {
  error: { bg: 'color-mix(in srgb, var(--viz-neg) 20%, transparent)', fg: 'var(--viz-neg)', label: 'Error' },
  fail: { bg: 'color-mix(in srgb, var(--viz-neg) 20%, transparent)', fg: 'var(--viz-neg)', label: 'Fail' },
  warning: { bg: 'color-mix(in srgb, var(--viz-warn) 20%, transparent)', fg: 'var(--viz-warn)', label: 'Warning' },
  notice: { bg: 'var(--neutral-800)', fg: 'var(--neutral-200)', label: 'Notice' },
  pass: { bg: 'color-mix(in srgb, var(--primary) 20%, transparent)', fg: 'var(--primary-text)', label: 'Pass' },
  manual: { bg: 'var(--neutral-800)', fg: 'var(--neutral-200)', label: 'Manual' },
  na: { bg: 'var(--neutral-800)', fg: 'var(--neutral-200)', label: 'N/A' },
  informational: { bg: 'var(--neutral-800)', fg: 'var(--neutral-200)', label: 'Info' },
  skipped: { bg: 'var(--neutral-800)', fg: 'var(--neutral-200)', label: 'Skipped' },
};

export const sevTone = (s) => SEV_TONE[s] || SEV_TONE.notice;

/** Answer-engine readiness → chip tone. */
export const PLATFORM_TONE = {
  ready: { bg: 'color-mix(in srgb, var(--primary) 20%, transparent)', fg: 'var(--primary-text)', label: 'Ready' },
  partial: { bg: 'color-mix(in srgb, var(--viz-warn) 20%, transparent)', fg: 'var(--viz-warn)', label: 'Partial' },
  not_ready: { bg: 'color-mix(in srgb, var(--viz-neg) 20%, transparent)', fg: 'var(--viz-neg)', label: 'Not ready' },
};

/** A 0–100 score → the report's three bands. Matches the crawl report's. */
export const bandColor = (score) => (
  !Number.isFinite(score) ? 'var(--text-3)'
    : score >= 70 ? 'var(--primary)'
      : score >= 45 ? 'var(--viz-warn)' : 'var(--viz-neg)'
);

export const Eyebrow = ({ children, tone = 'muted', style }) => (
  <span
    style={{
      fontSize: 10,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      fontWeight: 600,
      color: tone === 'accent' ? 'var(--primary-text)' : 'var(--text-3)',
      ...style,
    }}
  >
    {children}
  </span>
);

/** A card. The design's 14px radius, which is between --r-lg and --r-xl. */
export const Panel = ({ children, pad = '20px 22px', elevation = 'sm', style }) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      padding: pad,
      borderRadius: 14,
      background: 'var(--card)',
      border: '1px solid var(--border)',
      boxShadow: elevation === 'none' ? 'none'
        : elevation === 'md' ? 'var(--shadow-md)' : 'var(--shadow-sm)',
      ...style,
    }}
  >
    {children}
  </div>
);

/** A card's own heading — the design's 17px/600 line, at the app's 13px. */
export const PanelTitle = ({ children }) => (
  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{children}</span>
);

/**
 * The design's underlined tab strip, used at two levels: Summary / More Tech
 * Details, and the four panels inside the second one.
 */
export const UnderlineTabs = ({ tabs, active, onSelect }) => (
  <div style={{ display: 'flex', gap: 20, borderBottom: '1px solid var(--border)' }}>
    {tabs.map((t) => (
      <button
        key={t.id}
        type="button"
        onClick={() => onSelect(t.id)}
        style={{
          padding: '0 0 10px',
          fontFamily: 'var(--font-sans)',
          fontSize: 13,
          fontWeight: active === t.id ? 600 : 400,
          color: active === t.id ? 'var(--text)' : 'var(--text-3)',
          background: 'none',
          border: 'none',
          borderBottom: `2px solid ${active === t.id ? 'var(--primary)' : 'transparent'}`,
          cursor: 'pointer',
          marginBottom: -1,
          whiteSpace: 'nowrap',
        }}
      >
        {t.label}
      </button>
    ))}
  </div>
);

/** A pill filter, as on the Issues panel. */
export const FilterPill = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      fontSize: 12, padding: '5px 12px', borderRadius: 999, cursor: 'pointer',
      fontFamily: 'var(--font-sans)',
      border: `1px solid ${active ? 'var(--text)' : 'var(--border)'}`,
      background: active ? 'var(--text)' : 'var(--surface)',
      color: active ? 'var(--bg)' : 'var(--text-2)',
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </button>
);

/**
 * The design's small metric block, on --surface rather than --card: it sits in a
 * row above a card and would otherwise read as a card of its own.
 */
export const MiniStat = ({ label, value, color = 'var(--text)' }) => (
  <div
    style={{
      display: 'flex', flexDirection: 'column', gap: 4, padding: '14px 16px',
      borderRadius: 10, background: 'var(--surface)', border: '1px solid var(--border)',
    }}
  >
    <span
      style={{
        fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase',
        color: 'var(--text-3)', fontWeight: 600,
      }}
    >
      {label}
    </span>
    <span className="num" style={{ fontSize: 18, fontWeight: 700, color }}>{value}</span>
  </div>
);

/** A count tile — the four on the Summary view. */
export const CountTile = ({ label, value, color = 'var(--text)' }) => (
  <div
    style={{
      display: 'flex', flexDirection: 'column', gap: 4, padding: 18,
      borderRadius: 12, background: 'var(--card)', border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-sm)',
    }}
  >
    <span
      style={{
        fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase',
        color: 'var(--text-3)', fontWeight: 600,
      }}
    >
      {label}
    </span>
    <span className="num" style={{ fontSize: 26, fontWeight: 700, color }}>{value}</span>
  </div>
);

export const Chip = ({ children, bg = 'var(--neutral-800)', fg = 'var(--neutral-200)', mono = false }) => (
  <span
    style={{
      display: 'inline-flex', alignItems: 'center', fontSize: 11, padding: '2px 9px',
      borderRadius: 999, whiteSpace: 'nowrap', background: bg, color: fg,
      fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
    }}
  >
    {children}
  </span>
);

/**
 * A donut with the score inside it.
 *
 * The report's own rather than seoGeo/primitives.jsx's ScoreRing, which draws
 * its number as SVG <text> at a fixed 16px — unreadable at the 168px the
 * design's hero ring wants, and unscalable because the font size does not track
 * the size prop. This puts the number in the DOM over the middle.
 */
export function Donut({ score, size = 168, stroke = 9, numberSize = 42, label = '/ 100' }) {
  const has = Number.isFinite(score);
  const r = 52;
  const circ = 2 * Math.PI * r;
  const color = bandColor(score);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true">
        <circle cx="64" cy="64" r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        {has && (
          <circle
            cx="64" cy="64" r={r} fill="none" stroke={color} strokeWidth={stroke}
            strokeDasharray={`${(Math.max(0, Math.min(100, score)) / 100) * circ} ${circ}`}
            strokeLinecap="round" transform="rotate(-90 64 64)"
          />
        )}
      </svg>
      <div
        style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 2,
        }}
      >
        <span
          className="num"
          style={{ fontSize: numberSize, fontWeight: 600, color, lineHeight: 1 }}
        >
          {has ? score : '—'}
        </span>
        {label && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{label}</span>}
      </div>
    </div>
  );
}

/** A labelled bar, used for bucket composition. */
export const MeterRow = ({ label, value, pct, sub, color = 'var(--primary)' }) => (
  <div>
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
      <span style={{ fontSize: 12.5, color: 'var(--text)' }}>{label}</span>
      <span className="num" style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{value}</span>
    </div>
    <div style={{ height: 6, borderRadius: 999, background: 'var(--surface)', overflow: 'hidden' }}>
      <div style={{ height: '100%', borderRadius: 999, width: pct, background: color }} />
    </div>
    {sub && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{sub}</span>}
  </div>
);

export const TableFrame = ({ children }) => (
  <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--card)' }}>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>{children}</table>
  </div>
);

export const Th = ({ children, align = 'left' }) => (
  <th
    style={{
      padding: '10px 12px', textAlign: align, fontSize: 10, fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-3)',
      borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
    }}
  >
    {children}
  </th>
);

/** Strips a leading "ready — " / "partial — " verdict off an AI reason string. */
export function splitVerdict(value) {
  if (typeof value !== 'string') return { status: null, reason: '' };
  const m = value.match(/^\s*(ready|partial|not[_\s-]?ready)\s*[—:-]?\s*/i);
  if (!m) return { status: null, reason: value.trim() };
  const raw = m[1].toLowerCase().replace(/[\s-]/g, '_');
  return { status: raw === 'not_ready' ? 'not_ready' : raw, reason: value.slice(m[0].length).trim() };
}
