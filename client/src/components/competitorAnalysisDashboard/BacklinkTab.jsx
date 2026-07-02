import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { DataTable, Card } from '../../ui';
import { InsightCallout } from './InsightCallout';
import { domainLabel, fmtNum } from './utils';

const BUCKET_ORDER = ['80+', '60-79', '40-59', '20-39', '0-19'];

export function BacklinkTab({ snapshot, insight }) {
  const domains = snapshot?.domains || [];
  const backlinkGap = snapshot?.backlinkGap || [];
  const referringDomainCategories = snapshot?.referringDomainCategories || {};
  const clientDomain = domains.find(d => d.isClient);

  const authorityRows = domains.map(d => ({
    id: d.domain,
    domain: domainLabel(d) + (d.isClient ? ' (Client)' : ''),
    authorityScore: fmtNum(d.authorityScore),
    referringDomains: fmtNum(d.backlinks?.referringDomains),
    backlinks: fmtNum(d.backlinks?.totalBacklinks),
  }));

  const bucketData = BUCKET_ORDER.map(bucket => ({
    bucket,
    count: clientDomain?.authorityBuckets?.[bucket] || 0,
  }));

  const gapRows = backlinkGap.slice(0, 50).map((g, i) => ({
    id: i,
    domain: g.domain,
    ascore: fmtNum(g.ascore),
    sharedByCount: g.sharedByCount,
    linksTo: (g.linksTo || []).join(', '),
  }));

  const geoRows = (clientDomain?.geoDistribution || []).slice(0, 20).map((g, i) => ({
    id: i,
    country: g.country,
    referringDomains: fmtNum(g.referringDomains),
    backlinks: fmtNum(g.backlinks),
  }));

  const categoryCounts = {};
  Object.values(referringDomainCategories).forEach(cat => {
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  });
  const categoryRows = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count], i) => ({ id: i, category, count }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <InsightCallout insight={insight} />

      <DataTable
        title="Off-page Metrics Comparison"
        columns={[
          { key: 'domain', label: 'Domain' },
          { key: 'authorityScore', label: 'Authority', align: 'right', mono: true },
          { key: 'referringDomains', label: 'Referring Domains', align: 'right', mono: true },
          { key: 'backlinks', label: 'Backlinks', align: 'right', mono: true },
        ]}
        rows={authorityRows}
      />

      {clientDomain && (
        <Card title="Client Authority Distribution (Referring Domains)">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={bucketData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="bucket" stroke="var(--text-3)" fontSize={12} />
              <YAxis stroke="var(--text-3)" fontSize={12} />
              <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="count" fill="var(--primary)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      <DataTable
        title="Referring Domain Gaps (link to competitors, not client)"
        columns={[
          { key: 'domain', label: 'Domain' },
          { key: 'ascore', label: 'Authority', align: 'right', mono: true },
          { key: 'sharedByCount', label: 'Shared By', align: 'right', mono: true },
          { key: 'linksTo', label: 'Links To', maxWidth: 260, wrap: true },
        ]}
        rows={gapRows}
        emptyText="No gap data yet"
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <DataTable
          title="Client Referring Domains by Country"
          columns={[
            { key: 'country', label: 'Country' },
            { key: 'referringDomains', label: 'Ref. Domains', align: 'right', mono: true },
            { key: 'backlinks', label: 'Backlinks', align: 'right', mono: true },
          ]}
          rows={geoRows}
          emptyText="No geo data available"
        />
        <DataTable
          title="Client Referring Domains by Category (approximate)"
          columns={[
            { key: 'category', label: 'Category' },
            { key: 'count', label: 'Domains', align: 'right', mono: true },
          ]}
          rows={categoryRows}
          emptyText="No category data available"
        />
      </div>
      {categoryRows.length > 0 && (
        <p style={{ fontSize: 11, color: 'var(--text-3)', margin: 0 }}>
          Category breakdown is a GPT approximation from domain names — SEMrush's API doesn't export a category column.
        </p>
      )}
    </div>
  );
}

export default BacklinkTab;
