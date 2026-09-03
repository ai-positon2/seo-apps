// Findings a page×check matrix can't represent — a whole-site configuration
// issue (sitemap/robots, HSTS, llms.txt), a URL-pattern class (a crawl trap),
// or a specific asset file. Attaching one of these to "a page" and summing it
// into page-level totals either double-counts it (once per host, for HSTS) or
// silently drops it (the page×check grid has no cell for "the whole site").
// Shown here instead, on their own, excluded from every page-level count
// above — see buildCountHierarchy / healthMetrics in crawlHelpers.js.

import { Card, Badge } from '../../ui';
import { severityVariant } from './crawlHelpers';
import ExpandableText from './ExpandableText';

const SCOPE_LABEL = { site: 'Site', resource: 'Resource', template: 'Template' };

export default function SiteFindingsSection({ groups, catalogById }) {
  if (!groups.length) return null;

  return (
    <Card title={`Site-level findings (${groups.length})`}>
      <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.5 }}>
        These aren&apos;t about any one page — they cover the whole site, a URL-pattern
        class, or a specific asset file. Excluded from Errors/Warnings/Notices and the
        page-level occurrence count above, so they don&apos;t get double-counted or
        silently dropped.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
        {groups.map((g) => {
          const meta = catalogById.get(g.id);
          return (
            <Card key={g.id} padding="12px 14px">
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <Badge variant={severityVariant(g.severity)}>{g.severity}</Badge>
                  <span style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.3 }}>
                    {SCOPE_LABEL[g.scope] || g.scope}
                  </span>
                </div>
                <span style={{ fontSize: 11.5, color: 'var(--text-3)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                  {g.urls.length} instance{g.urls.length === 1 ? '' : 's'}
                </span>
              </div>
              <div style={{ marginTop: 6, fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.35 }}>
                {g.label}
              </div>
              <ExpandableText
                text={meta?.description}
                style={{ marginTop: 4, fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.4 }}
              />
            </Card>
          );
        })}
      </div>
    </Card>
  );
}
