import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { DataTable, Card } from '../../ui';
import { InsightCallout } from './InsightCallout';
import { domainColor, domainLabel, fmtNum, fmtDate } from './utils';

function buildHistoryRows(history) {
  if (!history || history.length < 2) return null;
  return history.map(point => {
    const row = { date: fmtDate(point.capturedAt) };
    point.domains.forEach(d => { row[d.domain] = d.organicTraffic; });
    return row;
  });
}

export function OverviewTab({ snapshot, insight }) {
  const domains = snapshot?.domains || [];
  const historyRows = buildHistoryRows(snapshot?.history);

  const rows = domains.map(d => ({
    id: d.domain,
    domain: domainLabel(d) + (d.isClient ? ' (Client)' : ''),
    authorityScore: fmtNum(d.authorityScore),
    homepageAuthorityScore: fmtNum(d.homepageAuthorityScore),
    organicTraffic: fmtNum(d.domainRank?.organicTraffic),
    organicKeywords: fmtNum(d.domainRank?.organicKeywords),
    backlinks: fmtNum(d.backlinks?.totalBacklinks),
    referringDomains: fmtNum(d.backlinks?.referringDomains),
    aioKeywords: fmtNum(d.aioKeywordCount),
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <InsightCallout insight={insight} />

      <DataTable
        title="Overall Analysis"
        columns={[
          { key: 'domain', label: 'Domain' },
          { key: 'authorityScore', label: 'Authority', align: 'right', mono: true },
          { key: 'homepageAuthorityScore', label: 'Home Page Auth.', align: 'right', mono: true },
          { key: 'organicTraffic', label: 'Organic Traffic', align: 'right', mono: true },
          { key: 'organicKeywords', label: 'Keywords', align: 'right', mono: true },
          { key: 'backlinks', label: 'Backlinks', align: 'right', mono: true },
          { key: 'referringDomains', label: 'Ref. Domains', align: 'right', mono: true },
          { key: 'aioKeywords', label: 'AIO Keywords', align: 'right', mono: true },
        ]}
        rows={rows}
      />

      {historyRows && (
        <Card title="Organic Traffic Trend">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={historyRows}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" stroke="var(--text-3)" fontSize={12} />
              <YAxis stroke="var(--text-3)" fontSize={12} />
              <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {domains.map((d, i) => (
                <Line key={d.domain} type="monotone" dataKey={d.domain} name={domainLabel(d)} stroke={domainColor(i)} strokeWidth={2} dot={{ r: 3 }} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}
    </div>
  );
}

export default OverviewTab;
