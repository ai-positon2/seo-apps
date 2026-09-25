import { Badge, STATUS } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Spinner as UiSpinner } from '../../ui/Spinner';

// ── SEO Studio primitives ───────────────────────────────────────────────────
// The small, repeated pieces of the SEO Studio design language, kept in one
// file so the card, kicker, tag and button language is defined once. Everything
// draws from the tokens in index.css, so all of it follows the theme switch
// without a single per-theme branch.
//
// These began as the home dashboard's own pieces and moved here when the module
// report pages were redesigned in the same language: the alternative was a
// module page importing from components/home, or a second copy of Card and Tag
// that would drift from this one on the first tweak.

export const Card = ({ children, style, elevation = 'sm', ...rest }) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      padding: 16,
      borderRadius: 'var(--r-md)',
      background: 'var(--card)',
      boxShadow: elevation === 'md' ? 'var(--shadow-md)' : 'var(--shadow-sm)',
      border: '1px solid var(--border)',
      ...style,
    }}
    {...rest}
  >
    {children}
  </div>
);

/** The design's recurring 10px uppercase accent label above a card's content. */
export const Kicker = ({ children, tone = 'accent', style }) => (
  <div
    style={{
      fontSize: 10,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      fontWeight: 600,
      // 'warn' and 'neg' were passed by callers ("Setup did not finish") but only
      // 'muted' was understood, so warnings rendered in the affirmative accent.
      color: tone === 'muted' ? 'var(--text-3)'
        : tone === 'warn' ? 'var(--viz-warn)'
          : tone === 'neg' ? 'var(--viz-neg)'
            : 'var(--primary-text)',
      ...style,
    }}
  >
    {children}
  </div>
);

export const Muted = ({ children, size = 11, style }) => (
  <span style={{ fontSize: size, color: 'var(--text-3)', ...style }}>{children}</span>
);

// ── Folded into the shared kit (docs/design-audit/03-plan-one-kit.md) ──────
// Tag, Btn and Spinner used to be a second, differently styled set of the same
// parts ui/ already had, so Home, Projects, Admin and AI Visibility looked like
// a different product from the tools. They keep their names and props here, so
// no caller changes, but they now render the ui/ parts.

// Tone → ui/Badge status. 'accent' affirmative, 'warn' needs attention, 'neg'
// failed, 'muted' nothing to say yet, 'outline' a neutral identifier.
// Exported because the module card tints its icon tile with the same pair its
// status tag uses, so the mark and the tag cannot disagree about state.
const TONE_TO_STATUS = { accent: 'brand', warn: 'warning', neg: 'danger', muted: 'neutral' };
export const TAG_TONES = {
  accent:  { bg: STATUS.brand.bg,   fg: STATUS.brand.fg,   border: 'transparent' },
  warn:    { bg: STATUS.warning.bg, fg: STATUS.warning.fg, border: 'transparent' },
  neg:     { bg: STATUS.danger.bg,  fg: STATUS.danger.fg,  border: 'transparent' },
  muted:   { bg: STATUS.neutral.bg, fg: STATUS.neutral.fg, border: 'transparent' },
  outline: { bg: 'transparent',     fg: 'var(--primary-text)', border: 'var(--primary)' },
};

export const Tag = ({ children, tone = 'muted', style }) => {
  if (tone === 'outline') {
    return (
      <Badge variant="neutral" style={{ background: 'transparent', color: 'var(--primary-text)', border: '1px solid var(--primary)', ...style }}>
        {children}
      </Badge>
    );
  }
  return <Badge variant={TONE_TO_STATUS[tone] || 'neutral'} style={style}>{children}</Badge>;
};

/**
 * Buttons — the ui/ Button, with the studio kit's default of `secondary`.
 * (Studio's own `primary` was outlined; the product now has one primary look.)
 */
export const Btn = ({ variant = 'secondary', children, style, disabled, ...rest }) => (
  <Button variant={variant} disabled={disabled} style={style} {...rest}>
    {children}
  </Button>
);

/**
 * A 0–100 score ring. Renders ONLY when there is a score: `value` of null draws
 * the empty track with an em dash, because a ring stuck at zero reads as a
 * catastrophic result rather than as missing data.
 */
export const ScoreRing = ({ value, size = 68, tone = 'accent', label }) => {
  const radius = size / 2 - 8;
  const circumference = 2 * Math.PI * radius;
  const hasValue = Number.isFinite(value);
  const dash = hasValue ? (Math.max(0, Math.min(100, value)) / 100) * circumference : 0;
  const stroke = tone === 'warn' ? 'var(--viz-warn)' : tone === 'neg' ? 'var(--viz-neg)' : 'var(--primary)';

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ flexShrink: 0 }}
      role="img"
      aria-label={label || (hasValue ? `Score ${value} out of 100` : 'No score yet')}
    >
      <circle
        cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={6}
        stroke="color-mix(in srgb, var(--text) 12%, transparent)"
      />
      {hasValue && (
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={6}
          stroke={stroke} strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
      <text
        x="50%" y="50%" textAnchor="middle" dominantBaseline="central"
        fontSize={hasValue ? size * 0.27 : size * 0.24}
        fontFamily="var(--font-sans)" fontWeight="500"
        fill={hasValue ? stroke : 'var(--text-3)'}
      >
        {hasValue ? value : '—'}
      </text>
    </svg>
  );
};

/**
 * The six-axis audit profile. Axes with no score are drawn as an unfilled spoke
 * with a dash in the label, so an incomplete profile looks incomplete instead of
 * looking like a small site.
 */
export const RadarChart = ({ axes, size = 232 }) => {
  const center = size / 2;
  const maxRadius = center - 34;

  // Axis labels sit outside the outer ring and read outward, so the leftmost and
  // rightmost ones extend past the plot. "AGENT 28" was rendering as "NT 28".
  //
  // The viewBox is widened rather than the chart shrunk: padding the box keeps
  // the polygon its full size and gives the text room, where reducing maxRadius
  // would have made every chart smaller to fit two words.
  const labelPad = 46;
  const rings = [0.25, 0.5, 0.75, 1];
  const count = axes.length;

  const point = (index, ratio) => {
    const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
    return [center + Math.cos(angle) * maxRadius * ratio, center + Math.sin(angle) * maxRadius * ratio];
  };

  const scored = axes.filter((a) => Number.isFinite(a.score));
  const polygon = scored.length === count
    ? axes.map((a, i) => point(i, Math.max(0.06, a.score / 100)).join(',')).join(' ')
    : null;

  return (
    <svg
      width="100%" height={size}
      viewBox={`${-labelPad} 0 ${size + labelPad * 2} ${size}`}
      role="img"
      aria-label={
        scored.length
          ? `Audit profile across ${count} modules, ${scored.length} scored`
          : `Audit profile across ${count} modules — none scored yet`
      }
      style={{ maxWidth: size, display: 'block', margin: '0 auto' }}
    >
      <g fill="none" stroke="color-mix(in srgb, var(--text) 12%, transparent)">
        {rings.map((r) => (
          <circle key={r} cx={center} cy={center} r={maxRadius * r} />
        ))}
        {axes.map((_, i) => {
          const [x, y] = point(i, 1);
          return <line key={i} x1={center} y1={center} x2={x} y2={y} />;
        })}
      </g>

      {polygon && (
        <polygon
          points={polygon}
          fill="color-mix(in srgb, var(--primary) 26%, transparent)"
          stroke="var(--primary)" strokeWidth={1.5} strokeLinejoin="round"
        />
      )}

      {axes.map((axis, i) => {
        if (!Number.isFinite(axis.score)) return null;
        const [x, y] = point(i, Math.max(0.06, axis.score / 100));
        return <circle key={axis.key} cx={x} cy={y} r={3} fill="var(--accent-200)" />;
      })}

      {axes.map((axis, i) => {
        const [x, y] = point(i, 1.18);
        return (
          <text
            key={axis.key}
            x={x} y={y}
            textAnchor={x < center - 6 ? 'end' : x > center + 6 ? 'start' : 'middle'}
            dominantBaseline="middle"
            fontSize={9.5} fontFamily="var(--font-sans)" letterSpacing="0.06em"
            fill="color-mix(in srgb, var(--text) 62%, transparent)"
          >
            {axis.short} {Number.isFinite(axis.score) ? axis.score : '—'}
          </text>
        );
      })}
    </svg>
  );
};

/**
 * The design's severity bar strip. Each bar is one finding bucket; height and
 * color carry severity, so it reads at a glance without a legend.
 */
export const SeverityBars = ({ counts, height = 26 }) => {
  const buckets = [
    { key: 'error',   color: 'color-mix(in srgb, var(--viz-neg) 55%, transparent)',  ratio: 1 },
    { key: 'warning', color: 'color-mix(in srgb, var(--viz-warn) 55%, transparent)', ratio: 0.62 },
    { key: 'notice',  color: 'var(--accent-700)', ratio: 0.34 },
  ];

  // Cap the number of bars so a site with 400 notices doesn't render 400 rects.
  const bars = [];
  for (const bucket of buckets) {
    const n = Math.min(Number(counts?.[bucket.key]) || 0, 14);
    for (let i = 0; i < n; i += 1) bars.push(bucket);
  }
  if (!bars.length) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center' }}>
        <Muted>No findings at error, warning or notice level.</Muted>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 2, height, alignItems: 'flex-end' }} aria-hidden="true">
      {bars.slice(0, 26).map((bar, i) => (
        <span
          key={i}
          style={{
            flex: 1,
            height: `${bar.ratio * 100}%`,
            background: bar.color,
            borderRadius: 2,
          }}
        />
      ))}
    </div>
  );
};

/** Coloured dot + label, for a pass/fail signal list. */
export const SignalDot = ({ tone = 'muted', children }) => (
  <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
    <span
      style={{
        width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
        background:
          tone === 'accent' ? 'var(--primary)'
          : tone === 'warn' ? 'var(--viz-warn)'
          : tone === 'neg' ? 'var(--viz-neg)'
          : 'var(--neutral-600)',
      }}
    />
    {children}
  </span>
);

/** A rule that fades out at both ends — the design's signature divider. */
export const FadingRule = ({ style }) => (
  <div
    style={{
      height: 1,
      border: 0,
      background:
        'linear-gradient(to right, transparent, var(--border) 48px, var(--border) calc(100% - 48px), transparent)',
      ...style,
    }}
  />
);

export const SectionHead = ({ title, right }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 12,
      marginBottom: 12,
      paddingBottom: 8,
      borderBottom: '1px solid var(--border)',
      flexWrap: 'wrap',
    }}
  >
    <h6
      style={{
        margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'var(--text)',
      }}
    >
      {title}
    </h6>
    {right && <Muted size={12}>{right}</Muted>}
  </div>
);

/** Alert row: severity icon, title, detail. */
export const AlertRow = ({ severity, title, detail, at }) => {
  const color = severity === 'error' ? 'var(--viz-neg)' : 'var(--viz-warn)';
  return (
    <div
      style={{
        display: 'flex', gap: 12, padding: 12,
        borderRadius: 'var(--r-md)', background: 'var(--card)',
        border: '1px solid var(--border)',
      }}
    >
      <svg
        width="18" height="18" viewBox="0 0 24 24" fill="none" strokeWidth={1.8}
        strokeLinecap="round" strokeLinejoin="round"
        style={{ display: 'block', flexShrink: 0, marginTop: 1, stroke: color }}
        aria-hidden="true"
      >
        <path d="M12 9v4M12 17h.01" />
        <path d="M10.3 3.9 2.6 17.5A1.5 1.5 0 0 0 3.9 20h16.2a1.5 1.5 0 0 0 1.3-2.5L13.7 3.9a1.5 1.5 0 0 0-2.6 0Z" />
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{title}</div>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: 'var(--text-3)' }}>{detail}</p>
        {at && <Muted>{at}</Muted>}
      </div>
    </div>
  );
};

// Was the bare word "Loading…"; now the shared spinner with its label.
export const Spinner = ({ label = 'Loading…' }) => <UiSpinner label={label} style={{ padding: '40px 0' }} />;
