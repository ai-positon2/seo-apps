import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { DataTable, Card } from '../../ui';
import { InsightCallout } from './InsightCallout';
import { domainLabel, fmtNum } from './utils';

export function BrandedTab({ snapshot, insight }) {
  const domains = snapshot?.domains || [];

  const rows = domains.map(d => ({
    id: d.domain,
    domain: domainLabel(d) + (d.isClient ? ' (Client)' : ''),
    branded: fmtNum(d.brandedKeywordCount) + (d.brandedKeywordCountCapped ? '+' : ''),
    nonBranded: fmtNum(d.nonBrandedKeywordCount),
  }));

  const chartData = domains.map(d => ({
    name: domainLabel(d),
    Branded: d.brandedKeywordCount || 0,
    'Non-branded': d.nonBrandedKeywordCount || 0,
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <InsightCallout insight={insight} />

      <DataTable
        title="Branded vs. Non-branded Keywords"
        columns={[
          { key: 'domain', label: 'Domain' },
          { key: 'branded', label: 'Branded', align: 'right', mono: true },
          { key: 'nonBranded', label: 'Non-branded', align: 'right', mono: true },
        ]}
        rows={rows}
      />

      <Card title="Branded / Non-branded Split">
        <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px' }}>
          Branded counts are capped at 500 matching keywords per domain to keep SEMrush credit usage bounded — domains with more true matches will show an undercount.
        </p>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 40 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis type="number" stroke="var(--text-3)" fontSize={12} />
            <YAxis type="category" dataKey="name" stroke="var(--text-3)" fontSize={12} width={120} />
            <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="Branded" stackId="a" fill="var(--primary)" />
            <Bar dataKey="Non-branded" stackId="a" fill="var(--surface-2)" stroke="var(--border)" />
          </BarChart>
        </ResponsiveContainer>
      </Card>
    </div>
  );
}

export default BrandedTab;
