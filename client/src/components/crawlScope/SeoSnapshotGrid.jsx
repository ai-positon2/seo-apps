// A quadrant read of this run's own findings. See buildSeoSnapshot in
// crawlHelpers.js for exactly what lands in each quadrant and why — there is
// no second crawl or competitor data behind this, on purpose: it is this
// run's catalog coverage, reframed, not a trend or a rivals comparison.

import { Card, Badge } from '../../ui';
import { severityVariant } from './crawlHelpers';
import ExpandableText from './ExpandableText';

const QUADRANTS = [
  {
    key: 'strengths',
    title: 'Passed Checks',
    eyebrow: 'Strengths',
    accent: 'var(--success)',
    empty: 'No catalog checks came back fully clean this run.',
  },
  {
    key: 'weaknesses',
    title: 'On-Page Issues',
    eyebrow: 'Weaknesses',
    accent: 'var(--danger)',
    empty: 'No metadata, content, link, accessibility, or performance issues found.',
  },
  {
    key: 'opportunities',
    title: 'Quick Wins',
    eyebrow: 'Opportunities',
    accent: 'var(--info)',
    empty: 'No low-priority quick wins queued right now.',
  },
  {
    key: 'threats',
    title: 'Indexability Risks',
    eyebrow: 'Threats',
    accent: 'var(--warning)',
    empty: 'No crawlability or indexability risks found.',
  },
];

// Same fixed leading-icon column IssueConcentrationChart/BacklogSection use —
// a 1-digit count badge and a 3-digit one (or the ✓ for a clean check) all
// start their label at the same x position instead of drifting with digit
// width.
const ICON_COL_WIDTH = 34;

function QuadrantCard({ title, eyebrow, accent, empty, items }) {
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-3)' }}>
            {eyebrow}
          </div>
          <div style={{ marginTop: 2, fontSize: 15, fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.01em' }}>
            {title}
          </div>
        </div>
        <span style={{ fontSize: 20, fontWeight: 700, color: accent, fontFamily: 'var(--font-mono)' }}>
          {items.length}
        </span>
      </div>
      <div style={{ marginTop: 4, height: 3, borderRadius: 999, background: accent, opacity: items.length ? 0.9 : 0.25 }} />

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.length ? items.map((item) => (
          <div key={item.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            {item.severity ? (
              <Badge
                variant={severityVariant(item.severity)}
                style={{ flexShrink: 0, marginTop: 1, width: ICON_COL_WIDTH, justifyContent: 'center' }}
              >
                {item.count}
              </Badge>
            ) : (
              <span style={{
                flexShrink: 0, marginTop: 1, fontSize: 11, fontWeight: 700, color: accent,
                fontFamily: 'var(--font-mono)', width: ICON_COL_WIDTH, textAlign: 'center',
              }}
              >
                ✓
              </span>
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', lineHeight: 1.35 }}>
                {item.label}
              </div>
              <ExpandableText
                text={item.detail}
                style={{ marginTop: 2, fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.4 }}
              />
            </div>
          </div>
        )) : (
          <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.4 }}>{empty}</div>
        )}
      </div>
    </Card>
  );
}

export default function SeoSnapshotGrid({ snapshot }) {
  if (!snapshot) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
      {QUADRANTS.map((q) => (
        <QuadrantCard key={q.key} {...q} items={snapshot[q.key] || []} />
      ))}
    </div>
  );
}
