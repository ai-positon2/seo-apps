import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { DataTable, Card, Badge } from '../../ui';
import { InsightCallout } from './InsightCallout';
import { domainLabel, scoreColor } from './utils';

function ScoreCell({ score }) {
  if (score === null || score === undefined) return <span style={{ color: 'var(--text-3)' }}>—</span>;
  return <span style={{ color: scoreColor(score), fontWeight: 600 }}>{score}</span>;
}

export function PageSpeedTab({ snapshot, insight }) {
  const domains = snapshot?.domains || [];

  const rows = domains.map(d => ({
    id: d.domain,
    domain: domainLabel(d) + (d.isClient ? ' (Client)' : ''),
    mobile: <ScoreCell score={d.pageSpeed?.mobile?.score} />,
    desktop: <ScoreCell score={d.pageSpeed?.desktop?.score} />,
    cwv: d.pageSpeed?.dataUnavailable
      ? <Badge variant="neutral">Unavailable</Badge>
      : d.pageSpeed?.coreWebVitalsPassed
      ? <Badge variant="success">Pass</Badge>
      : <Badge variant="danger">Fail</Badge>,
  }));

  const chartData = domains
    .filter(d => d.pageSpeed?.mobile?.score != null)
    .map(d => ({ name: domainLabel(d), mobile: d.pageSpeed.mobile.score, desktop: d.pageSpeed.desktop?.score ?? 0 }));

  const vitalsRows = domains.map(d => ({
    id: d.domain,
    domain: domainLabel(d) + (d.isClient ? ' (Client)' : ''),
    lcp: d.pageSpeed?.mobile?.lcp ?? '—',
    inp: d.pageSpeed?.mobile?.inp ?? '—',
    cls: d.pageSpeed?.mobile?.cls ?? '—',
    fcp: d.pageSpeed?.mobile?.fcp ?? '—',
    ttfb: d.pageSpeed?.mobile?.ttfb ?? '—',
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <InsightCallout insight={insight} />

      <DataTable
        title="Page Speed Score Comparison"
        columns={[
          { key: 'domain', label: 'Domain' },
          { key: 'mobile', label: 'Mobile', align: 'right' },
          { key: 'desktop', label: 'Desktop', align: 'right' },
          { key: 'cwv', label: 'Core Web Vitals', align: 'right' },
        ]}
        rows={rows}
      />

      {chartData.length > 0 && (
        <Card title="Score Comparison">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="name" stroke="var(--text-3)" fontSize={12} />
              <YAxis stroke="var(--text-3)" fontSize={12} domain={[0, 100]} />
              <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="mobile" name="Mobile" fill="var(--primary)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="desktop" name="Desktop" fill="var(--success)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      <DataTable
        title="Core Web Vitals (Mobile)"
        columns={[
          { key: 'domain', label: 'Domain' },
          { key: 'lcp', label: 'LCP', align: 'right', mono: true },
          { key: 'inp', label: 'INP', align: 'right', mono: true },
          { key: 'cls', label: 'CLS', align: 'right', mono: true },
          { key: 'fcp', label: 'FCP', align: 'right', mono: true },
          { key: 'ttfb', label: 'TTFB', align: 'right', mono: true },
        ]}
        rows={vitalsRows}
      />
    </div>
  );
}

export default PageSpeedTab;
