// The detailed tag inventory — one row per detected vendor: how many pages
// carry it, where it sits (head/body), how it loads (async/defer/sync), and
// whether it's still actively maintained by its vendor. This is the "what's
// used and what's old and stagnant" read; IntegrationsAdoptionChart (in the
// main column) is just the adoption-rate glance at the same data.
//
// Placement/loading come from the crawled HTML itself — this crawler parses
// served markup, it doesn't execute JavaScript, so these describe where a
// tag sits and how the browser is told to load it, not a trace of when it
// actually fires at runtime.

import { Card, Badge } from '../../ui';

const COL = { pages: 120, placement: 130, loading: 190 };

function loadingSummary(loadingCounts) {
  const parts = [];
  if (loadingCounts.async) parts.push(`${loadingCounts.async} async`);
  if (loadingCounts.defer) parts.push(`${loadingCounts.defer} defer`);
  if (loadingCounts.sync) parts.push(`${loadingCounts.sync} sync`);
  return parts.join(' · ') || '—';
}

function ColumnCaption({ children, width }) {
  return (
    <span style={{
      flex: `0 0 ${width}px`, fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase',
      letterSpacing: 0.4, color: 'var(--text-3)',
    }}
    >
      {children}
    </span>
  );
}

export default function IntegrationsSection({ integrations }) {
  if (!integrations?.items?.length) return null;
  const { items, totalPages } = integrations;
  const deprecatedCount = items.filter((item) => item.status === 'deprecated').length;

  return (
    <Card title={`Integrations detected — ${items.length} tag${items.length === 1 ? '' : 's'}`}>
      <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.5 }}>
        Detected by matching each page&apos;s scripts against a known-vendor signature list. Placement and
        loading are read from the markup, not traced at runtime.
        {deprecatedCount > 0 && (
          <>
            {' '}{deprecatedCount} of these {deprecatedCount === 1 ? 'is' : 'are'} flagged{' '}
            <strong style={{ color: 'var(--warning)' }}>deprecated</strong> — no longer maintained by its
            vendor, worth reviewing for removal or replacement.
          </>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, paddingBottom: 6 }}>
        <span style={{ flex: '1 1 220px' }} />
        <ColumnCaption width={COL.pages}>Pages</ColumnCaption>
        <ColumnCaption width={COL.placement}>Placement</ColumnCaption>
        <ColumnCaption width={COL.loading}>Loading</ColumnCaption>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {items.map((item, i) => (
          <div
            key={item.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 14, padding: '10px 0',
              borderTop: i === 0 ? 'none' : '1px solid var(--border)', flexWrap: 'wrap',
            }}
          >
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{item.name}</span>
                {item.status === 'deprecated' && <Badge variant="warning">Deprecated</Badge>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{item.category}</div>
            </div>
            <span style={{ flex: `0 0 ${COL.pages}px`, fontSize: 12, color: 'var(--text-2)' }}>
              {item.pageCount} of {totalPages}
            </span>
            <span style={{ flex: `0 0 ${COL.placement}px`, fontSize: 12, color: 'var(--text-2)' }}>
              {item.headCount} head · {item.bodyCount} body
            </span>
            <span style={{ flex: `0 0 ${COL.loading}px`, fontSize: 12, color: 'var(--text-2)' }}>
              {loadingSummary(item.loadingCounts)}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
