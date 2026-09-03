// Horizontal bars: the % of (internal, HTML) pages carrying each detected
// third-party tag. Bars, not a pie — a page routinely carries several tags
// at once (GTM + GA4 + a pixel), so these percentages don't sum to 100% the
// way pie slices must; a pie here would visually claim a whole that doesn't
// exist. See buildIntegrations in analyzer.js for what's actually detected —
// a static signature match against the page's markup, not runtime
// execution. This is the adoption-rate glance; the full per-vendor detail
// (placement, loading, deprecated flags) is in IntegrationsSection.jsx, at
// the end of the page.

import { Card } from '../../../ui';

const TOP_N = 8;
const LABEL_WIDTH = 190;
// Fixed categorical order, same rule every chart on this page follows — a
// 7th+ category shares the last hue rather than generating a new one.
const CATEGORY_COLORS = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)', 'var(--viz-6)'];

export default function IntegrationsAdoptionChart({ integrations }) {
  if (!integrations?.items?.length || !integrations.totalPages) return null;
  const { items, totalPages } = integrations;

  const categoryColor = new Map();
  for (const item of items) {
    if (!categoryColor.has(item.category)) {
      categoryColor.set(item.category, CATEGORY_COLORS[Math.min(categoryColor.size, CATEGORY_COLORS.length - 1)]);
    }
  }

  const top = items.slice(0, TOP_N);
  const rest = items.length - top.length;
  const max = Math.max(...top.map((item) => item.pageCount), 1);

  return (
    <Card title={`Tags detected — top ${top.length} of ${items.length}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {top.map((item) => {
          const pct = Math.round((item.pageCount / totalPages) * 100);
          return (
            <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                title={`${item.name} (${item.category})`}
                style={{
                  flex: `0 1 ${LABEL_WIDTH}px`, fontSize: 12, color: 'var(--text-2)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}
              >
                {item.name}
              </span>
              <div style={{ flex: 1, height: 12, background: 'var(--surface)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
                <div
                  title={`${item.name}: ${item.pageCount.toLocaleString()} of ${totalPages.toLocaleString()} pages (${pct}%)`}
                  style={{
                    width: `${(item.pageCount / max) * 100}%`, height: '100%',
                    background: categoryColor.get(item.category), borderRadius: 'var(--r-sm)',
                  }}
                />
              </div>
              <span style={{ width: 40, flexShrink: 0, fontSize: 11.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text)', textAlign: 'right' }}>
                {pct}%
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.4 }}>
        Share of pages carrying each tag — these overlap (a page often carries several at once), so they
        don&apos;t sum to 100%. Placement, loading, and anything deprecated are in Integrations detected,
        at the end of the page.
        {rest > 0 ? ` ${rest} more tag${rest === 1 ? '' : 's'} not shown here.` : ''}
      </div>
    </Card>
  );
}
