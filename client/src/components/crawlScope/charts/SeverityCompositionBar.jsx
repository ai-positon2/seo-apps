// A single stacked bar for the part-of-whole read Errors/Warnings/Notices
// actually is — three separate unrelated number tiles made a reader do the
// addition themselves to see the proportion. Same status colors
// severityVariant() already uses everywhere else on this page (danger/
// warning/info), so this doesn't teach a second color meaning just for one
// chart. Page-level only — site/resource/template-scoped findings get their
// own note below rather than being folded in, matching the scope rule every
// other total on this page already follows.

import { Card } from '../../../ui';

const SEGMENTS = [
  { key: 'errors', label: 'Errors', color: 'var(--danger)' },
  { key: 'warnings', label: 'Warnings', color: 'var(--warning)' },
  { key: 'notices', label: 'Notices', color: 'var(--info)' },
];

export default function SeverityCompositionBar({
  metrics, siteOccurrences = 0, resourceOccurrences = 0, templateOccurrences = 0,
}) {
  const total = metrics.errors + metrics.warnings + metrics.notices;
  const nonPageTotal = siteOccurrences + resourceOccurrences + templateOccurrences;

  const dominant = total > 0
    ? [...SEGMENTS].sort((a, b) => metrics[b.key] - metrics[a.key])[0]
    : null;
  const dominantShare = dominant ? Math.round((metrics[dominant.key] / total) * 100) : 0;

  return (
    <Card title={total ? `Findings by severity — ${total.toLocaleString()} page-level` : 'Findings by severity'}>
      {total === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>No page-level findings this run.</div>
      ) : (
        <>
          <div
            role="img"
            aria-label={SEGMENTS.map((s) => `${s.label}: ${metrics[s.key]}`).join(', ')}
            style={{
              display: 'flex', height: 22, borderRadius: 'var(--r-pill)', overflow: 'hidden',
              background: 'var(--surface)',
            }}
          >
            {SEGMENTS.map((seg) => {
              const value = metrics[seg.key];
              if (!value) return null;
              const pct = (value / total) * 100;
              return (
                <div
                  key={seg.key}
                  title={`${seg.label}: ${value.toLocaleString()} (${Math.round(pct)}%)`}
                  style={{
                    width: `${pct}%`, minWidth: 2, background: seg.color,
                    borderRight: '2px solid var(--card)',
                  }}
                />
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
            {SEGMENTS.map((seg) => (
              <div key={seg.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-2)' }}>
                <span aria-hidden style={{ width: 9, height: 9, borderRadius: '50%', background: seg.color, flexShrink: 0 }} />
                {seg.label}: <strong style={{ color: 'var(--text)' }}>{metrics[seg.key].toLocaleString()}</strong>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.4 }}>
            {dominant.label} are {dominantShare}% of all page-level findings.
            {nonPageTotal > 0 && (
              <> {nonPageTotal.toLocaleString()} more finding{nonPageTotal === 1 ? '' : 's'} are site/resource/
                template-scoped and never counted here — see Site-level findings in the pane.
              </>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
