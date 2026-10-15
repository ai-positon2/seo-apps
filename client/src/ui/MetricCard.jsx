/**
 * MetricCard — Ledger signature compact metric tile
 * @param {string} label — eyebrow label (auto-uppercased, mono)
 * @param {string|number} value — display value (mono, large)
 * @param {'success'|'warning'|'danger'|'neutral'} deltaVariant
 * @param {string} delta — delta text e.g. "+12%" or "−3"
 * @param {string} sub — small subtext below value
 */
export function MetricCard({ label, value, delta, deltaVariant = 'neutral', sub, style: extraStyle, ...rest }) {
  const deltaColors = {
    success: { bg: 'var(--success-soft)', fg: 'var(--success)' },
    danger:  { bg: 'var(--danger-soft)',  fg: 'var(--danger)'  },
    warning: { bg: 'var(--warning-soft)', fg: 'var(--warning)' },
    neutral: { bg: 'var(--surface)',      fg: 'var(--text-3)'  },
  };
  const dc = deltaColors[deltaVariant] || deltaColors.neutral;

  return (
    <div {...rest} style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      padding: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      ...extraStyle,
    }}>
      {/* Eyebrow */}
      <div style={{
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        fontWeight: 500,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: 'var(--text-3)',
      }}>
        {label}
      </div>

      {/* Value row */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{
          fontSize: 28,
          fontFamily: 'var(--font-mono)',
          fontWeight: 700,
          lineHeight: 1,
          color: 'var(--text)',
          letterSpacing: '-0.02em',
        }}>
          {value}
        </span>
        {delta && (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '1px 6px',
            borderRadius: 'var(--r-pill)',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            fontWeight: 500,
            background: dc.bg,
            color: dc.fg,
          }}>
            {delta}
          </span>
        )}
      </div>

      {/* Sub */}
      {sub && (
        <div style={{
          fontSize: 12,
          color: 'var(--text-3)',
          lineHeight: 1.4,
        }}>
          {sub}
        </div>
      )}
    </div>
  );
}

export default MetricCard;
